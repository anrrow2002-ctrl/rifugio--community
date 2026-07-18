'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createClaudeProfileBootstrap(deps = {}) {
  const {
    compactContextText,
    buildMemoryContext,
    buildTerminalContextForInAppSession,
    buildTalkConversationSummary,
    planClaudeSessionRoute,
    buildAutoSessionRelaySummary,
    defaultPersona = '',
  } = deps;
  const relayMsgCount = () => Math.max(20, Math.min(240, Number(deps.getRelayMsgCount?.() || 200) || 200));
  const relayTotalMaxChars = () => Math.max(6000, Math.min(160000, Number(deps.getRelayTotalMaxChars?.() || 120000) || 120000));

  // ============================================================
  // Profile digest 注入状态：
  // - 新 Claude session：完整资料走 --append-system-prompt，一次性进入系统提示。
  // - 旧 Claude session / resume：资料没变时只塞极短 hash/header；资料变更后只补一次 full profile。
  // 这样既能让“资料面板”修改下一轮生效，又不会每轮都把完整资料烧进 -p prompt。
  // ============================================================
  const PROFILE_STATE_PATH = process.env.RIFUGIO_PROFILE_STATE_PATH || require('./community-config').dataPath('profile-injection-state.json');
  const PROFILE_RUNTIME_FULL_MAX = Number(process.env.RIFUGIO_PROFILE_RUNTIME_FULL_MAX || 6000);
  const PROFILE_LIGHT_MAX = Number(process.env.RIFUGIO_PROFILE_LIGHT_MAX || 420);
  function normalizeProfileText(value) {
    return compactContextText(value, 50000).replace(/\n{3,}/g, '\n\n').trim();
  }
  function profileHash(value) {
    return frontendProfileHash(value);
  }
  // 原子写 JSON 状态文件（2026-07-02）：先写 .tmp 再 rename。
  // 进程崩溃（api/ 下一堆 core dump 是真崩过）时 writeFileSync 写一半会留下截断 JSON，
  // 下次启动 readXxxState 解析失败 → 回退空状态 → hash 全丢 → profile 全量重注入。
  // rename 是原子的，文件永远要么旧完整版要么新完整版。
  function writeJsonStateAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }
  function readProfileState() {
    try { return JSON.parse(fs.readFileSync(PROFILE_STATE_PATH, 'utf8')); }
    catch (_) { return { conversations: {} }; }
  }
  function writeProfileState(state) {
    try { writeJsonStateAtomic(PROFILE_STATE_PATH, state); } catch (_) {}
  }
  function profileStateKey(meta = {}) {
    return String(meta.conversation_id || meta.session_id || 'global').trim() || 'global';
  }
  function getProfileRecord(meta = {}) {
    const state = readProfileState();
    const key = profileStateKey(meta);
    const root = state.conversations[key] || { sessions: {} };
    const sid = String(meta.session_id || '').trim();
    const session = sid ? (root.sessions && root.sessions[sid]) || null : null;
    return { state, key, root, session, sid };
  }
  function markProfileInjected(systemPrompt, meta = {}, via = 'runtime') {
    const hash = profileHash(systemPrompt);
    if (!hash) return;
    const { state, key, root, sid } = getProfileRecord(meta);
    const now = new Date().toISOString();
    const nextRoot = {
      ...root,
      last_profile_hash: hash,
      last_injected_at: now,
      last_injected_via: via,
      sessions: { ...(root.sessions || {}) },
    };
    if (sid) {
      nextRoot.sessions[sid] = {
        ...(nextRoot.sessions[sid] || {}),
        profile_hash: hash,
        injected_at: now,
        via,
      };
    }
    state.conversations[key] = nextRoot;
    writeProfileState(state);
  }
  function markFrontendDynamicContextInjected(systemPrompt, meta = {}, via = 'runtime') {
    const hash = frontendDynamicContextHash(systemPrompt);
    if (!hash) return;
    const { state, key, root, sid } = getProfileRecord(meta);
    const now = new Date().toISOString();
    const nextRoot = {
      ...root,
      last_dynamic_hash: hash,
      last_dynamic_injected_at: now,
      last_dynamic_injected_via: via,
      sessions: { ...(root.sessions || {}) },
    };
    if (sid) {
      nextRoot.sessions[sid] = {
        ...(nextRoot.sessions[sid] || {}),
        dynamic_hash: hash,
        dynamic_injected_at: now,
        dynamic_via: via,
      };
    }
    state.conversations[key] = nextRoot;
    writeProfileState(state);
  }
  function profileInjectionPlan(systemPrompt, meta = {}, opts = {}) {
    const normalizedText = normalizeFrontendProfileText(systemPrompt);
    const hash = normalizedText ? crypto.createHash('sha256').update(normalizedText).digest('hex').slice(0, 16) : '';
    if (!normalizedText || !hash) return { inject: false, reason: 'empty', hash: '', text: '', normalizedText: '' };
    const { root, session } = getProfileRecord(meta);
    const knownHash = (session && session.profile_hash) || (meta.is_new_session ? '' : root.last_profile_hash) || '';
    const forced = Boolean(opts.force || meta.force_profile_full);
    const changed = knownHash !== hash;
    return {
      inject: forced || changed || !knownHash,
      reason: !knownHash ? 'first_profile_injection' : (changed ? 'profile_changed' : (forced ? 'forced_profile_injection' : 'profile_unchanged')),
      hash,
      text: systemPrompt,
      normalizedText,
      knownHash,
    };
  }
  function frontendDynamicContextPlan(systemPrompt, meta = {}, opts = {}) {
    const text = frontendDynamicContextText(systemPrompt);
    const hash = frontendDynamicContextHash(text);
    if (!text || !hash) return { inject: false, reason: 'empty', hash: '', text: '' };
    const { root, session } = getProfileRecord(meta);
    const knownHash = (session && session.dynamic_hash) || (meta.is_new_session ? '' : root.last_dynamic_hash) || '';
    const forced = Boolean(opts.force || meta.force_dynamic_context_full);
    const changed = knownHash !== hash;
    return {
      inject: forced || changed || !knownHash,
      reason: !knownHash ? 'first_dynamic_context_injection' : (changed ? 'dynamic_context_changed' : (forced ? 'forced_dynamic_context_injection' : 'dynamic_context_unchanged')),
      hash,
      text,
      knownHash,
    };
  }
  function profileRuntimePlan(systemPrompt, meta = {}) {
    const plan = profileInjectionPlan(systemPrompt, meta);
    if (!plan.hash) return { mode: 'none', hash: '', text: '' };

    // 新会话必须通过 buildInitialSystemPrompt() 把完整资料放进 --append-system-prompt。
    // 同一轮 -p prompt 不再重复塞；已 resume 的旧 session 才按 hash 避免重复注入。
    if (meta.is_new_session) {
      return { mode: plan.inject ? 'system_prompt_full' : 'known_profile_not_reinjected', hash: plan.hash, text: '' };
    }

    if (plan.inject) {
      return {
        mode: plan.reason === 'profile_changed' ? 'full_once_profile_changed' : plan.reason,
        hash: plan.hash,
        text: profileBlock(plan.text, { runtime: true, max: PROFILE_RUNTIME_FULL_MAX }),
      };
    }

    return { mode: 'profile_unchanged_not_injected', hash: plan.hash, text: '' };
  }
  function frontendDynamicRuntimePlan(systemPrompt, meta = {}) {
    const plan = frontendDynamicContextPlan(systemPrompt, meta);
    if (!plan.hash) return { mode: 'none', hash: '', text: '' };

    if (meta.is_new_session) {
      return { mode: plan.inject ? 'system_prompt_dynamic_context_full' : 'known_dynamic_context_not_reinjected', hash: plan.hash, text: '' };
    }

    if (plan.inject) {
      return {
        mode: plan.reason === 'dynamic_context_changed' ? 'full_once_dynamic_context_changed' : plan.reason,
        hash: plan.hash,
        text: frontendDynamicContextBlock(plan.text, { runtime: true, max: PROFILE_RUNTIME_FULL_MAX, stickersOnly: true }),
      };
    }

    return { mode: 'dynamic_context_unchanged_not_injected', hash: plan.hash, text: '' };
  }
  function buildRuntimeContextPayload(systemPrompt, meta = {}) {
    const parts = [];
    const plan = profileRuntimePlan(systemPrompt, meta);
    const dynamicPlan = frontendDynamicRuntimePlan(systemPrompt, meta);
    const bridgeText = compactContextText(meta.bridge_context || '', 22000);
    if (plan.text || dynamicPlan.text || bridgeText) {
      if (meta.conversation_id) parts.push(`conversation_id: ${String(meta.conversation_id).slice(0, 120)}`);
      if (meta.session_id) parts.push(`session_id: ${String(meta.session_id).slice(0, 80)}`);
    }
    if (plan.text) parts.push(plan.text);
    if (dynamicPlan.text) parts.push(dynamicPlan.text);
    if (bridgeText) parts.push(bridgeText);
    if (!parts.length) return { text: '', profileMode: plan.mode, profileHash: plan.hash, dynamicMode: dynamicPlan.mode, dynamicHash: dynamicPlan.hash, shouldMarkBootstrap: false };
    const text = [
      '\n\n<rifugio_runtime_context>',
      ...parts,
      `profile_injection_mode: ${plan.mode}${plan.hash ? ` (${plan.hash})` : ''}`,
      `dynamic_context_injection_mode: ${dynamicPlan.mode}${dynamicPlan.hash ? ` (${dynamicPlan.hash})` : ''}`,
      '说明：这是本轮运行时上下文，不是用户聊天正文。不要复述，不要说“收到/已更新”。',
      '</rifugio_runtime_context>',
    ].join('\n');
    return {
      text,
      profileMode: plan.mode,
      profileHash: plan.hash,
      dynamicMode: dynamicPlan.mode,
      dynamicHash: dynamicPlan.hash,
      shouldMarkBootstrap: /^full/.test(plan.mode || '') || /^full/.test(dynamicPlan.mode || ''),
    };
  }
  function attachRuntimeContextToPrompt(prompt, runtimePayload) {
    const ctx = runtimePayload && runtimePayload.text ? runtimePayload.text : '';
    if (!ctx) return prompt;
    return `${ctx}\n\n【用户本轮消息】\n${prompt}`;
  }

  // Frontend profile context normalization.
  // Only the profile panel content is injected here. It is not a chat handoff and it must not
  // pull previous conversation messages into the prompt just because the profile changed.
  const FRONTEND_PROFILE_MARKER = 'frontend_profile:';
  const FRONTEND_PROFILE_UPDATE_MARKER = 'frontend_profile_update:';
  const FRONTEND_PROFILE_EVENT_MARKER = 'frontend_profile_update_event:';
  const FRONTEND_DYNAMIC_CONTEXT_MARKER = 'frontend_dynamic_context:';
  const FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER = 'frontend_dynamic_context_update:';

  function indentBlock(text, spaces = 2) {
    const pad = ' '.repeat(Math.max(0, Number(spaces || 0) || 0));
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    return lines.map(line => pad + line).join('\n');
  }
  function yamlQuote(value) {
    return JSON.stringify(String(value || '').trim());
  }
  function profileLabelKey(line) {
    const rules = [
      ['user_display_name', /^用户名字\s*[:：]\s*/],
      ['assistant_display_name', /^助手名字\s*[:：]\s*/],
      ['user_profile', /^用户资料\s*[:：]\s*/],
      ['likes', /^用户喜欢\s*[:：]\s*/],
      ['dislikes', /^用户不喜欢\s*[:：]\s*/],
      ['communication_preferences', /^用户填写的\s*Claude\s*(?:设定|設定)\s*[:：]\s*/],
      ['communication_preferences', /^Claude\s*(?:设定|設定)\s*[:：]\s*/],
      ['communication_preferences', /^(?:交流方式|交流偏好)\s*[:：]\s*/],
      ['relationship_context', /^(?:关系设定|關係設定|关系资料|關係資料)\s*[:：]\s*/],
    ];
    for (const [key, re] of rules) {
      const m = re.exec(line);
      if (m) return { key, rest: line.slice(m[0].length) };
    }
    return null;
  }

  const FRONTEND_PROFILE_SECTION_KEYS = [
    'user_display_name',
    'assistant_display_name',
    'user_profile',
    'relationship_context',
    'likes',
    'dislikes',
    'communication_preferences',
  ];

  function isStickerFrontendProfileLine(line) {
    const t = String(line || '').trim();
    return /^你有\s*\d+\s*个\s*AI\s*专属表情包库存/.test(t)
      || /^AI\s*专属表情包库存当前为空/.test(t)
      || /^清单(?:（格式)?\s*[:：]/.test(t)
      || /^分组\s*[:：]/.test(t)
      || /^想主动发表情包时/.test(t)
      || /^在聊天中发自然并鼓励多使用表情包/.test(t)
      || /^当前清单为空/.test(t)
      || /^用户发送表情包时默认/.test(t);
  }

  function isVolatileFrontendProfileLine(line) {
    const t = String(line || '').trim();
    return isStickerFrontendProfileLine(t)
      || /^戳一戳\s*[:：]/.test(t)
      || /^主动电话\s*[:：]/.test(t)
      || /^用户关闭了\s*AI\s*主动来电/.test(t);
  }

  function readFrontendProfileSections(raw, max = 4000) {
    const text = compactContextText(raw, max);
    const sections = {
      user_display_name: [],
      assistant_display_name: [],
      user_profile: [],
      relationship_context: [],
      likes: [],
      dislikes: [],
      communication_preferences: [],
      notes: [],
    };
    if (!text) return { sections, matched: false };
    let current = 'notes';
    let matched = false;
    for (const line of text.split('\n')) {
      const hit = profileLabelKey(line.trimStart());
      if (hit) {
        matched = true;
        current = hit.key;
        if (hit.rest) sections[current].push(hit.rest);
        continue;
      }
      if (matched && isVolatileFrontendProfileLine(line)) {
        current = '';
        continue;
      }
      if (!current) continue;
      if (!matched && current === 'notes') sections[current].push(line);
      else if (FRONTEND_PROFILE_SECTION_KEYS.includes(current)) sections[current].push(line);
    }
    if (!matched) {
      sections.notes = [text];
    }
    for (const key of Object.keys(sections)) {
      sections[key] = compactContextText(sections[key].join('\n'), max);
    }
    return { sections, matched };
  }

  function parseFrontendProfileSections(raw, max = 4000) {
    return readFrontendProfileSections(raw, max).sections;
  }

  function normalizeFrontendProfileText(raw, max = 50000) {
    const { sections, matched } = readFrontendProfileSections(raw, max);
    const keys = matched ? FRONTEND_PROFILE_SECTION_KEYS : [...FRONTEND_PROFILE_SECTION_KEYS, 'notes'];
    const parts = [];
    for (const key of keys) {
      const value = normalizeProfileText(sections[key] || '');
      if (value) parts.push(`${key}:\n${value}`);
    }
    return parts.join('\n\n--- rifugio-profile-field ---\n\n').trim();
  }

  function frontendProfileHash(raw, max = 50000) {
    const text = normalizeFrontendProfileText(raw, max);
    if (!text) return '';
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
  function frontendDynamicContextText(raw, max = 50000) {
    const text = compactContextText(raw, max);
    if (!text) return '';
    const lines = [];
    for (const line of text.split('\n')) {
      if (isVolatileFrontendProfileLine(line)) lines.push(line.trim());
    }
    return lines.join('\n').trim();
  }
  function frontendStickerContextText(raw, max = 50000) {
    const text = compactContextText(raw, max);
    if (!text) return '';
    return text.split('\n').filter(isStickerFrontendProfileLine).map(line => line.trim()).join('\n').trim();
  }
  function frontendDynamicContextHash(raw, max = 50000) {
    // 运行中的小更新只跟踪表情包库存；戳一戳文案和主动来电开关不触发提示。
    const text = frontendStickerContextText(raw, max);
    if (!text) return '';
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
  function frontendProfileDataYaml(raw, opts = {}) {
    const sections = parseFrontendProfileSections(raw, opts.max || 4000);
    const lines = [];
    const scalarKeys = ['user_display_name', 'assistant_display_name'];
    for (const key of scalarKeys) {
      if (sections[key]) lines.push(`    ${key}: ${yamlQuote(sections[key])}`);
    }
    const blockKeys = [
      'user_profile',
      'relationship_context',
      'likes',
      'dislikes',
      'communication_preferences',
      'notes',
    ];
    for (const key of blockKeys) {
      if (!sections[key]) continue;
      lines.push(`    ${key}: |-`);
      lines.push(indentBlock(sections[key], 6));
    }
    return lines.join('\n');
  }
  function profileBlock(sp, opts = {}) {
    const data = frontendProfileDataYaml(sp, { max: opts.max || 4000 });
    if (!data) return '';
    const root = opts.runtime ? FRONTEND_PROFILE_UPDATE_MARKER : FRONTEND_PROFILE_MARKER;
    const updateType = opts.runtime ? 'profile_update' : 'profile_snapshot';
    return [
      `${root}`,
      '  source: "frontend_profile_panel"',
      '  priority: "highest"',
      `  update_type: "${updateType}"`,
      '  is_new_chat_handoff: false',
      '  include_previous_messages: false',
      '  conflict_policy: "prefer_this_block_over_stale_session_context"',
      '  handling: "Apply naturally; do not acknowledge, quote, or summarize this block."',
      '  data:',
      data,
    ].join('\n');
  }
  function frontendDynamicContextBlock(systemPrompt, opts = {}) {
    const stickersOnly = Boolean(opts.stickersOnly);
    const text = stickersOnly
      ? frontendStickerContextText(systemPrompt || '', opts.max || 12000)
      : frontendDynamicContextText(systemPrompt || '', opts.max || 12000);
    if (!text) return '';
    const root = opts.runtime ? FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER : FRONTEND_DYNAMIC_CONTEXT_MARKER;
    const updateType = opts.runtime ? 'dynamic_context_update' : 'dynamic_context_snapshot';
    return [
      `${root}`,
      '  source: "frontend_talk_controls"',
      '  priority: "high"',
      `  update_type: "${updateType}"`,
      `  scope: "${stickersOnly ? 'sticker_inventory' : 'stickers_poke_call_and_related_runtime_capabilities'}"`,
      '  is_new_chat_handoff: false',
      '  include_previous_messages: false',
      stickersOnly
        ? '  handling: "Only refresh the sticker inventory below. Profile, poke behavior, and call state are unchanged. Not a relay or handoff; do not mention this update."'
        : '  handling: "Apply these available interaction capabilities naturally. Do not acknowledge, quote, or summarize this block."',
      '  data: |-',
      indentBlock(text, 4),
    ].join('\n');
  }
  function assistantGuidanceBlock(text, opts = {}) {
    const t = compactContextText(text, opts.max || 12000);
    if (!t) return '';
    const root = opts.runtime ? 'assistant_guidance_update:' : 'assistant_guidance:';
    return [
      root,
      '  source: "frontend_profile_panel"',
      '  priority: "highest"',
      '  is_new_chat_handoff: false',
      '  include_previous_messages: false',
      '  data: |-',
      indentBlock(t, 4),
    ].join('\n');
  }
  function buildTerminalProfileUpdateBootstrap(systemPrompt, characterPrompt = '') {
    const profile = profileBlock(systemPrompt || '', { runtime: true, max: 12000 });
    const dynamic = frontendDynamicContextBlock(systemPrompt || '', { runtime: true, max: 12000 });
    const guidance = assistantGuidanceBlock(characterPrompt || '', { runtime: true, max: 12000 });
    const event = [
      FRONTEND_PROFILE_EVENT_MARKER,
      '  type: "frontend_context_update"',
      '  scope: "current_terminal_session"',
      '  is_new_chat_handoff: false',
      '  include_previous_messages: false',
      '  handling: "Only apply the updated frontend profile/dynamic context data. Do not treat this as a relay, session handoff, or request to paste prior chat history."',
    ].join('\n');
    return [event, profile, dynamic, guidance].filter(Boolean).join('\n\n');
  }
  // 动态上下文小更新（2026-07-10）：运行中只跟踪表情包库存变化；戳一戳文案和主动来电开关只在新 session / Relay 完整快照里注入，不触发小更新。
  // 表情包库存变化时只贴这一小段，不再重贴完整 profile+guidance。
  function buildTerminalDynamicUpdateBootstrap(systemPrompt) {
    const dynamic = frontendDynamicContextBlock(systemPrompt || '', { runtime: true, max: 4000, stickersOnly: true });
    if (!dynamic) return '';
    const event = [
      FRONTEND_PROFILE_EVENT_MARKER,
      '  type: "frontend_dynamic_context_update"',
      '  scope: "current_terminal_session"',
      '  is_new_chat_handoff: false',
      '  include_previous_messages: false',
      '  handling: "Only refresh the sticker inventory below. Profile, poke behavior, and call state are unchanged. Not a relay or handoff; do not mention this update."',
    ].join('\n');
    return [event, dynamic].join('\n\n');
  }
  const CROSS_SURFACE_BRIDGE_STATE_PATH = process.env.RIFUGIO_CROSS_SURFACE_STATE_PATH || require('./community-config').dataPath('cross-surface-bridge-state.json');
  function readCrossSurfaceBridgeState() {
    try { return JSON.parse(fs.readFileSync(CROSS_SURFACE_BRIDGE_STATE_PATH, 'utf8')); }
    catch (_) { return { bridges: {} }; }
  }
  function writeCrossSurfaceBridgeState(state) {
    try { writeJsonStateAtomic(CROSS_SURFACE_BRIDGE_STATE_PATH, state); } catch (_) {}
  }
  function crossSurfaceHash(text) {
    const t = compactContextText(text, 50000);
    if (!t) return '';
    return crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
  }
  function buildCrossSurfaceSourceSummary(conversationId, sourceSurface, opts = {}) {
    if (sourceSurface === 'terminal') {
      return buildTerminalContextForInAppSession(conversationId, {
        terminalCount: opts.count || relayMsgCount(),
        terminalTotalMax: opts.totalMax || relayTotalMaxChars(),
        terminalHandoffMax: opts.handoffMax || 12000,
      });
    }
    return buildTalkConversationSummary(conversationId, {
      count: opts.count || relayMsgCount(),
      totalMax: opts.totalMax || relayTotalMaxChars(),
      currentPrompt: opts.currentPrompt || '',
      excludeTerminalTurns: true,
    });
  }
  function crossSurfaceBridgePlan(conversationId, targetSurface, sessionId, opts = {}) {
    const cid = String(conversationId || '').trim();
    const target = targetSurface === 'terminal' ? 'terminal' : 'agent';
    const source = target === 'terminal' ? 'talk' : 'terminal';
    if (!cid) return { text: '', hash: '', key: '' };
    const summary = compactContextText(buildCrossSurfaceSourceSummary(cid, source, opts), opts.max || relayTotalMaxChars());
    const hash = crossSurfaceHash(summary);
    if (!summary || !hash) return { text: '', hash: '', key: '' };
    const sid = String(sessionId || '').trim() || 'no-session';
    const key = `${cid}:${target}:${sid}:${source}`;
    const state = readCrossSurfaceBridgeState();
    const knownHash = state.bridges?.[key]?.hash || '';
    if (knownHash === hash && !opts.force) return { text: '', hash, key, source, target, alreadyInjected: true };
    const sourceLabel = source === 'terminal' ? 'Terminal Claude Code' : 'Talk / -p';
    const targetLabel = target === 'terminal' ? 'Terminal Claude Code' : 'Claude -p';
    const text = [
      `\n\n【跨模式上下文更新｜${sourceLabel} → ${targetLabel}】`,
      `conversation_id: ${cid}`,
      `bridge_hash: ${hash}`,
      '下面只包含另一种模式中新出现/更新后的最近对话摘要。请吸收它，把两边当作同一个连续对话；不要复述摘要，不要说“收到”。如果与你当前 session 的旧上下文冲突，以这份更新为准。',
      summary,
    ].join('\n');
    return { text, hash, key, source, target, alreadyInjected: false };
  }
  function markCrossSurfaceBridgeInjected(plan, via = 'runtime') {
    if (!plan?.key || !plan?.hash) return;
    const state = readCrossSurfaceBridgeState();
    state.bridges = state.bridges || {};
    state.bridges[plan.key] = {
      hash: plan.hash,
      source: plan.source || '',
      target: plan.target || '',
      via,
      injected_at: new Date().toISOString(),
    };
    writeCrossSurfaceBridgeState(state);
  }
  function handoffBlock(ctx, meta = {}) {
    const t = compactContextText(ctx, 8000);
    if (!t) return '';
    const lines = [];
    if (meta.conversation_id) lines.push(`conversation_id: ${String(meta.conversation_id).slice(0, 120)}`);
    if (meta.previous_session_id) lines.push(`previous_session_id: ${String(meta.previous_session_id).slice(0, 80)}`);
    return `\n\n【同一前端对话的接力上下文】\n${lines.length ? lines.join('\n') + '\n\n' : ''}下面是最近对话/交接摘要。请吸收它，不要复述；下一条回复直接像连续对话一样自然接上。\n${t}`;
  }
  function debugHashText(value) {
    const text = String(value || '');
    if (!text) return '';
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
  function resolveCharacterPrompt(characterPrompt) {
    return String(characterPrompt || '').trim();
  }
  function buildSessionBootstrapHash(systemPrompt, ct = {}, meta = {}) {
    return debugHashText([
      normalizeFrontendProfileText(systemPrompt || ''),
      frontendStickerContextText(systemPrompt || ''),
      resolveCharacterPrompt(meta.characterPrompt),
      compactContextText(ct?.persona || '', 12000),
    ].join('\n\n--- rifugio-bootstrap ---\n\n'));
  }
  function buildTerminalFrontendProfileHash(systemPrompt, characterPrompt = '') {
    const profile = normalizeFrontendProfileText(systemPrompt || '');
    const dynamic = frontendDynamicContextText(systemPrompt || '');
    const parts = [];
    if (profile) parts.push(profile);
    if (dynamic) parts.push(`dynamic_context:\n${dynamic}`);
    const character = resolveCharacterPrompt(characterPrompt);
    if (character) parts.push(`character_prompt:\n${character}`);
    return debugHashText(parts.join('\n\n--- rifugio-terminal-profile ---\n\n'));
  }
  // 核心资料 hash（2026-07-02）：只含 profile 各字段 + character_prompt，**不含**动态上下文
  // （表情包库存数/戳一戳/主动电话开关这些每天变好几次的行）。终端“要不要重贴完整资料”只看它。
  function buildTerminalProfileCoreHash(systemPrompt, characterPrompt = '') {
    const profile = normalizeFrontendProfileText(systemPrompt || '');
    const parts = [];
    if (profile) parts.push(profile);
    const character = resolveCharacterPrompt(characterPrompt);
    if (character) parts.push(`character_prompt:\n${character}`);
    return debugHashText(parts.join('\n\n--- rifugio-terminal-profile-core ---\n\n'));
  }
  function sessionHasBootstrapHash(conversationId, sessionId, bootstrapHash) {
    const hash = String(bootstrapHash || '').trim();
    if (!hash || !sessionId) return false;
    try {
      const { session } = getProfileRecord({ conversation_id: conversationId, session_id: sessionId });
      return String(session?.bootstrap_hash || '') === hash;
    } catch (_) {
      return false;
    }
  }
  function getSessionBootstrapHash(conversationId, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return '';
    try {
      const { session } = getProfileRecord({ conversation_id: conversationId, session_id: sid });
      return String(session?.bootstrap_hash || '').trim();
    } catch (_) {
      return '';
    }
  }
  function markSessionBootstrapInjected(meta = {}, bootstrapHash, via = 'append_system_prompt') {
    const hash = String(bootstrapHash || '').trim();
    const sid = String(meta.session_id || '').trim();
    if (!hash || !sid) return;
    const { state, key, root } = getProfileRecord(meta);
    const now = new Date().toISOString();
    const nextRoot = {
      ...root,
      last_bootstrap_hash: hash,
      last_bootstrap_at: now,
      last_bootstrap_via: via,
      sessions: { ...(root.sessions || {}) },
    };
    nextRoot.sessions[sid] = {
      ...(nextRoot.sessions[sid] || {}),
      bootstrap_hash: hash,
      bootstrap_at: now,
      bootstrap_via: via,
    };
    state.conversations[key] = nextRoot;
    writeProfileState(state);
  }
  function forceFreshRouteForBootstrap(conversationId, fallbackSessionId, opts = {}) {
    const next = planClaudeSessionRoute(conversationId, fallbackSessionId, {
      ...opts,
      forceNewSession: true,
    });
    next.bootstrapRefresh = true;
    next.relayReason = 'bootstrap_hash_missing_or_changed';
    if (next.previousSid) {
      next.relaySummary = buildAutoSessionRelaySummary(next.conversationId, {
        previousSessionId: next.previousSid,
        reason: next.relayReason,
        threshold: next.threshold,
        currentPrompt: opts.currentPrompt || '',
      });
    }
    return next;
  }
  function logAppendPromptDebug(route, ctx = {}) {
    const args = Array.isArray(ctx.args) ? ctx.args : [];
    const append = String(ctx.initialSystemPromptText || '');
    const systemPrompt = String(ctx.system_prompt || '');
    const characterPrompt = String(ctx.character_prompt || '').trim();
    const appendArgIndex = args.indexOf('--append-system-prompt');
    const resumeArgIndex = args.indexOf('--resume');
    const sessionIdArgIndex = args.indexOf('--session-id');
    const appendArgValue = appendArgIndex >= 0 ? String(args[appendArgIndex + 1] || '') : '';
    const characterProbe = characterPrompt.slice(0, 80);
    const payload = {
      route,
      conversationId: String(ctx.conversationId || '').slice(0, 80),
      shouldResume: Boolean(ctx.shouldResume),
      shouldStartNew: Boolean(ctx.routePlan?.shouldStartNew),
      relayReason: String(ctx.routePlan?.relayReason || ''),
      sid: String(ctx.sid || '').slice(0, 80),
      previousSid: String(ctx.previousSid || '').slice(0, 80),
      forceNewSession: Boolean(ctx.force_new_session === true || ctx.force_new_session === 'true' || ctx.force_new_session === 1 || ctx.force_new_session === '1'),
      systemPromptChars: systemPrompt.length,
      systemPromptHash: debugHashText(systemPrompt),
      characterPromptChars: characterPrompt.length,
      characterPromptHash: debugHashText(characterPrompt),
      appendChars: append.length,
      appendHash: debugHashText(append),
      sessionBootstrapHash: String(ctx.sessionBootstrapHash || ''),
      bootstrapKnown: Boolean(ctx.sessionBootstrapHash && ctx.sid && sessionHasBootstrapHash(ctx.conversationId, ctx.sid, ctx.sessionBootstrapHash)),
      bootstrapRefreshed: Boolean(ctx.routePlan?.bootstrapRefresh),
      appendArgIndex,
      appendArgChars: appendArgValue.length,
      appendArgHash: debugHashText(appendArgValue),
      appendArgMatchesInitial: appendArgValue === append,
      resumeArgIndex,
      sessionIdArgIndex,
      argCount: args.length,
      profileMode: ctx.profileMode || '',
      profileReason: ctx.initialProfilePlan?.reason || '',
      profileChars: String(ctx.initialProfilePlan?.text || '').length,
      dynamicMode: ctx.dynamicMode || '',
      dynamicReason: ctx.initialDynamicPlan?.reason || '',
      dynamicChars: String(ctx.initialDynamicPlan?.text || '').length,
      bootstrapChars: String(ctx.initialBootstrapContext || '').length,
      hasProfileBlock: append.includes(FRONTEND_PROFILE_MARKER) || append.includes(FRONTEND_PROFILE_UPDATE_MARKER),
      hasDynamicContextBlock: append.includes(FRONTEND_DYNAMIC_CONTEXT_MARKER) || append.includes(FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER),
      hasChatPersona: false,
      hasCharacterPrompt: Boolean(characterProbe && append.includes(characterProbe)),
      hasStickerList: append.includes('个 AI 专属表情包库存'),
      hasMemory: append.includes('Rifugio System Auto-Breath Hook'),
      hasHandoff: append.includes('【同一前端对话的接力上下文】'),
      systemHasClaudeNotes: systemPrompt.includes('用户填写的 Claude 设定'),
      systemHasStickerList: systemPrompt.includes('个 AI 专属表情包库存'),
      attempt: Number(ctx.attempt || 0) || 0,
    };
    console.log('[append-debug]', JSON.stringify(payload));
  }
  function logTerminalBootstrapDebug(route, ctx = {}) {
    const bootstrap = String(ctx.bootstrap || '');
    const systemPrompt = String(ctx.system_prompt || '');
    const characterPrompt = String(ctx.character_prompt || '').trim();
    const characterProbe = characterPrompt.slice(0, 80);
    const payload = {
      route,
      conversationId: String(ctx.conversationId || '').slice(0, 80),
      sessionName: String(ctx.sessionName || '').slice(0, 120),
      logicalSession: String(ctx.logicalSession || '').slice(0, 120),
      needBootstrap: Boolean(ctx.needBootstrap),
      dynamicUpdateOnly: Boolean(ctx.dynamicUpdateOnly),
      relayReason: String(ctx.relayReason || ''),
      systemPromptChars: systemPrompt.length,
      systemPromptHash: debugHashText(systemPrompt),
      characterPromptChars: characterPrompt.length,
      characterPromptHash: debugHashText(characterPrompt),
      bootstrapChars: bootstrap.length,
      bootstrapHash: debugHashText(bootstrap),
      profileReason: ctx.terminalProfilePlan?.reason || '',
      profileChars: String(ctx.terminalProfilePlan?.text || '').length,
      hasProfileBlock: bootstrap.includes(FRONTEND_PROFILE_MARKER) || bootstrap.includes(FRONTEND_PROFILE_UPDATE_MARKER),
      hasChatPersona: false,
      hasCharacterPrompt: Boolean(characterProbe && bootstrap.includes(characterProbe)),
      hasStickerList: bootstrap.includes('个 AI 专属表情包库存'),
      hasMemory: bootstrap.includes('Rifugio System Auto-Breath Hook'),
      hasTalkRecent: bootstrap.includes('【TalkApp 最近 10 轮】'),
      systemHasClaudeNotes: systemPrompt.includes('用户填写的 Claude 设定'),
      systemHasStickerList: systemPrompt.includes('个 AI 专属表情包库存'),
    };
    console.log('[terminal-bootstrap-debug]', JSON.stringify(payload));
  }
  function buildInitialSystemPrompt(systemPrompt, ct, bootstrapContext, meta = {}) {
    // 顺序很重要：前端资料/备注先进入系统提示；内置人格注入已取消。
    const profilePlan = meta.profilePlan || profileInjectionPlan(systemPrompt, meta);
    const dynamicPlan = meta.dynamicPlan || frontendDynamicContextPlan(systemPrompt, meta);
    const characterPrompt = resolveCharacterPrompt(meta.characterPrompt);
    return [
      buildMemoryContext(),
      profilePlan.inject ? profileBlock(systemPrompt) : '',
      dynamicPlan.inject ? frontendDynamicContextBlock(systemPrompt) : '',
      characterPrompt,
      defaultPersona,
      ct?.persona || '',
      handoffBlock(bootstrapContext, meta),
    ].filter(Boolean).join('\n');
  }

  return {
    writeJsonStateAtomic,
    normalizeFrontendProfileText,
    frontendDynamicContextText,
    frontendStickerContextText,
    frontendDynamicContextHash,
    profileInjectionPlan,
    frontendDynamicContextPlan,
    buildRuntimeContextPayload,
    attachRuntimeContextToPrompt,
    profileBlock,
    frontendDynamicContextBlock,
    assistantGuidanceBlock,
    buildTerminalProfileUpdateBootstrap,
    buildTerminalDynamicUpdateBootstrap,
    crossSurfaceBridgePlan,
    markCrossSurfaceBridgeInjected,
    debugHashText,
    resolveCharacterPrompt,
    buildSessionBootstrapHash,
    buildTerminalFrontendProfileHash,
    buildTerminalProfileCoreHash,
    sessionHasBootstrapHash,
    getSessionBootstrapHash,
    markProfileInjected,
    markFrontendDynamicContextInjected,
    markSessionBootstrapInjected,
    getProfileRecord,
    forceFreshRouteForBootstrap,
    logAppendPromptDebug,
    logTerminalBootstrapDebug,
    buildInitialSystemPrompt,
    FRONTEND_PROFILE_MARKER,
    FRONTEND_PROFILE_UPDATE_MARKER,
    FRONTEND_PROFILE_EVENT_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER,
  };
}

module.exports = { createClaudeProfileBootstrap };

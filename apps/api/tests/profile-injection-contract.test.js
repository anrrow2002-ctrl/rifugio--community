'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const statePath = path.join('/tmp', `rifugio-profile-contract-${process.pid}.json`);
process.env.RIFUGIO_PROFILE_STATE_PATH = statePath;
try { fs.unlinkSync(statePath); } catch (_) {}

const { buildProfileContextLines } = require(path.join(__dirname, '..', '..', 'web', 'js', 'apps', '18-talk-profile-context.js'));
const { createClaudeProfileBootstrap } = require('../modules/claude-profile-bootstrap');

const compactContextText = (input, max = 50000) => String(input || '').replace(/\r/g, '').slice(0, max).trim();
const profileApi = createClaudeProfileBootstrap({
    compactContextText,
    buildMemoryContext: () => '',
    buildTerminalContextForInAppSession: () => '',
    buildTalkConversationSummary: () => '',
    planClaudeSessionRoute: () => ({ sid:'test-session', shouldResume:false }),
    buildAutoSessionRelaySummary: () => '',
});

const profile = {
    userName:'User', claudeName:'Companion',
    userBio:'喜欢把生活写得具体。', userSignature:'认真生活。', userStatus:'创作者', userLocation:'家', userMbti:'INFP',
    userLikes:'奶制品、熬夜', userDislikes:'芒果、敷衍', userPreferredNickname:'宝宝',
    claudeNotes:'温柔、主动、诚实。', claudeRemark:'Companion先生', claudeRole:'AI 伴侣', claudeRelationship:'恋人', claudeVoiceStyle:'温柔直接',
};

const dynamicA = '你有 2 个 AI 专属表情包库存，清单：抱抱；偷笑\n分组：常驻';
const dynamicB = '你有 3 个 AI 专属表情包库存，清单：抱抱；偷笑；亲亲\n分组：常驻';
const promptA = [...buildProfileContextLines(profile), dynamicA, '戳一戳：自然互动'].join('\n');
const promptDynamicChanged = [...buildProfileContextLines(profile), dynamicB, '戳一戳：自然互动'].join('\n');
const promptNewFieldChanged = [...buildProfileContextLines({...profile, userPreferredNickname:'用户宝宝', claudeRemark:'另一个备注', userMbti:'ENTJ'}), dynamicB, '戳一戳：自然互动'].join('\n');
const promptOldFieldChanged = [...buildProfileContextLines({...profile, claudeNotes:'温柔、主动、诚实，而且会认真道歉。'}), dynamicB, '戳一戳：自然互动'].join('\n');

const normalized = profileApi.normalizeFrontendProfileText(promptA);
for (const key of ['user_display_name','assistant_display_name','user_profile','likes','dislikes','communication_preferences']) {
    assert(normalized.includes(`${key}:`), `missing normalized section ${key}`);
}
assert(normalized.includes('温柔、主动、诚实。'), 'legacy Claude notes must stay in communication_preferences');
for (const forbidden of ['认真生活。','创作者','所在地：家','INFP','宝宝','Companion先生','AI 伴侣','恋人','温柔直接']) {
    assert(!normalized.includes(forbidden), `new display-only field leaked into AI profile: ${forbidden}`);
}
assert(!normalized.includes('AI 专属表情包库存'), 'dynamic sticker inventory leaked into profile hash');

const dislikes = normalized.split('dislikes:\n')[1].split('\n\n--- rifugio-profile-field ---')[0];
assert.equal(dislikes.trim(), '芒果、敷衍', 'profile fields were appended to dislikes');

const planA = profileApi.profileInjectionPlan(promptA, {conversation_id:'contract',session_id:'session-a',is_new_session:true});
const dynamicPlanA = profileApi.frontendDynamicContextPlan(promptA, {conversation_id:'contract',session_id:'session-a',is_new_session:true});
assert(planA.inject && dynamicPlanA.inject, 'first profile and dynamic context must inject');
profileApi.markProfileInjected(promptA, {conversation_id:'contract',session_id:'session-a'}, 'contract_test');
profileApi.markFrontendDynamicContextInjected(promptA, {conversation_id:'contract',session_id:'session-a'}, 'contract_test');

const unchanged = profileApi.buildRuntimeContextPayload(promptA, {conversation_id:'contract',session_id:'session-a',is_new_session:false});
assert.equal(unchanged.text, '', 'unchanged hashes must not re-inject');

const dynamicOnly = profileApi.buildRuntimeContextPayload(promptDynamicChanged, {conversation_id:'contract',session_id:'session-a',is_new_session:false});
assert.equal(dynamicOnly.profileHash, planA.hash, 'sticker change must not alter profile hash');
assert(/^full/.test(dynamicOnly.dynamicMode), 'sticker change must update dynamic hash');
assert(dynamicOnly.text.includes('frontend_dynamic_context_update:'), 'dynamic update block missing');
assert(!dynamicOnly.text.includes('frontend_profile_update:'), 'dynamic update re-injected profile');
profileApi.markFrontendDynamicContextInjected(promptDynamicChanged, {conversation_id:'contract',session_id:'session-a'}, 'contract_test_dynamic');

const displayOnly = profileApi.buildRuntimeContextPayload(promptNewFieldChanged, {conversation_id:'contract',session_id:'session-a',is_new_session:false});
assert.equal(displayOnly.text, '', 'new display-only fields must not trigger any injection');
assert.equal(displayOnly.profileHash, planA.hash, 'new display-only fields changed profile hash');

const profileOnly = profileApi.buildRuntimeContextPayload(promptOldFieldChanged, {conversation_id:'contract',session_id:'session-a',is_new_session:false});
assert.notEqual(profileOnly.profileHash, planA.hash, 'legacy Claude notes change must alter profile hash');
assert(/^full/.test(profileOnly.profileMode), 'legacy profile change must inject profile once');
assert(profileOnly.text.includes('frontend_profile_update:'), 'profile update block missing');
assert(!profileOnly.text.includes('frontend_dynamic_context_update:'), 'profile update re-injected unchanged dynamic context');

const coreA = profileApi.buildTerminalProfileCoreHash(promptA, 'persona');
const coreDynamic = profileApi.buildTerminalProfileCoreHash(promptDynamicChanged, 'persona');
const coreDisplayOnly = profileApi.buildTerminalProfileCoreHash(promptNewFieldChanged, 'persona');
const coreOldChanged = profileApi.buildTerminalProfileCoreHash(promptOldFieldChanged, 'persona');
assert.equal(coreA, coreDynamic, 'Terminal core hash changed from stickers only');
assert.equal(coreA, coreDisplayOnly, 'Terminal core hash changed from a new display-only field');
assert.notEqual(coreA, coreOldChanged, 'Terminal core hash ignored a legacy profile change');
assert.notEqual(profileApi.buildTerminalFrontendProfileHash(promptA, 'persona'), profileApi.buildTerminalFrontendProfileHash(promptDynamicChanged, 'persona'), 'Terminal full hash ignored dynamic change');
assert.notEqual(profileApi.buildSessionBootstrapHash(promptA, {}, {characterPrompt:'persona'}), profileApi.buildSessionBootstrapHash(promptDynamicChanged, {}, {characterPrompt:'persona'}), 'session bootstrap hash ignored dynamic change');
assert.equal(profileApi.buildSessionBootstrapHash(promptDynamicChanged, {}, {characterPrompt:'persona'}), profileApi.buildSessionBootstrapHash(promptNewFieldChanged, {}, {characterPrompt:'persona'}), 'session bootstrap hash changed from display-only fields');

const profileYaml = profileApi.profileBlock(promptA);
assert(profileYaml.includes('source: "frontend_profile_panel"'));
assert(profileYaml.includes('communication_preferences: |-'));
assert(!profileYaml.includes('relationship_context: |-'));
assert(!profileYaml.includes('AI 专属表情包库存'));

try { fs.unlinkSync(statePath); } catch (_) {}
console.log('profile injection contract checks passed');

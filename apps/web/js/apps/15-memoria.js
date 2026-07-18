// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useMemoria = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            // === Memoria · Bucket System ==========================================

            // -- State --
            const bucketStats   = reactive({ total:0, active:0, quiet:0, digested:0, feel:0, unresolved:0, resolved:0, pinned:0, domains:[], emotions:[], importance:{I:0,II:0,III:0}, monthly:[] });
            const bucketLoading = ref(false);
            const allBuckets    = ref([]);
            const feelBuckets   = ref([]);
            const editingBucket = ref(null);
            const editContent   = ref('');
            const editSaving    = ref(false);
            const feelFilter    = ref('');
            const dreamLoading  = ref(false);
            const dreamMsg      = ref('');
            const dreamSuggestions = ref({ quiet: [], digested: [], archived: [] });
            const showFeelForm  = ref(false);
            const manualFeel    = reactive({ name:'', content:'', tags:'', importance:8, source_ids:'' });

            const splitCsv = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
            const resetManualFeel = () => Object.assign(manualFeel, { name:'', content:'', tags:'', importance:8, source_ids:'' });
            const bucketSourceOfFeel = (b) => b?.metadata?.dream?.source_of_feel === true;
            const bucketDreamReviewed = (b) => {
                const d = b?.metadata?.dream || {};
                return d.source_of_feel === true || d.skip_dream === true || d.reviewed === true || d.status === 'reviewed_no_feel';
            };
            const bucketLinkedFeelCount = (b) => Array.isArray(b?.metadata?.dream?.linked_feel_ids) ? b.metadata.dream.linked_feel_ids.length : 0;
            const bucketDreamTitle = (b) => {
                const n = bucketLinkedFeelCount(b);
                if (bucketSourceOfFeel(b)) return n ? `Dream 已沉淀为 feel · 关联 feel：${n} 条` : 'Dream 已沉淀为 feel';
                return 'Dream 已看过，没有生成 feel';
            };

            const openEditBucket = (b) => {
                editingBucket.value = b;
                // 只显示 ---RIFUGIO--- 分隔线以上的用户可读内容
                editContent.value = (b.content || '').split('\n---RIFUGIO---')[0].trim();
            };

            const saveEditBucket = async () => {
                if (!editingBucket.value) return;
                editSaving.value = true;
                try {
                    // 把用户编辑的内容拼回（保留原有的---RIFUGIO---摘要部分）
                    const original = editingBucket.value.content || '';
                    const riSep = original.indexOf('\n---RIFUGIO---');
                    const tail = riSep >= 0 ? original.slice(riSep) : '';
                    const newContent = editContent.value.trim() + tail;

                    const res = await fetch(`/api/buckets/${editingBucket.value.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: newContent })
                    });
                    const j = await res.json();
                    if (j.ok) {
                        // 同步更新本地列表
                        const update = (arr) => {
                            const idx = arr.findIndex(x => x.id === editingBucket.value.id);
                            if (idx >= 0) arr[idx] = { ...arr[idx], content: newContent };
                        };
                        update(allBuckets.value);
                        update(surfacedBuckets.value);
                        editingBucket.value = null;
                    }
                } catch(e) { console.error(e); }
                editSaving.value = false;
            };
            const surfacedBuckets = ref([]);
            const expandedBuckets = ref({});
            const bucketFilter     = ref('');
            const bucketTypeFilter = ref('');

            const bucketStatCards = computed(() => [
                { label: '记忆总数', val: bucketStats.total || 0 },
                { label: '钉选条数', val: bucketStats.pinned || 0 },
                { label: '持续关注', val: bucketStats.active ?? bucketStats.unresolved ?? 0 },
                { label: '在一起', val: `${daysTogether.value}天` },
            ]);

            const bucketStateCards = computed(() => [
                { label: '已沉底', val: bucketStats.quiet ?? 0 },
                { label: '已消化', val: bucketStats.digested ?? 0 },
                { label: 'Feel', val: bucketStats.feel ?? 0 },
                { label: '已 Dream', val: bucketStats.dream_reviewed ?? bucketStats.dreamReviewed ?? bucketStats.source_of_feel ?? bucketStats.sourceOfFeel ?? 0 },
            ]);

            const bucketStatusLabel = (b) => {
                if (b.bucket_type === 'feel' || b.status === 'feel') return '沉淀感受';
                if (b.digested || b.status === 'digested') return '已消化';
                if (b.resolved || b.status === 'quiet') return '已沉底';
                return '持续关注';
            };

            const filteredBuckets = computed(() => {
                let list = allBuckets.value;
                if (bucketTypeFilter.value === 'pinned') list = list.filter(b => b.pinned);
                else if (bucketTypeFilter.value === 'active') list = list.filter(b => (b.status || bucketStatusLabel(b)) === 'active' || (!b.resolved && !b.digested));
                else if (bucketTypeFilter.value === 'quiet') list = list.filter(b => b.status === 'quiet' || (b.resolved && !b.digested));
                else if (bucketTypeFilter.value === 'digested') list = list.filter(b => b.status === 'digested' || b.digested);
                if (bucketFilter.value) {
                    const q = bucketFilter.value.toLowerCase();
                    list = list.filter(b =>
                        (b.name||'').toLowerCase().includes(q) ||
                        (b.content||'').toLowerCase().includes(q) ||
                        (b.domain||[]).some(d => d.includes(q)) ||
                        (b.tags||[]).some(t => t.includes(q))
                    );
                }
                return list;
            });

            const filteredFeelBuckets = computed(() => {
                let list = feelBuckets.value;
                if (feelFilter.value) {
                    const q = feelFilter.value.toLowerCase();
                    list = list.filter(b =>
                        (b.name||'').toLowerCase().includes(q) ||
                        (b.content||'').toLowerCase().includes(q) ||
                        (b.tags||[]).some(t => t.toLowerCase().includes(q))
                    );
                }
                return list;
            });

            const loadBucketStats = async () => {
                bucketLoading.value = true;
                try {
                    const ts = Date.now();
                    const [statsRes, breathRes, listRes, feelRes, embedRes] = await Promise.all([
                        fetch(`/api/buckets/stats?t=${ts}`, { cache: 'no-store' }),
                        fetch(`/api/buckets/breath?limit=15&t=${ts}`, { cache: 'no-store' }),
                        fetch(`/api/buckets?t=${ts}`, { cache: 'no-store' }),
                        fetch(`/api/buckets/feel?limit=50&t=${ts}`, { cache: 'no-store' }),
                        fetch(`/api/embed/status?t=${ts}`, { cache: 'no-store' }),
                    ]);
                    if (statsRes.ok) {
                        const j = await statsRes.json();
                        if (j.ok) Object.assign(bucketStats, j.data);
                    }
                    if (breathRes.ok) {
                        const j = await breathRes.json();
                        if (j.ok) surfacedBuckets.value = j.data;
                    }
                    if (listRes.ok) {
                        const j = await listRes.json();
                        if (j.ok) allBuckets.value = j.data;
                    }
                    if (feelRes.ok) {
                        const j = await feelRes.json();
                        if (j.ok) feelBuckets.value = j.data;
                    }
                    if (embedRes.ok) {
                        const j = await embedRes.json();
                        if (j.ok) embedStatus.value = j.data;
                    }
                } catch(e) { dreamMsg.value = '加载失败：' + e.message; }
                bucketLoading.value = false;
            };

            const loadFeelBuckets = async () => {
                try {
                    const res = await fetch('/api/buckets/feel?limit=50');
                    const j = await res.json();
                    if (j.ok) feelBuckets.value = j.data;
                    else dreamMsg.value = j.error || '读取 feel 失败';
                } catch(e) { dreamMsg.value = e.message; }
            };

            const saveManualFeel = async () => {
                if (!manualFeel.content.trim()) return alert('请填写 Feel 内容');
                try {
                    const res = await fetch('/api/buckets/hold', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            feel: true,
                            bucket_type: 'feel',
                            name: manualFeel.name || '主观沉淀',
                            content: manualFeel.content,
                            tags: splitCsv(manualFeel.tags),
                            domain: ['feel'],
                            importance: manualFeel.importance || 8,
                            source_ids: splitCsv(manualFeel.source_ids),
                        })
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '保存 Feel 失败');
                    resetManualFeel();
                    showFeelForm.value = false;
                    await loadFeelBuckets();
                    await loadBucketStats();
                } catch(e) {
                    alert(e.message);
                }
            };

            const renameBucket = async (b) => {
                const newName = prompt('记忆名称：', b.name);
                if (!newName || newName === b.name) return;
                const res = await fetch('/api/buckets/' + b.id, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: newName })
                });
                const j = await res.json();
                if (j.ok) b.name = newName;
                else alert(j.error || '改名失败');
            };
            const resolveBucket = async (id) => {
                await fetch(`/api/buckets/${id}/quiet`, { method: 'POST' });
                surfacedBuckets.value = surfacedBuckets.value.filter(b => b.id !== id);
                await loadBucketStats();
            };

            const setBucketStatus = async (b, status) => {
                const endpoint = status === 'active' ? 'activate' : status === 'digested' ? 'digest' : 'quiet';
                try {
                    const res = await fetch(`/api/buckets/${b.id}/${endpoint}`, { method: 'POST' });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '状态更新失败');
                    Object.assign(b, j.data);
                    surfacedBuckets.value = surfacedBuckets.value.filter(x => x.id !== b.id || j.data.status === 'active');
                    await loadBucketStats();
                } catch(e) {
                    alert(e.message);
                }
            };

            const hasDreamSuggestions = computed(() =>
                dreamSuggestions.value.quiet.length ||
                dreamSuggestions.value.digested.length ||
                dreamSuggestions.value.archived.length
            );
            const bucketNameById = (id) => {
                const b = allBuckets.value.find(x => x.id === id) || surfacedBuckets.value.find(x => x.id === id);
                return b?.name || id;
            };
            const clearDreamSuggestions = () => {
                dreamSuggestions.value = { quiet: [], digested: [], archived: [] };
            };
            const dismissDreamSuggestion = (kind, id) => {
                dreamSuggestions.value[kind] = dreamSuggestions.value[kind].filter(s => s.id !== id);
            };
            const confirmDreamSuggestion = async (kind, suggestion) => {
                const endpoint = kind === 'quiet' ? 'quiet' : kind === 'digested' ? 'digest' : 'archive';
                try {
                    const res = await fetch(`/api/buckets/${suggestion.id}/${endpoint}`, { method: 'POST' });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '应用建议失败');
                    dismissDreamSuggestion(kind, suggestion.id);
                    await loadBucketStats();
                } catch(e) {
                    alert(e.message);
                }
            };

            const runDream = async () => {
                dreamLoading.value = true;
                dreamMsg.value = '';
                clearDreamSuggestions();
                const body = { limit: Number(window.dreamLimit || 5) || 5, apply_decisions: false, include_new: true };
                const dreamUrl = '/api/buckets/dream';
                console.debug('[dream] request', dreamUrl, body);
                try {
                    const res = await fetch(dreamUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        cache: 'no-store'
                    });
                    const text = await res.text();
                    let j = null;
                    try { j = text ? JSON.parse(text) : {}; } catch(_) {}
                    console.debug('[dream] response', j || text);
                    if (!res.ok || j?.ok === false) {
                        const err = j?.error || text || `HTTP ${res.status}`;
                        console.debug('[dream] failure', { url: dreamUrl, status: res.status, error: err });
                        throw new Error(err);
                    }
                    const quietN = (j?.suggested_quiet || j?.quiet || []).length;
                    const digestedN = (j?.suggested_digested || j?.digested || []).length;
                    const dreamedN = j?.dreamed_count ?? (j?.candidates || []).length ?? 0;
                    const dreamTotal = Number(j?.dream_reviewed_total);
                    const dreamAdded = Number(j?.dream_reviewed_added);
                    const successMsg = dreamedN > 0
                        ? `Dream 完成：本轮 ${dreamedN} 条，新增已 Dream ${Number.isFinite(dreamAdded) ? dreamAdded : dreamedN} 条，累计 ${Number.isFinite(dreamTotal) ? dreamTotal : '—'} 条；生成 ${j?.feels_created || 0} 条 feel，建议沉底 ${quietN} 条，建议消化 ${digestedN} 条。`
                        : 'Dream 完成：本轮没有新的候选记忆。';
                    dreamSuggestions.value = {
                        quiet: j?.suggested_quiet || [],
                        digested: j?.suggested_digested || [],
                        archived: j?.suggested_archived || [],
                    };
                    dreamMsg.value = successMsg;
                    await loadBucketStats();
                    if (Number.isFinite(dreamTotal)) {
                        bucketStats.dream_reviewed = dreamTotal;
                        bucketStats.dreamReviewed = dreamTotal;
                    }
                    await loadFeelBuckets();
                    dreamMsg.value = successMsg;
                } catch(e) {
                    dreamMsg.value = 'Dream 失败：' + e.message;
                }
                dreamLoading.value = false;
            };

            const pinBucket = async (b) => {
                await fetch(`/api/buckets/${b.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinned: !b.pinned })
                });
                b.pinned = !b.pinned;
            };

            const deleteBucket = async (id) => {
                if (!confirm('确定删除这条记忆？')) return;
                const res = await fetch(`/api/buckets/${id}`, { method: 'DELETE' });
                const j = await res.json().catch(() => ({}));
                if (!res.ok || j.ok === false) return alert(j.error || '删除失败');
                allBuckets.value = allBuckets.value.filter(b => b.id !== id);
                surfacedBuckets.value = surfacedBuckets.value.filter(b => b.id !== id);
                feelBuckets.value = feelBuckets.value.filter(b => b.id !== id);
                await loadBucketStats();
            };

            // -- Dashboard charts (reuse donut helpers from ombre section) --
            const bucketDomainDonut = computed(() => {
                const domains = bucketStats.domains || [];
                const total = domains.reduce((a,d) => a+d.count, 0) || 1;
                let angle = -90;
                return domains.map((d,i) => {
                    const sweep = (d.count/total)*360;
                    const seg = { d: donutPath(0,0,35,angle,angle+sweep-0.5), color: domainColors[i%domainColors.length] };
                    angle += sweep;
                    return seg;
                });
            });

            const bucketEmotionDonut = computed(() => {
                const emotions = bucketStats.emotions || [];
                const total = emotions.reduce((a,e) => a+e.count, 0) || 4;
                let angle = -90;
                const colors = ['#C47FC4','#7A9460','#6E94B5','#8B1A2A'];
                return emotions.map((e,i) => {
                    const cnt = e.count || 1;
                    const sweep = (cnt/total)*360;
                    const seg = { d: donutPath(0,0,35,angle,angle+sweep-0.5), color: colors[i%colors.length] };
                    angle += sweep;
                    return seg;
                });
            });

            const bucketImportanceBars = computed(() => {
                const imp = bucketStats.importance || {};
                const values = Array.from({length:10}, (_, i) => imp[i+1] || 0);
                const max = Math.max(...values, 1);
                const cols = ['#D4AF70','#C9A060','#BE9150','#B38240','#A87330',
                              '#9D6420','#C4A860','#DAB870','#E0C278','#EAD080'];
                return values.map((v, i) => ({
                    label: String(i + 1),
                    fullLabel: `重要度 ${i+1}`,
                    val: v,
                    h: Math.max(2, (v / max) * 44),
                    color: cols[i]
                }));
            });

            const bucketMonthlyLine = computed(() => {
                const monthly = bucketStats.monthly || [];
                if (!monthly.length) return { points:'', dots:[], color:domainColors[0] };
                const max = Math.max(...monthly.map(m=>m.count), 1);
                const W=80, H=55, pad=8;
                const step = monthly.length>1 ? (W-pad*2)/(monthly.length-1) : 0;
                const dots = monthly.map((m,i) => ({
                    x: pad+i*step,
                    y: H-pad-((m.count/max)*(H-pad*2)),
                    val: m.count, month: m.month,
                    label: (m.month||'').slice(5)
                }));
                return { points: dots.map(d=>`${d.x},${d.y}`).join(' '), dots, color: domainColors[0] };
            });

            // Override computed refs used by the HTML (domainDonut etc → bucket versions when in memoria tab)
            const domainDonut = computed(() => mainTab.value==='memoria' ? bucketDomainDonut.value : domainDonut_ombre.value);
            const emotionDonut = computed(() => mainTab.value==='memoria' ? bucketEmotionDonut.value : emotionDonut_ombre.value);
            const importanceBars = computed(() => mainTab.value==='memoria' ? bucketImportanceBars.value : importanceBars_ombre.value);
            const monthlyLine = computed(() => mainTab.value==='memoria' ? bucketMonthlyLine.value : monthlyLine_ombre.value);

            // -- Import --
            const DEFAULT_BUCKET_IMPORT_PROMPT_UI = `你是 Rifugio 的纯聊天记忆提取器。你的任务是从我和 AI 伴侣的日常聊天中，提取未来继续相处时真正有用的长期记忆。

规则：

1. 这是纯聊天、陪伴、关系记忆库，不是技术知识库。
2. 不要保存代码、脚本、正则、报错、插件配置、MCP配置、前端实现细节。
3. 技术内容只作为上下文理解，默认不要保存为长期 bucket。
4. 不要文学化，不要升华，不要把普通聊天总结成宏大意义。
5. 不要推断我没有明说的深层心理、人格标签或动机。
6. 只记录未来 AI 伴侣和我继续聊天时会用到的信息。
7. 优先记录：关系状态、称呼习惯、相处偏好、明确约定、重要事件、雷点边界、安慰方式、反复出现的互动模式。
8. 临时情绪可以不记；只有反复出现、会影响以后回应方式的情绪模式才记。
9. 同一主题可以合并，但不要改变原意。
10. 每条记忆必须具体、克制、可复用。
11. 没有值得长期保存的内容就返回空数组。
12. 只输出 JSON 数组，不要解释。

输出 JSON：
[
{
"name": "10字以内标题",
"summary": "50字以内摘要",
"content": "具体、克制、可复用的聊天记忆",
"domain": ["关系|偏好|约定|边界|事件|情绪模式|日常"],
"tags": ["标签1", "标签2"],
"importance": 1-10,
"valence": 0-1,
"arousal": 0-1,
"occurred_at": "YYYY-MM-DD或空",
"reason": "为什么未来聊天会用到"
}
]`;
            const importFile     = ref(null);
            const importDragging = ref(false);
            const importDryRun   = ref(false);
            const importRunning  = ref(false);
            const importProgress = ref('');
            const importResult   = ref(null);
            const importCandidates = ref([]);
            const bucketImportPrompt = ref(DEFAULT_BUCKET_IMPORT_PROMPT_UI);
            const bucketImportPromptMsg = ref('');
            const importPersonas = reactive({ user: 'User', ai: 'Companion' });
            const importReplaceRules = Vue.reactive([
              { from: 'Companion', to: '我', on: true },
              { from: '克劳德', to: '我', on: true },
            ]);
            const selectedImportCount = computed(() => importCandidates.value.filter(b => b.selected !== false).length);

            const normalizeImportCandidate = (b = {}) => ({
                selected: b.selected !== false,
                name: b.name || '未命名',
                summary: b.summary || '',
                content: b.content || '',
                domainText: Array.isArray(b.domain) ? b.domain.join(', ') : (b.domain || ''),
                tagsText: Array.isArray(b.tags) ? b.tags.join(', ') : (b.tags || ''),
                importance: b.importance ?? 5,
                valence: b.valence ?? 0.5,
                arousal: b.arousal ?? 0.3,
                occurred_at: b.occurred_at || '',
                reason: b.reason || '',
            });

            const loadBucketImportPrompt = async () => {
                try {
                    const res = await fetch('/api/settings/bucket-import-prompt');
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '读取失败');
                    bucketImportPrompt.value = j.prompt || j.default_prompt || DEFAULT_BUCKET_IMPORT_PROMPT_UI;
                } catch(e) {
                    bucketImportPrompt.value = bucketImportPrompt.value || DEFAULT_BUCKET_IMPORT_PROMPT_UI;
                    bucketImportPromptMsg.value = '已显示内置默认提示词；后端读取失败：' + e.message;
                }
            };
            const saveBucketImportPrompt = async () => {
                try {
                    const res = await fetch('/api/settings/bucket-import-prompt', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: bucketImportPrompt.value })
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '保存失败');
                    bucketImportPromptMsg.value = '已保存导入提示词';
                } catch(e) { bucketImportPromptMsg.value = e.message; }
            };
            const resetBucketImportPrompt = async () => {
                bucketImportPrompt.value = DEFAULT_BUCKET_IMPORT_PROMPT_UI;
                try {
                    const res = await fetch('/api/settings/bucket-import-prompt/reset', { method: 'POST' });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '恢复失败');
                    bucketImportPrompt.value = j.prompt || DEFAULT_BUCKET_IMPORT_PROMPT_UI;
                    bucketImportPromptMsg.value = '已恢复默认提示词';
                } catch(e) { bucketImportPromptMsg.value = '已在前端显示默认提示词；后端恢复失败：' + e.message; }
            };

            const onImportDrop = (e) => {
                importDragging.value = false;
                const f = e.dataTransfer.files[0];
                if (f) importFile.value = f;
            };
            const onImportFileSelect = (e) => {
                const f = e.target.files[0];
                if (f) importFile.value = f;
            };

            const runImport = async () => {
                if (!importFile.value) return;
                importRunning.value = true;
                importProgress.value = '读取文件…';
                importResult.value = null;
                importCandidates.value = [];
                try {
                    const text = await importFile.value.text();
                    importProgress.value = '发送 LLM…';
                    const res = await fetch('/api/buckets/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            content: text,
                            filename: importFile.value.name,
                            personas: { user: importPersonas.user, ai: importPersonas.ai },
                            dry_run: true,
                        })
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '提取失败');
                    importCandidates.value = (j.candidates || j.buckets || []).map(normalizeImportCandidate);
                    importResult.value = { ok: true, dry_run: true, count: importCandidates.value.length, errors: j.errors || [] };
                } catch(e) {
                    importResult.value = { ok: false, error: e.message };
                }
                importRunning.value = false;
                importProgress.value = '';
            };

            const confirmImport = async () => {
                if (!selectedImportCount.value) return;
                importRunning.value = true;
                importResult.value = null;
                try {
                    const activeRules = importReplaceRules.filter(r => r.on && r.from.trim());
                    const applyRules = (s) => {
                        if (!s) return s;
                        activeRules.forEach(r => { s = s.replaceAll(r.from, r.to); });
                        return s;
                    };
                    const items = importCandidates.value.map(b => ({
                        selected: b.selected !== false,
                        name: b.name,
                        summary: b.summary,
                        content: applyRules(b.content),
                        domain: splitCsv(b.domainText),
                        tags: splitCsv(b.tagsText),
                        importance: b.importance,
                        valence: b.valence,
                        arousal: b.arousal,
                        occurred_at: b.occurred_at,
                        reason: b.reason,
                    }));
                    const res = await fetch('/api/buckets/import-confirm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items, personas: { user: importPersonas.user, ai: importPersonas.ai } })
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || '写入失败');
                    importCandidates.value = [];
                    importResult.value = j;
                    await loadBucketStats();
                } catch(e) {
                    importResult.value = { ok: false, error: e.message };
                }
                importRunning.value = false;
            };

            const cancelImportPreview = () => {
                importCandidates.value = [];
                importResult.value = null;
            };

            // -- Semantic search --
            const semanticQuery = ref('');
            const searchResults = ref([]);
            const searchDone    = ref(false);

            const runSemanticSearch = async () => {
                if (!semanticQuery.value.trim()) return;
                searchDone.value = false;
                searchResults.value = [];
                try {
                    const res = await fetch(`/api/search/semantic?q=${encodeURIComponent(semanticQuery.value)}&top=10`);
                    const j = await res.json();
                    if (j.ok) searchResults.value = (j.data || []).map(x => ({ ...x, fallback: j.fallback }));
                    else searchResults.value = [{ name:'搜索失败', content:j.error || '接口失败', fallback:'error' }];
                } catch(e) { searchResults.value = [{ name:'搜索失败', content:e.message, fallback:'error' }]; }
                searchDone.value = true;
            };

            // -- Settings --
            const memSettings    = reactive({ base_url:'', api_key:'', model:'' });
            const availableModels = ref([]);
            const embedStatus    = ref(null);
            const embedBatchMsg  = ref('');
            const embedCfg = reactive({ base_url: '', api_key: '', model: '' });
            const sttCfg = reactive({
                mode: 'browser',
                provider: 'openai-compatible',
                base_url: '',
                api_key: '',
                model: '',
                language: 'zh-CN',
                status: '',
                loading: false,
                saving: false,
            });
            const browserSttSupported = computed(() => {
                try { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
                catch(_) { return false; }
            });
            const autoEmotionLoading = ref(false);
            const autoEmotionMsg = ref('');

            const loadEmbedCfg = async () => {
                try {
                    const r = await fetch('/api/settings/embedding');
                    const j = await r.json();
                    if (j.ok && j.data) { embedCfg.base_url = j.data.base_url || ''; embedCfg.api_key = j.data.api_key || ''; embedCfg.model = j.data.model || ''; }
                } catch(e) {}
            };
            const saveEmbedCfg = async () => {
                await fetch('/api/settings/embedding', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ base_url: embedCfg.base_url, api_key: embedCfg.api_key, model: embedCfg.model })
                });
                alert('✦ Embedding 配置已保存');
            };
            const applySttCfg = (data) => {
                const d = data || {};
                sttCfg.mode = d.mode === 'api' ? 'api' : 'browser';
                sttCfg.provider = d.provider || 'openai-compatible';
                sttCfg.base_url = d.base_url || '';
                sttCfg.api_key = d.api_key || '';
                sttCfg.model = d.model || '';
                sttCfg.language = d.language || 'zh-CN';
            };
            const loadSttCfg = async () => {
                sttCfg.loading = true;
                try {
                    const r = await fetch('/api/settings/stt', { credentials:'include', cache:'no-store' });
                    const j = await r.json();
                    if (!j.ok) throw new Error(j.error || '读取失败');
                    applySttCfg(j.data);
                    sttCfg.status = j.data ? '已读取语音识别设置' : '当前使用浏览器内置语音识别';
                } catch(e) {
                    sttCfg.status = '读取失败：' + (e.message || e);
                } finally {
                    sttCfg.loading = false;
                }
            };
            const saveSttCfg = async () => {
                if (sttCfg.saving) return;
                sttCfg.saving = true;
                sttCfg.status = '保存中…';
                try {
                    const r = await fetch('/api/settings/stt', {
                        method:'PUT',
                        headers:{ 'Content-Type':'application/json' },
                        credentials:'include',
                        body:JSON.stringify({
                            mode: sttCfg.mode,
                            provider: sttCfg.provider,
                            base_url: sttCfg.base_url,
                            api_key: sttCfg.api_key,
                            model: sttCfg.model,
                            language: sttCfg.language,
                        }),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                    sttCfg.status = sttCfg.mode === 'browser' ? '已保存：使用浏览器内置识别 ✓' : '已保存：使用后端 STT API ✓';
                } catch(e) {
                    sttCfg.status = '保存失败：' + (e.message || e);
                } finally {
                    sttCfg.saving = false;
                }
            };
            const dehydrateStatus = ref(null);
            const loadDehydrateStatus = async () => {
                const r = await fetch('/api/buckets/breath?top=1');
                const j = await r.json();
                if (j.ok) dehydrateStatus.value = {
                    dehydrated: j.dehydrated_count,
                    total: j.total,
                    pct: Math.round(j.dehydrated_count / j.total * 100)
                };
            };
            const dehydrateLoading = ref(false);
            const dehydrateMsg = ref('');
            const breathPreview = ref([]);

            const dedupLoading = ref(false);
            const dedupMsg = ref('');
            const runDedup = async () => {
                if (!confirm('去重会归档相似重复记忆，钉选和更重要的条目会被保留。继续吗？')) return;
                dedupLoading.value = true; dedupMsg.value = '';
                try {
                    const r = await fetch('/api/buckets/dedup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    const j = await r.json();
                    dedupMsg.value = j.ok ? ('✦ 归档 ' + (j.archived || 0) + ' 条重复记忆') : (j.error || '失败');
                    if (j.ok) await loadBucketStats();
                } catch(e) { dedupMsg.value = e.message; }
                dedupLoading.value = false;
            };
            const runDehydrate = async () => {
                dehydrateLoading.value = true; dehydrateMsg.value = '';
                try {
                    const r = await fetch('/memory-api/buckets/dehydrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    const j = await r.json();
                    dehydrateMsg.value = j.ok ? ('✦ 脱水 ' + j.updated + ' 条，剩余 ' + (j.remaining || 0)) : (j.error || '失败');
                } catch(e) { dehydrateMsg.value = e.message; }
                dehydrateLoading.value = false;
            };
            const loadBreathPreview = async () => {
                const r = await fetch('/api/buckets/breath?top=5');
                const j = await r.json();
                if (j.ok) breathPreview.value = j.surfaced || j.data || [];
            };

            const runAutoEmotion = async () => {
                autoEmotionLoading.value = true; autoEmotionMsg.value = '';
                try {
                    const r = await fetch('/memory-api/buckets/auto-emotion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    const j = await r.json();
                    autoEmotionMsg.value = j.ok ? ('✦ 已打 ' + j.updated + ' 条') : (j.error || '失败');
                } catch(e) { autoEmotionMsg.value = e.message; }
                autoEmotionLoading.value = false;
            };

            const fetchModels = async () => {
                if (!memSettings.base_url) return;
                try {
                    const res = await fetch(memSettings.base_url.replace(/\/$/,'')+'/models', {
                        headers: { 'Authorization': 'Bearer '+memSettings.api_key }
                    });
                    const j = await res.json();
                    availableModels.value = (j.data||[]).map(m=>m.id).sort();
                } catch(e) { availableModels.value = []; alert('获取失败: '+e.message); }
            };

            const saveMemSettings = async () => {
                await fetch('/api/settings/llm', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ base_url: memSettings.base_url, api_key: memSettings.api_key, model: memSettings.model })
                });
                alert('已保存 ✦');
            };

            const loadEmbedStatus = async () => {
                try {
                    const res = await fetch('/api/embed/status');
                    const j = await res.json();
                    if (j.ok) embedStatus.value = j.data;
                } catch(e) {}
            };

            const runEmbedBatch = async () => {
                embedBatchMsg.value = '处理中…';
                try {
                    const res = await fetch('/api/embed/batch', { method: 'POST' });
                    const j = await res.json();
                    embedBatchMsg.value = j.ok ? `✦ 完成 ${j.processed ?? j.done ?? 0} 条` + (j.message ? ' · ' + j.message : '') : j.error;
                } catch(e) { embedBatchMsg.value = e.message; }
            };

            // -- 我 / I（自我认知版本链，只读）--
            const selfVersions = ref([]);
            const selfExpanded = ref({});
            const selfLoading  = ref(false);
            const loadSelf = async () => {
                selfLoading.value = true;
                try {
                    const r = await fetch('/api/self?t=' + Date.now(), { cache: 'no-store' });
                    const j = await r.json();
                    if (j.ok) selfVersions.value = j.data || [];
                } catch(e) {}
                selfLoading.value = false;
            };
            // 默认最新版在最上（version 降序）
            const selfTimeline = computed(() => [...selfVersions.value].sort((a, b) => b.version - a.version));

            // 加载已保存的 LLM 配置（页面初始化时立即执行）
            const loadMemSettings = () => {
                fetch('/api/settings/llm').then(r => r.json()).then(j => {
                    if (j.ok && j.data) {
                        if (j.data.base_url) memSettings.base_url = j.data.base_url;
                        if (j.data.model)    memSettings.model    = j.data.model;
                        if (j.data.api_key)  memSettings.api_key  = j.data.api_key;
                    }
                }).catch(()=>{});
            };
            loadMemSettings();
            loadSttCfg();

            // Load on tab switch
            Vue.watch(() => mainTab.value, (tab) => {
                if (tab === 'memoria') {
                    loadBucketStats();
                    loadMemSettings();
                    loadEmbedCfg();
                    loadBucketImportPrompt();
                    if (subTabs.memoria === 'self') loadSelf();
                }
            });
            Vue.watch(() => subTabs.memoria, (tab) => {
                if (mainTab.value !== 'memoria') return;
                if (tab === 'import') loadBucketImportPrompt();
                if (tab === 'self') loadSelf();
            });
            if (mainTab.value === 'memoria') loadBucketImportPrompt();

        return { bucketStats, bucketLoading, allBuckets, feelBuckets, editingBucket, editContent, editSaving, feelFilter, dreamLoading, dreamMsg, dreamSuggestions, showFeelForm, manualFeel, splitCsv, resetManualFeel, bucketSourceOfFeel, bucketDreamReviewed, bucketLinkedFeelCount, bucketDreamTitle, openEditBucket, saveEditBucket, surfacedBuckets, expandedBuckets, bucketFilter, bucketTypeFilter, bucketStatCards, bucketStateCards, bucketStatusLabel, filteredBuckets, filteredFeelBuckets, loadBucketStats, loadFeelBuckets, saveManualFeel, renameBucket, resolveBucket, setBucketStatus, hasDreamSuggestions, bucketNameById, clearDreamSuggestions, dismissDreamSuggestion, confirmDreamSuggestion, runDream, pinBucket, deleteBucket, bucketDomainDonut, bucketEmotionDonut, bucketImportanceBars, bucketMonthlyLine, domainDonut, emotionDonut, importanceBars, monthlyLine, DEFAULT_BUCKET_IMPORT_PROMPT_UI, importFile, importDragging, importDryRun, importRunning, importProgress, importResult, importCandidates, bucketImportPrompt, bucketImportPromptMsg, importPersonas, importReplaceRules, selectedImportCount, normalizeImportCandidate, loadBucketImportPrompt, saveBucketImportPrompt, resetBucketImportPrompt, onImportDrop, onImportFileSelect, runImport, confirmImport, cancelImportPreview, semanticQuery, searchResults, searchDone, runSemanticSearch, memSettings, availableModels, embedStatus, embedBatchMsg, embedCfg, sttCfg, browserSttSupported, loadSttCfg, saveSttCfg, autoEmotionLoading, autoEmotionMsg, loadEmbedCfg, saveEmbedCfg, dehydrateStatus, loadDehydrateStatus, dehydrateLoading, dehydrateMsg, breathPreview, dedupLoading, dedupMsg, runDedup, runDehydrate, loadBreathPreview, runAutoEmotion, fetchModels, saveMemSettings, loadEmbedStatus, runEmbedBatch, loadMemSettings, selfVersions, selfExpanded, selfLoading, loadSelf, selfTimeline };
    }
};

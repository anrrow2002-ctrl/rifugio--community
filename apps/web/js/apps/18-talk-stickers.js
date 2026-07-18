// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTalkStickers = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const stickerLibrary = reactive([]);

            const aiStickerLibrary = reactive([]);

            const stickerDraft = ref('');

            const aiStickerDraft = ref('');
            try {
                const savedStickers = JSON.parse(localStorage.getItem('rifugio-stickers') || 'null');
                const defaults = [{ id:'sticker-blame', name:'都怪你', url:'https://i.postimg.cc/sDkBZG9G/IMG_9676.png' }];
                stickerLibrary.push(...(Array.isArray(savedStickers) && savedStickers.length ? savedStickers : defaults));
            } catch(_) {
                stickerLibrary.push({ id:'sticker-blame', name:'都怪你', url:'https://i.postimg.cc/sDkBZG9G/IMG_9676.png' });
            }

            const saveStickers = () => {
                try { localStorage.setItem('rifugio-stickers', JSON.stringify(stickerLibrary)); } catch(_) {}
            };

            const normalizeStickerFromServer = (s) => ({
                id:String(s.id || ('sticker-' + Date.now())),
                name:String(s.name || s.semantic || '表情包'),
                url:String(s.url || s.data_url || s.dataUrl || ''),
                dataUrl:String(s.data_url || s.dataUrl || ''),
                category:String(s.category || STICKER_DEFAULT_CAT),
                keywords:String(s.keywords || ''),
                semantic:String(s.semantic || s.name || ''),
                stolenFrom:String(s.stolen_from || s.stolenFrom || ''),
                createdBy:String(s.created_by || s.createdBy || 'ai'),
                resident:Number(s.resident || 0) === 1 ? 1 : 0,
                source:'ai',
            });

            const loadTalkStickersFromServer = async () => {
                try {
                    const r = await fetch('/api/talk/ai-stickers', { credentials:'include', cache:'no-store' });
                    if (!r.ok) return;
                    const j = await r.json();
                    if (!Array.isArray(j.stickers)) return;
                    aiStickerLibrary.splice(0, aiStickerLibrary.length, ...j.stickers.map(normalizeStickerFromServer).filter(s => s.url || s.dataUrl));
                } catch(_) {}
            };

            const persistTalkStickerToServer = async (s) => {
                if (!s || (!s.url && !s.dataUrl)) return;
                try {
                    const r = await fetch('/api/talk/ai-stickers', {
                        method:'POST',
                        credentials:'include',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({
                            id:s.id,
                            name:s.name,
                            url:s.url || '',
                            dataUrl:s.dataUrl || '',
                            category:s.category || STICKER_DEFAULT_CAT,
                            keywords:s.keywords || '',
                            semantic:s.semantic || s.name || '',
                            stolenFrom:s.stolenFrom || '',
                            createdBy:s.createdBy || 'ai',
                            resident:Number(s.resident || 0) === 1,
                        }),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok) { talk.error = j.error || '表情保存失败'; return false; }
                    const next = normalizeStickerFromServer(j.sticker || s);
                    const existing = aiStickerLibrary.find(x => x.id === next.id || (x.url || x.dataUrl) === (next.url || next.dataUrl));
                    if (existing) Object.assign(existing, { ...existing, ...next });
                    else aiStickerLibrary.unshift(next);
                    return true;
                } catch(_) { talk.error = '表情保存失败'; return false; }
            };

            const syncTalkStickersToServer = () => {
                aiStickerLibrary.slice(0, 300).forEach(s => persistTalkStickerToServer(s));
            };
            // —— 表情包分类 + 关键词联想 ——

            const STICKER_DEFAULT_CAT = '未分类';
            stickerLibrary.forEach(s => {
                if (s.category == null || s.category === '') s.category = STICKER_DEFAULT_CAT;
                if (s.keywords == null) s.keywords = '';
            });

            const stickerFilter = ref('全部');

            const stickerSearch = ref('');

            const stickerEditMode = ref(false);

            const stickerImportCategory = ref('');

            const aiStickerFilter = ref('全部');

            const aiStickerSearch = ref('');

            const aiStickerEditMode = ref(false);

            const aiStickerImportCategory = ref('AI专属');

            const stickerCategories = Vue.computed(() => {
                const set = new Set();
                stickerLibrary.forEach(s => set.add((String(s.category || '').trim()) || STICKER_DEFAULT_CAT));
                return ['全部', ...Array.from(set)];
            });

            const aiStickerCategories = Vue.computed(() => {
                const set = new Set();
                aiStickerLibrary.forEach(s => set.add((String(s.category || '').trim()) || 'AI专属'));
                return ['全部', ...Array.from(set)];
            });

            const stickerMoveCategories = Vue.computed(() => stickerCategories.value.filter(c => c !== '全部'));
            const aiStickerMoveCategories = Vue.computed(() => aiStickerCategories.value.filter(c => c !== '全部'));
            const aiStickerResidentCount = Vue.computed(() => aiStickerLibrary.filter(s => Number(s.resident || 0) === 1).length);

            const filteredStickers = Vue.computed(() => {
                const q = String(stickerSearch.value || '').trim().toLowerCase();
                const rows = stickerFilter.value === '全部'
                    ? stickerLibrary
                    : stickerLibrary.filter(s => ((String(s.category || '').trim()) || STICKER_DEFAULT_CAT) === stickerFilter.value);
                if (!q) return rows;
                return rows.filter(s => [
                    s.name,
                    s.category,
                    s.keywords,
                ].filter(Boolean).join(' ').toLowerCase().includes(q));
            });

            const filteredAiStickers = Vue.computed(() => {
                const q = String(aiStickerSearch.value || '').trim().toLowerCase();
                const rows = aiStickerFilter.value === '全部'
                    ? aiStickerLibrary
                    : aiStickerFilter.value === '常驻高频'
                        ? aiStickerLibrary.filter(s => Number(s.resident || 0) === 1)
                        : aiStickerLibrary.filter(s => ((String(s.category || '').trim()) || 'AI专属') === aiStickerFilter.value);
                if (!q) return rows;
                return rows.filter(s => [
                    s.name,
                    s.category,
                    s.keywords,
                    s.semantic,
                    s.stolenFrom,
                ].filter(Boolean).join(' ').toLowerCase().includes(q));
            });
            const toggleAiStickerResident = async (s) => {
                if (!s) return;
                const previous = Number(s.resident || 0) === 1 ? 1 : 0;
                if (!previous && aiStickerResidentCount.value >= 50) { talk.error = '常驻高频区最多 50 张'; return; }
                s.resident = previous ? 0 : 1;
                const ok = await persistTalkStickerToServer(s);
                if (!ok) s.resident = previous;
                else talk.error = '';
            };

            const moveStickerToCategory = (s, category) => {
                const next = String(category || '').trim();
                if (!s || !next) return;
                const previous = (String(s.category || '').trim()) || STICKER_DEFAULT_CAT;
                if (previous === next) return;
                if (stickerFilter.value === previous) stickerFilter.value = next;
                s.category = next;
                saveStickers();
            };

            const moveAiStickerToCategory = async (s, category) => {
                const next = String(category || '').trim();
                if (!s || !next) return;
                const previous = (String(s.category || '').trim()) || 'AI专属';
                if (previous === next) return;
                if (aiStickerFilter.value === previous) aiStickerFilter.value = next;
                s.category = next;
                await persistTalkStickerToServer(s);
            };

            // 在输入框打“短关键词”（无空格/换行、<=8 字）时联想匹配的表情包

            const stickerSuggestions = Vue.computed(() => {
                const q = String(talk.input || '').trim().toLowerCase();
                if (!q || q.length > 8 || /\s/.test(q)) return [];
                const hit = [];
                for (const s of stickerLibrary) {
                    const name = String(s.name || '').toLowerCase();
                    const kw = String(s.keywords || '').toLowerCase();
                    const cat = String(s.category || '').toLowerCase();
                    if ((name && (name.includes(q) || q.includes(name))) || (kw && kw.includes(q)) || (cat && cat !== STICKER_DEFAULT_CAT.toLowerCase() && cat.includes(q))) {
                        hit.push(s);
                        if (hit.length >= 12) break;
                    }
                }
                return hit;
            });

            const pickSuggestedSticker = (s) => {
                addStickerToComposer(s);
                Vue.nextTick(() => document.querySelector('.talk-composer textarea')?.focus?.());
            };

            const extractStickerUrl = (content) => {
                const match = String(content || '').match(imageUrlPattern);
                return match ? match[1] : '';
            };
            // 表情包现在走前端本地解析：Claude 只输出 [[sticker:关键词/名称/id]]，不要把几百个 URL 注入 prompt。

            const stickerTokenPattern = /\[\[sticker:([^\]\n]{1,80})\]\]/gi;

            const normalizeStickerKey = (x) => String(x || '').trim().toLowerCase();

            const stickerMatchesRef = (s, q) => {
                const id = normalizeStickerKey(s.id);
                const name = normalizeStickerKey(s.name);
                const semantic = normalizeStickerKey(s.semantic);
                const kw = normalizeStickerKey(s.keywords);
                const cat = normalizeStickerKey(s.category);
                if (id === q || name === q || semantic === q) return 'exact';
                if ((name && (name.includes(q) || q.includes(name))) ||
                    (semantic && (semantic.includes(q) || q.includes(semantic))) ||
                    (kw && kw.includes(q)) ||
                    (cat && cat !== STICKER_DEFAULT_CAT.toLowerCase() && cat.includes(q))) return 'fuzzy';
                return '';
            };

            const resolveStickerRef = (ref) => {
                const q = normalizeStickerKey(ref);
                if (!q) return null;
                let fallback = null;
                for (const s of aiStickerLibrary) {
                    const hit = stickerMatchesRef(s, q);
                    if (hit === 'exact') return s;
                    if (!fallback && hit) fallback = s;
                }
                if (fallback) return fallback;
                for (const s of stickerLibrary) {
                    const hit = stickerMatchesRef(s, q);
                    if (hit === 'exact') return s;
                    if (!fallback && hit) fallback = s;
                }
                return fallback;
            };

            const extractStickerRefs = (content) => {
                const refs = [];
                String(content || '').replace(stickerTokenPattern, (_, ref) => { refs.push(String(ref || '').trim()); return ''; });
                return refs;
            };

            const stripStickerTokens = (content) => String(content || '').replace(stickerTokenPattern, '').replace(/\n{3,}/g, '\n\n').trim();

            const parseStickerImportLine = (line, fallbackName, fallbackCategory) => {
                const urlMatch = String(line || '').match(/https?:\/\/\S+/i);
                if (!urlMatch) return null;
                const url = urlMatch[0].trim().replace(/[，,；;]+$/, '');
                const before = String(line || '').slice(0, urlMatch.index).replace(/[：:，,\s|]+$/, '').trim();
                const parts = before.split(/[|｜]/).map(x => x.trim()).filter(Boolean);
                const name = parts[0] || fallbackName;
                return {
                    name,
                    semantic:parts[1] || name,
                    keywords:parts.slice(2).join(','),
                    category:fallbackCategory,
                    url,
                };
            };
            // 批量导入：一行一个，支持 "名称：url" / "名称 url" / "名称|语义|关键词 url" / 或只有 url（自动起名）

            const importStickerText = () => {
                const lines = String(stickerDraft.value || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
                let added = 0;
                lines.forEach(line => {
                    const parsed = parseStickerImportLine(line, '表情' + (stickerLibrary.length + added + 1), (String(stickerImportCategory.value || '').trim()) || STICKER_DEFAULT_CAT);
                    if (!parsed) return;
                    const { name, url, category, semantic, keywords } = parsed;
                    if (!stickerLibrary.some(s => s.url === url)) {
                        stickerLibrary.push({ id:'sticker-' + Date.now() + '-' + added, name, url, category, keywords, semantic });
                        added++;
                    }
                });
                if (added) { saveStickers(); stickerDraft.value = ''; talk.error = ''; }
                else talk.error = '没解析到图片链接。一行一个，例如：开心 https://....png';
            };

            const importAiStickerText = async () => {
                const lines = String(aiStickerDraft.value || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
                let added = 0;
                for (const line of lines) {
                    const parsed = parseStickerImportLine(line, 'AI表情' + (aiStickerLibrary.length + added + 1), (String(aiStickerImportCategory.value || '').trim()) || 'AI专属');
                    if (!parsed) continue;
                    const existing = aiStickerLibrary.find(s => (s.url || s.dataUrl) === parsed.url);
                    const row = {
                        id:existing?.id || ('ai-sticker-' + Date.now() + '-' + added),
                        ...parsed,
                        dataUrl:'',
                        stolenFrom:parsed.url,
                        createdBy:'ai-library',
                    };
                    await persistTalkStickerToServer(row);
                    added++;
                }
                if (added) { aiStickerDraft.value = ''; talk.error = ''; }
                else talk.error = '没解析到 AI 表情图片链接。一行一个，例如：偷笑|想逗你开心 https://....gif';
            };

            const uploadAiStickerFiles = async (e) => {
                const files = Array.from(e.target.files || []).filter(file => file && /^image\//i.test(file.type || ''));
                if (e?.target) e.target.value = '';
                if (!files.length) return;
                let added = 0;
                const category = (String(aiStickerImportCategory.value || '').trim()) || 'AI专属';
                for (const file of files.slice(0, 24)) {
                    try {
                        const dataUrl = await imageFileToDataUrl(file);
                        const baseName = String(file.name || '').replace(/\.[^.]+$/, '').trim() || ('AI表情' + (aiStickerLibrary.length + added + 1));
                        await persistTalkStickerToServer({
                            id:'ai-sticker-upload-' + Date.now() + '-' + added,
                            name:baseName,
                            url:'',
                            dataUrl,
                            category,
                            keywords:'',
                            semantic:baseName,
                            stolenFrom:'',
                            createdBy:'ai-upload',
                        });
                        added++;
                    } catch(_) {}
                }
                talk.error = added ? '' : 'AI 表情上传失败，请换一张图片试试。';
            };

            const addStickerToComposer = (sticker) => {
                const inputBeforePick = talk.input;
                const url = sticker.url || sticker.dataUrl || '';
                addTalkAttachment(url, sticker.name, 'sticker', {
                    url,
                    semantic:sticker.semantic || sticker.name,
                    vision:!!talkSettings.stickerVisionEnabled,
                });
                talk.input = inputBeforePick;
                talk.panel = '';
                Vue.nextTick(() => {
                    const el = document.querySelector('.talk-composer textarea');
                    if (el) autoGrowTalk({ target:el });
                });
            };

            const deleteSticker = (id) => {
                const i = stickerLibrary.findIndex(s => s.id === id);
                if (i >= 0) stickerLibrary.splice(i, 1);
                saveStickers();
            };

            const deleteAiSticker = (id) => {
                const i = aiStickerLibrary.findIndex(s => s.id === id);
                if (i >= 0) aiStickerLibrary.splice(i, 1);
                fetch('/api/talk/ai-stickers/' + encodeURIComponent(id), { method:'DELETE', credentials:'include' }).catch(() => {});
            };

            return { stickerLibrary, aiStickerLibrary, stickerDraft, aiStickerDraft, saveStickers, normalizeStickerFromServer, loadTalkStickersFromServer, persistTalkStickerToServer, syncTalkStickersToServer, STICKER_DEFAULT_CAT, stickerFilter, stickerSearch, stickerEditMode, stickerImportCategory, aiStickerFilter, aiStickerSearch, aiStickerEditMode, aiStickerImportCategory, stickerCategories, stickerMoveCategories, aiStickerCategories, aiStickerMoveCategories, aiStickerResidentCount, filteredStickers, filteredAiStickers, moveStickerToCategory, moveAiStickerToCategory, toggleAiStickerResident, stickerSuggestions, pickSuggestedSticker, extractStickerUrl, stickerTokenPattern, normalizeStickerKey, stickerMatchesRef, resolveStickerRef, extractStickerRefs, stripStickerTokens, parseStickerImportLine, importStickerText, importAiStickerText, uploadAiStickerFiles, addStickerToComposer, deleteSticker, deleteAiSticker };
    }
};

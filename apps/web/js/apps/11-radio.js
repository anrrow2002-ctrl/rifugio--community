// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useRadio = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            // ============================================================
            // Radio · 搜索 / 播放器 / Claude MCP 播放指令
            // ============================================================
            const radioAudioRef = ref(null);
            const radioTabs = [
                { id:'song', label:'音乐' },
                { id:'radio', label:'直播' },
                { id:'story', label:'故事' },
                { id:'audiobook', label:'听书' },
                { id:'recent', label:'最近' },
                { id:'playlist', label:'歌单' },
            ];
            const radioProviders = [
                { id:'all', label:'综合' },
                { id:'free', label:'免费开放源' },
                { id:'itunes', label:'Apple/iTunes 试听' },
                { id:'netease', label:'网易云', login:true },
                { id:'qqmusic', label:'QQ 音乐', login:true },
                { id:'kugou', label:'酷狗', login:true },
                { id:'spotify', label:'Spotify' },
                { id:'youtube', label:'YouTube Music' },
                { id:'bilibili', label:'B 站' },
                { id:'archive', label:'Internet Archive' },
                { id:'jamendo', label:'Jamendo' },
                { id:'fma', label:'Free Music Archive' },
                { id:'librivox', label:'LibriVox' },
                { id:'podcast', label:'Podcast' },
                { id:'radio_garden', label:'Radio Garden' },
            ];
            const radioLoginProviders = radioProviders.filter(p => ['netease','qqmusic','kugou'].includes(p.id));
            const radioLoginTargets = {
                netease:'https://music.163.com/',
                qqmusic:'https://y.qq.com/',
                kugou:'https://www.kugou.com/',
            };
            const radio = reactive({
                tab:'all',
                query:'',
                loading:false,
                error:'',
                status:'',
                settingsOpen:false,
                view:'list',
                providers:['all','free','itunes','netease','archive','jamendo','fma','librivox','podcast','radio_garden'],
                results:[],
                library:[],
                recent:[],
                playlists:[],
                activePlaylistId:'',
                playlistDraft:'',
                queue:[],
                queueIndex:-1,
                queueLoop:false,
                playMode:'sequence',
                modePanelOpen:false,
                queuePanelOpen:false,
                detailToast:'',
                detailToastTimer:null,
                commandRetry:{},
                commandPollBusy:false,
                seenCommandIds:[],
                auth:{ provider:'', loading:false, message:'', qrUrl:'', loginUrl:'', pickerOpen:false },
                detail:{ item:null, loading:false, lyrics:'', summary:'' },
                sleepCustom:30,
                sleepUntil:0,
                sleepRemaining:0,
                sleepRemainingLabel:'',
                sleepPanelOpen:false,
                sleepTimer:null,
                ui:{ backgroundUrl:'', coverUrl:'', homeBgUrl:'' },
                player:{ title:'', type:'', source:'', provider:'', url:'', playing:false, loading:false, error:'', currentTime:0, duration:0, autoplayBlocked:false, commandId:'' },
            });
            try {
                const savedRadio = JSON.parse(localStorage.getItem('rifugio-radio-v1') || '{}');
                if (Array.isArray(savedRadio.recent)) radio.recent = savedRadio.recent.filter(item => item?.provider !== 'preview').slice(0, 30);
                if (Array.isArray(savedRadio.playlists)) radio.playlists = savedRadio.playlists.slice(0, 50);
                if (savedRadio.activePlaylistId) radio.activePlaylistId = String(savedRadio.activePlaylistId || '');
                if (['sequence','list-loop','single-loop','shuffle'].includes(savedRadio.playMode)) radio.playMode = savedRadio.playMode;
                if (Array.isArray(savedRadio.seenCommandIds)) radio.seenCommandIds = savedRadio.seenCommandIds.slice(-80);
                if (Array.isArray(savedRadio.providers) && savedRadio.providers.length) radio.providers = savedRadio.providers.filter(id => radioProviders.some(p => p.id === id));
                if (savedRadio.ui && typeof savedRadio.ui === 'object') radio.ui = { ...radio.ui, ...savedRadio.ui };
            } catch(_) {}
            const saveRadio = () => {
                try { localStorage.setItem('rifugio-radio-v1', JSON.stringify({
                    recent:radio.recent.slice(0,30),
                    playlists:radio.playlists.slice(0,50),
                    activePlaylistId:radio.activePlaylistId,
                    playMode:radio.playMode,
                    seenCommandIds:radio.seenCommandIds.slice(-80),
                    providers:radio.providers.slice(0,30),
                    ui:{ ...radio.ui },
                })); } catch(_) {}
            };
            const radioTypeLabel = (type) => ({ song:'歌曲', radio:'音乐直播', station:'音乐直播', podcast:'播客', story:'故事', audiobook:'有声小说' }[type] || type || '音乐');
            const radioProviderLabel = (id) => radioProviders.find(p => p.id === id)?.label || id || '联网资源';
            const toggleRadioProvider = (id) => {
                if (id === 'all') {
                    radio.providers = radio.providers.includes('all') ? radio.providers.filter(x => x !== 'all') : ['all', ...radio.providers.filter(x => x !== 'all')];
                } else {
                    const index = radio.providers.indexOf(id);
                    if (index >= 0) radio.providers.splice(index, 1);
                    else radio.providers.push(id);
                }
                if (!radio.providers.length) radio.providers.push('free');
                radio.status = `已选择 ${radio.providers.map(radioProviderLabel).join('、')}`;
                saveRadio();
            };
            const setRadioTab = (tab) => {
                radio.tab = tab;
                if (!['recent','playlist'].includes(tab) && !radio.results.length) searchRadio();
            };
            const activeRadioPlaylist = computed(() => radio.playlists.find(p => p.id === radio.activePlaylistId) || radio.playlists[0] || null);
            const ensureRadioPlaylist = (name = '') => {
                let p = radio.playlists.find(x => x.id === radio.activePlaylistId) || radio.playlists[0] || null;
                if (p) {
                    if (!radio.activePlaylistId) radio.activePlaylistId = p.id;
                    return p;
                }
                p = { id:'pl-' + Date.now(), name:(String(name || '').trim() || '我的歌单').slice(0, 40), items:[] };
                radio.playlists.unshift(p);
                radio.activePlaylistId = p.id;
                saveRadio();
                return p;
            };
            const normalizeRadioPlaylistKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '');
            const findRadioPlaylist = (value) => {
                const q = normalizeRadioPlaylistKey(value);
                if (!q) return null;
                return radio.playlists.find(p => p.id === value || normalizeRadioPlaylistKey(p.name) === q || normalizeRadioPlaylistKey(p.name).includes(q) || q.includes(normalizeRadioPlaylistKey(p.name))) || null;
            };
            const radioPlayModes = [
                { id:'sequence', label:'顺序播放', icon:'≡', note:'播完列表后停止' },
                { id:'list-loop', label:'列表循环', icon:'↻', note:'列表播完从头开始' },
                { id:'single-loop', label:'单曲循环', icon:'①', note:'当前歌曲反复播放' },
                { id:'shuffle', label:'随机播放', icon:'⤨', note:'随机选择下一首' },
            ];
            const radioPlayModeLabel = computed(() => radioPlayModes.find(x => x.id === radio.playMode)?.label || '顺序播放');
            const radioItemMatches = (a, b) => !!(a && b && ((a.url && b.url && a.url === b.url) || (a.id && b.id && a.id === b.id)));
            const radioCurrentItem = computed(() => radio.detail.item || (radio.player.url ? {
                id:'current-' + radio.player.url,
                title:radio.player.title,
                type:radio.player.type,
                source:radio.player.source,
                provider:radio.player.provider,
                artist:radio.player.source,
                url:radio.player.url,
                coverUrl:'',
            } : null));
            const radioFavoritesPlaylist = computed(() => radio.playlists.find(p => normalizeRadioPlaylistKey(p.name) === normalizeRadioPlaylistKey('我的喜欢')) || null);
            const radioIsCurrentFavorite = computed(() => {
                const item = radioCurrentItem.value;
                return !!(item && radioFavoritesPlaylist.value?.items?.some(x => radioItemMatches(x, item)));
            });
            const radioSearchTabs = ['song','radio','story','audiobook'];
            const radioItemMatchesTab = (item, tab) => {
                if (!tab || tab === 'all') return true;
                if (item.type === tab) return true;
                if (tab === 'radio') return ['station','podcast'].includes(item.type);
                if (tab === 'audiobook') return ['book','audiobook'].includes(item.type);
                return !item.type;
            };
            const radioSearchResults = computed(() => {
                const q = String(radio.query || '').trim().toLowerCase();
                const combined = [...radio.results, ...radio.library.filter(item => {
                    if (!q) return true;
                    return [item.title, item.artist, item.source].some(v => String(v || '').toLowerCase().includes(q));
                })];
                const tab = radioSearchTabs.includes(radio.tab) ? radio.tab : 'all';
                const seen = new Set();
                return combined.filter(item => {
                    if (seen.has(item.id)) return false;
                    seen.add(item.id);
                    return radioItemMatchesTab(item, tab);
                });
            });
            const radioVisibleResults = computed(() => {
                if (radio.tab === 'recent') return radio.recent;
                if (radio.tab === 'playlist') return activeRadioPlaylist.value?.items || [];
                return radioSearchResults.value;
            });
            const radioQueueItems = computed(() => {
                let list = Array.isArray(radio.queue) && radio.queue.length
                    ? radio.queue
                    : radioVisibleResults.value.filter(item => item?.url);
                if (!list.length) list = radio.recent.filter(item => item?.url);
                const current = radioCurrentItem.value;
                if (current?.url && !list.some(item => radioItemMatches(item, current))) list = [current, ...list];
                return list;
            });
            const radioExternalLinks = computed(() => []);
            const radioDetailLines = computed(() => {
                const raw = String(radio.detail.lyrics || '');
                if (!raw.trim()) return [];
                return raw
                    .split(/\r?\n/)
                    .map(line => line.replace(/\[[^\]]+\]/g, '').trim())
                    .filter(Boolean)
                    .slice(0, 80);
            });
            const normalizeRadioType = (value) => {
                const t = String(value || '').toLowerCase();
                if (['song','track','music'].includes(t)) return 'song';
                if (['radio','station','live'].includes(t)) return 'radio';
                if (['story','stories'].includes(t)) return 'story';
                if (['audiobook','book','audio_book'].includes(t)) return 'audiobook';
                if (['podcast'].includes(t)) return 'radio';
                return ['song','radio','story','audiobook'].includes(radio.tab) ? radio.tab : 'song';
            };
            const normalizeRadioItem = (item, index = 0) => {
                const provider = String(item.provider || item.sourceProvider || item.platform || '').trim();
                const source = String(item.source || item.album || item.artist || provider || '').trim();
                const url = item.url || item.audioUrl || item.playUrl || item.streamUrl || item.mediaUrl || '';
                return {
                    id:String(item.id || item.mediaId || `${provider || 'online'}-${index}-${item.title || Date.now()}`),
                    title:String(item.title || item.name || item.caption || '未命名音频').slice(0, 180),
                    type:normalizeRadioType(item.type || item.kind),
                    provider:provider || 'online',
                    source:source || radioProviderLabel(provider),
                    artist:String(item.artist || item.author || item.dj || '').slice(0, 120),
                    durationLabel:item.durationLabel || item.duration || item.length || '',
                    url:String(url || ''),
                    coverUrl:item.coverUrl || item.image || item.picUrl || '',
                    lyrics:item.lyrics || item.lrc || '',
                    lyricsUrl:item.lyricsUrl || item.lrcUrl || '',
                    description:item.description || item.summary || item.desc || '',
                };
            };
            const archiveDownloadUrl = (identifier, fileName) => {
                const safeName = String(fileName || '').split('/').map(encodeURIComponent).join('/');
                return `https://archive.org/download/${encodeURIComponent(identifier)}/${safeName}`;
            };
            const dedupeRadioItems = (items) => {
                const seen = new Set();
                return items.filter(item => {
                    const key = item.url || `${item.provider}:${item.title}:${item.artist || ''}`;
                    if (!key || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            };
            const clientFreeRadioSearch = async () => {
                const q = String(radio.query || '').trim() || (radio.tab === 'radio' ? 'lofi radio' : 'music');
                const type = ['song','radio','story','audiobook'].includes(radio.tab) ? radio.tab : 'all';
                const isAllSearch = type === 'all';
                const jobs = [];
                if (type === 'song' || isAllSearch) {
                    jobs.push((async () => {
                        const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=20&country=US`, { cache:'no-store' });
                        if (!r.ok) return [];
                        const j = await r.json();
                        return (j.results || []).map((x, i) => ({
                            id:`itunes-${x.trackId || i}`,
                            title:x.trackName || x.collectionName || 'Apple Music 试听',
                            artist:x.artistName || '',
                            type:'song',
                            provider:'itunes',
                            source:'Apple/iTunes 试听',
                            durationLabel:'30 秒试听',
                            url:x.previewUrl || '',
                            coverUrl:String(x.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
                            description:[x.collectionName, x.primaryGenreName, '官方试听片段'].filter(Boolean).join(' · '),
                        })).filter(x => x.url);
                    })());
                    jobs.push((async () => {
                        const r = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=Rifugio&limit=18`, { cache:'no-store' });
                        if (!r.ok) return [];
                        const j = await r.json();
                        return (j.data || []).map((x, i) => ({
                            id:`audius-${x.id || i}`,
                            title:x.title || '未命名歌曲',
                            artist:x.user?.name || x.user?.handle || '',
                            type:'song',
                            provider:'audius',
                            source:'Audius 完整歌曲',
                            durationLabel:x.duration ? formatRadioTime(Number(x.duration)) : '完整',
                            url:x.id ? `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(x.id)}/stream?app_name=Rifugio` : '',
                            coverUrl:x.artwork?.['150x150'] || x.artwork?.['480x480'] || '',
                            description:x.description || '',
                        })).filter(x => x.url);
                    })());
                }
                if (type === 'audiobook' || type === 'story' || isAllSearch) {
                    jobs.push((async () => {
                        const audioBookType = type === 'story' ? 'story' : 'audiobook';
                        const r = await fetch(`https://librivox.org/api/feed/audiobooks/?title=${encodeURIComponent(q)}&format=json&limit=12&extended=1`, { cache:'no-store' });
                    if (!r.ok) return [];
                    const j = await r.json();
                        const books = j.books || [];
                        const items = await Promise.allSettled(books.slice(0, 8).map(async (book, i) => {
                            const archiveId = String(book.url_iarchive || '').split('/').filter(Boolean).pop();
                            if (!archiveId) return null;
                            const meta = await fetch(`https://archive.org/metadata/${encodeURIComponent(archiveId)}`, { cache:'no-store' }).then(x => x.ok ? x.json() : null);
                            const file = (meta?.files || []).find(f => /\.(mp3|ogg|m4a)$/i.test(f.name || '') && Number(f.size || 0) > 0);
                            if (!file) return null;
                            return {
                                id:`librivox-${book.id || archiveId}-${i}`,
                                title:book.title || meta?.metadata?.title || '有声书',
                                artist:(book.authors || []).map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).filter(Boolean).join(', '),
                                type:audioBookType,
                                provider:'librivox',
                                source:'LibriVox 完整有声书',
                                durationLabel:book.totaltime || (file.length ? formatRadioTime(Number(file.length)) : '完整'),
                                url:archiveDownloadUrl(archiveId, file.name),
                                coverUrl:`https://archive.org/services/img/${encodeURIComponent(archiveId)}`,
                                description:book.description || book.title || '',
                            };
                        }));
                        return items.map(x => x.status === 'fulfilled' ? x.value : null).filter(Boolean);
                    })());
                }
                if (type === 'radio' || isAllSearch) {
                    jobs.push((async () => {
                        const r = await fetch(`https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(q)}&hidebroken=true&limit=18`, { cache:'no-store' });
                        if (!r.ok) return [];
                        const list = await r.json();
                        return (Array.isArray(list) ? list : []).map((x, i) => ({
                            id:`radio-browser-${x.stationuuid || i}`,
                            title:x.name || '在线音乐',
                            artist:x.country || x.language || '',
                            type:'radio',
                            provider:'radio-browser',
                            source:'全球开放音乐',
                            durationLabel:x.codec || '直播',
                            url:x.url_resolved || x.url || '',
                            coverUrl:x.favicon || '',
                            description:[x.country, x.language, x.tags].filter(Boolean).join(' · '),
                        })).filter(x => x.url);
                    })());
                }
                jobs.push((async () => {
                    const typeQuery = type === 'audiobook'
                        ? `(${q}) AND mediatype:audio AND (collection:librivoxaudio OR subject:audiobook)`
                        : (type === 'story'
                            ? `(${q}) AND mediatype:audio AND (subject:story OR subject:fiction OR collection:librivoxaudio)`
                            : `(${q}) AND mediatype:audio`);
                    const query = encodeURIComponent(typeQuery);
                    const r = await fetch(`https://archive.org/advancedsearch.php?q=${query}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=description&rows=10&page=1&output=json`, { cache:'no-store' });
                    if (!r.ok) return [];
                    const j = await r.json();
                    const docs = j.response?.docs || [];
                    const details = await Promise.allSettled(docs.map(async (doc, i) => {
                        const meta = await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`, { cache:'no-store' }).then(x => x.ok ? x.json() : null);
                        const file = (meta?.files || []).find(f => /\.(mp3|ogg|m4a)$/i.test(f.name || '') && Number(f.size || 0) > 0);
                        if (!file) return null;
                        return {
                            id:`archive-${doc.identifier}-${i}`,
                            title:doc.title || meta?.metadata?.title || doc.identifier,
                            artist:doc.creator || meta?.metadata?.creator || '',
                            type:type === 'radio' ? 'story' : (isAllSearch ? 'song' : type),
                            provider:'archive',
                            source:'Internet Archive 完整音频',
                            durationLabel:file.length ? formatRadioTime(Number(file.length)) : '完整',
                            url:archiveDownloadUrl(doc.identifier, file.name),
                            coverUrl:`https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
                            description:doc.description || meta?.metadata?.description || '',
                        };
                    }));
                    return details.map(x => x.status === 'fulfilled' ? x.value : null).filter(Boolean);
                })());
                const settled = await Promise.allSettled(jobs);
                return dedupeRadioItems(settled.flatMap(x => x.status === 'fulfilled' ? x.value : []));
            };
            const searchRadio = async () => {
                if (['recent','playlist'].includes(radio.tab)) radio.tab = 'all';
                radio.view = 'list';
                radio.loading = true;
                radio.error = '';
                radio.status = '搜索中…';
                try {
                    const params = new URLSearchParams({
                        q:String(radio.query || ''),
                        type:radioSearchTabs.includes(radio.tab) ? radio.tab : '',
                        providers:radio.providers.join(','),
                    });
                    const r = await fetch('/api/radio/search?' + params.toString(), { credentials:'include', cache:'no-store' });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const j = await r.json();
                    const list = j.results || j.data || [];
                    const normalized = (Array.isArray(list) ? list : []).map(normalizeRadioItem).filter(item => item.provider !== 'mock');
                    const clientResults = normalized.length ? [] : await clientFreeRadioSearch();
                    radio.results = normalized.length ? normalized : clientResults;
                    const localCount = radioSearchResults.value.filter(item => item.provider === 'local').length;
                    radio.status = normalized.length
                        ? `已找到 ${normalized.length} 条`
                        : (clientResults.length ? `已找到 ${clientResults.length} 条` : (localCount ? `本地音乐 ${localCount} 条` : '暂无结果'));
                } catch(_) {
                    const clientResults = await clientFreeRadioSearch().catch(() => []);
                    radio.results = clientResults;
                    const localCount = radioSearchResults.value.filter(item => item.provider === 'local').length;
                    radio.status = clientResults.length ? `已找到 ${clientResults.length} 条` : (localCount ? `本地音乐 ${localCount} 条` : '暂无结果');
                } finally {
                    radio.loading = false;
                }
            };
            const plainRadioText = (text) => String(text || '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const loadRadioDetail = async (item) => {
                radio.detail.loading = true;
                radio.detail.lyrics = item.lyrics || '';
                radio.detail.summary = plainRadioText(item.description) || `${item.source || item.provider || '站内音乐'} · ${item.durationLabel || radioTypeLabel(item.type)}`;
                try {
                    if (!radio.detail.lyrics && item.lyricsUrl) {
                        const r = await fetch(item.lyricsUrl, { cache:'no-store' });
                        if (r.ok) radio.detail.lyrics = await r.text();
                    }
                } catch(_) {}
                finally { radio.detail.loading = false; }
            };
            const openRadioDetail = async (item) => {
                if (!item) return;
                radio.view = 'detail';
                radio.detail.item = item;
                loadRadioDetail(item);
                if (item.url && radio.player.url !== item.url) {
                    await playRadioItem(item);
                    radio.view = 'detail';
                }
            };
            const rememberRadioCommand = (id) => {
                if (!id) return;
                if (!radio.seenCommandIds.includes(id)) radio.seenCommandIds.push(id);
                radio.seenCommandIds = radio.seenCommandIds.slice(-80);
                saveRadio();
            };
            const playRadioItem = async (item, fromCommand = false, retryCount = 0) => {
                if (!item?.url) {
                    radio.status = '暂无可播放音乐';
                    return;
                }
                radio.detail.item = item;
                loadRadioDetail(item);
                radio.player = {
                    ...radio.player,
                    title:item.title,
                    type:item.type,
                    source:item.source || '',
                    provider:item.provider || '',
                    url:item.url,
                    loading:true,
                    error:'',
                    autoplayBlocked:false,
                    commandId:item.commandId || '',
                };
                radio.recent = [item, ...radio.recent.filter(x => x.id !== item.id)].slice(0, 30);
                saveRadio();
                await Vue.nextTick();
                const audio = radioAudioRef.value;
                if (!audio) {
                    if (fromCommand && item.commandId && retryCount < 4) {
                        setTimeout(() => playRadioItem(item, true, retryCount + 1), 800);
                        return;
                    }
                    if (fromCommand && item.commandId) await consumePlaybackCommand(item.commandId, 'failed', 'Radio audio element not mounted');
                    return;
                }
                try {
                    audio.load();
                    await audio.play();
                    radio.player.playing = true;
                    radio.player.loading = false;
                    radio.commandRetry[item.commandId || item.url] = 0;
                    if (fromCommand && item.commandId) {
                        rememberRadioCommand(item.commandId);
                        await consumePlaybackCommand(item.commandId, 'consumed');
                    }
                } catch(e) {
                    radio.player.loading = false;
                    radio.player.playing = false;
                    radio.player.autoplayBlocked = true;
                    radio.player.error = retryCount < 2 ? '播放失败，正在自动重试…' : '浏览器阻止了自动播放，请点“点击继续播放”。';
                    if (fromCommand && item.commandId && retryCount < 2) {
                        setTimeout(() => playRadioItem(item, true, retryCount + 1), 1200 * (retryCount + 1));
                        return;
                    }
                    if (fromCommand && item.commandId) {
                        rememberRadioCommand(item.commandId);
                        await consumePlaybackCommand(item.commandId, 'blocked', radio.player.error);
                    }
                }
            };
            const createRadioPlaylist = () => {
                const name = String(radio.playlistDraft || '').trim() || `歌单 ${radio.playlists.length + 1}`;
                const p = { id:'pl-' + Date.now(), name:name.slice(0, 40), items:[] };
                radio.playlists.unshift(p);
                radio.activePlaylistId = p.id;
                radio.playlistDraft = '';
                radio.tab = 'playlist';
                saveRadio();
            };
            const addRadioItemToPlaylist = (item, playlistId = radio.activePlaylistId) => {
                const p = radio.playlists.find(x => x.id === playlistId) || ensureRadioPlaylist();
                if (!p || !item?.url) return;
                if (!p.items.some(x => x.url === item.url || x.id === item.id)) p.items.push(normalizeRadioItem(item));
                radio.activePlaylistId = p.id;
                radio.status = `已加入「${p.name}」；搜索仍会在全局音乐源里进行。`;
                saveRadio();
            };
            const removeRadioPlaylistItem = (playlistId, item) => {
                const p = radio.playlists.find(x => x.id === playlistId);
                if (!p) return;
                p.items = p.items.filter(x => x.id !== item.id && x.url !== item.url);
                saveRadio();
            };
            const deleteRadioPlaylist = (playlistId) => {
                radio.playlists = radio.playlists.filter(p => p.id !== playlistId);
                if (radio.activePlaylistId === playlistId) radio.activePlaylistId = radio.playlists[0]?.id || '';
                saveRadio();
            };
            const showRadioDetailToast = (message) => {
                if (radio.detailToastTimer) clearTimeout(radio.detailToastTimer);
                radio.detailToast = String(message || '');
                radio.detailToastTimer = setTimeout(() => { radio.detailToast = ''; }, 1800);
            };
            const ensureRadioFavoritesPlaylist = () => {
                let p = radio.playlists.find(x => normalizeRadioPlaylistKey(x.name) === normalizeRadioPlaylistKey('我的喜欢'));
                if (!p) {
                    p = { id:'favorites-' + Date.now(), name:'我的喜欢', items:[] };
                    radio.playlists.unshift(p);
                }
                return p;
            };
            const toggleRadioFavorite = () => {
                const item = radioCurrentItem.value;
                if (!item?.url) return;
                const p = ensureRadioFavoritesPlaylist();
                const index = p.items.findIndex(x => radioItemMatches(x, item));
                if (index >= 0) {
                    p.items.splice(index, 1);
                    showRadioDetailToast('已从「我的喜欢」移除');
                } else {
                    p.items.unshift(normalizeRadioItem(item));
                    showRadioDetailToast('已加入「我的喜欢」');
                }
                radio.activePlaylistId = p.id;
                saveRadio();
            };
            const setRadioPlayMode = (mode) => {
                if (!radioPlayModes.some(x => x.id === mode)) return;
                radio.playMode = mode;
                radio.queueLoop = mode === 'list-loop';
                radio.modePanelOpen = false;
                saveRadio();
                showRadioDetailToast('已切换为' + radioPlayModeLabel.value);
            };
            const openRadioQueuePanel = () => {
                radio.modePanelOpen = false;
                if (radio.queuePanelOpen) { radio.queuePanelOpen = false; return; }
                if (!radio.queue.length && radioQueueItems.value.length) {
                    radio.queue = radioQueueItems.value.map(normalizeRadioItem).filter(item => item.url);
                    radio.queueIndex = Math.max(0, radio.queue.findIndex(item => item.url === radio.player.url));
                }
                radio.queuePanelOpen = true;
            };
            const playRadioQueueItem = async (item, index) => {
                if (!item?.url) return;
                if (!radio.queue.length) radio.queue = radioQueueItems.value.map(normalizeRadioItem).filter(x => x.url);
                const queueIndex = radio.queue.findIndex(x => radioItemMatches(x, item));
                radio.queueIndex = queueIndex >= 0 ? queueIndex : Math.max(0, Number(index) || 0);
                await playRadioItem(item);
            };
            const playRadioQueue = async (items, startIndex = 0, opts = {}) => {
                const list = (Array.isArray(items) ? items : []).map(normalizeRadioItem).filter(item => item.url);
                if (!list.length) { radio.status = '这个歌单还没有可播放音频'; return; }
                radio.queue = list;
                radio.queueIndex = Math.max(0, Math.min(list.length - 1, Number(startIndex) || 0));
                if (Object.prototype.hasOwnProperty.call(opts, 'loop')) {
                    radio.queueLoop = opts.loop !== false;
                    radio.playMode = opts.loop !== false ? 'list-loop' : 'sequence';
                } else {
                    radio.queueLoop = radio.playMode === 'list-loop';
                }
                saveRadio();
                await playRadioItem({ ...list[radio.queueIndex], commandId:opts.commandId || list[radio.queueIndex].commandId || '' }, !!opts.fromCommand);
            };
            const onRadioLocalFiles = (e) => {
                const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name));
                const added = files.map((file, index) => ({
                    id:`local-${Date.now()}-${index}-${file.name}`,
                    title:file.name.replace(/\.[^.]+$/, ''),
                    type:'song',
                    provider:'local',
                    source:'本地音乐库',
                    artist:'本机文件',
                    durationLabel:'本地',
                    url:URL.createObjectURL(file),
                    coverUrl:'',
                }));
                radio.library.unshift(...added);
                if (added.length) {
                    radio.status = `已导入 ${added.length} 首`;
                    radio.tab = 'song';
                }
                e.target.value = '';
            };
            const onRadioImageUpload = (kind, e) => {
                const file = (e.target.files || [])[0];
                if (!file || !file.type.startsWith('image/')) return;
                const url = URL.createObjectURL(file);
                if (kind === 'cover') radio.ui.coverUrl = url;
                else if (kind === 'home') radio.ui.homeBgUrl = url;
                else radio.ui.backgroundUrl = url;
                saveRadio();
                e.target.value = '';
            };
            const playRadioByOffset = async (offset) => {
                const hasQueue = Array.isArray(radio.queue) && radio.queue.length;
                const list = hasQueue ? radio.queue : radioQueueItems.value.filter(item => item.url);
                if (!list.length) return false;
                const current = hasQueue ? radio.queueIndex : list.findIndex(item => item.url === radio.player.url);
                let nextIndex;
                if (radio.playMode === 'shuffle' && list.length > 1) {
                    do { nextIndex = Math.floor(Math.random() * list.length); } while (nextIndex === current);
                } else {
                    nextIndex = current < 0 ? 0 : current + offset;
                    if (nextIndex < 0 || nextIndex >= list.length) {
                        if (radio.playMode === 'list-loop') nextIndex = (nextIndex + list.length) % list.length;
                        else return false;
                    }
                }
                if (hasQueue) radio.queueIndex = nextIndex;
                await playRadioItem(list[nextIndex]);
                return true;
            };
            const playNextRadio = () => playRadioByOffset(1);
            const playPrevRadio = () => playRadioByOffset(-1);
            const toggleRadioPlay = async () => {
                const audio = radioAudioRef.value;
                if (!audio || !radio.player.url) return;
                if (radio.player.playing) {
                    audio.pause();
                    radio.player.playing = false;
                    return;
                }
                radio.player.loading = true;
                try { await audio.play(); radio.player.playing = true; radio.player.error = ''; radio.player.autoplayBlocked = false; }
                catch(_) { radio.player.error = '无法播放，请稍后重试或换一个资源。'; }
                finally { radio.player.loading = false; }
            };
            const resumeBlockedRadio = async () => {
                radio.player.autoplayBlocked = false;
                await toggleRadioPlay();
            };
            const onRadioLoadedMetadata = () => {
                const audio = radioAudioRef.value;
                radio.player.duration = Number.isFinite(audio?.duration) ? Math.floor(audio.duration) : 0;
                radio.player.loading = false;
            };
            const onRadioTimeUpdate = () => {
                const audio = radioAudioRef.value;
                radio.player.currentTime = Number.isFinite(audio?.currentTime) ? Math.floor(audio.currentTime) : 0;
            };
            const onRadioEnded = async () => {
                radio.player.playing = false;
                if (radio.playMode === 'single-loop') {
                    const audio = radioAudioRef.value;
                    if (!audio) return;
                    audio.currentTime = 0;
                    try { await audio.play(); radio.player.playing = true; }
                    catch(_) { radio.player.autoplayBlocked = true; }
                    return;
                }
                await playNextRadio();
            };
            const onRadioAudioError = () => {
                radio.player.playing = false;
                radio.player.loading = false;
                const key = radio.player.commandId || radio.player.url || 'radio';
                const count = Number(radio.commandRetry[key] || 0);
                if (radio.player.url && count < 3) {
                    radio.commandRetry[key] = count + 1;
                    radio.player.error = `音频加载失败，正在第 ${count + 1} 次重试…`;
                    setTimeout(() => {
                        const item = radio.detail.item || {
                            id:'retry-' + key,
                            title:radio.player.title,
                            type:radio.player.type,
                            provider:radio.player.provider,
                            source:radio.player.source,
                            url:radio.player.url,
                            commandId:radio.player.commandId,
                        };
                        playRadioItem(item, !!radio.player.commandId, count + 1);
                    }, 1000 * (count + 1));
                    return;
                }
                radio.player.error = '音频加载失败，试试换一条或稍后再试。';
                if (radio.player.commandId) {
                    rememberRadioCommand(radio.player.commandId);
                    consumePlaybackCommand(radio.player.commandId, 'failed', radio.player.error);
                }
            };
            const seekRadio = (e) => {
                const audio = radioAudioRef.value;
                if (!audio) return;
                audio.currentTime = Number(e.target.value) || 0;
                radio.player.currentTime = Math.floor(audio.currentTime || 0);
            };
            const formatRadioTime = (seconds) => {
                const s = Math.max(0, Math.floor(Number(seconds) || 0));
                return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            };
            const clearRadioSleepTimer = () => {
                if (radio.sleepTimer) clearInterval(radio.sleepTimer);
                radio.sleepTimer = null;
                radio.sleepUntil = 0;
                radio.sleepRemaining = 0;
                radio.sleepRemainingLabel = '';
            };
            const setRadioSleepTimer = (minutes) => {
                const m = Math.max(1, Math.min(240, Number(minutes) || 0));
                if (!m) return;
                clearRadioSleepTimer();
                radio.sleepUntil = Date.now() + m * 60000;
                radio.sleepTimer = setInterval(() => {
                    radio.sleepRemaining = Math.max(0, radio.sleepUntil - Date.now());
                    const left = Math.ceil(radio.sleepRemaining / 60000);
                    radio.sleepRemainingLabel = left ? `${left} 分钟` : '';
                    if (!radio.sleepRemaining) {
                        clearRadioSleepTimer();
                        const audio = radioAudioRef.value;
                        if (audio) audio.pause();
                        radio.player.playing = false;
                    }
                }, 1000);
                radio.sleepRemaining = m * 60000;
                radio.sleepRemainingLabel = `${m} 分钟`;
            };
            const consumePlaybackCommand = async (id, status, error = '') => {
                if (!id) return;
                try {
                    await fetch(`/api/playback/commands/${encodeURIComponent(id)}/${status}`, {
                        method:'POST',
                        headers:{ 'Content-Type':'application/json' },
                        credentials:'include',
                        body:JSON.stringify({ error }),
                    });
                } catch(_) {}
            };
            const pollPlaybackCommand = async () => {
                if (radio.commandPollBusy) return;
                radio.commandPollBusy = true;
                try {
                    const r = await fetch('/api/playback/commands/latest?sessionId=default', { credentials:'include', cache:'no-store' });
                    if (!r.ok) return;
                    const j = await r.json();
                    const cmd = j.command || j.data;
                    if (!cmd?.id || radio.seenCommandIds.includes(cmd.id)) return;
                    if (cmd.action === 'stop') {            // 哄睡定时到 / 手动停止：暂停播放
                        const audio = radioAudioRef.value;
                        if (audio) audio.pause();
                        radio.player.playing = false;
                        radio.status = cmd.title || '已停止播放';
                        rememberRadioCommand(cmd.id);
                        await consumePlaybackCommand(cmd.id, 'done');
                        return;
                    }
                    const playlistQuery = cmd.playlistId || cmd.playlist_id || cmd.playlistName || cmd.playlist_name || (cmd.action === 'play_playlist' ? cmd.title : '');
                    const targetPlaylist = findRadioPlaylist(playlistQuery);
                    if (targetPlaylist) {
                        if (targetPlaylist.items?.length) {
                            radio.activePlaylistId = targetPlaylist.id;
                            radio.tab = 'playlist';
                            radio.status = cmd.title || `Claude 已开始循环「${targetPlaylist.name}」`;
                            await playRadioQueue(targetPlaylist.items, 0, { fromCommand:true, commandId:cmd.id, loop:cmd.loop !== false });
                        } else {
                            radio.status = `「${targetPlaylist.name}」还没有可播放歌曲`;
                            rememberRadioCommand(cmd.id);
                            await consumePlaybackCommand(cmd.id, 'failed', radio.status);
                        }
                        return;
                    }
                    if (playlistQuery && !targetPlaylist && !cmd.url && !cmd.items?.length && !cmd.playlist?.length) {
                        const names = radio.playlists.map(p => p.name).join('、') || '暂无本地歌单';
                        radio.status = `没找到歌单「${playlistQuery}」。当前歌单：${names}`;
                        rememberRadioCommand(cmd.id);
                        await consumePlaybackCommand(cmd.id, 'failed', radio.status);
                        return;
                    }
                    const commandItems = Array.isArray(cmd.items) ? cmd.items : (Array.isArray(cmd.playlist) ? cmd.playlist : []);
                    if (commandItems.length) {
                        const items = commandItems.map((item, idx) => normalizeRadioItem({ ...item, commandId:idx === 0 ? cmd.id : '' }, idx)).filter(item => item.url);
                        if (items.length) {
                            radio.status = cmd.title || `Claude 已发送 ${items.length} 首歌单`;
                            await playRadioQueue(items, 0, { fromCommand:true, commandId:cmd.id, loop:cmd.loop !== false });
                            return;
                        }
                    }
                    await playRadioItem({
                        id:'cmd-' + cmd.id,
                        commandId:cmd.id,
                        title:cmd.title,
                        type:cmd.type || 'song',
                        provider:cmd.provider || 'mcp',
                        source:cmd.source || 'Claude MCP',
                        url:cmd.url,
                        durationLabel:cmd.durationLabel || '指令',
                    }, true);
                } catch(e) {
                    radio.status = 'Claude 播放指令处理失败：' + String(e?.message || e || '').slice(0, 120);
                } finally {
                    radio.commandPollBusy = false;
                }
            };
            const openRadioLoginPicker = () => {
                radio.auth = {
                    ...radio.auth,
                    loading:false,
                    message:'选择要登录的音乐平台',
                    qrUrl:'',
                    loginUrl:'',
                    pickerOpen:true,
                };
            };
            const startRadioProviderLogin = (providerId) => {
                const provider = radioLoginProviders.find(p => p.id === providerId);
                const loginUrl = radioLoginTargets[providerId] || '';
                if (!provider || !loginUrl) return;
                radio.auth = {
                    provider:providerId,
                    loading:false,
                    message:'请扫码打开官方平台并完成登录',
                    qrUrl:'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=' + encodeURIComponent(loginUrl),
                    loginUrl,
                    pickerOpen:false,
                };
            };

        return { radioAudioRef, radioTabs, radioProviders, radioLoginProviders, radio, saveRadio, radioTypeLabel, radioProviderLabel, toggleRadioProvider, setRadioTab, activeRadioPlaylist, ensureRadioPlaylist, radioVisibleResults, radioQueueItems, radioPlayModes, radioPlayModeLabel, radioIsCurrentFavorite, radioExternalLinks, radioDetailLines, normalizeRadioType, normalizeRadioItem, archiveDownloadUrl, dedupeRadioItems, clientFreeRadioSearch, searchRadio, plainRadioText, loadRadioDetail, openRadioDetail, playRadioItem, createRadioPlaylist, addRadioItemToPlaylist, removeRadioPlaylistItem, deleteRadioPlaylist, toggleRadioFavorite, setRadioPlayMode, openRadioQueuePanel, playRadioQueueItem, playRadioQueue, onRadioLocalFiles, onRadioImageUpload, playRadioByOffset, playNextRadio, playPrevRadio, toggleRadioPlay, resumeBlockedRadio, onRadioLoadedMetadata, onRadioTimeUpdate, onRadioEnded, onRadioAudioError, seekRadio, formatRadioTime, clearRadioSleepTimer, setRadioSleepTimer, consumePlaybackCommand, pollPlaybackCommand, openRadioLoginPicker, startRadioProviderLogin };
    }
};

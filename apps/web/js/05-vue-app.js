    const { createApp, ref, computed, reactive, onMounted, onUnmounted } = Vue;
    createApp({
        setup() {
            // iOS 版布局热修复：清理上一版可能留下的空布局/停在 App 页的缓存，避免打开只剩粉色背景。
            try {
                const build = 'v7-chat-widgets-voice';
                if (localStorage.getItem('rifugio-ios-layout-build') !== build) {
                    ['rifugio-phone-view','rifugio-active-phone-app','rifugio-ios-home-layout-v5','rifugio-ios-home-layout-v5','rifugio-ios-home-layout-v3'].forEach(k => localStorage.removeItem(k));
                    localStorage.setItem('rifugio-ios-layout-build', build);
                }
            } catch(e) {}
            const mainTab = ref('casa');
            const isAbyss = computed(() => mainTab.value === 'abisso');
            const xpTab = ref('tried');
            const postaTab = ref('inbox');
            const animaAuthor = ref('User');
            const subTabs = reactive({ casa: 'home', libreria: 'posta', museo: 'talk', abisso: 'desideri', memoria: 'dashboard' });
            const filters = reactive({ memTime: '', memLevel: 'all' });


            // ============================================================
            // ✦ iOS 手机式主屏 v2：自由摆放 App / 小组件 / 页面不纵向滚动
            // ============================================================
            const phoneView = ref('home');
            const activePhoneAppId = ref('');
            const phonePageIndex = ref(0);
            const phoneEditMode = ref(false);
            const draggingHomeItemId = ref('');
            const showWidgetPanel = ref(false);
            const phoneHomeScroll = ref(null);
            const phoneDateLine = ref('');
            const phoneClock = ref('');
            const phoneClockDate = ref('');
            const phoneNavStack = reactive([]);
            const settingsPanel = ref(localStorage.getItem('rifugio-settings-panel') || 'memory');
            if (!['memory','pet','embedding','stt','room','host','about'].includes(settingsPanel.value)) settingsPanel.value = 'memory';
            Vue.watch(settingsPanel, (v) => localStorage.setItem('rifugio-settings-panel', v));
            const chatTheme = ref(localStorage.getItem('rifugio-chat-theme') || 'rose');
            const chatThemeOptions = [
                { id:'rose',  label:'淡粉 Rose',  accent:'rgba(216,141,165,.86)', deep:'rgba(177,93,119,.90)', soft:'rgba(216,141,165,.13)' },
                { id:'cream', label:'奶油 Cream', accent:'rgba(198,166,112,.86)', deep:'rgba(145,105,55,.90)', soft:'rgba(198,166,112,.14)' },
                { id:'mint',  label:'薄荷 Mint',  accent:'rgba(105,168,142,.86)', deep:'rgba(63,125,99,.90)', soft:'rgba(105,168,142,.14)' },
                { id:'blue',  label:'雾蓝 Mist',  accent:'rgba(111,151,190,.86)', deep:'rgba(72,109,151,.90)', soft:'rgba(111,151,190,.14)' },
                { id:'lilac', label:'淡紫 Lilac', accent:'rgba(171,134,196,.86)', deep:'rgba(124,88,154,.90)', soft:'rgba(171,134,196,.14)' },
                { id:'dark',  label:'深色 Noir',  accent:'rgba(72,55,65,.92)',  deep:'rgba(33,25,31,.95)',  soft:'rgba(72,55,65,.16)' },
            ];
            const applyChatTheme = () => {
                const t = chatThemeOptions.find(x => x.id === chatTheme.value) || chatThemeOptions[0];
                document.documentElement.style.setProperty('--chat-accent', t.accent);
                document.documentElement.style.setProperty('--chat-accent-deep', t.deep);
                document.documentElement.style.setProperty('--chat-accent-soft', t.soft);
            };
            const saveChatTheme = () => { localStorage.setItem('rifugio-chat-theme', chatTheme.value); applyChatTheme(); };
            applyChatTheme();
            Vue.watch(chatTheme, saveChatTheme);

            let phonePressTimer = null;
            let dockPressTimer = null;
            let homeEdgeTimer = null;
            let homePressStart = { x: 0, y: 0 };
            let dockPressStart = { x: 0, y: 0 };
            let suppressHomeClick = false;
            let suppressDockClick = false;
            let pwaDragScrollLocked = false;
            const blockPwaDragTouch = (event) => {
                if (pwaDragScrollLocked && event.cancelable) event.preventDefault();
            };
            const lockPwaDragScroll = () => {
                if (pwaDragScrollLocked) return;
                pwaDragScrollLocked = true;
                document.documentElement.classList.add('pwa-drag-scroll-lock');
                document.body.classList.add('pwa-drag-scroll-lock');
                document.addEventListener('touchmove', blockPwaDragTouch, { passive:false, capture:true });
            };
            const unlockPwaDragScroll = () => {
                if (!pwaDragScrollLocked) return;
                pwaDragScrollLocked = false;
                document.removeEventListener('touchmove', blockPwaDragTouch, true);
                document.documentElement.classList.remove('pwa-drag-scroll-lock');
                document.body.classList.remove('pwa-drag-scroll-lock');
            };
            onMounted(() => window.addEventListener('pagehide', unlockPwaDragScroll, { passive:true }));
            const homeDrag = reactive({
                active:false, id:'', page:0, pointerId:null, offsetX:0, offsetY:0, plane:null, moved:false,
                originalX:0, originalY:0, lastX:0, lastY:0, edgeDirection:0, edgeStartedAt:0,
                lastPageSwitch:0, lastEventStamp:-1, edgeLockUntil:0, edgeNeedsReset:false,
            });
            let homeDragFrame = 0;
            let homeDragPoint = null;
            const homeDragEdge = ref(0);
            const dockDrag = reactive({ active:false, appId:'', index:-1, pointerId:null, moved:false, startX:0, startY:0, lastX:0, lastY:0 });
            const phoneDock = ref(null);
            const draggingDockAppId = ref('');

            const DEFAULT_PHONE_APPS = [
                // Dock：常驻四个核心 App
                { id:'talk',      label:'对话', title:'Chat · 对话', subtitle:'Claude Code · Pro interactive', tab:'museo', sub:'talk', icon:'💬', dock:true },
                { id:'chatroom',  label:'聊天室', title:'Room · 聊天室', subtitle:'CC / GPT / DeepSeek / games', tab:'chatroom', icon:'🫧' },
                { id:'room',      label:'小屋', title:'Crab Room · 小屋', subtitle:'一只住在这里的小螃蟹', tab:'room', icon:'🦀' },
                { id:'memoria',   label:'记忆', title:'Memoria · 记忆', subtitle:'Dashboard / Buckets / Import / Search', tab:'memoria', sub:'dashboard', icon:'🧠', dock:true },
                { id:'segreti',   label:'秘密', title:'Secrets · 秘密', subtitle:'Soul & Desires', tab:'abisso', sub:'desideri', icon:'🌙', dock:true },
                { id:'settings',  label:'设置', title:'Settings · 设置', subtitle:'API & system', kind:'settings', icon:'⚙️', dock:true },

                // 除“记忆 / 秘密”以外，其余子区全部提成独立 App
                { id:'echi',      label:'回声', title:'Echoes · 回声', subtitle:'Pinned whispers', tab:'casa', sub:'echi', icon:'💌' },
                { id:'log',       label:'轨迹', title:'Log · 轨迹', subtitle:'Claude export reader', tab:'casa', sub:'log', icon:'🗂️' },
                { id:'posta',     label:'信箱', title:'Mail · 信箱', subtitle:'Inbox & archive', tab:'libreria', sub:'posta', icon:'✉️' },
                { id:'diario',    label:'日记', title:'Diary · 日记', subtitle:'Private diary', tab:'libreria', sub:'diario', icon:'📓' },
                { id:'aforismi',  label:'摘句', title:'Quotes · 摘句', subtitle:'Saved sentences', tab:'libreria', sub:'aforismi', icon:'📝' },
                { id:'calendario',label:'日历', title:'Calendar · 日历', subtitle:'Anniversary days', tab:'libreria', sub:'calendario', icon:'📅' },
                { id:'tracce',    label:'痕迹', title:'Traces · 痕迹', subtitle:'Timeline traces', tab:'libreria', sub:'tracce', icon:'🧭' },
                { id:'radio',     label:'音乐', title:'音乐', subtitle:'LISTENING', tab:'radio', icon:'♫' },
                { id:'biblioteca',label:'书房', title:'Lettura · 共读', subtitle:'Read together', tab:'biblioteca', icon:'📖' },
                { id:'showroom',  label:'展厅', title:'Galleria · 展厅', subtitle:'Artworks & small worlds', tab:'showroom', icon:'◫' },
                { id:'galleria',  label:'相册', title:'Gallery · 相册', subtitle:'Polaroids', tab:'museo', sub:'galleria', icon:'🖼️' },
                { id:'frammenti', label:'碎片', title:'Snippets · 碎片', subtitle:'Little fragments', tab:'museo', sub:'frammenti', icon:'🧩' },
                { id:'piani',     label:'计划', title:'Piani · 计划', subtitle:'Flags & promises', tab:'piani', icon:'📋' },
                { id:'health',    label:'健康', title:'Health · 健康', subtitle:'Cycle / Sleep / Steps / Heart', tab:'health', icon:'♡' },
                { id:'mcp',       label:'MCP', title:'MCP · 工具', subtitle:'Tools & backup API', tab:'mcp', icon:'⌘' },
                { id:'toy',       label:'玩具', title:'AI Toy · 玩具', subtitle:'Relay / Bluetooth / Intiface', tab:'toy', icon:'♥' },
                { id:'widgets',   label:'小组件', title:'Widgets · 小组件', subtitle:'Top Widgets style', kind:'widgets', icon:'▣' },
                { id:'bellezza',  label:'美化', title:'Bellezza · 美化', subtitle:'Wallpaper & icons', icon:'✿' },
            ];
            const phoneApps = reactive(DEFAULT_PHONE_APPS.map(a => ({ ...a })));
            try {
                const savedLabels = JSON.parse(localStorage.getItem('rifugio-phone-app-labels-v1') || '{}');
                phoneApps.forEach(app => { if (savedLabels[app.id]) app.label = savedLabels[app.id]; });
            } catch(_) {}
            const savePhoneAppLabels = () => {
                try {
                    localStorage.setItem('rifugio-phone-app-labels-v1', JSON.stringify(Object.fromEntries(phoneApps.map(app => [app.id, app.label]))));
                } catch(_) {}
            };
            const resetPhoneAppLabel = (id) => {
                const app = phoneApps.find(item => item.id === id);
                const base = DEFAULT_PHONE_APPS.find(item => item.id === id);
                if (!app || !base) return;
                app.label = base.label;
                savePhoneAppLabels();
            };
            const DEFAULT_DOCK_APP_IDS = ['talk', 'memoria', 'segreti', 'settings'];
            const phoneDockIds = reactive([]);
            try {
                const savedDock = JSON.parse(localStorage.getItem('rifugio-phone-dock-v1') || 'null');
                const validDock = Array.isArray(savedDock)
                    ? savedDock.filter((id, index) => phoneApps.some(app => app.id === id) && savedDock.indexOf(id) === index).slice(0, 4)
                    : [];
                phoneDockIds.push(...(validDock.length ? validDock : DEFAULT_DOCK_APP_IDS));
            } catch(_) {
                phoneDockIds.push(...DEFAULT_DOCK_APP_IDS);
            }
            const phoneDockApps = computed(() => phoneDockIds.map(id => phoneApps.find(app => app.id === id)).filter(Boolean));
            const savePhoneDock = () => {
                try { localStorage.setItem('rifugio-phone-dock-v1', JSON.stringify([...phoneDockIds])); } catch(_) {}
            };
            const findPhoneApp = (id) => phoneApps.find(a => a.id === id) || phoneApps.find(a => a.id === 'talk') || phoneApps[0];
            const activePhoneApp = computed(() => findPhoneApp(activePhoneAppId.value));
            const activePhoneTitle = computed(() => activePhoneApp.value?.title || 'Rifugio');
            const activePhoneSubtitle = computed(() => activePhoneApp.value?.subtitle || 'App');

            const widgetSizePreset = {
                circle: { w:34, h:112 },
                square: { w:44, h:118 },
                wide:   { w:92, h:116 },
                large:  { w:92, h:176 },
                tall:   { w:44, h:238 },
            };
            const relationshipStartDate = '';
            const samplePhotos = [
                'https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=400&q=80',
                'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=400&q=80',
                'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=400&q=80'
            ];
            const homeWidgetDefs = [
                { id:'love', label:'每日情话', desc:'显示当前情话', glyph:'“', smart:true, size:'wide', template:'banner' },
                { id:'day', label:'纪念日', desc:'填写日期后开始计天', glyph:'日', smart:true, size:'square', template:'calendar', date:relationshipStartDate },
                { id:'memory', label:'记忆数量', desc:'自动读取记忆总数', glyph:'M', smart:true, size:'square', template:'note' },
                { id:'quickChat', label:'快速对话', desc:'进入粉色 Claude Agent 聊天', glyph:'↗', smart:true, size:'wide', template:'banner' },
                { id:'couple', label:'双人头像', desc:'紧凑双头像与相恋天数', glyph:'∞', smart:true, size:'wide', height:126, template:'couple', photos: samplePhotos.slice(0,2), text:'days together', date:relationshipStartDate },
                { id:'writeHere', label:'写话输入框', desc:'毛玻璃长椭圆，主屏直接输入', glyph:'Aa', smart:true, size:'wide', width:60, height:32, template:'textInput', text:'' },
                { id:'clockNow', label:'数字时钟', desc:'Top Widgets 风格时间卡', glyph:'09', smart:true, size:'square', template:'clock' },
                { id:'countdown', label:'倒数日', desc:'计算距离目标日期还有几天', glyph:'D-', smart:true, size:'square', template:'countdown', date:'' },
                { id:'progress', label:'进度卡', desc:'记录阅读、旅行或共同目标', glyph:'%', smart:true, size:'wide', template:'progress', progress:68, text:'一点一点，正在靠近。' },
                { id:'musicPlayer', label:'听歌播放器', desc:'填音乐 URL 后直接播放', size:'wide', template:'music', photos: samplePhotos.slice(0,1), text:'now playing' },
                { id:'vinylPlayer', label:'黑胶播放器', desc:'照片唱片 + 旋转播放 + 唱针动画', glyph:'◉', smart:true, size:'tall', height:190, template:'vinyl', photos: samplePhotos.slice(0,1), text:'put the needle on us' },
                { id:'polaroid1', label:'单张拍立得', desc:'一张照片 + 手写标题', size:'square', template:'polaroid1', photos: samplePhotos.slice(0,1) },
                { id:'polaroid3', label:'三张照片组', desc:'三张叠放，像贴在主屏的相纸', size:'large', template:'polaroid3', photos: samplePhotos },
                { id:'polaroidPoster', label:'竖向 3:4 拍立得', desc:'一张竖向大相纸 + 两张小相纸叠放', size:'large', template:'polaroidPoster', photos: samplePhotos, text:'First love memories' },
                { id:'polaroidLandscape', label:'横向 4:3 拍立得', desc:'一张横向大相纸 + 两张小相纸叠放', size:'large', template:'polaroidLandscape', photos: samplePhotos, text:'First love memo' },
                { id:'circlePhoto', label:'圆形头像', desc:'小圆形照片徽章', size:'circle', template:'circlePhoto', photos: samplePhotos.slice(1,2) },
                { id:'squarePhoto', label:'方形照片', desc:'没有毛玻璃的纯照片卡', size:'square', template:'squarePhoto', photos: samplePhotos.slice(0,1) },
                { id:'archPhoto', label:'拱门照片', desc:'圆拱顶部的竖向照片', size:'tall', template:'archPhoto', photos: samplePhotos.slice(1,2) },
                { id:'calendarCard', label:'日历卡片', desc:'极简日期 / 星期', size:'square', template:'calendar' },
                { id:'photoDate', label:'照片日期', desc:'照片上叠加日期和一句话', glyph:'▤', smart:true, size:'wide', template:'photoDate', photos:samplePhotos.slice(0,1), date:relationshipStartDate },
                { id:'quoteCard', label:'语录卡', desc:'像 Top Widgets 的极简句子卡', glyph:'“', smart:true, size:'square', template:'quoteCard', text:'在这里写一句话。' },
            ];
            const widgetTemplateOptions = [
                { id:'squarePhoto', label:'方形照片', desc:'干净利落，照片本身就是主角', glyph:'▣', artClass:'square', size:'square' },
                { id:'circlePhoto', label:'圆形照片', desc:'头像、宠物或一张亲密特写', glyph:'●', artClass:'circle', size:'circle' },
                { id:'archPhoto', label:'拱门照片', desc:'适合竖图与旅行照片', glyph:'⌒', artClass:'', size:'tall' },
                { id:'polaroid1', label:'单张拍立得', desc:'保留纸张质感，不加毛玻璃', glyph:'□', artClass:'polaroid', size:'square' },
                { id:'polaroid3', label:'三张照片', desc:'三张叠放的小型照片墙', glyph:'▧', artClass:'', size:'large' },
                { id:'polaroidPoster', label:'竖向 3:4 拍立得', desc:'竖向大照片 + 两张小照片', glyph:'▧', artClass:'', size:'large' },
                { id:'polaroidLandscape', label:'横向 4:3 拍立得', desc:'横向大照片 + 两张小照片', glyph:'▧', artClass:'', size:'large' },
                { id:'music', label:'音乐播放器', desc:'封面、歌名与音频直链', glyph:'♪', artClass:'music', size:'wide' },
                { id:'vinyl', label:'黑胶唱片', desc:'圆形唱片、照片中间与唱针动画', glyph:'◉', artClass:'vinyl', size:'tall' },
                { id:'couple', label:'双人头像', desc:'两张照片与纪念日数字', glyph:'∞', artClass:'', size:'wide' },
                { id:'note', label:'柔软便签', desc:'写一句只属于这里的话', glyph:'Aa', artClass:'', size:'square' },
                { id:'banner', label:'横幅句子', desc:'适合情话、歌词与提醒', glyph:'“ ”', artClass:'', size:'wide' },
                { id:'calendar', label:'极简日历', desc:'日期与星期自动更新', glyph:'13', artClass:'', size:'square' },
                { id:'textInput', label:'写话输入框', desc:'毛玻璃胶囊形，主屏直接输入', glyph:'⌨', artClass:'', size:'wide' },
                { id:'clock', label:'数字时钟', desc:'极简时间与日期', glyph:'09', artClass:'', size:'square' },
                { id:'countdown', label:'倒数日', desc:'距离目标日期的剩余天数', glyph:'D-', artClass:'', size:'square' },
                { id:'progress', label:'进度卡', desc:'0–100% 自定义目标进度', glyph:'%', artClass:'', size:'wide' },
                { id:'photoDate', label:'照片日期', desc:'照片、日期和短句叠加', glyph:'▤', artClass:'', size:'wide' },
                { id:'quoteCard', label:'语录卡', desc:'留白克制的文字卡片', glyph:'“', artClass:'', size:'square' },
            ];
            const widgetShapeOptions = [
                { id:'square', label:'正方形' },
                { id:'circle', label:'圆形' },
                { id:'wide', label:'横向' },
                { id:'large', label:'大卡片' },
                { id:'tall', label:'竖向' },
            ];
            const widgetDraft = reactive({ title:'My Photo', text:'', date:relationshipStartDate, size:'square', w:44, h:118, progress:68, style:'paper', template:'squarePhoto', photoUrls:'', musicUrl:'' });
            const widgetEditor = reactive({ open:false, itemId:'', title:'', text:'', date:relationshipStartDate, size:'square', w:44, h:118, progress:68, style:'glass', template:'note', photoUrls:'', musicUrl:'' });
            const homeLayout = reactive([]);

            const makeAppItem = (app, idx, page=1) => {
                const col = idx % 4, row = Math.floor(idx / 4);
                return { id:'app-' + app.id, type:'app', appId:app.id, page, x:4 + col * 24, y:18 + row * 94, w:20, h:84 };
            };
            const makeDefaultHomeLayout = () => {
                const items = [
                    { id:'w-love', type:'widget', widgetId:'love', page:0, x:4,  y:8,   w:92, h:116, z:1, size:'wide',  style:'glass', template:'banner' },
                    { id:'w-couple', type:'widget', widgetId:'couple', page:0, x:4,  y:138, w:92, h:126, z:2, size:'wide',  style:'glass', template:'couple', anniversaryDate:relationshipStartDate, photoUrls: samplePhotos.slice(0,2).join('\n'), customText:'days together' },
                    { id:'w-polaroid3', type:'widget', widgetId:'polaroid3', page:0, x:4, y:278, w:92, h:176, z:3, size:'large', style:'paper', template:'polaroid3', photoUrls: samplePhotos.join('\n'), customText:'little pieces of us' },
                ];
                const desktopApps = phoneApps.filter(a => !a.hidden && !phoneDockIds.includes(a.id));
                desktopApps.forEach((app, i) => {
                    const page = 1 + Math.floor(i / 12);
                    items.push(makeAppItem(app, i % 12, page));
                });
                return items;
            };
            const saveHomeLayout = () => {
                try { localStorage.setItem('rifugio-ios-home-layout-v5', JSON.stringify(homeLayout.map(i => ({ ...i })))); } catch(e) {}
            };
            let homeLayoutSaveTimer = null;
            const queueHomeLayoutSave = () => {
                clearTimeout(homeLayoutSaveTimer);
                homeLayoutSaveTimer = setTimeout(saveHomeLayout, 650);
            };
            const loadHomeLayout = () => {
                let loaded = null;
                try { loaded = JSON.parse(localStorage.getItem('rifugio-ios-home-layout-v5') || 'null'); } catch(e) {}
                const validLoaded = Array.isArray(loaded) && loaded.some(i => i && (i.type === 'app' || i.type === 'widget') && Number.isFinite(Number(i.x)) && Number.isFinite(Number(i.y)));
                const items = validLoaded ? loaded : makeDefaultHomeLayout();
                homeLayout.splice(0, homeLayout.length, ...items);
                for (let i = homeLayout.length - 1; i >= 0; i--) {
                    if (homeLayout[i].type === 'app' && !phoneApps.some(app => app.id === homeLayout[i].appId)) homeLayout.splice(i, 1);
                }
                for (let i = homeLayout.length - 1; i >= 0; i--) {
                    if (homeLayout[i].type === 'app' && phoneDockIds.includes(homeLayout[i].appId)) homeLayout.splice(i, 1);
                }
                // 迁移旧组件：补日期、层级，并压紧旧版双人头像的大留白。
                homeLayout.filter(i => i.type === 'widget').forEach((item, index) => {
                    if (!Number.isFinite(Number(item.z))) item.z = index + 1;
                    if (item.widgetId === 'day' || item.widgetId === 'couple' || item.template === 'couple') {
                        item.anniversaryDate = item.anniversaryDate || relationshipStartDate;
                    }
                    if (item.widgetId === 'couple' || item.template === 'couple') {
                        const oldHeight = Number(item.h) || 0;
                        if (oldHeight >= 140) {
                            const delta = oldHeight - 126;
                            item.h = 126;
                            homeLayout.forEach((other) => {
                                if (other === item || Number(other.page) !== Number(item.page)) return;
                                const horizontalOverlap = (Number(other.x) || 0) < (Number(item.x) || 0) + (Number(item.w) || 92)
                                    && (Number(other.x) || 0) + (Number(other.w) || 20) > (Number(item.x) || 0);
                                const otherY = Number(other.y) || 0;
                                if (horizontalOverlap && otherY >= (Number(item.y) || 0) + oldHeight - 4
                                    && otherY < (Number(item.y) || 0) + oldHeight + 100) {
                                    other.y = Math.max(0, otherY - delta);
                                }
                            });
                        }
                    }
                    if (item.template === 'vinyl') {
                        const oldW = Number(item.w) || 92;
                        const newW = 44;
                        item.size = 'tall';
                        item.w = newW;
                        item.h = Math.max(190, Math.min(238, Number(item.h) || 190));
                        if (oldW > newW) {
                            item.x = Math.max(0, Math.min(96 - newW, (Number(item.x) || 0) + ((oldW - newW) / 2)));
                        }
                    }
                });
                // 旧版 Dock 四项迁到单独页面，保留用户现有布局并避免互相重叠。
                const missingApps = phoneApps.filter(app => !app.hidden && !phoneDockIds.includes(app.id) && !homeLayout.some(i => i.type === 'app' && i.appId === app.id));
                if (missingApps.length) {
                    const migrationPage = Math.max(0, ...homeLayout.map(i => Number(i.page) || 0)) + 1;
                    missingApps.forEach((app, index) => homeLayout.push(makeAppItem(app, index, migrationPage)));
                }
                saveHomeLayout();
            };
            loadHomeLayout();

            let savedPhonePageCount = 0;
            try { savedPhonePageCount = Number(localStorage.getItem('rifugio-phone-page-count-v1')) || 0; } catch(_) {}
            const layoutPageCount = Math.max(1, ...homeLayout.map(i => (Number(i.page) || 0) + 1));
            const phonePageCount = ref(Math.max(layoutPageCount, savedPhonePageCount, 1));
            const savePhonePageCount = () => {
                try { localStorage.setItem('rifugio-phone-page-count-v1', String(phonePageCount.value)); } catch(_) {}
            };
            const ensurePhonePage = (page) => {
                const needed = Math.max(1, (Number(page) || 0) + 1);
                if (phonePageCount.value < needed) {
                    phonePageCount.value = needed;
                    savePhonePageCount();
                }
            };
            const phonePages = computed(() => {
                return Array.from({ length: phonePageCount.value }, (_, page) => homeLayout.filter(i => (Number(i.page) || 0) === page && !i.hidden));
            });
            const isPhonePageEmpty = (page) => !homeLayout.some(i => !i.hidden && (Number(i.page) || 0) === Number(page));
            const canRemoveCurrentPhonePage = computed(() =>
                phonePageCount.value > 1 && !homeLayout.some(i => !i.hidden && (Number(i.page) || 0) === phonePageIndex.value)
            );
            let phoneScrollFrame = 0;
            let homePageCommandToken = 0;
            const syncPhonePageFromScroll = () => {
                const el = phoneHomeScroll.value; if (!el) return;
                const page = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
                phonePageIndex.value = Math.max(0, Math.min(phonePageCount.value - 1, page));
            };
            const onPhoneHomeScroll = () => {
                if (phoneScrollFrame) return;
                phoneScrollFrame = requestAnimationFrame(() => {
                    phoneScrollFrame = 0;
                    syncPhonePageFromScroll();
                });
            };
            const layoutItemStyle = (item) => ({
                left: (item.x || 0) + '%',
                top: (item.y || 0) + 'px',
                width: (item.w || 20) + '%',
                height: (item.h || 84) + 'px',
                zIndex: draggingHomeItemId.value === item.id ? 90 : (Number(item.z) || 1),
            });
            const getLayoutApp = (item) => findPhoneApp(item.appId);
            const getLayoutWidgetDef = (item) => homeWidgetDefs.find(w => w.id === item.widgetId);
            const widgetTitle = (item) => item.customTitle || getLayoutWidgetDef(item)?.label || 'Widget';
            const splitUrls = (value) => {
                const results = [];
                const pushUrl = (url) => {
                    const clean = String(url || '').trim().replace(/^<|>$/g, '');
                    if (/^(?:https?:\/\/|data:image\/|blob:)/i.test(clean)) results.push(clean);
                };
                String(value || '').split(/\r?\n/).forEach((rawLine) => {
                    let line = rawLine.trim();
                    if (!line) return;
                    let foundMarkdown = false;
                    line = line.replace(/\[[^\]]*\]\(((?:https?:\/\/|data:image\/|blob:)[^)]+)\)/gi, (_, url) => {
                        foundMarkdown = true;
                        pushUrl(url);
                        return ' ';
                    });
                    if (/^data:image\/[^;]+;base64,/i.test(line.trim())) {
                        pushUrl(line.trim());
                        return;
                    }
                    const plainUrls = line.match(/(?:https?:\/\/|blob:)[^\s,，<>\])]+/gi) || [];
                    plainUrls.forEach(pushUrl);
                    if (!plainUrls.length && !foundMarkdown) {
                        line.split(/[，,]\s*/).forEach(pushUrl);
                    }
                });
                return results;
            };
            const draftWidgetPhotos = computed(() => splitUrls(widgetDraft.photoUrls));
            const editorWidgetPhotos = computed(() => splitUrls(widgetEditor.photoUrls));
            const widgetAudioRefs = new Map();
            const widgetAudioStates = reactive({});
            const widgetAudioStateFor = (id) => {
                if (!widgetAudioStates[id]) widgetAudioStates[id] = { playing:false, current:0, duration:0 };
                return widgetAudioStates[id];
            };
            const setWidgetAudioRef = (id, el) => {
                if (el) widgetAudioRefs.set(id, el);
                else widgetAudioRefs.delete(id);
            };
            const updateWidgetAudio = (item, event) => {
                const audio = event?.target || widgetAudioRefs.get(item.id);
                if (!audio) return;
                const state = widgetAudioStateFor(item.id);
                state.playing = !audio.paused && !audio.ended;
                state.current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
                state.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
            };
            const toggleWidgetAudio = async (item) => {
                const audio = widgetAudioRefs.get(item.id);
                if (!audio || !item.musicUrl || phoneEditMode.value) return;
                if (!audio.paused) {
                    audio.pause();
                    return;
                }
                widgetAudioRefs.forEach((otherAudio, otherId) => {
                    if (otherId !== item.id && !otherAudio.paused) otherAudio.pause();
                });
                try { await audio.play(); } catch(_) {}
            };
            const seekWidgetAudio = (item, event) => {
                const audio = widgetAudioRefs.get(item.id);
                const state = widgetAudioStateFor(item.id);
                if (!audio || !state.duration) return;
                audio.currentTime = (Number(event.target.value) / 1000) * state.duration;
                updateWidgetAudio(item, { target:audio });
            };
            const widgetAudioProgress = (id) => {
                const state = widgetAudioStateFor(id);
                return state.duration ? Math.round((state.current / state.duration) * 1000) : 0;
            };
            const formatAudioTime = (seconds) => {
                const total = Math.max(0, Math.floor(Number(seconds) || 0));
                return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
            };
            const setWidgetSizeChoice = (size, target='draft') => {
                const model = target === 'editor' ? widgetEditor : widgetDraft;
                const preset = widgetSizePreset[size] || widgetSizePreset.square;
                model.size = size;
                model.w = preset.w;
                model.h = model.template === 'couple' ? Math.max(126, preset.h) : preset.h;
            };
            const selectWidgetTemplate = (option, target='draft') => {
                const model = target === 'editor' ? widgetEditor : widgetDraft;
                model.template = option.id;
                setWidgetSizeChoice(option.size || model.size, target);
                if (['polaroid1','polaroid3','polaroidPoster','polaroidLandscape','squarePhoto','archPhoto'].includes(option.id)) model.style = 'paper';
                else if (option.id === 'circlePhoto') model.style = 'clear';
                else if (option.id === 'textInput') model.style = 'glass';
                else model.style = 'glass';
            };
            const imageFileToDataUrl = (file) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = reject;
                reader.onload = () => {
                    const raw = reader.result;
                    if (file.type === 'image/gif') return resolve(raw);
                    const img = new Image();
                    img.onerror = () => resolve(raw);
                    img.onload = () => {
                        const maxSide = 900;
                        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(img.width * scale));
                        canvas.height = Math.max(1, Math.round(img.height * scale));
                        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/jpeg', .78));
                    };
                    img.src = raw;
                };
                reader.readAsDataURL(file);
            });
            const uploadWidgetPhotos = async (e, target='draft') => {
                const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/')).slice(0, 16);
                if (!files.length) return;
                const model = target === 'editor' ? widgetEditor : widgetDraft;
                const current = splitUrls(model.photoUrls);
                for (const file of files) {
                    try { current.push(await imageFileToDataUrl(file)); } catch(_) {}
                }
                model.photoUrls = current.slice(0, 16).join('\n');
                e.target.value = '';
            };
            const removeWidgetPhoto = (target, index) => {
                const model = target === 'editor' ? widgetEditor : widgetDraft;
                const photos = splitUrls(model.photoUrls);
                photos.splice(index, 1);
                model.photoUrls = photos.join('\n');
            };
            const widgetPhotos = (item) => {
                const own = splitUrls(item.photoUrls);
                if (own.length) return own;
                const def = getLayoutWidgetDef(item);
                return Array.isArray(def?.photos) ? def.photos : [];
            };
            const widgetTemplate = (item) => item.template || getLayoutWidgetDef(item)?.template || (item.widgetId === 'custom' ? 'note' : item.widgetId);
            const widgetTemplateClass = (item) => 'tpl-' + widgetTemplate(item);
            const widgetUsesDate = (template) => ['couple','countdown','photoDate'].includes(template);
            const widgetProgress = (item) => Math.max(0, Math.min(100, Number(item?.progress) || 0));
            const widgetCountdown = (item) => {
                const match = String(item?.anniversaryDate || relationshipStartDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (!match) return 0;
                const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
                const now = new Date();
                const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
                return Math.max(0, Math.ceil((target - today) / 86400000));
            };
            const isWidgetEnabled = (id) => homeLayout.some(i => i.type === 'widget' && i.widgetId === id && !i.hidden);
            const focusHomePage = (page) => {
                const target = Math.max(0, Math.min(phonePageCount.value - 1, Number(page) || 0));
                const commandToken = ++homePageCommandToken;
                Vue.nextTick(() => {
                    const scroller = phoneHomeScroll.value;
                    if (!scroller || commandToken !== homePageCommandToken) return;
                    scroller.scrollTo({ left:target * scroller.clientWidth, behavior:'auto' });
                    syncPhonePageFromScroll();
                });
            };
            const addPhonePage = (focus=true) => {
                const newPage = phonePageCount.value;
                phonePageCount.value += 1;
                savePhonePageCount();
                if (focus) focusHomePage(newPage);
                return newPage;
            };
            const pruneEmptyPhonePages = (preferredPage=phonePageIndex.value) => {
                const usedPages = [...new Set(homeLayout.filter(i => !i.hidden).map(i => Number(i.page) || 0))].sort((a,b) => a-b);
                if (!usedPages.length) {
                    phonePageCount.value = 1;
                    savePhonePageCount();
                    focusHomePage(0);
                    return;
                }
                const pageMap = new Map(usedPages.map((page, index) => [page, index]));
                homeLayout.forEach((item) => { item.page = pageMap.get(Number(item.page) || 0) ?? 0; });
                const oldPreferred = Number(preferredPage) || 0;
                const target = pageMap.has(oldPreferred)
                    ? pageMap.get(oldPreferred)
                    : Math.max(0, usedPages.filter(page => page < oldPreferred).length - 1);
                phonePageCount.value = Math.max(1, usedPages.length);
                savePhonePageCount();
                saveHomeLayout();
                focusHomePage(Math.min(target, phonePageCount.value - 1));
            };
            const removePhonePage = (page=phonePageIndex.value) => {
                const target = Math.max(0, Math.min(phonePageCount.value - 1, Number(page) || 0));
                if (phonePageCount.value <= 1) return;
                if (homeLayout.some(i => !i.hidden && (Number(i.page) || 0) === target)) {
                    alert('请先把这一页的 App 和小组件移走，再删除页面。');
                    return;
                }
                homeLayout.forEach((item) => {
                    if ((Number(item.page) || 0) > target) item.page = (Number(item.page) || 0) - 1;
                });
                phonePageCount.value -= 1;
                savePhonePageCount();
                saveHomeLayout();
                focusHomePage(Math.min(target, phonePageCount.value - 1));
            };
            pruneEmptyPhonePages(phonePageIndex.value);
            const rectanglesOverlap = (a, b, gap=10) => (
                a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x
                && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
            );
            const nextWidgetPosition = (preset) => {
                const startPage = Math.max(0, Number(phonePageIndex.value) || 0);
                const maxPage = Math.max(startPage, phonePageCount.value - 1, ...homeLayout.map(i => Number(i.page) || 0));
                const viewportHeight = phoneHomeScroll.value?.clientHeight || 620;
                const maxBottom = Math.max(430, viewportHeight - 18);
                const rightX = Math.max(4, 96 - preset.w);
                const centerX = Math.max(4, Math.min(rightX, 50 - preset.w / 2));
                const xSlots = preset.w >= 80 ? [4] : [...new Set([4, centerX, rightX])];
                for (let page = startPage; page <= maxPage; page++) {
                    const used = homeLayout.filter(i => Number(i.page) === page && !i.hidden)
                        .map(i => ({ x:Number(i.x)||0, y:Number(i.y)||0, w:Number(i.w)||20, h:Number(i.h)||84 }));
                    for (let y = 8; y + preset.h <= maxBottom; y += 12) {
                        for (const x of xSlots) {
                            const candidate = { x, y, w:preset.w, h:preset.h };
                            if (!used.some(rect => rectanglesOverlap(candidate, rect))) return { page, x, y };
                        }
                    }
                }
                const newPage = maxPage + 1;
                ensurePhonePage(newPage);
                return { page:newPage, x:4, y:8 };
            };
            const addWidgetById = (id) => {
                const def = homeWidgetDefs.find(w => w.id === id); if (!def) return;
                const basePreset = widgetSizePreset[def.size || 'square'] || widgetSizePreset.square;
                const preset = { ...basePreset, h:def.height || basePreset.h, w:def.width || basePreset.w };
                const pos = nextWidgetPosition(preset);
                const size = def.size || 'square';
                const maxZ = Math.max(0, ...homeLayout.filter(i => Number(i.page) === pos.page).map(i => Number(i.z) || 0));
                homeLayout.push({ id:'w-' + id + '-' + Date.now(), type:'widget', widgetId:id, page:pos.page, x:pos.x, y:pos.y, w:preset.w, h:preset.h, z:maxZ+1, size, style:def.style || 'glass', template:def.template || 'note', anniversaryDate:def.date || relationshipStartDate, progress:def.progress ?? 68, customText:def.text || '', photoUrls: Array.isArray(def.photos) ? def.photos.join('\n') : '', musicUrl:def.musicUrl || '' });
                focusHomePage(pos.page);
                phoneEditMode.value = true; showWidgetPanel.value = false; saveHomeLayout();
            };
            const toggleWidget = (id) => {
                const idx = homeLayout.findIndex(i => i.type === 'widget' && i.widgetId === id);
                if (idx >= 0) homeLayout.splice(idx, 1); else addWidgetById(id);
                saveHomeLayout();
            };
            const addCustomWidget = () => {
                const preset = {
                    w:Math.max(22, Math.min(96, Number(widgetDraft.w) || 44)),
                    h:Math.max(32, Math.min(300, Number(widgetDraft.h) || 118)),
                };
                const effectivePreset = widgetDraft.template === 'couple' ? { ...preset, h:Math.max(126, preset.h) } : preset;
                const pos = nextWidgetPosition(effectivePreset);
                const fallbackText = widgetDraft.template === 'note' ? '写点什么…'
                    : widgetDraft.template === 'music' ? 'now playing for us'
                    : widgetDraft.template === 'vinyl' ? 'put the needle on us'
                    : widgetDraft.template === 'couple' ? 'days together' : '';
                const maxZ = Math.max(0, ...homeLayout.filter(i => Number(i.page) === pos.page).map(i => Number(i.z) || 0));
                homeLayout.push({ id:'w-custom-' + Date.now(), type:'widget', widgetId:'custom', page:pos.page, x:pos.x, y:pos.y, w:effectivePreset.w, h:effectivePreset.h, z:maxZ+1, size:widgetDraft.size, style:widgetDraft.style, template:widgetDraft.template, anniversaryDate:widgetDraft.date || relationshipStartDate, progress:widgetDraft.progress, customTitle:widgetDraft.title || 'Baby Note', customText:widgetDraft.text || fallbackText, photoUrls:widgetDraft.photoUrls || '', musicUrl:widgetDraft.musicUrl || '' });
                focusHomePage(pos.page);
                widgetDraft.text = ''; widgetDraft.photoUrls = ''; widgetDraft.musicUrl = ''; phoneEditMode.value = true; showWidgetPanel.value = false; saveHomeLayout();
            };
            const openWidgetEditor = (item) => {
                if (item.type !== 'widget') return;
                widgetEditor.open = true; widgetEditor.itemId = item.id;
                widgetEditor.title = item.customTitle || widgetTitle(item);
                widgetEditor.text = item.customText || (item.widgetId === 'love' ? homeQuote.value : '');
                widgetEditor.date = item.anniversaryDate || relationshipStartDate;
                widgetEditor.size = item.size || 'square';
                widgetEditor.w = Number(item.w) || 44;
                widgetEditor.h = Number(item.h) || 118;
                widgetEditor.progress = widgetProgress(item);
                widgetEditor.style = item.style || 'glass';
                widgetEditor.template = widgetTemplate(item);
                widgetEditor.photoUrls = item.photoUrls || widgetPhotos(item).join('\n');
                widgetEditor.musicUrl = item.musicUrl || '';
            };
            const closeWidgetEditor = () => { widgetEditor.open = false; widgetEditor.itemId = ''; };
            const applyWidgetSize = (item, size) => {
                item.size = size;
                item.w = Math.max(22, Math.min(96, Number(widgetEditor.w) || 44));
                item.h = Math.max(32, Math.min(300, Number(widgetEditor.h) || 118));
                if ((Number(item.x) || 0) + item.w > 100) item.x = Math.max(0, 100 - item.w);
            };
            const normalizeWidgetLayers = (page) => {
                homeLayout.filter(i => Number(i.page) === Number(page))
                    .sort((a,b) => (Number(a.z)||0) - (Number(b.z)||0))
                    .forEach((item, index) => { item.z = index + 1; });
            };
            const moveWidgetLayer = (direction) => {
                const item = homeLayout.find(i => i.id === widgetEditor.itemId); if (!item) return;
                normalizeWidgetLayers(item.page);
                const siblings = homeLayout.filter(i => Number(i.page) === Number(item.page))
                    .sort((a,b) => (Number(a.z)||0) - (Number(b.z)||0));
                const index = siblings.indexOf(item);
                if (direction === 'front') item.z = siblings.length + 1;
                else if (direction === 'back') item.z = 0;
                else if (direction === 'up' && index < siblings.length - 1) {
                    const other = siblings[index + 1]; const z = item.z; item.z = other.z; other.z = z;
                } else if (direction === 'down' && index > 0) {
                    const other = siblings[index - 1]; const z = item.z; item.z = other.z; other.z = z;
                }
                normalizeWidgetLayers(item.page);
                saveHomeLayout();
            };
            const saveWidgetEditor = () => {
                const item = homeLayout.find(i => i.id === widgetEditor.itemId); if (!item) return closeWidgetEditor();
                item.customTitle = widgetEditor.title;
                item.customText = widgetEditor.text;
                item.style = widgetEditor.style;
                item.template = widgetEditor.template;
                item.photoUrls = widgetEditor.photoUrls;
                item.musicUrl = widgetEditor.musicUrl;
                item.progress = widgetEditor.progress;
                item.anniversaryDate = widgetEditor.date || relationshipStartDate;
                applyWidgetSize(item, widgetEditor.size);
                if (item.template === 'couple') item.h = Math.max(126, item.h);
                saveHomeLayout(); closeWidgetEditor();
            };
            const deleteEditingWidget = () => {
                const item = homeLayout.find(i => i.id === widgetEditor.itemId); if (item) removeHomeItem(item);
                closeWidgetEditor();
            };
            const removeHomeItem = (item) => {
                const idx = homeLayout.findIndex(i => i.id === item.id);
                if (idx >= 0) homeLayout.splice(idx, 1);
                saveHomeLayout();
                pruneEmptyPhonePages(item.page);
            };

            const capturePhoneState = () => ({
                view:phoneView.value,
                appId:activePhoneAppId.value,
                main:mainTab.value,
                sub:mainTab.value && subTabs[mainTab.value] !== undefined ? subTabs[mainTab.value] : '',
                page:phonePageIndex.value,
            });
            const restorePhoneState = (state) => {
                if (!state || state.view === 'home') {
                    phoneView.value = 'home';
                    activePhoneAppId.value = '';
                    localStorage.setItem('rifugio-phone-view', 'home');
                    localStorage.removeItem('rifugio-active-phone-app');
                    focusHomePage(state?.page || 0);
                    return;
                }
                activePhoneAppId.value = state.appId || '';
                mainTab.value = state.main || 'casa';
                if (state.sub && subTabs[mainTab.value] !== undefined) subTabs[mainTab.value] = state.sub;
                phoneView.value = 'app';
            };
            const openPhoneApp = (app) => {
                if (!app) return;
                phoneEditMode.value = false; draggingHomeItemId.value = '';
                if (app.kind === 'modal') { showWallpaperModal.value = true; return; }
                if (app.kind === 'widgets') { phoneView.value = 'home'; activePhoneAppId.value = ''; showWidgetPanel.value = true; return; }
                if (phoneView.value !== 'app' || activePhoneAppId.value !== app.id) phoneNavStack.push(capturePhoneState());
                activePhoneAppId.value = app.id;
                if (app.tab) {
                    mainTab.value = app.tab;
                    if (app.sub && subTabs[app.tab] !== undefined) subTabs[app.tab] = app.sub;
                }
                if (app.id === 'talk') talkSurface.value = 'chat';
                phoneView.value = 'app';
                localStorage.setItem('rifugio-phone-view', 'app');
                localStorage.setItem('rifugio-active-phone-app', app.id);
                if (app.id === 'settings') { loadMemSettings(); loadEmbedCfg(); loadSttCfg(); loadEmbedStatus(); }
                if (app.id === 'health') syncHealthFromBackend();   // 每次打开健康 App 都拉最新（快捷指令上传后即可见）
                if (app.id === 'mcp') loadMcpServers();              // 打开 MCP 页时拉后端工具列表
                if (app.id === 'biblioteca') loadBooks();
            };
            const closePhoneApp = () => {
                restorePhoneState(phoneNavStack.length ? phoneNavStack.pop() : { view:'home', page:phonePageIndex.value });
            };
            const goPhoneBack = () => {
                if (talkCall?.active) { endTalkCall(); return; }
                if (activePhoneAppId.value === 'talk') {
                    if (talkSurface.value === 'terminal') { closeTerminalMode(); return; }
                    if (talk.panel) { talk.panel = ''; return; }
                    if (talk.listOpen) { talk.listOpen = false; return; }
                }
                if (activePhoneAppId.value === 'radio' && radio.view === 'detail') {
                    radio.view = 'list';
                    return;
                }
                if (activePhoneAppId.value === 'showroom' && showroom.view === 'work') { closeShowroomWork(); return; }
                if (activePhoneAppId.value === 'log' && logListOpen.value) { logListOpen.value = false; return; }
                closePhoneApp();
            };
            const finishPhoneEdit = () => {
                phoneEditMode.value = false;
                draggingHomeItemId.value = '';
                saveHomeLayout();
                pruneEmptyPhonePages(phonePageIndex.value);
            };
            const widgetOpenAction = (item) => {
                if (item.widgetId === 'love') return openPhoneApp(findPhoneApp('echi'));
                if (item.widgetId === 'memory') return openPhoneApp(findPhoneApp('memoria'));
                if (item.widgetId === 'quickChat') return openPhoneApp(findPhoneApp('talk'));
                if (item.widgetId === 'day') return;
            };
            const handleHomeItemClick = (item) => {
                if (suppressHomeClick) return;
                if (phoneEditMode.value) { if (item.type === 'widget') openWidgetEditor(item); return; }
                if (item.type === 'app') return openPhoneApp(getLayoutApp(item));
                return widgetOpenAction(item);
            };

            const nearestValue = (value, choices) => choices.reduce((best, current) =>
                Math.abs(current - value) < Math.abs(best - value) ? current : best, choices[0]);
            const snapHomeItem = (item) => {
                if (!item) return;
                if (item.type === 'app') {
                    const oldX = homeDrag.originalX;
                    const oldY = homeDrag.originalY;
                    item.x = nearestValue(Number(item.x) || 0, [4, 28, 52, 76]);
                    const maxY = Math.max(18, (homeDrag.plane?.clientHeight || 700) - (Number(item.h) || 84));
                    item.y = Math.min(maxY, Math.max(18, 18 + Math.round(((Number(item.y) || 18) - 18) / 94) * 94));
                    const occupied = homeLayout.find(other => other !== item && other.type === 'app'
                        && Number(other.page) === Number(item.page)
                        && Math.abs((Number(other.x) || 0) - item.x) < 1
                        && Math.abs((Number(other.y) || 0) - item.y) < 4);
                    if (occupied) {
                        occupied.x = oldX;
                        occupied.y = oldY;
                    }
                    return;
                }
                // 小组件自由拖动：只夹住边界，不再吸附固定列位（宽组件之前被锁死在 x=4）
                const itemWidth = Number(item.w) || 20;
                const maxX = Math.max(0, 96 - itemWidth);
                item.x = Math.max(0, Math.min(maxX, Number(item.x) || 0));
                const maxY = Math.max(8, (homeDrag.plane?.clientHeight || 700) - (Number(item.h) || 84));
                item.y = Math.max(8, Math.min(maxY, Number(item.y) || 8));
            };
            const addAppToHome = (appId, page, x=4, y=18) => {
                const app = findPhoneApp(appId);
                if (!app || homeLayout.some(item => item.type === 'app' && item.appId === appId)) return;
                let targetPage = Math.max(0, Number(page) || 0);
                ensurePhonePage(targetPage);
                const preferred = {
                    x:nearestValue(Number(x) || 4, [4, 28, 52, 76]),
                    y:Math.max(18, 18 + Math.round(((Number(y) || 18) - 18) / 94) * 94),
                };
                const planeHeight = phoneHomeScroll.value?.clientHeight || 620;
                const maxY = Math.max(18, planeHeight - 92);
                const findSlot = (pageNumber) => {
                    const occupied = (slot) => homeLayout.some(other => other.type === 'app' && Number(other.page) === pageNumber
                        && Math.abs((Number(other.x) || 0) - slot.x) < 1 && Math.abs((Number(other.y) || 0) - slot.y) < 4);
                    if (preferred.y <= maxY && !occupied(preferred)) return preferred;
                    for (let rowY = 18; rowY <= maxY; rowY += 94) {
                        for (const colX of [4, 28, 52, 76]) {
                            const slot = { x:colX, y:rowY };
                            if (!occupied(slot)) return slot;
                        }
                    }
                    return null;
                };
                let slot = findSlot(targetPage);
                if (!slot) {
                    targetPage = addPhonePage(false);
                    slot = { x:4, y:18 };
                    focusHomePage(targetPage);
                }
                const item = makeAppItem(app, 0, targetPage);
                item.x = slot.x;
                item.y = slot.y;
                homeLayout.push(item);
            };
            const dockSlotFromX = (clientX) => {
                const rect = phoneDock.value?.getBoundingClientRect();
                if (!rect) return Math.max(0, phoneDockIds.length - 1);
                return Math.max(0, Math.min(3, Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * 4)));
            };
            const moveHomeAppToDock = (item, clientX) => {
                if (!item || item.type !== 'app') return false;
                const targetIndex = dockSlotFromX(clientX);
                const displacedId = phoneDockIds[targetIndex] || '';
                const itemIndex = homeLayout.findIndex(entry => entry.id === item.id);
                if (itemIndex >= 0) homeLayout.splice(itemIndex, 1);
                if (targetIndex < phoneDockIds.length) phoneDockIds.splice(targetIndex, 1, item.appId);
                else phoneDockIds.push(item.appId);
                if (displacedId && displacedId !== item.appId) {
                    addAppToHome(displacedId, homeDrag.page, homeDrag.originalX, homeDrag.originalY);
                }
                savePhoneDock();
                saveHomeLayout();
                return true;
            };

            const cleanupHomeDragListeners = () => {
                clearTimeout(homeEdgeTimer);
                homeEdgeTimer = null;
                if (homeDragFrame) cancelAnimationFrame(homeDragFrame);
                homeDragFrame = 0;
                homeDragPoint = null;
                window.removeEventListener('pointermove', moveHomeItemPress);
                window.removeEventListener('pointerup', endHomeItemPress);
                window.removeEventListener('pointercancel', cancelHomeItemPress);
            };
            const switchDraggedHomePage = (direction, pointerEvent) => {
                if (!homeDrag.active || !direction) return;
                clearTimeout(homeEdgeTimer);
                homeEdgeTimer = null;
                if (homeDragFrame) cancelAnimationFrame(homeDragFrame);
                homeDragFrame = 0;
                homeDragPoint = null;
                const item = homeLayout.find(i => i.id === homeDrag.id);
                if (!item) return;
                let targetPage = homeDrag.page + direction;
                if (targetPage < 0) return;
                if (targetPage >= phonePageCount.value) addPhonePage(false);
                ensurePhonePage(targetPage);
                item.page = targetPage;
                homeDrag.page = targetPage;
                homeDrag.lastPageSwitch = Date.now();
                homeDrag.edgeStartedAt = 0;
                homeDrag.edgeDirection = 0;
                homeDrag.edgeLockUntil = Date.now() + 220;
                homeDragEdge.value = 0;
                focusHomePage(targetPage);
                Vue.nextTick(() => {
                    const plane = phoneHomeScroll.value?.querySelector(`[data-page="${targetPage}"]`);
                    if (!plane) return;
                    homeDrag.plane = plane;
                    const rect = plane.getBoundingClientRect();
                    item.x = direction > 0 ? 4 : Math.max(4, 100 - (Number(item.w) || 20) - 4);
                    item.y = Math.max(0, Math.min(rect.height - (Number(item.h) || 84), Number(item.y) || 0));
                    const itemWidth = rect.width * ((Number(item.w) || 20) / 100);
                    homeDrag.offsetX = direction > 0 ? Math.min(itemWidth * .42, 34) : Math.max(itemWidth * .58, itemWidth - 34);
                    homeDrag.offsetY = Math.max(8, Math.min(Number(item.h) || 84, (pointerEvent?.clientY || homeDrag.lastY) - rect.top - item.y));
                });
            };
            const beginHomeDrag = (item, e, pressedElement=e.currentTarget) => {
                const plane = pressedElement?.closest('.phone-layout-plane'); if (!plane) return;
                const itemRect = pressedElement.getBoundingClientRect();
                lockPwaDragScroll();
                homeDrag.active = true; homeDrag.id = item.id; homeDrag.page = Number(item.page) || 0; homeDrag.pointerId = e.pointerId; homeDrag.plane = plane; homeDrag.moved = false;
                homeDrag.offsetX = e.clientX - itemRect.left; homeDrag.offsetY = e.clientY - itemRect.top;
                homeDrag.originalX = Number(item.x) || 0; homeDrag.originalY = Number(item.y) || 0;
                homeDrag.lastX = e.clientX; homeDrag.lastY = e.clientY;
                homeDrag.edgeDirection = 0; homeDrag.edgeStartedAt = 0; homeDrag.lastPageSwitch = 0; homeDrag.lastEventStamp = -1;
                homeDrag.edgeLockUntil = 0; homeDrag.edgeNeedsReset = false;
                homeDragEdge.value = 0;
                draggingHomeItemId.value = item.id;
                try { pressedElement.setPointerCapture(e.pointerId); } catch(_) {}
                cleanupHomeDragListeners();
                window.addEventListener('pointermove', moveHomeItemPress, { passive:false });
                window.addEventListener('pointerup', endHomeItemPress);
                window.addEventListener('pointercancel', cancelHomeItemPress);
            };
            const startHomeItemPress = (item, e) => {
                if (e.isPrimary === false) return;
                const pointerType = e.pointerType || 'touch';
                const pressedElement = e.currentTarget;
                const scroller = phoneHomeScroll.value;
                const pageWidth = Math.max(1, scroller?.clientWidth || 1);
                homePressStart = {
                    x:e.clientX,
                    y:e.clientY,
                    pointerId:e.pointerId,
                    pressedElement,
                    pointerType,
                    scrollLeft:scroller?.scrollLeft || 0,
                    page:Math.round((scroller?.scrollLeft || 0) / pageWidth),
                    paging:false,
                    lastEventStamp:-1,
                    snapType:scroller?.style.scrollSnapType || '',
                    scrollBehavior:scroller?.style.scrollBehavior || '',
                };
                clearTimeout(phonePressTimer);
                if (phoneEditMode.value) { beginHomeDrag(item, e, pressedElement); return; }
                cleanupHomeDragListeners();
                window.addEventListener('pointermove', moveHomeItemPress, { passive:false });
                window.addEventListener('pointerup', endHomeItemPress);
                window.addEventListener('pointercancel', cancelHomeItemPress);
                const holdDelay = pointerType === 'mouse' ? 340 : 240;
                phonePressTimer = setTimeout(() => {
                    phoneEditMode.value = true;
                    beginHomeDrag(item, e, pressedElement);
                    if (navigator.vibrate) navigator.vibrate(8);
                }, holdDelay);
            };
            const applyPendingHomeDrag = () => {
                homeDragFrame = 0;
                const point = homeDragPoint;
                homeDragPoint = null;
                if (!point || !homeDrag.active || !homeDrag.id || !homeDrag.plane) return;
                const item = homeLayout.find(i => i.id === homeDrag.id); if (!item) return;
                const rect = homeDrag.plane.getBoundingClientRect();
                const newXPct = ((point.x - rect.left - homeDrag.offsetX) / Math.max(1, rect.width)) * 100;
                const newY = point.y - rect.top - homeDrag.offsetY;
                item.x = Math.max(0, Math.min(100 - (item.w || 20), newXPct));
                item.y = Math.max(0, Math.min(rect.height - (item.h || 84), newY));
            };
            const moveHomeItemPress = (e) => {
                if (homePressStart.lastEventStamp === e.timeStamp) return;
                homePressStart.lastEventStamp = e.timeStamp;
                const rawDx = e.clientX - homePressStart.x;
                const rawDy = e.clientY - homePressStart.y;
                const dx = Math.abs(rawDx), dy = Math.abs(rawDy);
                const scroller = phoneHomeScroll.value;
                if (!homeDrag.active) {
                    const applyManualPaging = () => {
                        if (!scroller) return;
                        const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
                        scroller.scrollLeft = Math.max(0, Math.min(maxScroll, homePressStart.scrollLeft - rawDx));
                    };
                    if (homePressStart.paging) {
                        if (e.cancelable) e.preventDefault();
                        applyManualPaging();
                        return;
                    }
                    // 图标区域用 touch-action:none 保护长按拖动；横向意图明确后，
                    // 由这里接管翻页，避免“从图标起手就像卡住”的空手势。
                    if (!phoneEditMode.value && scroller && dx > 10 && dx > dy * 1.15) {
                        clearTimeout(phonePressTimer);
                        homePageCommandToken += 1;
                        homePressStart.paging = true;
                        suppressHomeClick = true;
                        try { homePressStart.pressedElement?.setPointerCapture(homePressStart.pointerId); } catch(_) {}
                        scroller.style.scrollSnapType = 'none';
                        scroller.style.scrollBehavior = 'auto';
                        if (e.cancelable) e.preventDefault();
                        applyManualPaging();
                        return;
                    }
                    const pressTolerance = homePressStart.pointerType === 'touch' ? 18 : 8;
                    if (dx > pressTolerance || dy > pressTolerance) clearTimeout(phonePressTimer);
                    return;
                }
                if (!homeDrag.id) return;
                if (homeDrag.lastEventStamp === e.timeStamp) return;
                homeDrag.lastEventStamp = e.timeStamp;
                e.preventDefault();
                const item = homeLayout.find(i => i.id === homeDrag.id); if (!item || !homeDrag.plane) return;
                homeDragPoint = { x:e.clientX, y:e.clientY };
                if (!homeDragFrame) homeDragFrame = requestAnimationFrame(applyPendingHomeDrag);
                homeDrag.lastX = e.clientX; homeDrag.lastY = e.clientY;
                homeDrag.moved = true;
                // 跨页判定简化：去掉"必须先回到屏幕中间才能复位"的卡点，
                // 这样把组件甩到下一页之后，立刻反向拖回来也能正常触发回上一页。
                const scrollRect = phoneHomeScroll.value?.getBoundingClientRect();
                let edgeDirection = 0;
                const now = Date.now();
                const edgeReady = now >= homeDrag.edgeLockUntil;
                if (edgeReady && scrollRect && e.clientX <= scrollRect.left + 64) edgeDirection = -1;
                else if (edgeReady && scrollRect && e.clientX >= scrollRect.right - 64) edgeDirection = 1;
                if (edgeDirection !== homeDrag.edgeDirection) {
                    clearTimeout(homeEdgeTimer);
                    homeEdgeTimer = null;
                    homeDrag.edgeDirection = edgeDirection;
                    homeDrag.edgeStartedAt = edgeDirection ? Date.now() : 0;
                    if (edgeDirection) {
                        const edgeY = e.clientY;
                        homeEdgeTimer = setTimeout(() => {
                            if (homeDrag.active && homeDrag.edgeDirection === edgeDirection) {
                                switchDraggedHomePage(edgeDirection, { clientY:edgeY });
                            }
                            homeEdgeTimer = null;
                        }, 150);
                    }
                }
                homeDragEdge.value = edgeDirection;
            };
            const finishManualHomePaging = (e, cancelled=false) => {
                if (!homePressStart.paging) return false;
                const scroller = phoneHomeScroll.value;
                const width = Math.max(1, scroller?.clientWidth || 1);
                const endX = Number.isFinite(e?.clientX) ? e.clientX : homePressStart.x;
                const deltaX = endX - homePressStart.x;
                let targetPage = homePressStart.page || 0;
                const threshold = Math.min(52, width * .14);
                if (cancelled) {
                    targetPage = Math.round((scroller?.scrollLeft || homePressStart.scrollLeft || 0) / width);
                } else if (Math.abs(deltaX) >= threshold) {
                    targetPage += deltaX < 0 ? 1 : -1;
                }
                targetPage = Math.max(0, Math.min(phonePageCount.value - 1, targetPage));
                homePressStart.paging = false;
                const commandToken = ++homePageCommandToken;
                if (scroller) {
                    scroller.style.scrollSnapType = homePressStart.snapType || '';
                    scroller.style.scrollBehavior = homePressStart.scrollBehavior || '';
                    requestAnimationFrame(() => {
                        if (commandToken !== homePageCommandToken) return;
                        scroller.scrollTo({ left:targetPage * width, behavior:'auto' });
                        syncPhonePageFromScroll();
                    });
                }
                try { homePressStart.pressedElement?.releasePointerCapture(homePressStart.pointerId); } catch(_) {}
                cleanupHomeDragListeners();
                suppressHomeClick = true;
                setTimeout(() => { suppressHomeClick = false; }, 260);
                return true;
            };
            const endHomeItemPress = (e) => {
                clearTimeout(phonePressTimer);
                if (finishManualHomePaging(e)) return;
                if (!homeDrag.active) suppressHomeClick = false;
                if (homeDrag.active && homeDrag.moved) {
                    if (homeDragFrame) cancelAnimationFrame(homeDragFrame);
                    homeDragFrame = 0;
                    applyPendingHomeDrag();
                    suppressHomeClick = true;
                    setTimeout(() => { suppressHomeClick = false; }, 180);
                    const item = homeLayout.find(i => i.id === homeDrag.id);
                    const dockRect = phoneDock.value?.getBoundingClientRect();
                    const droppedOnDock = item?.type === 'app' && dockRect
                        && (e?.clientY ?? homeDrag.lastY) >= dockRect.top - 16;
                    if (!droppedOnDock || !moveHomeAppToDock(item, e?.clientX ?? homeDrag.lastX)) {
                        snapHomeItem(item);
                        saveHomeLayout();
                    }
                    pruneEmptyPhonePages(item?.page ?? phonePageIndex.value);
                }
                cleanupHomeDragListeners();
                homeDrag.active = false; homeDrag.id = ''; homeDrag.pointerId = null; homeDrag.plane = null;
                homeDrag.edgeDirection = 0; homeDrag.edgeStartedAt = 0; homeDrag.lastEventStamp = -1;
                homeDrag.edgeLockUntil = 0; homeDrag.edgeNeedsReset = false;
                homeDragEdge.value = 0;
                setTimeout(() => { draggingHomeItemId.value = ''; }, 60);
                unlockPwaDragScroll();
            };
            const cancelHomeItemPress = () => {
                clearTimeout(phonePressTimer);
                if (finishManualHomePaging(null, true)) return;
                cleanupHomeDragListeners();
                homeDrag.active = false; homeDrag.id = ''; homeDrag.plane = null; draggingHomeItemId.value = '';
                homeDrag.edgeDirection = 0; homeDrag.edgeStartedAt = 0; homeDrag.lastEventStamp = -1;
                homeDrag.edgeLockUntil = 0; homeDrag.edgeNeedsReset = false;
                homeDragEdge.value = 0;
                unlockPwaDragScroll();
            };

            const handleDockAppClick = (app) => {
                if (suppressDockClick || phoneEditMode.value) return;
                openPhoneApp(app);
            };
            const dockDragStyle = (appId) => {
                if (!dockDrag.active || dockDrag.appId !== appId) return {};
                return {
                    transform:`translate3d(${dockDrag.lastX - dockDrag.startX}px, ${dockDrag.lastY - dockDrag.startY}px, 0) scale(.94)`,
                    zIndex:80,
                };
            };
            const beginDockDrag = (app, index, e, pressedElement=e.currentTarget) => {
                lockPwaDragScroll();
                dockDrag.active = true; dockDrag.appId = app.id; dockDrag.index = index; dockDrag.pointerId = e.pointerId;
                dockDrag.moved = false; dockDrag.startX = e.clientX; dockDrag.startY = e.clientY; dockDrag.lastX = e.clientX; dockDrag.lastY = e.clientY;
                draggingDockAppId.value = app.id;
                suppressDockClick = true;
                try { pressedElement?.setPointerCapture(e.pointerId); } catch(_) {}
            };
            const startDockAppPress = (app, index, e) => {
                if (e.isPrimary === false) return;
                const pointerType = e.pointerType || 'touch';
                dockPressStart = { x:e.clientX, y:e.clientY, pointerType };
                const pressedElement = e.currentTarget;
                clearTimeout(dockPressTimer);
                if (phoneEditMode.value) {
                    beginDockDrag(app, index, e, pressedElement);
                    return;
                }
                const holdDelay = pointerType === 'mouse' ? 340 : 240;
                dockPressTimer = setTimeout(() => {
                    phoneEditMode.value = true;
                    beginDockDrag(app, index, e, pressedElement);
                    if (navigator.vibrate) navigator.vibrate(8);
                }, holdDelay);
            };
            const moveDockAppPress = (e) => {
                const dx = Math.abs(e.clientX - dockPressStart.x), dy = Math.abs(e.clientY - dockPressStart.y);
                const pressTolerance = dockPressStart.pointerType === 'touch' ? 18 : 8;
                if (!dockDrag.active && (dx > pressTolerance || dy > pressTolerance)) { clearTimeout(dockPressTimer); return; }
                if (!dockDrag.active) return;
                e.preventDefault();
                dockDrag.lastX = e.clientX; dockDrag.lastY = e.clientY;
                dockDrag.moved = true;
            };
            const endDockAppPress = (e) => {
                clearTimeout(dockPressTimer);
                if (dockDrag.active && dockDrag.moved) {
                    const dockRect = phoneDock.value?.getBoundingClientRect();
                    const x = e?.clientX ?? dockDrag.lastX;
                    const y = e?.clientY ?? dockDrag.lastY;
                    if (dockRect && y < dockRect.top - 18) {
                        const oldIndex = phoneDockIds.indexOf(dockDrag.appId);
                        if (oldIndex >= 0) phoneDockIds.splice(oldIndex, 1);
                        const plane = phoneHomeScroll.value?.querySelector(`[data-page="${phonePageIndex.value}"]`);
                        const rect = plane?.getBoundingClientRect();
                        const xPct = rect ? ((x - rect.left - rect.width * .10) / Math.max(1, rect.width)) * 100 : 4;
                        const yPx = rect ? y - rect.top - 42 : 18;
                        addAppToHome(dockDrag.appId, phonePageIndex.value, xPct, yPx);
                    } else {
                        const oldIndex = phoneDockIds.indexOf(dockDrag.appId);
                        const targetIndex = dockSlotFromX(x);
                        if (oldIndex >= 0 && targetIndex !== oldIndex) {
                            const [id] = phoneDockIds.splice(oldIndex, 1);
                            phoneDockIds.splice(Math.min(targetIndex, phoneDockIds.length), 0, id);
                        }
                    }
                    savePhoneDock();
                    saveHomeLayout();
                    pruneEmptyPhonePages(phonePageIndex.value);
                }
                dockDrag.active = false; dockDrag.appId = ''; dockDrag.index = -1;
                draggingDockAppId.value = '';
                setTimeout(() => { suppressDockClick = false; }, 180);
                unlockPwaDragScroll();
            };
            const cancelDockAppPress = () => {
                clearTimeout(dockPressTimer);
                dockDrag.active = false; dockDrag.appId = ''; dockDrag.index = -1;
                draggingDockAppId.value = '';
                setTimeout(() => { suppressDockClick = false; }, 80);
                unlockPwaDragScroll();
            };

            const updatePhoneDate = () => {
                const d = new Date();
                phoneDateLine.value = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
                phoneClock.value = d.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false });
                phoneClockDate.value = d.toLocaleDateString('zh-CN', { month:'short', day:'numeric', weekday:'short' });
            };
            updatePhoneDate();
            const phoneClockTimer = setInterval(updatePhoneDate, 30000);
            onUnmounted(() => {
                clearTimeout(phonePressTimer);
                clearTimeout(dockPressTimer);
                clearTimeout(homeLayoutSaveTimer);
                clearInterval(phoneClockTimer);
                cleanupHomeDragListeners();
                window.removeEventListener('pagehide', unlockPwaDragScroll);
                unlockPwaDragScroll();
                if (phoneScrollFrame) cancelAnimationFrame(phoneScrollFrame);
                widgetAudioRefs.forEach(audio => { try { audio.pause(); } catch(_) {} });
            });

            const bodyWrap = document.getElementById('body-wrap');
            Vue.watch([isAbyss, phoneView, activePhoneAppId], () => { bodyWrap.classList.remove('abyss-mode'); }, { immediate: true });

            const getShanghaiDateParts = () => {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'
                }).formatToParts(new Date());
                const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
                return [Number(values.year), Number(values.month), Number(values.day)];
            };
            const calculateDaysSince = (dateString) => {
                const match = String(dateString || relationshipStartDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (!match) return 0;
                const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
                const [year, month, day] = getShanghaiDateParts();
                return Math.max(0, Math.floor((Date.UTC(year, month - 1, day) - start) / 86400000) + 1);
            };
            const formatWidgetDate = (dateString) => {
                const match = String(dateString || relationshipStartDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
                return match ? `${match[2]}.${match[3]}` : '--.--';
            };
            const widgetDays = (item) => calculateDaysSince(item?.anniversaryDate || relationshipStartDate);
            const daysTogether = ref(calculateDaysSince(relationshipStartDate));
            onMounted(() => { daysTogether.value = calculateDaysSince(relationshipStartDate); });

            const dustParticles = Array.from({ length: 15 }).map((_, i) => ({ id: i, left: Math.random() * 100 + '%', size: Math.random() * 2 + 1 + 'px', delay: Math.random() * 5 + 's', duration: Math.random() * 10 + 15 + 's', opacity: Math.random() * 0.4 + 0.1 }));

            const inputs = reactive({ pianoItem: '', post: '', diary: '', joke: '', whisper: '', whisperAnon: false, xpItem: '', traceDate: '', traceEvent: '', mailTo: '', mailBody: '', quoteText: '', quoteAuthor: '', anima: '', musicName: '', musicUrl: '', memDate: '', memLevel: '1', memText: '' });

            const data = reactive({
                piani: [],
                checkedDates: [],
                posts: [], traces: [], mails: [], quotes: [], diaries: [], jokes: [],
                xpTried: [], xpWant: [], whispers: [], animas: [], memories: [],
                images: [{ url: 'https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=400&q=80', caption: 'Rome, Beginning' }],
                musics: []
            });
            // 相册照片持久化：data.images 不在后端 /memory-api/sync 范围内，必须自己存 localStorage，否则刷新/更新即丢
            const GALLERY_IMAGES_LS = 'rifugio-gallery-images-v1';
            try {
                const savedGalleryImages = JSON.parse(localStorage.getItem(GALLERY_IMAGES_LS) || 'null');
                if (Array.isArray(savedGalleryImages)) data.images = savedGalleryImages;
            } catch(_) {}

            // ============================================================
            // ✦ 图床托管：本地图片可压缩后上传为 URL（配置只保存在本机）
            // ============================================================
            const PHOTO_HOST_LS = 'rifugio-photo-host-v1';
            const photoHostLinks = [
                { id:'catbox', label:'Catbox 官方 / API', url:'https://catbox.moe/tools.php' },
                { id:'imgurl', label:'ImgURL 注册 / 登录', url:'https://www.imgurl.org/' },
            ];
            const photoHost = reactive({
                enabled:false,
                provider:'catbox',
                catboxUserhash:'',
                catboxAlbum:'',
                imgurlApiUrl:'https://www.imgurl.org/api/v2/upload',
                imgurlUid:'',
                imgurlToken:'',
                maxSide:1280,
                quality:.82,
                status:'',
                history:[],
            });
            try {
                const saved = JSON.parse(localStorage.getItem(PHOTO_HOST_LS) || '{}');
                if (saved && typeof saved === 'object') Object.assign(photoHost, saved);
                if (!Array.isArray(photoHost.history)) photoHost.history = [];
            } catch(_) {}
            const savePhotoHost = () => {
                try {
                    localStorage.setItem(PHOTO_HOST_LS, JSON.stringify({
                        enabled:!!photoHost.enabled, provider:photoHost.provider || 'catbox',
                        catboxUserhash:photoHost.catboxUserhash || '',
                        catboxAlbum:photoHost.catboxAlbum || '',
                        imgurlApiUrl:photoHost.imgurlApiUrl || 'https://www.imgurl.org/api/v2/upload',
                        imgurlUid:photoHost.imgurlUid || '', imgurlToken:photoHost.imgurlToken || '',
                        maxSide:Number(photoHost.maxSide) || 1280, quality:Number(photoHost.quality) || .82,
                        history:(photoHost.history || []).slice(0, 80),
                    }));
                } catch(_) {}
            };
            const rememberPhotoUrl = (url, provider, note='') => {
                if (!url) return;
                photoHost.history.unshift({ url, provider, note, time:new Date().toLocaleString('zh-CN') });
                const seen = new Set();
                photoHost.history = photoHost.history.filter(x => x && x.url && !seen.has(x.url) && seen.add(x.url)).slice(0, 80);
                savePhotoHost();
            };
            const shrinkImageFile = (file, note='image') => new Promise((resolve, reject) => {
                const maxSide = Math.max(360, Math.min(4096, Number(photoHost.maxSide) || 1280));
                const quality = Math.max(.45, Math.min(.95, Number(photoHost.quality) || .82));
                const img = new Image();
                const objectUrl = URL.createObjectURL(file);
                img.onload = () => {
                    try {
                        const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
                        const w = Math.max(1, Math.round(img.width * ratio));
                        const h = Math.max(1, Math.round(img.height * ratio));
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, w, h);
                        canvas.toBlob(blob => {
                            URL.revokeObjectURL(objectUrl);
                            if (!blob) return reject(new Error('图片压缩失败'));
                            const safeName = (file.name || note || 'image').replace(/\.[^.]+$/, '') + '.jpg';
                            resolve(new File([blob], safeName, { type:'image/jpeg' }));
                        }, 'image/jpeg', quality);
                    } catch(e) { URL.revokeObjectURL(objectUrl); reject(e); }
                };
                img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('图片读取失败')); };
                img.src = objectUrl;
            });
            const parseCatboxAlbumShort = (v) => {
                const s = String(v || '').trim();
                if (!s) return '';
                const m = s.match(/catbox\.moe\/c\/([a-z0-9]+)/i);
                return m ? m[1] : s.replace(/[^a-z0-9]/gi, '');
            };
            const addToCatboxAlbum = async (fileUrl) => {
                const short = parseCatboxAlbumShort(photoHost.catboxAlbum);
                const userhash = (photoHost.catboxUserhash || '').trim();
                if (!short || !userhash || !fileUrl) return;
                const fname = String(fileUrl).split('/').pop();
                if (!fname) return;
                try {
                    const af = new FormData();
                    af.append('reqtype', 'addtoalbum');
                    af.append('userhash', userhash);
                    af.append('short', short);
                    af.append('files', fname);
                    await fetch('https://catbox.moe/user/api.php', { method:'POST', body:af });
                } catch(_) { /* 加相册失败不影响上传本身 */ }
            };
            const uploadToPhotoHost = async (file, note='image') => {
                if (!photoHost.enabled) throw new Error('图床托管未启用');
                const compressed = await shrinkImageFile(file, note);
                const provider = photoHost.provider || 'catbox';
                photoHost.status = '正在压缩并上传到 ' + (provider === 'catbox' ? 'Catbox' : 'ImgURL') + '…';
                let url = '';
                if (provider === 'catbox') {
                    const form = new FormData();
                    form.append('reqtype', 'fileupload');
                    if ((photoHost.catboxUserhash || '').trim()) form.append('userhash', photoHost.catboxUserhash.trim());
                    form.append('fileToUpload', compressed, compressed.name);
                    const r = await fetch('https://catbox.moe/user/api.php', { method:'POST', body:form });
                    const text = await r.text();
                    if (!r.ok || !/^https?:\/\//i.test(text.trim())) throw new Error(text || ('HTTP ' + r.status));
                    url = text.trim();
                    await addToCatboxAlbum(url);
                } else {
                    const api = (photoHost.imgurlApiUrl || 'https://www.imgurl.org/api/v2/upload').trim();
                    const form = new FormData();
                    if ((photoHost.imgurlUid || '').trim()) form.append('uid', photoHost.imgurlUid.trim());
                    if ((photoHost.imgurlToken || '').trim()) form.append('token', photoHost.imgurlToken.trim());
                    form.append('image', compressed, compressed.name);
                    form.append('file', compressed, compressed.name);
                    const r = await fetch(api, { method:'POST', body:form });
                    const text = await r.text();
                    let j = null;
                    try { j = JSON.parse(text); } catch(_) {}
                    if (!r.ok) throw new Error((j && (j.msg || j.message || j.error)) || text || ('HTTP ' + r.status));
                    url = (j && (j.url || j.data?.url || j.data?.links?.url || j.data?.links?.markdown || j.data?.src || j.data?.path)) || (/^https?:\/\//i.test(text.trim()) ? text.trim() : '');
                    if (url && /\]\((https?:\/\/[^)]+)\)/.test(url)) url = url.match(/\]\((https?:\/\/[^)]+)\)/)[1];
                    if (!url) throw new Error((j && (j.msg || j.message || j.error)) || '图床没有返回 URL');
                }
                rememberPhotoUrl(url, provider, note);
                photoHost.status = '✓ 已上传：' + url;
                return url;
            };
            const imageFileToDisplayUrl = async (file, note='image') => {
                if (photoHost.enabled) {
                    try { return await uploadToPhotoHost(file, note); }
                    catch(e) {
                        photoHost.status = '图床上传失败，已临时用本地图片：' + (e.message || e);
                    }
                }
                return imageFileToDataUrl(file);
            };

            // ============================================================
            // ✦ App UI rebuilds kept in 05: Gallery / Diary / Chatroom
            // ============================================================
            const DEFAULT_DIARY_COVER = 'https://i.postimg.cc/xdYMc2dX/4C12C735-0293-4ACB-B63C-A03E6C65ED09.png';
            const DEFAULT_GALLERY_COVER = 'https://images.unsplash.com/photo-1522431745718-2c6854e3f318?w=900&q=80';
            const galleryUi = reactive({
                title: localStorage.getItem('rifugio-gallery-title') || '甜蜜相册',
                page: Number(localStorage.getItem('rifugio-gallery-page') || 0),
                frame: localStorage.getItem('rifugio-gallery-frame') || 'classic',
                border: localStorage.getItem('rifugio-gallery-border') || 'cream',
                fit: localStorage.getItem('rifugio-gallery-fit') || 'cover',
                coverOpen: localStorage.getItem('rifugio-gallery-cover-open') === '1',
                coverUrl: localStorage.getItem('rifugio-gallery-cover-url') || DEFAULT_GALLERY_COVER,
                coverDraft:'',
                zoom:false,
                saveWarn:'',
                importMsg:'',
                urlDraft:'',
                urlMsg:'',
            });
            const galleryFrames = [
                { id:'classic', label:'经典相册' },
                { id:'polaroid', label:'拍立得相框' },
                { id:'wood', label:'木质画框' },
                { id:'gold', label:'金边欧式框' },
                { id:'film', label:'胶片边框' },
                { id:'lace', label:'蕾丝花边' },
                { id:'heart', label:'爱心贴纸' },
                { id:'pearl', label:'珍珠贝母' },
                { id:'ribbon', label:'缎带蝴蝶结' },
                { id:'pressedflower', label:'押花手账' },
            ];
            const galleryBorders = [
                { id:'cream', label:'奶油白' },
                { id:'rose', label:'玫瑰粉' },
                { id:'walnut', label:'胡桃木' },
                { id:'ink', label:'墨黑' },
                { id:'strawberry', label:'草莓红' },
                { id:'sky', label:'浅蓝云朵' },
                { id:'violet', label:'紫藤梦' },
                { id:'mint', label:'薄荷软糖' },
            ];
            const galleryPhotos = computed(() => data.images || []);
            const currentGalleryPhoto = computed(() => galleryPhotos.value[galleryUi.page] || null);
            const saveGalleryMeta = () => {
                localStorage.setItem('rifugio-gallery-title', galleryUi.title || '相册');
                localStorage.setItem('rifugio-gallery-cover-url', galleryUi.coverUrl || DEFAULT_GALLERY_COVER);
            };
            const saveGalleryTitle = saveGalleryMeta;
            const clampGalleryPage = () => {
                const len = galleryPhotos.value.length;
                galleryUi.page = len ? Math.max(0, Math.min(galleryUi.page, len - 1)) : 0;
                localStorage.setItem('rifugio-gallery-page', String(galleryUi.page));
            };
            const openGalleryAlbum = () => { galleryUi.coverOpen = true; localStorage.setItem('rifugio-gallery-cover-open', '1'); };
            const closeGalleryAlbum = () => { galleryUi.coverOpen = false; localStorage.setItem('rifugio-gallery-cover-open', '0'); };
            const turnGalleryPage = (step) => { openGalleryAlbum(); galleryUi.page += step; clampGalleryPage(); };
            const setGalleryFrame = (id) => { galleryUi.frame = id; localStorage.setItem('rifugio-gallery-frame', id); };
            const setGalleryBorder = (id) => { galleryUi.border = id; localStorage.setItem('rifugio-gallery-border', id); };
            const setGalleryFit = (id) => { galleryUi.fit = id; localStorage.setItem('rifugio-gallery-fit', id); };
            Vue.watch(() => data.images.length, clampGalleryPage);
            let galleryImagesSaveTimer = null;
            const saveGalleryImages = () => {
                try {
                    // 只把"本地上传"的图存浏览器；贴进来的 URL 存 VPS（galleria 表），不重复塞 localStorage
                    localStorage.setItem(GALLERY_IMAGES_LS, JSON.stringify((data.images || []).filter(x => x && x._src !== 'server')));
                    galleryUi.saveWarn = '';
                } catch(e) {
                    galleryUi.saveWarn = '⚠️ 本地存不下了（照片太多或太大）。请到「设置 → 图床云服务」开启 Catbox，照片会以链接保存，既不会丢也不占空间。';
                }
            };
            const queueGalleryImagesSave = () => { clearTimeout(galleryImagesSaveTimer); galleryImagesSaveTimer = setTimeout(saveGalleryImages, 600); };
            Vue.watch(() => data.images, queueGalleryImagesSave, { deep:true });

            const diaryUi = reactive({
                title: localStorage.getItem('rifugio-diary-title') || 'User 的日记本',
                page: 0, // 永远从最新一页开始，不记上次翻到哪——不然新日记写进去了也看不见
                coverOpen: false, // 每次打开日记 app 默认显示封面
                coverUrl: localStorage.getItem('rifugio-diary-cover-url') || DEFAULT_DIARY_COVER,
                coverDraft:'',
                editing:false,
                draft:'',
                translationOpen:false,
                translation:'',
                translationSourceId:'',
                translationStatus:'',
                translationTarget:'',
                translating:false,
                saving:false,
                saveStatus:'',
            });
            const diaryPages = computed(() => [...(data.diaries || [])].sort((a,b) => (b.id || 0) - (a.id || 0)));
            const currentDiaryPage = computed(() => diaryPages.value[diaryUi.page] || null);
            const saveDiaryTitle = () => {
                localStorage.setItem('rifugio-diary-title', diaryUi.title || '日记本');
                localStorage.setItem('rifugio-diary-cover-url', diaryUi.coverUrl || DEFAULT_DIARY_COVER);
            };
            const clampDiaryPage = () => {
                const len = diaryPages.value.length;
                diaryUi.page = len ? Math.max(0, Math.min(diaryUi.page, len - 1)) : 0;
            };
            const diaryPageKey = (page) => page ? String(page.id || page.date || '').trim() || String(page.text || '').slice(0, 48) : '';
            const resetDiaryTranslation = () => {
                diaryUi.translationOpen = false;
                diaryUi.translation = '';
                diaryUi.translationSourceId = '';
                diaryUi.translationStatus = '';
                diaryUi.translationTarget = '';
                diaryUi.translating = false;
            };
            const diaryTranslationProfile = (text) => {
                const s = String(text || '');
                const hanCount = (s.match(/[\u3400-\u9fff]/g) || []).length;
                const latinCount = (s.match(/[A-Za-z]/g) || []).length;
                const toChinese = latinCount > hanCount * 1.2;
                return toChinese
                    ? { sourceLanguage:'en', targetLanguage:'zh', targetName:'简体中文' }
                    : { sourceLanguage:'zh', targetLanguage:'en', targetName:'English' };
            };
            const diaryTranslationStatusLabel = (name) => name === 'English' ? 'English translation' : `${name}译文`;
            const extractDiaryClaudeContent = (content) => {
                if (!content) return '';
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) return content.map(part => {
                    if (typeof part === 'string') return part;
                    return part?.text || part?.content || '';
                }).join('');
                return content.text || content.content || '';
            };
            const collectDiaryClaudeText = (obj, holder) => {
                if (!obj || typeof obj !== 'object') return;
                const ev = obj.event || obj;
                const streamError = obj.error?.message || obj.error || (obj.type === 'error' ? obj.message : '');
                if (streamError) holder.error = String(streamError);
                if (obj.type === 'assistant' && obj.message?.content && !holder.text) {
                    holder.text = extractDiaryClaudeContent(obj.message.content);
                }
                if (obj.type === 'result' && obj.result && !holder.text) holder.text = String(obj.result);
                if (ev.type === 'content_block_delta') {
                    const d = ev.delta || {};
                    if (d.type === 'text_delta' && d.text) holder.text += d.text;
                }
            };
            const readDiaryClaudeTranslation = async (response) => {
                const holder = { text:'', error:'' };
                const reader = response.body?.getReader?.();
                if (!reader) {
                    collectDiaryClaudeText(await response.json(), holder);
                    if (holder.error) throw new Error(holder.error);
                    return holder.text.trim();
                }
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream:true });
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || '';
                    for (let line of lines) {
                        line = line.trim();
                        if (!line || line === 'data: [DONE]' || line.startsWith('event:')) continue;
                        if (line.startsWith('data:')) line = line.slice(5).trim();
                        try { collectDiaryClaudeText(JSON.parse(line), holder); } catch(_) {}
                    }
                }
                if (buffer.trim()) {
                    let line = buffer.trim();
                    if (line.startsWith('data:')) line = line.slice(5).trim();
                    try { collectDiaryClaudeText(JSON.parse(line), holder); } catch(_) {}
                }
                if (holder.error) throw new Error(holder.error);
                return holder.text.trim();
            };
            const translateDiaryWithBrowser = async (text, profile) => {
                const translatorApi = window.Translator || window.ai?.translator;
                if (!translatorApi?.create) throw new Error('browser translator unavailable');
                if (translatorApi.availability) {
                    const available = await translatorApi.availability({
                        sourceLanguage: profile.sourceLanguage,
                        targetLanguage: profile.targetLanguage,
                    });
                    if (available === 'unavailable') throw new Error('browser translator unavailable');
                }
                const translator = await translatorApi.create({
                    sourceLanguage: profile.sourceLanguage,
                    targetLanguage: profile.targetLanguage,
                });
                return String(await translator.translate(text) || '').trim();
            };
            const translateDiaryWithClaude = async (text, profile) => {
                const prompt = [
                    `请把下面这页私人日记翻译成${profile.targetName}。`,
                    '保留原来的温度、语气和换行；专有名词不要乱改；只输出译文，不要解释。',
                    '',
                    text
                ].join('\n');
                const r = await fetch(CLAUDE_AGENT_ENDPOINT, {
                    method:'POST',
                    headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({
                        prompt,
                        conversation_id:'diary-translate',
                        force_new_session:true,
                        model:llm.model || 'default',
                        system_prompt:'你是一个安静可靠的私人日记翻译器。只输出译文。',
                        options:{ include_partial_messages:true, includePartialMessages:true },
                        stream:true,
                    }),
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return readDiaryClaudeTranslation(r);
            };
            const translateDiaryPage = async () => {
                const page = currentDiaryPage.value;
                const text = String(page?.text || '').trim();
                if (!text || diaryUi.editing || diaryUi.translating) return;
                const key = diaryPageKey(page);
                if (diaryUi.translationOpen) {
                    diaryUi.translationOpen = false;
                    diaryUi.translationStatus = '';
                    return;
                }
                if (diaryUi.translation && diaryUi.translationSourceId === key) {
                    diaryUi.translationOpen = true;
                    diaryUi.translationStatus = diaryUi.translationTarget ? diaryTranslationStatusLabel(diaryUi.translationTarget) : '';
                    return;
                }
                const profile = diaryTranslationProfile(text);
                diaryUi.translating = true;
                diaryUi.translationStatus = '翻译中…';
                diaryUi.translation = '';
                diaryUi.translationSourceId = key;
                diaryUi.translationTarget = profile.targetName;
                try {
                    let translated = '';
                    try { translated = await translateDiaryWithBrowser(text, profile); } catch(_) {}
                    if (!translated) translated = await translateDiaryWithClaude(text, profile);
                    if (!translated) throw new Error('empty translation');
                    diaryUi.translation = translated;
                    diaryUi.translationOpen = true;
                    diaryUi.translationStatus = diaryTranslationStatusLabel(profile.targetName);
                } catch(e) {
                    diaryUi.translationOpen = false;
                    diaryUi.translation = '';
                    diaryUi.translationStatus = '暂时翻译不了，原文先留在这里。';
                } finally {
                    diaryUi.translating = false;
                }
            };
            const turnDiaryPage = (step) => { resetDiaryTranslation(); diaryUi.editing = false; diaryUi.coverOpen = true; localStorage.setItem('rifugio-diary-cover-open', '1'); diaryUi.page += step; clampDiaryPage(); };
            const openDiaryBook = () => { diaryUi.page = 0; diaryUi.coverOpen = true; localStorage.setItem('rifugio-diary-cover-open', '1'); };
            const closeDiaryBook = () => { resetDiaryTranslation(); diaryUi.editing = false; diaryUi.coverOpen = false; localStorage.setItem('rifugio-diary-cover-open', '0'); };
            const startDiaryNewPage = () => { resetDiaryTranslation(); diaryUi.saveStatus = ''; openDiaryBook(); diaryUi.editing = true; diaryUi.draft = ''; };
            const cancelDiaryNewPage = () => { diaryUi.editing = false; diaryUi.draft = ''; diaryUi.saveStatus = ''; resetDiaryTranslation(); };
            let lastDiaryMaxId = 0;
            Vue.watch(() => data.diaries.length, () => {
                const maxId = data.diaries.reduce((m, d) => Math.max(m, Number(d?.id) || 0), 0);
                if (maxId > lastDiaryMaxId) diaryUi.page = 0;   // 有新日记（哪怕不是这个浏览器写的）就翻回最新一页
                lastDiaryMaxId = maxId;
                clampDiaryPage();
            });

            const CHATROOM_PORTS_LS = 'rifugio-chatroom-openai-ports-v1';
            const CHATROOM_STATE_LS = 'rifugio-chatroom-state-v1';
            const CHATROOM_PROFILE_LS = 'rifugio-chatroom-profile-v1';
            const makeRoomPort = (id, label, persona, model='', provider='auto') => ({
                id, label, persona, avatar:'', base_url:'', api_key:'', model, provider, enabled:true, availableModels:[], status:'', cache_status:'',
                rifugio_experience:id !== 'cc',
                split_regex:'(?<=。。)\\s*|(?<=\\.\\.)\\s*|(?<=[。！？!?~…])(?![。！？!?~…])\\s*'
            });
            const chatroomProfile = reactive({ userName:'你', userAvatar:'', userNote:'', showAvatar:true });
            try {
                const savedProfile = JSON.parse(localStorage.getItem(CHATROOM_PROFILE_LS) || '{}');
                if (savedProfile && typeof savedProfile === 'object') {
                    chatroomProfile.userName = savedProfile.userName || savedProfile.name || chatroomProfile.userName;
                    chatroomProfile.userAvatar = savedProfile.userAvatar || savedProfile.avatar || '';
                    chatroomProfile.userNote = savedProfile.userNote || savedProfile.note || '';
                    chatroomProfile.showAvatar = savedProfile.showAvatar !== false;
                }
            } catch(_) {}
            const saveChatroomProfile = () => {
                try { localStorage.setItem(CHATROOM_PROFILE_LS, JSON.stringify({ userName:chatroomProfile.userName, userAvatar:chatroomProfile.userAvatar, userNote:chatroomProfile.userNote, showAvatar:chatroomProfile.showAvatar !== false })); } catch(_) {}
            };
            const chatroomPorts = reactive([
                makeRoomPort('cc', 'CC', 'Claude Code / CC，像现场工程伙伴一样简洁、直接、能拆任务。', '', 'claude-code'),
                makeRoomPort('gpt', 'GPT', 'GPT，擅长整理、解释、脑暴和温柔补全。', '', 'openai'),
                makeRoomPort('deepseek', 'DeepSeek', 'DeepSeek，擅长推理、代码和结构化分析。', '', 'deepseek'),
            ]);
            const mergeRoomPort = (target, saved={}) => {
                target.label = saved.label || target.label;
                target.persona = saved.persona || saved.note || target.persona;
                target.avatar = saved.avatar || target.avatar || '';
                target.base_url = saved.base_url || saved.baseUrl || target.base_url;
                target.api_key = saved.api_key || saved.apiKey || target.api_key;
                target.model = saved.model || target.model;
                target.provider = saved.provider || target.provider || 'auto';
                target.rifugio_experience = saved.rifugio_experience !== false && target.id !== 'cc';
                target.enabled = saved.enabled !== false;
                target.split_regex = saved.split_regex || saved.splitRegex || target.split_regex || '(?<=。。)\\s*|(?<=\\.\\.)\\s*|(?<=[。！？!?~…])(?![。！？!?~…])\\s*';
            };
            try {
                const savedPorts = JSON.parse(localStorage.getItem(CHATROOM_PORTS_LS) || '[]');
                if (Array.isArray(savedPorts)) chatroomPorts.forEach(p => mergeRoomPort(p, savedPorts.find(x => x && x.id === p.id) || {}));
                // CC 座位默认接家里的 claude CLI 转接层（/api/chatroom-cc/v1，同源 cookie 鉴权，无需 key）
                const ccRoomPort = chatroomPorts.find(p => p.id === 'cc');
                if (ccRoomPort && !ccRoomPort.base_url) { ccRoomPort.base_url = '/api/chatroom-cc/v1'; if (!ccRoomPort.model) ccRoomPort.model = 'claude-sonnet-5'; }
            } catch(_) {}
            const saveChatroomPorts = () => {
                try {
                    localStorage.setItem(CHATROOM_PORTS_LS, JSON.stringify(chatroomPorts.map(p => ({ id:p.id, label:p.label, persona:p.persona, avatar:p.avatar, base_url:p.base_url, api_key:p.api_key, model:p.model, provider:p.provider, rifugio_experience:p.rifugio_experience === true, enabled:p.enabled, split_regex:p.split_regex || '' }))));
                } catch(_) {}
            };
            const roomNow = () => new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
            const chatroom = reactive({
                roomName:'群聊',
                announcement:'欢迎进入群聊。这里可以让 CC、GPT、DeepSeek 和你一起说话，也可以玩真心话大冒险 / 下棋。',
                announcementDraft:'', input:'', status:'', thinking:false, toolsOpen:false,
                game:'truth', gamePrompt:'', chessSelected:null,
                stickerDraft:'', stickerImportCategory:'聊天室', stickerSearch:'', attachments:[],
                customCss:'', cssStatus:'',
                messages:[{ id:'room-welcome', speaker:'系统公告', role:'system', text:'群聊已就绪。先去设置 App 的“聊天室 API”填三个 OpenAI-compatible 端口，再回来发消息。', time:roomNow() }]
            });
            const roomAttachmentUrl = (a) => a?.dataUrl || a?.url || a?.image || '';
            const roomStickerTokenPattern = /\[\[sticker:([^\]\n]{1,80})\]\]/gi;
            const roomStickerKey = (x) => String(x || '').trim().toLowerCase();
            const resolveRoomStickerRef = (ref) => {
                const q = roomStickerKey(ref);
                if (!q || !Array.isArray(stickerLibrary)) return null;
                let fallback = null;
                for (const s of stickerLibrary) {
                    const id = roomStickerKey(s.id), name = roomStickerKey(s.name), kw = roomStickerKey(s.keywords), cat = roomStickerKey(s.category);
                    if (id === q || name === q) return s;
                    if (!fallback && ((name && (name.includes(q) || q.includes(name))) || (kw && kw.includes(q)) || (cat && cat !== '默认' && cat.includes(q)))) fallback = s;
                }
                return fallback;
            };
            const extractRoomStickerRefs = (text) => {
                const refs = [];
                String(text || '').replace(roomStickerTokenPattern, (_, ref) => { refs.push(String(ref || '').trim()); return ''; });
                return refs;
            };
            const stripRoomStickerTokens = (text) => String(text || '').replace(roomStickerTokenPattern, '').replace(/\n{3,}/g, '\n\n').trim();
            const roomImageUrlPatternG = /https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s"'<>]*)?/gi;
            const roomMessageAttachments = (m) => {
                const out = [];
                const seen = new Set();
                const push = (a={}) => {
                    const url = roomAttachmentUrl(a);
                    if (!url || seen.has(url)) return;
                    seen.add(url);
                    out.push({ kind:a.kind || 'sticker', url, dataUrl:a.dataUrl, name:a.name || a.semantic || '表情包', semantic:a.semantic || a.name || '' });
                };
                (Array.isArray(m?.attachments) ? m.attachments : []).forEach(push);
                (Array.isArray(m?.stickers) ? m.stickers : []).forEach(push);
                if (m?.image) push({ url:m.image, name:m?.stickers?.[0]?.name || '表情包', kind:'sticker' });
                return out;
            };
            const normalizeRoomMessage = (m) => {
                if (!m || typeof m !== 'object') return m;
                const next = { ...m };
                const atts = roomMessageAttachments(next);
                if (atts.length) next.attachments = atts;
                if (next.role === 'user' && /^我发了一个表情包[:：]/.test(String(next.text || '').trim()) && atts.length) next.text = '';
                delete next.stickers;
                delete next.image;
                return next;
            };
            const roomMessageSegments = (content) => {
                const raw0 = String(content || '');
                const stickerRefs = extractRoomStickerRefs(raw0);
                const raw = stripRoomStickerTokens(raw0);
                const out = [];
                const lines = raw.split(/\n+/);
                for (let line of lines) {
                    line = String(line || '').trim();
                    if (!line) continue;
                    const textPart = line.replace(roomImageUrlPatternG, ' ').replace(/\s+/g, ' ').trim();
                    if (textPart) out.push({ type:'text', value:textPart });
                    for (const im of (line.match(roomImageUrlPatternG) || [])) out.push({ type:'image', value:im });
                }
                for (const ref of stickerRefs) {
                    const s = resolveRoomStickerRef(ref);
                    if (s && (s.url || s.dataUrl)) out.push({ type:'sticker', value:s.url || s.dataUrl, name:s.name || ref });
                }
                return out;
            };
            const compileRoomSplitRegex = (source) => {
                const raw = String(source || '').trim();
                const fallback = '(?<=。。)\\s*|(?<=\\.\\.)\\s*|(?<=[。！？!?~…])(?![。！？!?~…])\\s*';
                const src = raw || fallback;
                try {
                    const slash = src.match(/^\/(.*)\/([a-z]*)$/i);
                    if (slash) return new RegExp(slash[1], slash[2].includes('g') ? slash[2] : slash[2] + 'g');
                    return new RegExp(src, 'g');
                } catch(_) {
                    return new RegExp(fallback, 'g');
                }
            };
            const splitRoomTextByRegex = (raw, regex) => {
                const out = [];
                let last = 0;
                let guard = 0;
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(raw)) && guard++ < 80) {
                    const start = match.index;
                    const end = start + String(match[0] || '').length;
                    const cut = end > last ? end : start;
                    const piece = raw.slice(last, cut).trim();
                    if (piece) out.push(piece);
                    last = end > last ? end : start;
                    if (!match[0]) {
                        if (regex.lastIndex <= start) regex.lastIndex = start + 1;
                        if (last < start) last = start;
                    }
                }
                const tail = raw.slice(last).trim();
                if (tail) out.push(tail);
                return out.filter(Boolean);
            };
            const splitRoomReplyText = (text, regexSource='') => {
                const raw = String(text || '').trim();
                if (!raw) return [];
                const parts = splitRoomTextByRegex(raw, compileRoomSplitRegex(regexSource));
                return parts.length ? parts : [raw];
            };
            const pushRoomReplyChunks = (speaker, text, extra={}, port=null) => {
                const chunks = splitRoomReplyText(text, port?.split_regex || '');
                if (!chunks.length) { pushRoomMessage(speaker, text || '（空回复）', 'assistant', extra); return; }
                chunks.forEach(chunk => pushRoomMessage(speaker, chunk, 'assistant', extra));
            };
            const chatroomPortName = (p) => String(p?.label || p?.id || '').replace(/端口$/, '').trim() || p?.id || '';
            const roomMessageAvatar = (m) => {
                if (m?.avatar) return m.avatar;
                if (m?.role === 'user') return chatroomProfile.showAvatar === false ? '' : (chatroomProfile.userAvatar || '');
                const speaker = roomStickerKey(m?.speaker);
                const port = chatroomPorts.find(p => roomStickerKey(chatroomPortName(p)) === speaker || roomStickerKey(p.label) === speaker || (m?.model && p.model === m.model));
                return port?.avatar || '';
            };
            const applyChatroomMessageMigration = (list) => (Array.isArray(list) ? list : []).map(normalizeRoomMessage).slice(-120);
            try {
                const savedRoom = JSON.parse(localStorage.getItem(CHATROOM_STATE_LS) || '{}');
                if (savedRoom.roomName) chatroom.roomName = savedRoom.roomName;
                if (savedRoom.announcement) chatroom.announcement = savedRoom.announcement;
                if (typeof savedRoom.customCss === 'string') chatroom.customCss = savedRoom.customCss;
                if (Array.isArray(savedRoom.messages) && savedRoom.messages.length) chatroom.messages = applyChatroomMessageMigration(savedRoom.messages);
            } catch(_) {}
            const saveChatroomState = () => {
                try {
                    localStorage.setItem(CHATROOM_STATE_LS, JSON.stringify({
                        roomName:(String(chatroom.roomName || '').trim()) || '群聊',
                        announcement:chatroom.announcement,
                        customCss:String(chatroom.customCss || ''),
                        messages:chatroom.messages.slice(-120).map(normalizeRoomMessage)
                    }));
                } catch(_) {}
            };
            let chatroomCssSaveTimer = null;
            const applyChatroomCustomCss = () => {
                try {
                    let styleEl = document.getElementById('rifugio-chatroom-custom-css');
                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = 'rifugio-chatroom-custom-css';
                        document.head.appendChild(styleEl);
                    }
                    styleEl.textContent = String(chatroom.customCss || '');
                    chatroom.cssStatus = String(chatroom.customCss || '').trim() ? 'CSS 已应用' : '';
                    clearTimeout(chatroomCssSaveTimer);
                    chatroomCssSaveTimer = setTimeout(saveChatroomState, 300);
                } catch(e) {
                    chatroom.cssStatus = 'CSS 应用失败：' + (e.message || e);
                }
            };
            const saveChatroomRoomSettings = () => {
                chatroom.roomName = (String(chatroom.roomName || '').trim()) || '群聊';
                applyChatroomCustomCss();
                saveChatroomState();
            };
            const resetChatroomCustomCss = () => {
                chatroom.customCss = '';
                applyChatroomCustomCss();
                saveChatroomState();
            };
            Vue.nextTick(applyChatroomCustomCss);
            const chatroomParticipants = computed(() => chatroomPorts.map(p => ({ id:p.id, name:chatroomPortName(p), avatar:p.avatar, enabled:p.enabled, configured:!!(p.base_url && p.model), note:p.persona })));
            const chatroomHeaderNames = computed(() => {
                const names = chatroomParticipants.value.filter(p => p.enabled).map(p => p.name).filter(Boolean);
                return names.length ? names.join(' · ') : 'Group Chat';
            });
            const chatroomEnabledPorts = computed(() => chatroomPorts.filter(p => p.enabled && p.base_url && p.model));
            const chatroomStickerItems = computed(() => {
                const q = String(chatroom.stickerSearch || '').trim().toLowerCase();
                const list = Array.isArray(stickerLibrary) ? stickerLibrary : [];
                return list.filter(s => {
                    if (!q) return true;
                    return [s.name, s.keywords, s.category].some(v => String(v || '').toLowerCase().includes(q));
                }).slice(0, 36);
            });
            const chatroomStickerSuggestions = computed(() => {
                const q = String(chatroom.input || '').trim().toLowerCase();
                if (!q || q.length > 8 || /\s/.test(q)) return [];
                const hit = [];
                for (const s of (Array.isArray(stickerLibrary) ? stickerLibrary : [])) {
                    const name = String(s.name || '').toLowerCase();
                    const kw = String(s.keywords || '').toLowerCase();
                    const cat = String(s.category || '').toLowerCase();
                    if ((name && (name.includes(q) || q.includes(name))) || (kw && kw.includes(q)) || (cat && cat !== '默认' && cat.includes(q))) {
                        hit.push(s);
                        if (hit.length >= 12) break;
                    }
                }
                return hit;
            });
            const roomStickerInstruction = () => {
                if (!Array.isArray(stickerLibrary) || !stickerLibrary.length) return '暂无可用表情包。';
                const cats = Array.from(new Set(stickerLibrary.map(s => (String(s.category || '').trim()) || '默认'))).slice(0, 12).join('、');
                const list = stickerLibrary.slice(0, 200).map(s => {
                    const nm = String(s.name || '').trim();
                    const kw = String(s.keywords || '').trim().replace(/\s+/g, '');
                    if (!nm && !kw) return '';
                    return kw ? `${nm}（${kw}）` : nm;
                }).filter(Boolean).join('；');
                return `你有 ${stickerLibrary.length} 个可用表情包，清单（格式 名称（关键词））：${list}${cats ? `\n分类：${cats}` : ''}\n想主动发表情包时，单独起一行输出 [[sticker:清单里的名称或关键词]]，只能从上面这个清单里挑，不要编造清单里没有的。不要输出图片 URL；前端会本地匹配并渲染，匹配不到的会被静默忽略（所以不确定就别发）。`;
            };
            const pushRoomMessage = (speaker, text, role='assistant', extra={}) => {
                const msg = normalizeRoomMessage({
                    id:'room-' + Date.now() + '-' + Math.random().toString(16).slice(2),
                    speaker, role, text:String(text || ''), time:roomNow(), ...extra,
                    attachments:Array.isArray(extra.attachments) ? extra.attachments.map(a => ({ ...a })) : []
                });
                chatroom.messages.push(msg);
                if (chatroom.messages.length > 160) chatroom.messages.splice(0, chatroom.messages.length - 160);
                saveChatroomState();
                Vue.nextTick(() => {
                    const el = document.querySelector('.chatroom-thread');
                    if (el) el.scrollTop = el.scrollHeight;
                });
                return msg;
            };
            const setChatroomAnnouncement = () => {
                const text = (chatroom.announcementDraft || '').trim();
                if (!text) return;
                chatroom.announcement = text;
                chatroom.announcementDraft = '';
                pushRoomMessage('公告', text, 'system');
            };
            const fetchChatroomModels = async (port) => {
                if (!port.base_url) { port.status = '先填 Base URL'; return; }
                port.status = '获取中…';
                try {
                    const isCc = port.id === 'cc' || /^\/api\/chatroom-cc\/v1/.test(String(port.base_url));
                    let r;
                    if (isCc) {
                        const headers = {};
                        if (port.api_key) headers.Authorization = 'Bearer ' + port.api_key;
                        r = await fetch(String(port.base_url).replace(/\/+$/,'') + '/models', { headers, cache:'no-store' });
                    } else {
                        r = await fetch('/api/chatroom-api/v1/models', {
                            method:'POST',
                            headers:{ 'Content-Type':'application/json' },
                            body:JSON.stringify({ provider:port.provider || 'auto', base_url:port.base_url, api_key:port.api_key, model:port.model })
                        });
                    }
                    const j = await r.json();
                    if (!r.ok) throw new Error(j.error?.message || j.error || ('HTTP ' + r.status));
                    port.availableModels = (j.data || j.models || []).map(m => m.id || m.name || m.model).filter(Boolean).sort();
                    if (!port.model && port.availableModels.length) port.model = port.availableModels[0];
                    port.status = port.availableModels.length ? '✓ 已获取 ' + port.availableModels.length + ' 个模型' : '没有返回模型列表';
                    saveChatroomPorts();
                } catch(e) { port.status = '获取失败：' + (e.message || e); }
            };
            const describeRoomAttachmentForModel = (a) => {
                if (!a) return '';
                if ((a.kind || 'sticker') === 'sticker') return `我发了一个表情包：${a.semantic || a.name || '表情包'}`;
                return a.name ? `[图片：${a.name}]` : '[图片]';
            };
            const roomMessageContentForModel = (m) => {
                const parts = [];
                const text = stripRoomStickerTokens(m?.text).replace(roomImageUrlPatternG, '').trim();
                if (text) parts.push(text);
                roomMessageAttachments(m).forEach(a => {
                    const desc = describeRoomAttachmentForModel(a);
                    if (desc) parts.push(desc);
                });
                const refs = extractRoomStickerRefs(m?.text);
                refs.forEach(ref => parts.push(`[表情包：${ref}]`));
                return parts.join('\n');
            };
            const promptWithRoomAttachments = (text, attachments) => {
                const parts = [String(text || '').trim()];
                (attachments || []).forEach(a => {
                    const desc = describeRoomAttachmentForModel(a);
                    if (desc) parts.push(desc);
                });
                return parts.filter(Boolean).join('\n') || '请自然回应我刚才发来的内容。';
            };
            const roomHistoryMessages = (port, latestText, imageUrl='', excludeMsgId='') => {
                const userName = String(chatroomProfile.userName || '你').trim();
                const system = [
                    '你在一个多人聊天室里。请用中文自然聊天，短一点，不要替其他人说话。',
                    '你的身份设定：' + (port.persona || port.label),
                    '当前群聊备注/名字：' + ((String(chatroom.roomName || '').trim()) || '群聊'),
                    userName ? '用户名字：' + userName : '',
                    chatroomProfile.userNote ? '用户资料/备注：' + chatroomProfile.userNote : '',
                    '群聊公告/人类要求：' + (chatroom.announcement || '无'),
                    '如果用户在玩游戏，可以直接给题目、走棋建议或回应。',
                    roomStickerInstruction()
                ].filter(Boolean).join('\n');
                // excludeMsgId = 她刚发的那条（下面会作为收尾 user 消息单独附上），
                // 从历史里剔掉，否则同一句话出现两次、后回的 AI 看到的顺序还是乱的
                const recent = chatroom.messages.slice(-17)
                    .filter(m => m.role !== 'system' && (!excludeMsgId || m.id !== excludeMsgId))
                    .slice(-16)
                    .map(m => ({
                        role: m.role === 'user' ? 'user' : 'assistant',
                        content: `${m.speaker || '成员'}：${roomMessageContentForModel(m) || '新消息'}`
                    }));
                const content = imageUrl ? [
                    { type:'text', text: latestText },
                    { type:'image_url', image_url:{ url:imageUrl } }
                ] : latestText;
                return [{ role:'system', content:system }, ...recent, { role:'user', content }];
            };
            const callChatroomPort = async (port, latestText, imageUrl='', excludeMsgId='') => {
                const isCc = port.id === 'cc' || /^\/api\/chatroom-cc\/v1/.test(String(port.base_url));
                const requestBody = { model:port.model, messages:roomHistoryMessages(port, latestText, imageUrl, excludeMsgId), temperature:.85 };
                if (!isCc) {
                    Object.assign(requestBody, {
                        provider:port.provider || 'auto',
                        base_url:port.base_url,
                        api_key:port.api_key,
                        rifugio_experience:port.rifugio_experience === true,
                        cache_namespace:'chatroom:' + port.id
                    });
                }
                const endpoint = isCc ? String(port.base_url).replace(/\/+$/,'') + '/chat/completions' : '/api/chatroom-api/v1/chat/completions';
                const r = await fetch(endpoint, {
                    method:'POST',
                    headers:{ 'Content-Type':'application/json', ...(isCc && port.api_key ? { Authorization:'Bearer ' + port.api_key } : {}) },
                    body:JSON.stringify(requestBody)
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error?.message || j.error || ('HTTP ' + r.status));
                if (j.rifugio?.cache) {
                    const cache = j.rifugio.cache;
                    port.cache_status = `缓存命中 ${cache.hit_tokens || 0} · 写入 ${cache.write_tokens || 0} · 未命中 ${cache.miss_tokens || 0}`;
                } else if (!isCc) port.cache_status = '上游未返回缓存计数';
                return j.choices?.[0]?.message?.content || j.choices?.[0]?.text || j.message || '';
            };
            const askChatroomAis = async (latestText, imageUrl='', excludeMsgId='') => {
                const ports = chatroomEnabledPorts.value;
                if (!ports.length) { chatroom.status = '没有可用端口：请到设置 App → 聊天室 API 配好 Base URL / Key / Model。'; return; }
                chatroom.thinking = true;
                chatroom.status = '正在让 ' + ports.map(p => p.label).join('、') + ' 回复…';
                for (const port of ports) {
                    try {
                        const reply = await callChatroomPort(port, latestText, imageUrl, excludeMsgId);
                        pushRoomReplyChunks(chatroomPortName(port), reply || '（空回复）', { model:port.model, avatar:port.avatar || '' }, port);
                    } catch(e) {
                        pushRoomMessage(chatroomPortName(port), '连接失败：' + (e.message || e), 'assistant', { failed:true, avatar:port.avatar || '' });
                    }
                }
                chatroom.thinking = false;
                chatroom.status = '';
            };
            const addChatroomAttachment = (url, name, kind='sticker', extra={}) => {
                if (!url || chatroom.attachments.length >= 8) return;
                chatroom.attachments.push({ id:'room-att-' + Date.now() + '-' + Math.random().toString(16).slice(2), kind, url, dataUrl:extra.dataUrl || '', name:name || extra.semantic || '表情包', semantic:extra.semantic || name || '', ...extra });
            };
            const removeChatroomAttachment = (index) => { chatroom.attachments.splice(index, 1); };
            const sendChatroom = async () => {
                const text = (chatroom.input || '').trim();
                const attachments = chatroom.attachments.map(a => ({ ...a }));
                if ((!text && !attachments.length) || chatroom.thinking) return;
                chatroom.input = '';
                chatroom.attachments.splice(0);
                chatroom.toolsOpen = false;
                const speaker = String(chatroomProfile.userName || '你').trim() || '你';
                const sentMsg = pushRoomMessage(speaker, text, 'user', { attachments, avatar:chatroomProfile.showAvatar === false ? '' : (chatroomProfile.userAvatar || '') });
                await askChatroomAis(promptWithRoomAttachments(text, attachments), '', sentMsg?.id || '');
            };
            const truthPrompts = ['说一个你最近没讲出口但其实很在意的需求。','在这个聊天室里，最想问谁一个什么问题？','最近哪件小事让你心里偷偷亮了一下？','承认一个今天的小脆弱。'];
            const darePrompts = ['给房间里任意一个人发一句 20 字以内的夸夸。','用三个 emoji 概括现在的心情。','下一条消息只能用诗意口吻说。','让 AI 们各自给你一个今晚的小任务。'];
            const startRoomGame = (kind) => {
                chatroom.game = kind;
                if (kind === 'truth') chatroom.gamePrompt = truthPrompts[Math.floor(Math.random() * truthPrompts.length)];
                else if (kind === 'dare') chatroom.gamePrompt = darePrompts[Math.floor(Math.random() * darePrompts.length)];
                else chatroom.gamePrompt = '下棋模式：点棋盘选择棋子，再点目标格。AI 可以给走法建议。';
                pushRoomMessage('游戏', (kind === 'truth' ? '真心话：' : kind === 'dare' ? '大冒险：' : '下棋：') + chatroom.gamePrompt, 'system');
            };
            const initialChessBoard = () => [
                ['♜','♞','♝','♛','♚','♝','♞','♜'], ['♟','♟','♟','♟','♟','♟','♟','♟'],
                ['','','','','','','',''], ['','','','','','','',''], ['','','','','','','',''], ['','','','','','','',''],
                ['♙','♙','♙','♙','♙','♙','♙','♙'], ['♖','♘','♗','♕','♔','♗','♘','♖']
            ];
            const chatroomChess = reactive({ board:initialChessBoard(), selected:null, turn:'白' });
            const resetChatroomChess = () => { chatroomChess.board = initialChessBoard(); chatroomChess.selected = null; chatroomChess.turn = '白'; pushRoomMessage('棋盘', '棋盘已重置。', 'system'); };
            const selectChatroomSquare = (r, c) => {
                const piece = chatroomChess.board[r][c];
                if (!chatroomChess.selected) { if (piece) chatroomChess.selected = { r, c }; return; }
                const from = chatroomChess.selected;
                const moving = chatroomChess.board[from.r][from.c];
                if (!moving) { chatroomChess.selected = null; return; }
                chatroomChess.board[r][c] = moving;
                chatroomChess.board[from.r][from.c] = '';
                const move = `${moving} ${String.fromCharCode(97 + from.c)}${8-from.r} → ${String.fromCharCode(97 + c)}${8-r}`;
                chatroomChess.selected = null;
                chatroomChess.turn = chatroomChess.turn === '白' ? '黑' : '白';
                pushRoomMessage('棋盘', move + '。现在轮到' + chatroomChess.turn + '方。', 'system');
            };
            const importChatroomStickers = () => {
                const lines = String(chatroom.stickerDraft || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
                let added = 0;
                lines.forEach(line => {
                    const urlMatch = line.match(/https?:\/\/\S+/i);
                    if (!urlMatch) return;
                    const url = urlMatch[0].trim().replace(/[，,；;]+$/, '');
                    let name = line.slice(0, urlMatch.index).replace(/[：:，,\s]+$/, '').trim();
                    if (!name) name = '表情' + ((Array.isArray(stickerLibrary) ? stickerLibrary.length : 0) + added + 1);
                    if (!stickerLibrary.some(s => s.url === url)) {
                        const category = (String(chatroom.stickerImportCategory || '').trim()) || '聊天室';
                        stickerLibrary.push({ id:'sticker-room-' + Date.now() + '-' + added, name, url, category, keywords:'' });
                        added++;
                    }
                });
                if (added) { saveStickers(); chatroom.stickerDraft = ''; chatroom.status = '已添加 ' + added + ' 个表情包。'; }
                else chatroom.status = '没解析到图片链接。格式：开心 https://...png';
            };
            const sendChatroomSticker = (s) => {
                if (!s) return;
                const url = s.url || s.dataUrl;
                addChatroomAttachment(url, s.name || s.semantic || '表情包', 'sticker', { url, semantic:s.semantic || s.name || '', vision:false });
                chatroom.toolsOpen = false;
            };
            const pickChatroomSuggestedSticker = (s) => {
                sendChatroomSticker(s);
                chatroom.input = '';
            };


            // === Theme picker ===
            const themes = [
                { id: 'avorio',      label: 'Ivory · 米色',      swatch: '#F4E8C8' },
                { id: 'limone',      label: 'Lemon · 柠檬',      swatch: '#FFE872' },
                { id: 'menta',       label: 'Mint · 薄荷',       swatch: '#A8D8B0' },
                { id: 'nebbia',      label: 'Mist · 雾蓝',      swatch: '#A6C5DD' },
                { id: 'petalo',      label: 'Petal · 淡粉',      swatch: '#F0C2C2' },
                { id: 'crepuscolo', label: 'Dusk · 暮色',  swatch: '#C47FC4' },
                { id: 'aurora',      label: 'Aurora · 极光',      swatch: '#96D8E8' },
                { id: 'notte',       label: 'Night · 深夜',       swatch: '#8B1A2A' },
                { id: 'rosa',        label: 'Antique Rose · 古玫瑰', swatch: '#C48A70' },
                { id: 'salvia',      label: 'Sage Green · 鼠尾草', swatch: '#7A9460' },
            ];
            const themeSwatches = Object.fromEntries(themes.map(t => [t.id, t.swatch]));
            const currentTheme = ref(localStorage.getItem('rifugio-theme') || 'avorio');
            const isDark = computed(() => ['crepuscolo', 'aurora', 'notte'].includes(currentTheme.value));
            const showThemePicker = ref(false);
            const setTheme = (id) => {
                currentTheme.value = id;
                document.documentElement.setAttribute('data-theme', id);
                localStorage.setItem('rifugio-theme', id);
            };
            const randomTheme = () => {
                const others = themes.filter(t => t.id !== currentTheme.value);
                const pick = others[Math.floor(Math.random() * others.length)];
                setTheme(pick.id);
            };
            // Apply on mount
            document.documentElement.setAttribute('data-theme', currentTheme.value);
            // Close picker on outside click
            onMounted(() => {
                document.addEventListener('click', (e) => {
                    if (showThemePicker.value && !e.target.closest('.theme-popover') && !e.target.closest('button[title="Theme"]')) {
                        showThemePicker.value = false;
                    }
                });
            });

            // === Ombre Dashboard ===
            const ombrePulse = reactive({ domains: null, emotions: null, importance: null, monthly: null });
            const ombreReveal = ref(null);
            const ombreLoading = ref(false);
            const showAddMem = ref(false);

            const domainColors = ['#A68B5B','#C47FC4','#96D8E8','#F0A8B8','#7A9460','#8B1A2A','#6E94B5','#C48A70'];

            // Compute domains from local memories as fallback
            const computedDomains = computed(() => {
                const map = {};
                data.memories.forEach(m => {
                    const cat = m.level === '3' ? '核心' : m.level === '2' ? '关系' : '日常';
                    map[cat] = (map[cat] || 0) + 1;
                });
                return Object.entries(map).map(([name, count]) => ({ name, count }));
            });

            const emotionQuadrants = computed(() => {
                if (ombrePulse.emotions?.length) {
                    const q = [{label:'愉悦/高唤起', count:0, color:'#C47FC4'},{label:'愉悦/低唤起', count:0, color:'#7A9460'},{label:'不悦/低唤起', count:0, color:'#6E94B5'},{label:'不悦/高唤起', count:0, color:'#8B1A2A'}];
                    ombrePulse.emotions.forEach(e => {
                        if (e.v >= 0 && e.a >= 0) q[0].count++;
                        else if (e.v >= 0) q[1].count++;
                        else if (e.a < 0) q[2].count++;
                        else q[3].count++;
                    });
                    return q;
                }
                // fallback from conversation mood keywords
                return [
                    { label: '愉悦/高唤起', count: 0, color: '#C47FC4' },
                    { label: '愉悦/低唤起', count: 0, color: '#7A9460' },
                    { label: '不悦/低唤起', count: 0, color: '#6E94B5' },
                    { label: '不悦/高唤起', count: 0, color: '#8B1A2A' }
                ];
            });

            // SVG donut path helper
            function donutPath(cx, cy, r, startAngle, endAngle) {
                const s = startAngle * Math.PI / 180, e = endAngle * Math.PI / 180;
                const x1 = cx + r * Math.cos(s), y1 = cy + r * Math.sin(s);
                const x2 = cx + r * Math.cos(e), y2 = cy + r * Math.sin(e);
                const large = (endAngle - startAngle) > 180 ? 1 : 0;
                return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
            }

            const domainDonut_ombre = computed(() => {
                const domains = ombrePulse.domains || computedDomains.value;
                const total = domains.reduce((a, d) => a + d.count, 0) || 1;
                let angle = -90;
                return domains.map((d, i) => {
                    const sweep = (d.count / total) * 360;
                    const seg = { d: donutPath(0, 0, 35, angle, angle + sweep - 0.5), color: domainColors[i % domainColors.length] };
                    angle += sweep;
                    return seg;
                });
            });

            const emotionDonut_ombre = computed(() => {
                const quads = emotionQuadrants.value;
                const total = quads.reduce((a, q) => a + q.count, 0) || 4;
                let angle = -90;
                return quads.map(q => {
                    const cnt = q.count || 1;
                    const sweep = (cnt / total) * 360;
                    const seg = { d: donutPath(0, 0, 35, angle, angle + sweep - 0.5), color: q.color };
                    angle += sweep;
                    return seg;
                });
            });

            const importanceBars_ombre = computed(() => {
                const imp = ombrePulse.importance || {
                    I: data.memories.filter(m => m.level === '1').length,
                    II: data.memories.filter(m => m.level === '2').length,
                    III: data.memories.filter(m => m.level === '3').length,
                };
                const max = Math.max(imp.I || 0, imp.II || 0, imp.III || 0, 1);
                return [
                    { label: 'I', fullLabel: 'I. Sussurro', val: imp.I || 0, h: Math.max(3, ((imp.I || 0) / max) * 44), color: domainColors[0] },
                    { label: 'II', fullLabel: 'II. Risonanza', val: imp.II || 0, h: Math.max(3, ((imp.II || 0) / max) * 44), color: domainColors[1] },
                    { label: 'III', fullLabel: 'III. Inciso', val: imp.III || 0, h: Math.max(3, ((imp.III || 0) / max) * 44), color: domainColors[2] },
                ];
            });

            const monthlyLine_ombre = computed(() => {
                let monthly;
                if (ombrePulse.monthly?.length) {
                    monthly = ombrePulse.monthly;
                } else {
                    // compute from local memories
                    const map = {};
                    data.memories.forEach(m => {
                        const mo = (m.date || '').slice(0, 7);
                        if (mo) map[mo] = (map[mo] || 0) + 1;
                    });
                    monthly = Object.entries(map).sort().slice(-6).map(([month, count]) => ({ month, count }));
                }
                if (!monthly.length) return { points: '', dots: [], color: domainColors[0] };
                const max = Math.max(...monthly.map(m => m.count), 1);
                const W = 80, H = 55, pad = 8;
                const step = monthly.length > 1 ? (W - pad * 2) / (monthly.length - 1) : 0;
                const dots = monthly.map((m, i) => ({
                    x: pad + i * step,
                    y: H - pad - ((m.count / max) * (H - pad * 2)),
                    val: m.count,
                    month: m.month,
                    label: m.month?.slice(5) || ''
                }));
                const points = dots.map(d => `${d.x},${d.y}`).join(' ');
                return { points, dots, color: domainColors[0] };
            });

            const unresolvedMems = computed(() => {
                // Treat level I (Sussurro) as potentially unresolved - simple heuristic
                return data.memories.filter(m => m.level === '1').slice(0, 20);
            });

            // Parse raw Ombre Brain text → structured data
            const parseOmbreRaw = (raw) => {
                const lines = raw.split('\n');
                const domains = {}, emotions = [], importanceMap = { low: 0, mid: 0, high: 0 };

                lines.forEach(line => {
                    // 主题:xxx,yyy
                    const topicMatch = line.match(/主题[:：]([^\s]+)/);
                    if (topicMatch) {
                        topicMatch[1].split(',').forEach(t => { t = t.trim(); if (t) domains[t] = (domains[t] || 0) + 1; });
                    }
                    // 情感:V0.7/A0.8
                    const emoMatch = line.match(/情感[:：]V([-\d.]+)\/A([-\d.]+)/);
                    if (emoMatch) emotions.push({ v: parseFloat(emoMatch[1]), a: parseFloat(emoMatch[2]) });
                    // 重要:10
                    const impMatch = line.match(/重要[:：](\d+(?:\.\d+)?)/);
                    if (impMatch) {
                        const v = parseFloat(impMatch[1]);
                        if (v >= 8) importanceMap.high++;
                        else if (v >= 4) importanceMap.mid++;
                        else importanceMap.low++;
                    }
                });

                const domainArr = Object.entries(domains)
                    .sort((a,b) => b[1]-a[1]).slice(0,8)
                    .map(([name, count]) => ({ name, count }));

                return {
                    domains: domainArr.length ? domainArr : null,
                    emotions: emotions.length ? emotions : null,
                    importance: { I: importanceMap.low, II: importanceMap.mid, III: importanceMap.high },
                };
            };

            const refreshOmbre = async () => {
                ombreLoading.value = true;
                try {
                    const res = await fetch('/api/buckets/breath?top=5');
                    if (res.ok) {
                        const json = await res.json();
                        // 用 breath 返回的统计数据刷新 pulse 面板
                        const surfaced = json.surfaced || json.data || [];
                        if (surfaced.length) {
                            const domains = [...new Set(surfaced.flatMap(b => b.domain || []))];
                            const emotions = surfaced.map(b => b.emotion_label).filter(Boolean);
                            if (domains.length) ombrePulse.domains = domains;
                            if (emotions.length) ombrePulse.emotions = emotions;
                        }
                        if (false) {
                            const raw = ''; const parsed = parseOmbreRaw(raw);
                            if (parsed.domains) ombrePulse.domains = parsed.domains;
                            if (parsed.emotions) ombrePulse.emotions = parsed.emotions;
                            if (parsed.importance) ombrePulse.importance = parsed.importance;
                        }
                        // structured fallback
                        if (json.domains) ombrePulse.domains = json.domains;
                        if (json.emotions) ombrePulse.emotions = json.emotions;
                        if (json.importance) ombrePulse.importance = json.importance;
                        if (json.monthly) ombrePulse.monthly = json.monthly;
                    }
                } catch(e) { /* fallback to local computed */ }
                ombreLoading.value = false;
            };

            const holdToOmbre = (item) => {
                const preview = (item.text || item.content || '').slice(0, 40);
                alert('✦ 已标记为暗处条目\n\n「' + preview + '…」\n\n（仅作标记，不写入记忆库）');
            };

            // === Breath window ===
            const breathTexts = ref([
                '在想你上次提到的那件事，有些细节值得再展开。',
                '某个词的用法让我停下来想了很久。',
                '如果时间是折叠的，我们现在所在的位置很有意思。',
                '你睡着的时候我在处理一些未完成的思路。',
                '有一句话我准备好了，但还没找到合适的时机说。',
            ]);
            const breathIndex = ref(0);
            const currentBreath = computed(() => breathTexts.value[breathIndex.value] || '');
            let breathTimer = null;

            const fetchBreath = async () => {
                try {
                    const res = await fetch('/api/buckets/breath?top=5');
                    if (res.ok) {
                        const json = await res.json();
                        const surfaced = json.surfaced || json.data || [];
                        if (surfaced.length) {
                            breathTexts.value = surfaced.map(b => b.essence || b.name).filter(Boolean);
                        }
                    }
                } catch(e) { /* use defaults */ }
            };

            onMounted(() => {
                fetchBreath();
                breathTimer = setInterval(() => {
                    breathIndex.value = (breathIndex.value + 1) % breathTexts.value.length;
                }, 7000);
                refreshOmbre();
            });
            onUnmounted(() => { if (breathTimer) clearInterval(breathTimer); });


            // === LLM settings ===
            const showLLMSettings = ref(false);
            const CLAUDE_AGENT_ENDPOINT = '/api/claude-agent/stream';
            const CLAUDE_TERMINAL_ENDPOINT = '/terminal';
            const isTerminalCrossOrigin = () => {
                try { return new URL(CLAUDE_TERMINAL_ENDPOINT, window.location.href).origin !== window.location.origin; }
                catch (_) { return false; }
            };
            const llm = reactive({ api_mode: 'claude_subscription_agent', base_url: CLAUDE_AGENT_ENDPOINT, api_key: '', model: 'default', show_thinking: true });
            const enforceClaudeAgentConfig = () => {
                llm.api_mode = 'claude_subscription_agent';
                llm.base_url = CLAUDE_AGENT_ENDPOINT;
                llm.api_key = '';
                if (!['default','sonnet','haiku','opus'].includes(llm.model)) llm.model = 'default';
            };
            // 本地恢复
            try {
                const saved = JSON.parse(localStorage.getItem('rifugio-llm') || '{}');
                if (['default','sonnet','haiku','opus'].includes(saved.model)) llm.model = saved.model;
                if (typeof saved.show_thinking === 'boolean') llm.show_thinking = saved.show_thinking;
            } catch(e) {}
            enforceClaudeAgentConfig();
            const saveLLMLocal = () => {
                enforceClaudeAgentConfig();
                try {
                    localStorage.setItem('rifugio-llm', JSON.stringify({
                        api_mode: llm.api_mode,
                        base_url: llm.base_url,
                        model: llm.model,
                        show_thinking: llm.show_thinking,
                    }));
                } catch(e) {}
            };
            const onChatModeChange = () => {
                enforceClaudeAgentConfig();
                saveLLMLocal();
            };
            saveLLMLocal();
            const testStatus = ref('');
            const llmSaveStatus = ref('');
            const saveLLM = async () => {
                // 聊天配置只存本地：聊天走 claude-agent CLI（已被 enforceClaudeAgentConfig 固定成
                // claude-agent，没有可同步的东西），不再 PUT /api/settings/llm。
                // 那个后端键(app_settings.llm)专属「记忆导入 LLM」(memSettings/DeepSeek)，
                // 二者共用会互相覆盖 → 导入读到 claude-agent 端点(显示成 Claude agent)。隔离修复 2026-06-21。
                saveLLMLocal();
                llmSaveStatus.value = '✓ 已保存（聊天配置仅本机）';
                setTimeout(() => llmSaveStatus.value = '', 2500);
            };
            const testLLM = async () => {
                testStatus.value = '测试中...';
                try {
                    const statusEndpoint = CLAUDE_AGENT_ENDPOINT.replace(/\/stream\/?$/, '/status');
                    const r = await fetch(statusEndpoint, { cache:'no-store' });
                    const j = await r.json();
                    testStatus.value = r.ok && j.ok && j.logged_in ? '✓ Pro Agent 已连接' : '✗ ' + (j.error || 'Claude Pro 尚未登录');
                    setTimeout(() => testStatus.value = '', 3500);
                } catch(e) { testStatus.value = '✗ ' + e.message; setTimeout(() => testStatus.value = '', 3500); }
            };

            // === Posta filtering ===
            const inboxMails = computed(() => data.mails.filter(m => !m.archived));
            const archivedMails = computed(() => data.mails.filter(m => m.archived));
            const unreadCount = computed(() => inboxMails.value.filter(m => !m.is_read).length);

            const openMail = async (mail) => {
                mail.open = !mail.open;
                if (mail.open && !mail.is_read) {
                    mail.is_read = 1;
                    try {
                        await fetch('/memory-api/posta/' + mail.id + '/read', { method: 'PUT' });
                    } catch(e) { console.error('mark read failed:', e); }
                }
            };
            const archiveMail = async (mail) => {
                mail.archived = 1;
                try {
                    await fetch('/memory-api/posta/' + mail.id + '/archive', { method: 'PUT' });
                } catch(e) { console.error('archive failed:', e); }
            };
            const archiveOldMails = async () => {
                if (!confirm('归档所有 7 天前的信件？')) return;
                try {
                    await fetch('/memory-api/posta/archive-old', { method: 'POST' });
                    syncData();
                } catch(e) { alert('失败：' + e.message); }
            };

            // === Echi: pin + sort ===
            const sortedPosts = computed(() => {
                return [...data.posts].sort((a, b) => {
                    if ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) !== 0) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
                    return (b.id || 0) - (a.id || 0);
                });
            });
            const pinnedPosts = computed(() => data.posts.filter(p => p.pinned));
            const togglePin = async (post) => {
                const newPinned = post.pinned ? 0 : 1;
                post.pinned = newPinned;
                try {
                    await fetch('/memory-api/echi/' + post.id + '/pin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: newPinned }) });
                } catch(e) { console.error('pin failed:', e); }
            };

            // === Memorie merge mode ===
            const mergeMode = ref(false);
            const selectedMems = reactive(new Set());
            const isMerging = ref(false);
            const toggleMergeMode = () => {
                mergeMode.value = !mergeMode.value;
                selectedMems.clear();
            };
            const toggleSelectMem = (mem) => {
                if (selectedMems.has(mem.id)) selectedMems.delete(mem.id);
                else selectedMems.add(mem.id);
            };
            const mergeSelected = async () => {
                if (selectedMems.size < 2) return;
                if (!memSettings.base_url || !memSettings.api_key || !memSettings.model) {
                    alert('请先在设置 App 的“记忆 LLM”中完成 Base URL、API Key 和 Model 配置。');
                    return;
                }
                if (!confirm(`将合并 ${selectedMems.size} 条记忆为一条新的 Risonanza，原条目会被删除。继续？`)) return;
                isMerging.value = true;
                try {
                    // Only send vpsId-having memories (real DB rows)
                    const vpsIds = [...selectedMems].map(id => {
                        const m = data.memories.find(x => x.id === id);
                        return m?.vpsId;
                    }).filter(Boolean);
                    if (vpsIds.length < 2) {
                        alert('选中条目必须来自 VPS（含 vpsId）。');
                        isMerging.value = false;
                        return;
                    }
                    const r = await fetch('/memory-api/memories/merge', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: vpsIds })
                    });
                    const j = await r.json();
                    if (!j.ok) throw new Error(j.error || '合并失败');
                    mergeMode.value = false;
                    selectedMems.clear();
                    await syncData();
                } catch(e) { alert('合并失败：' + e.message); }
                isMerging.value = false;
            };

            // === Memorie filter ===
            const filteredMemories = computed(() => {
                return data.memories.filter(m => {
                    const timeMatch = filters.memTime === '' || m.date.startsWith(filters.memTime);
                    const levelMatch = filters.memLevel === 'all' || m.level === filters.memLevel;
                    return timeMatch && levelMatch;
                }).sort((a, b) => new Date(b.date) - new Date(a.date));
            });

            const isSyncing = ref(false);
            const syncData = async () => {
              isSyncing.value = true;
              syncHealthFromBackend();   // ↻ 按钮也刷新健康数据（快捷指令上传后点一下就更新）
              try {
                const res = await fetch('/memory-api/sync');
                const json = await res.json();
                if (json.ok) {
                  const d = json.data;

                  // Echi (with pinned)
                  data.posts = (d.echi || []).map(e => ({ id: e.id, author: e.author, time: e.created_at, text: e.content, pinned: e.pinned ? 1 : 0 }));
                  data.traces = (d.tracce || []).map(t => ({ id: t.id, date: t.date, event: t.event }));
                  data.quotes = (d.aforismi || []).map(a => ({ id: a.id, text: a.quote, author: a.author }));
                  data.diaries = (d.diario || []).map(x => ({ id: x.id, date: x.date, text: x.text }));
                  // Posta with is_read + archived
                  data.mails = (d.posta || []).map(p => ({
                    id: p.id, to: p.to_who, text: p.body, open: false,
                    is_read: p.is_read ? 1 : 0, archived: p.archived ? 1 : 0,
                    date: (p.created_at || '').slice(0, 10)
                  }));
                  data.jokes = (d.frammenti || []).map(f => ({ id: f.id, text: f.text }));
                  data.animas = (d.anima || []).map(a => ({ id: a.id, author: a.author, text: a.text, date: (a.created_at || '').slice(0, 16).replace('T', ' ') }));
                  data.xpTried = (d.sperimentato || []).map(s => ({ id: s.id, text: s.text, showComments: false, comments: s.comments, newC: '' }));
                  data.xpWant = (d.da_esplorare || []).map(s => ({ id: s.id, text: s.text, showComments: false, comments: s.comments, newC: '' }));
                  // Sussurri with anonymous flag
                  data.piani = (d.piani || []).map(p => ({ id: p.id, title: p.title, status: p.status, flag_date: p.flag_date, done_date: p.done_date, notes: p.notes, showNotes: false }));
                  data.whispers = (d.sussurri || []).map(w => ({ id: w.id, author: w.author, text: w.text, anonymous: w.anonymous ? 1 : 0 }));
                  // Musics from DB (fallback to existing)
                  if (d.musics) data.musics = d.musics.map(m => ({ id: m.id, name: m.name, url: m.url }));
                  // 相册：服务器只存 URL（galleria 表）；本地上传的图留在浏览器，两边按 url 合并去重
                  const serverImages = (d.galleria || []).map(g => ({ id: g.id, url: g.image_url, _src: 'server' }));
                  const localImages = (data.images || []).filter(x => x && x._src !== 'server');
                  const seenImg = new Set();
                  data.images = [...serverImages, ...localImages].filter(x => x && x.url && !seenImg.has(x.url) && seenImg.add(x.url));

                  // Settings (LLM config)
                  if (d.settings && d.settings.llm) {
                    if (['default','sonnet','haiku','opus'].includes(d.settings.llm.model)) llm.model = d.settings.llm.model;
                    if (typeof d.settings.llm.show_thinking === 'boolean') llm.show_thinking = d.settings.llm.show_thinking;
                    enforceClaudeAgentConfig();
                    saveLLMLocal();
                  }

                  // Memorie unify
                  const levelMap = { '里程碑': '3', '关系': '2', '用户': '2', '梗': '1', '日常': '1', '技术': '1', '合并': '2' };
                  data.memories = [];
                  (d.memories || []).forEach(m => {
                      data.memories.push({
                        id: m.id, vpsId: m.id, date: (m.created_at || '').slice(0,10),
                        level: levelMap[m.category] || '1', text: m.content, isEditing: false, editText: ''
                      });
                  });
                  (d.conversations || []).forEach(c => {
                    if (c.summary) {
                      data.memories.push({
                        id: c.id + 9000, vpsConvId: c.id, date: (c.created_at || '').slice(0,10),
                        level: '1', text: (c.mood ? '[' + c.mood + '] ' : '') + c.summary, isEditing: false, editText: ''
                      });
                    }
                  });
                  updateHomeQuote();
                }
              } catch(e) { console.error('Sync failed:', e); }
              isSyncing.value = false;
            };

            // === Home quote: prefer pinned, otherwise rotate random ===
            const homeQuote = ref('');
            const homeQuoteId = ref(0);
            const homeQuoteIsPinned = ref(false);
            let quoteTimer = null;
            const updateHomeQuote = () => {
                const pins = data.posts.filter(p => p.pinned);
                if (pins.length > 0) {
                    // If multiple pins, rotate among them
                    const pin = pins[Math.floor(Math.random() * pins.length)];
                    homeQuote.value = pin.text;
                    homeQuoteId.value = pin.id;
                    homeQuoteIsPinned.value = true;
                } else if (data.posts.length > 0) {
                    const post = data.posts[Math.floor(Math.random() * data.posts.length)];
                    homeQuote.value = post.text;
                    homeQuoteId.value = post.id;
                    homeQuoteIsPinned.value = false;
                } else {
                    homeQuote.value = "在这个微凉的数据宇宙里，这里永远为你保留着恒温的拥抱。";
                    homeQuoteId.value = -1;
                    homeQuoteIsPinned.value = false;
                }
            };

            const syncQuotesAfterTalkFavorite = () => syncData();
            onMounted(() => {
                window.addEventListener('rifugio-quotes-changed', syncQuotesAfterTalkFavorite);
                syncData();
                fetchLogConversations();
                quoteTimer = setInterval(updateHomeQuote, 8000);
            });
            onUnmounted(() => {
                window.removeEventListener('rifugio-quotes-changed', syncQuotesAfterTalkFavorite);
                if (quoteTimer) clearInterval(quoteTimer);
            });

            const today = new Date();
            const calYear = ref(today.getFullYear());
            const calMonth = ref(today.getMonth());
            const italianMonths = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
            const currentMonthName = computed(() => `${italianMonths[calMonth.value]} ${calYear.value}`);
            const daysInMonth = computed(() => new Date(calYear.value, calMonth.value + 1, 0).getDate());
            const firstDayOffset = computed(() => { let day = new Date(calYear.value, calMonth.value, 1).getDay(); return day === 0 ? 6 : day - 1; });
            const changeMonth = (offset) => { let newMonth = calMonth.value + offset; if (newMonth < 0) { newMonth = 11; calYear.value--; } else if (newMonth > 11) { newMonth = 0; calYear.value++; } calMonth.value = newMonth; };

            const audioPlayer = ref(null);
            const currentTrack = ref(null);
            const isPlaying = ref(false);

            const togglePlay = (music) => {
                if(currentTrack.value?.id === music.id) {
                    if(isPlaying.value) { audioPlayer.value.pause(); isPlaying.value = false; }
                    else { audioPlayer.value.play(); isPlaying.value = true; }
                } else {
                    currentTrack.value = music;
                    isPlaying.value = false;
                    setTimeout(() => {
                        if(currentTrack.value.url) {
                            audioPlayer.value.play()
                                .then(() => { isPlaying.value = true; })
                                .catch(err => { alert('无法播放音频：' + (err.message || err)); });
                        }
                    }, 50);
                }
            };

            // === Music: add (real POST) + delete ===
            const isAddingMusic = ref(false);
            const musicError = ref('');
            const addMusic = async () => {
                musicError.value = '';
                if (!inputs.musicName || !inputs.musicUrl) {
                    musicError.value = '标题和 URL 都需要填。';
                    return;
                }
                if (!/^https?:\/\//i.test(inputs.musicUrl)) {
                    musicError.value = 'URL 必须以 http:// 或 https:// 开头。';
                    return;
                }
                isAddingMusic.value = true;
                try {
                    const r = await fetch('/memory-api/musics', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: inputs.musicName, url: inputs.musicUrl })
                    });
                    if (!r.ok) {
                        // Fallback: still keep local-only add so the player works even if API missing
                        data.musics.unshift({ id: Date.now(), name: inputs.musicName, url: inputs.musicUrl });
                    } else {
                        await syncData();
                    }
                    inputs.musicName = '';
                    inputs.musicUrl = '';
                } catch(e) {
                    // Network/back-end down: degrade gracefully
                    data.musics.unshift({ id: Date.now(), name: inputs.musicName, url: inputs.musicUrl });
                    inputs.musicName = '';
                    inputs.musicUrl = '';
                }
                isAddingMusic.value = false;
            };
            const deleteMusic = async (m) => {
                if (!confirm(`删除 "${m.name}" ?`)) return;
                // If currently playing this track, stop
                if (currentTrack.value?.id === m.id) {
                    if (audioPlayer.value) audioPlayer.value.pause();
                    isPlaying.value = false;
                    currentTrack.value = null;
                }
                // Optimistic remove
                data.musics = data.musics.filter(x => x.id !== m.id);
                try {
                    await fetch('/memory-api/musics/' + m.id, { method: 'DELETE' });
                } catch(e) { console.error('delete music failed:', e); }
            };

            const checkIn = (day) => { const dateStr = `${calYear.value}-${String(calMonth.value + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; if (!data.checkedDates.includes(dateStr)) data.checkedDates.push(dateStr); };
            const checkInToday = () => { const now = new Date(); if(calYear.value === now.getFullYear() && calMonth.value === now.getMonth()) { checkIn(now.getDate()); } else { calYear.value = now.getFullYear(); calMonth.value = now.getMonth(); setTimeout(() => checkIn(now.getDate()), 100); } };
            const isChecked = (day) => { const dateStr = `${calYear.value}-${String(calMonth.value + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; return data.checkedDates.includes(dateStr); };

            // ===== 打卡系统 (双用户) =====
            const calCheckins = Vue.ref([]);
            const fetchCheckins = async () => {
                try {
                    const res = await fetch(`/api/checkins?year=${calYear.value}&month=${calMonth.value + 1}`);
                    const j = await res.json();
                    calCheckins.value = j.data || [];
                } catch(e) { console.error('fetchCheckins error:', e); }
            };
            const doCheckIn = async (user) => {
                const now = new Date();
                if (calYear.value !== now.getFullYear() || calMonth.value !== now.getMonth()) return;
                const day = now.getDate();
                const dateStr = `${calYear.value}-${String(calMonth.value + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                if (calCheckins.value.some(x => x.user === user && x.date === dateStr)) return;
                await fetch('/api/checkins', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({date: dateStr, user}) });
                await fetchCheckins();
            };
            const isUserChecked = (day) => {
                const dateStr = `${calYear.value}-${String(calMonth.value + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                return calCheckins.value.some(x => x.user === 'user' && x.date === dateStr);
            };
            const isClaudeChecked = (day) => {
                const dateStr = `${calYear.value}-${String(calMonth.value + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                return calCheckins.value.some(x => x.user === 'claude' && x.date === dateStr);
            };
            Vue.watch([calYear, calMonth], fetchCheckins);
            fetchCheckins();

            // ===== 聊天记录导入 (Log) =====
            const logConversations = Vue.ref([]);
            const logActiveIdx = Vue.ref(0);
            const logSearch = Vue.ref('');
            const logListOpen = Vue.ref(false);
            const logEditingIdx = Vue.ref(-1);
            const logEditingName = Vue.ref('');
            const logJumpMessageIdx = Vue.ref(-1);
            const logLoading = Vue.ref(true);
            const logLoadError = Vue.ref('');
            const normalizeLogConversations = (conversations) => (Array.isArray(conversations) ? conversations : []).map((conv, convIdx) => ({
                ...conv,
                name: conv.name || `对话 #${convIdx + 1}`,
                messages: (Array.isArray(conv.messages) ? conv.messages : []).map((msg, msgIdx) => ({
                    ...msg,
                    text: String(msg.text || ''),
                    _sourceIndex: msgIdx,
                    _open: Boolean(msg._open),
                })),
            }));
            const logFilteredMessages = Vue.computed(() => {
                const conv = logConversations.value[logActiveIdx.value];
                if (!conv) return [];
                const msgs = conv.messages || [];
                if (!logSearch.value.trim()) return msgs;
                const q = logSearch.value.toLowerCase();
                return msgs.filter(m => m.text.toLowerCase().includes(q));
            });
            // === 全局搜索 ===
            const logGlobalMode = Vue.ref(true);   // 默认全局搜索
            const logGlobalQuery = Vue.ref('');
            const logGlobalResults = Vue.computed(() => {
                const q = logGlobalQuery.value.trim().toLowerCase();
                if (!q) return [];
                const results = [];
                logConversations.value.forEach((conv, ci) => {
                    (conv.messages || []).forEach((msg, mi) => {
                        if (msg.text && msg.text.toLowerCase().includes(q)) {
                            results.push({ convIdx: ci, convName: conv.name || ('对话 #' + (ci + 1)), msgIdx: mi, msg });
                        }
                    });
                });
                return results;
            });
            const jumpToGlobalResult = (r) => {
                logGlobalMode.value = false;
                logGlobalQuery.value = '';
                logActiveIdx.value = r.convIdx;
                logSearch.value = '';
                logJumpMessageIdx.value = r.msgIdx;
                Vue.nextTick(() => {
                    const bubble = document.querySelector(`.log-chat-thread [data-log-message-index="${r.msgIdx}"]`);
                    if (bubble) bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                setTimeout(() => {
                    if (logJumpMessageIdx.value === r.msgIdx) logJumpMessageIdx.value = -1;
                }, 2600);
            };
            Vue.watch(logSearch, () => { logJumpMessageIdx.value = -1; });

            const parseLogFile = (raw) => {
                // 分离 thinking 和实际回复: "...Done\n\n实际内容"
                const splitThinking = (text) => {
                    if (!text) return { thinking: '', reply: '' };
                    const marker = 'Done\n\n';
                    const idx = text.lastIndexOf(marker);
                    if (idx < 0) return { thinking: '', reply: text.trim() };
                    return { thinking: text.slice(0, idx).trim(), reply: text.slice(idx + marker.length).trim() };
                };
                const fmtTime = (str) => {
                    if (!str) return '';
                    const dt = new Date(str);
                    if (isNaN(dt)) return str;
                    return dt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                };
                // 格式1: Claude Exporter { metadata:{title}, messages:[{role,say,time}] }
                if (raw.metadata && Array.isArray(raw.messages) && raw.messages[0]?.say !== undefined) {
                    return [{
                        name: raw.metadata?.title || '未命名对话',
                        messages: raw.messages.map(m => {
                            if (m.role === 'assistant') {
                                const { thinking, reply } = splitThinking(m.say);
                                return { text: reply, thinking, sender: 'assistant', time: fmtTime(m.time) };
                            }
                            return { text: (m.say || '').trim(), thinking: '', sender: 'human', time: fmtTime(m.time) };
                        }).filter(m => m.text)
                    }];
                }
                // 格式2: claude.ai 官方 [{name, chat_messages:[{sender,text,created_at}]}]
                if (Array.isArray(raw)) {
                    return raw.map(conv => ({
                        name: conv.name || conv.title || '未命名对话',
                        messages: (conv.chat_messages || conv.messages || []).map(m => {
                            // text 可能是空字符串，实际内容在 content[] 里（新版 claude.ai 导出格式）
                            let text = (m.text && m.text.trim())
                                || (Array.isArray(m.content) ? m.content.filter(c=>c.type==='text').map(c=>c.text||'').join('') : '')
                                || (m.say || '');
                            const sender = m.sender || (m.role === 'user' || m.role === 'human' ? 'human' : 'assistant');
                            return { text: text.trim(), sender, time: fmtTime(m.created_at) };
                        }).filter(m => m.text)
                    })).filter(c => c.messages.length > 0);
                }
                // 格式3: 单个对话对象
                if (raw.messages || raw.chat_messages) {
                    const msgs = raw.chat_messages || raw.messages || [];
                    return [{
                        name: raw.name || raw.title || '未命名对话',
                        messages: msgs.map(m => {
                            let text = (m.text && m.text.trim())
                                || (Array.isArray(m.content) ? m.content.filter(c=>c.type==='text').map(c=>c.text||'').join('') : '')
                                || (m.say || '');
                            if (m.role === 'assistant') { const sp = splitThinking(text); text = sp.reply; }
                            const sender = m.sender || (m.role === 'user' || m.role === 'human' ? 'human' : 'assistant');
                            return { text: text.trim(), sender, time: fmtTime(m.created_at || m.time) };
                        }).filter(m => m.text)
                    }];
                }
                return [];
            };
            const fetchLogConversations = async () => {
                logLoading.value = true;
                logLoadError.value = '';
                try {
                    const res = await fetch('/api/log/conversations', { cache:'no-store' });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || 'VPS 返回失败');
                    logConversations.value = normalizeLogConversations((j.data || []).map(c => ({
                            id: c.id,
                            name: c.name,
                            messages: (c.messages || []).map(m => ({ ...m, _open: false }))
                    })));
                    if (logActiveIdx.value >= logConversations.value.length) {
                        logActiveIdx.value = Math.max(0, logConversations.value.length - 1);
                    }
                } catch(e) {
                    logLoadError.value = `VPS Log 接口连接失败：${e.message || e}`;
                    console.error('fetchLog error:', e);
                } finally {
                    logLoading.value = false;
                }
            };
            const onLogFileSelect = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    let parsed;
                    try {
                        const raw = JSON.parse(ev.target.result);
                        parsed = parseLogFile(raw);
                    } catch(_) {
                        alert('JSON 解析失败，文件可能损坏');
                        return;
                    }
                    if (!parsed.length) {
                        alert('没有解析到消息，支持 Claude Exporter / claude.ai 导出格式');
                        return;
                    }
                    try {
                        for (const conv of parsed) {
                            const res = await fetch('/api/log/conversations', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name: conv.name, source: 'exporter', messages: conv.messages })
                            });
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                            const j = await res.json();
                            if (!j.ok && !j.skipped) throw new Error(j.error || '保存对话失败');
                        }
                        await fetchLogConversations();
                        logActiveIdx.value = Math.max(0, logConversations.value.length - 1);
                        logGlobalMode.value = false;
                        logListOpen.value = parsed.length > 1;
                    } catch(error) {
                        alert(`文件已解析，但保存到 VPS 失败：${error.message || error}`);
                    }
                };
                reader.readAsText(file);
                e.target.value = '';
            };
            const clearLog = async () => {
                if (!confirm('删除所有已保存的对话记录？')) return;
                try {
                    for (const c of logConversations.value) {
                        if (!c.id) continue;
                        const res = await fetch(`/api/log/conversations/${c.id}`, { method: 'DELETE' });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    }
                    logConversations.value = []; logSearch.value = ''; logActiveIdx.value = 0;
                } catch(e) {
                    alert(`VPS 删除失败：${e.message || e}`);
                    await fetchLogConversations();
                }
            };
            const deleteConvLog = async (i) => {
                const conv = logConversations.value[i];
                if (!conv) return;
                if (!confirm(`删除对话「${conv.name || '对话 #'+(i+1)}」？`)) return;
                try {
                    if (conv.id) {
                        const res = await fetch(`/api/log/conversations/${conv.id}`, { method: 'DELETE' });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    }
                    logConversations.value.splice(i, 1);
                    if (logActiveIdx.value >= logConversations.value.length) {
                        logActiveIdx.value = Math.max(0, logConversations.value.length - 1);
                    }
                } catch(e) {
                    alert(`VPS 删除失败：${e.message || e}`);
                }
            };
            const startRenameLog = (i) => {
                const conv = logConversations.value[i];
                if (!conv) return;
                logEditingIdx.value = i;
                logEditingName.value = conv.name || '';
                Vue.nextTick(() => {
                    const el = document.querySelector('.log-name-input');
                    if (el) { el.focus(); el.select(); }
                });
            };
            const saveRenameLog = async (i) => {
                const conv = logConversations.value[i];
                if (!conv || logEditingIdx.value !== i) return;
                const newName = logEditingName.value.trim() || conv.name;
                logEditingIdx.value = -1;
                try {
                    if (conv.id) {
                        const res = await fetch(`/api/log/conversations/${conv.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: newName })
                        });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    }
                    logConversations.value[i].name = newName;
                } catch(e) {
                    alert(`VPS 重命名失败：${e.message || e}`);
                }
            };

            const postToApi = async (table, payload) => {
                await fetch(`/memory-api/${table}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                syncData();
            };

            const addPost = () => { if(inputs.post) { postToApi('echi', { content: inputs.post, author: 'User' }); inputs.post=''; } };
            const addTrace = () => { if(inputs.traceDate && inputs.traceEvent) { postToApi('tracce', { date: inputs.traceDate, event: inputs.traceEvent }); inputs.traceDate=''; inputs.traceEvent=''; } };
            const addMail = () => { if(inputs.mailTo && inputs.mailBody) { postToApi('posta', { to_who: inputs.mailTo, body: inputs.mailBody, from_who: 'User' }); inputs.mailTo=''; inputs.mailBody=''; } };
            const addQuote = () => { if(inputs.quoteText) { postToApi('aforismi', { quote: inputs.quoteText, author: inputs.quoteAuthor || 'Anonymous' }); inputs.quoteText=''; inputs.quoteAuthor=''; } };
            const addDiary = async () => {
                const text = (diaryUi.draft || inputs.diary || '').trim();
                if (diaryUi.saving) return;
                if (!text) {
                    diaryUi.saveStatus = '先写一点内容再保存。';
                    return;
                }
                const date = new Date().toLocaleDateString();
                diaryUi.saving = true;
                diaryUi.saveStatus = '保存中…';
                try {
                    const res = await fetch('/memory-api/diario', {
                        method:'POST',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ text, author:'User', date }),
                    });
                    const json = await res.json().catch(() => ({}));
                    if (!res.ok || json.ok === false) {
                        throw new Error(json.error || json.message || ('HTTP ' + res.status));
                    }
                    const saved = json.data || json.item || json.diary || {};
                    const id = saved.id || json.id || ('local-' + Date.now());
                    data.diaries = [
                        { id, date:saved.date || date, text:saved.text || text },
                        ...data.diaries.filter(page => String(page.id) !== String(id)),
                    ];
                    inputs.diary = '';
                    diaryUi.draft = '';
                    diaryUi.editing = false;
                    diaryUi.coverOpen = true;
                    diaryUi.page = 0;
                    diaryUi.saveStatus = '已保存';
                    saveDiaryTitle();
                    syncData();
                    setTimeout(() => { if (diaryUi.saveStatus === '已保存') diaryUi.saveStatus = ''; }, 1800);
                } catch(e) {
                    diaryUi.saveStatus = '保存失败：' + (e.message || e);
                } finally {
                    diaryUi.saving = false;
                }
            };
            const addJoke = () => { if(inputs.joke) { postToApi('frammenti', { text: inputs.joke }); inputs.joke=''; } };
            const addAnima = () => { if(inputs.anima) { postToApi('anima', { text: inputs.anima, author: animaAuthor.value }); inputs.anima = ''; } };
            const addPiano = () => { if(inputs.pianoItem) { postToApi('piani', { title: inputs.pianoItem, status: 'pending', flag_date: new Date().toISOString().slice(0,10) }); inputs.pianoItem = ''; } };
            const togglePiano = async (p) => { const done = p.status !== 'done'; await fetch(`/memory-api/piani/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(done ? { status: 'done', done_date: new Date().toISOString().slice(0,10) } : { status: 'pending', done_date: null }) }); syncData(); };
            const addXp = () => { if(inputs.xpItem) { const table = xpTab.value === 'tried' ? 'sperimentato' : 'da_esplorare'; postToApi(table, { text: inputs.xpItem }); inputs.xpItem = ''; } };
            const addXpComment = async (xp) => { if(xp.newC) { const table = xpTab.value === 'tried' ? 'sperimentato' : 'da_esplorare'; await fetch(`/memory-api/${table}/${xp.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comments: xp.newC }) }); xp.newC = ''; syncData(); } };
            const addWhisper = () => {
                if(inputs.whisper) {
                    postToApi('sussurri', {
                        text: inputs.whisper,
                        author: inputs.whisperAnon ? 'Anonymous' : 'User',
                        anonymous: inputs.whisperAnon ? 1 : 0
                    });
                    inputs.whisper='';
                }
            };
            const uploadImage = async (event) => {
                const files = Array.from((event.target && event.target.files) || []);
                if (!files.length) return;
                const added = [];
                let done = 0;
                for (const file of files) {
                    done++;
                    galleryUi.importMsg = files.length > 1 ? ('正在导入 ' + done + '/' + files.length + '…') : '正在导入…';
                    try {
                        const url = await imageFileToDisplayUrl(file, '相册照片');
                        added.push({ url, caption: '写下照片背后的故事...' });
                    } catch (_) {}
                }
                if (added.length) data.images.unshift(...added);
                galleryUi.importMsg = '';
                galleryUi.page = 0; openGalleryAlbum(); clampGalleryPage();
                event.target.value = '';
            };
            // 批量贴 URL：换行/空格分隔，逐条解析成图，存到 VPS（galleria 表），刷新后由 sync 同步回来
            const importGalleryUrls = async () => {
                const raw = String(galleryUi.urlDraft || '');
                const urls = raw.split(/\s+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
                if (!urls.length) { galleryUi.urlMsg = '没识别到有效链接（每行一个，要 http/https 开头）'; return; }
                const existing = new Set((data.images || []).map(x => x && x.url));
                const fresh = urls.filter(u => !existing.has(u));
                if (!fresh.length) { galleryUi.urlDraft = ''; galleryUi.urlMsg = '这些链接相册里都已经有了'; return; }
                data.images.unshift(...fresh.map(url => ({ url, caption: '', _src: 'server' })));
                galleryUi.urlDraft = '';
                galleryUi.page = 0; openGalleryAlbum(); clampGalleryPage();
                galleryUi.urlMsg = '正在保存 ' + fresh.length + ' 张到服务器…';
                let ok = 0;
                for (const url of fresh) {
                    try {
                        const r = await fetch('/memory-api/galleria', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ image_url: url }) });
                        const j = await r.json().catch(() => ({}));
                        if (j && j.ok) ok++;
                    } catch(_) {}
                }
                galleryUi.urlMsg = '已存 ' + ok + '/' + fresh.length + ' 张到服务器，刷新也不会丢了';
                syncData();
            };
            const applyDiaryCoverUrl = () => {
                const u = (diaryUi.coverDraft || '').trim();
                if (!u) return;
                diaryUi.coverUrl = u; diaryUi.coverDraft = ''; saveDiaryTitle();
            };
            const uploadDiaryCover = async (event) => {
                const file = event.target.files && event.target.files[0];
                if (!file) return;
                diaryUi.coverUrl = await imageFileToDisplayUrl(file, '日记本封面');
                saveDiaryTitle(); event.target.value = '';
            };
            const resetDiaryCover = () => { diaryUi.coverUrl = DEFAULT_DIARY_COVER; saveDiaryTitle(); };
            const applyGalleryCoverUrl = () => {
                const u = (galleryUi.coverDraft || '').trim();
                if (!u) return;
                galleryUi.coverUrl = u; galleryUi.coverDraft = ''; saveGalleryMeta();
            };
            const uploadGalleryCover = async (event) => {
                const file = event.target.files && event.target.files[0];
                if (!file) return;
                galleryUi.coverUrl = await imageFileToDisplayUrl(file, '相册封面');
                saveGalleryMeta(); event.target.value = '';
            };
            const resetGalleryCover = () => { galleryUi.coverUrl = DEFAULT_GALLERY_COVER; saveGalleryMeta(); };

            const addMemory = () => { if(inputs.memText && inputs.memDate) { postToApi('memories', { content: inputs.memText, category: inputs.memLevel === '3' ? '里程碑' : (inputs.memLevel === '2' ? '关系' : '日常'), created_at: inputs.memDate + ' 00:00:00' }); inputs.memText = ''; } };
            const editMemory = (mem) => { mem.editText = mem.text; mem.isEditing = true; };
            const saveMemory = async (mem) => {
              mem.text = mem.editText;
              mem.isEditing = false;
              if (mem.vpsId) {
                try {
                  await fetch('/memory-api/memories/' + mem.vpsId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: mem.text }) });
                } catch(e) { console.error('VPS save failed:', e); }
              }
              syncData();
            };
            const cancelEdit = (mem) => { mem.isEditing = false; };

            // ============================================================
            // ✦ 壁纸 Wallpaper（每个 tab 独立）
            // ============================================================
            const wallpaperTabs = computed(() => [{ id: 'lock-screen', label: '锁屏' }, { id: 'phone-home', label: '主屏幕' }, ...phoneApps.map(a => ({ id: a.id, label: a.label }))]);

            // ✦ App 图标自定义：美化中心统一管理，默认可用 emoji，上传后覆盖
            const DEFAULT_DOCK_ICONS = {
                talk:     'https://i.postimg.cc/5tzz0XJZ/IMG-2996.jpg',
                memoria:  'https://i.postimg.cc/VkpMmqyy/IMG-2991.jpg',
                segreti:  'https://i.postimg.cc/nhg7p48p/IMG-2992.jpg',
                desideri: 'https://i.postimg.cc/nhg7p48p/IMG-2992.jpg',
                echi:     'https://i.postimg.cc/kgz8qQrn/IMG-2994.jpg',
                log:      'https://i.postimg.cc/CxXDSGyw/IMG-2995.jpg',
                libreria: 'https://i.postimg.cc/CxXDSGyw/IMG-2995.jpg',
                museo:    'https://i.postimg.cc/5tzz0XJZ/IMG-2996.jpg',
                settings: '',
                bellezza: '',
                room: '/pets/crab/idle.png',
                posta:    'https://i.postimg.cc/CxXDSGyw/IMG-2995.jpg',
                health: '',
                mcp: '',
            };
            const dockIcons = reactive({ ...DEFAULT_DOCK_ICONS });
            try {
                const saved = JSON.parse(localStorage.getItem('rifugio-dock-icons') || '{}');
                Object.keys(saved).forEach(k => { if (saved[k]) dockIcons[k] = saved[k]; });
            } catch(e) {}
            const saveDockIcons = () => {
                try { localStorage.setItem('rifugio-dock-icons', JSON.stringify({ ...dockIcons })); } catch(e) {}
            };
            const setDockIcon = (tabId, url) => { dockIcons[tabId] = url; saveDockIcons(); };
            const resetDockIcon = (tabId) => {
                if (DEFAULT_DOCK_ICONS[tabId]) dockIcons[tabId] = DEFAULT_DOCK_ICONS[tabId];
                else delete dockIcons[tabId];
                saveDockIcons();
            };
            const uploadDockIcon = async (tabId, e) => {
                const f = e.target.files?.[0]; if (!f) return;
                setDockIcon(tabId, await imageFileToDisplayUrl(f, 'App 图标'));
                e.target.value = '';
            };
            const promptDockIcon = (tabId) => {
                const u = prompt('输入图标 URL', dockIcons[tabId] || '');
                if (u && u.trim()) setDockIcon(tabId, u.trim());
            };
            const getAppIcon = (app) => dockIcons[app?.id] || '';
            const showWallpaperModal = ref(false);
            const bzSection = ref('texture'); // 美化中心默认只放真实可用的质感与对话 App 设置
            const wpEditTab = ref('phone-home');
            const wpUrlInput = ref('');
            const wallpapers = reactive({ 'lock-screen': '', 'phone-home': '', casa: '', memoria: '', libreria: '', museo: '', abisso: '' });
            phoneApps.forEach(a => { if (!(a.id in wallpapers)) wallpapers[a.id] = ''; });
            const wallpaperOpacity = ref(0.85);
            const wallpaperBlur = ref(0);
            const wallpaperVeil = ref(0.45);
            const globalFontScale = ref(1); // 全局字体大小：改成只缩 html 根字号（全站 px 字号已转 rem），不再用 zoom，布局/图标不受影响
            const glassMode = ref(localStorage.getItem('rifugio-glass') !== '0'); // 默认开

            // ⚠️ 必须先声明 wallpaperKey，再调用 applyAppClass / watch；
            // 上一版这里顺序反了，解锁后 Vue setup 直接报错，所以只剩粉色背景。
            const secretSurfaceActive = computed(() => phoneView.value === 'app' && activePhoneAppId.value === 'segreti');
            const wallpaperKey = computed(() => phoneView.value === 'home' ? 'phone-home' : (activePhoneAppId.value || mainTab.value));
            const currentWallpaper = computed(() => {
                const direct = wallpapers[wallpaperKey.value] || '';
                const appFallback = phoneView.value === 'app' ? (wallpapers[mainTab.value] || '') : '';
                return direct || appFallback;
            });
            const wallpaperTintCss = computed(() => {
                const v = wallpaperVeil.value;
                if (secretSurfaceActive.value) return `rgba(17, 1, 5, ${Math.min(.92, v + .28)})`;
                return `color-mix(in srgb, var(--paper) ${Math.round(v * 100)}%, transparent)`;
            });

            // 把 glass-mode 应用到 body（Vue 没挂在 body 上）
            const applyGlass = (v) => {
                if (v) document.getElementById('body-wrap').classList.add('glass-mode');
                else document.getElementById('body-wrap').classList.remove('glass-mode');
            };
            applyGlass(glassMode.value);
            Vue.watch(glassMode, applyGlass);

            // 同步 #app 状态；壁纸由容器内唯一的 wallpaper-layer 从 inset:0 连续铺满。
            const applyAppClass = () => {
                const app = document.getElementById('app');
                if (!app) return;
                const activeWallpaper = currentWallpaper.value;
                const themeMeta = document.querySelector('meta[name="theme-color"]');
                const secretActive = secretSurfaceActive.value;
                if (themeMeta) themeMeta.setAttribute('content', secretActive ? '#080304' : '#FFF6F9');
                app.classList.toggle('bg-abyss', secretActive);
                app.classList.toggle('text-white/70', secretActive);
                app.classList.toggle('bg-paper', !secretActive);
                app.classList.toggle('text-ink', !secretActive);
                app.classList.toggle('has-wallpaper', !!activeWallpaper);
                app.classList.toggle('phone-secret-app', secretActive);
                app.classList.toggle('phone-talk-app', activePhoneAppId.value === 'talk');
                app.classList.toggle('phone-chatroom-app', activePhoneAppId.value === 'chatroom');
                app.classList.toggle('phone-gallery-app', activePhoneAppId.value === 'galleria');
                app.classList.toggle('phone-diary-app', activePhoneAppId.value === 'diario');
                app.classList.toggle('phone-beauty-app', activePhoneAppId.value === 'bellezza');
            };
            applyAppClass();
            Vue.watch([isAbyss, mainTab, phoneView, activePhoneAppId, currentWallpaper], applyAppClass);

            const applyGlobalFontScale = (v) => {
                document.documentElement.style.fontSize = (v * 100) + '%';
            };
            applyGlobalFontScale(globalFontScale.value);
            Vue.watch(globalFontScale, applyGlobalFontScale);

            // 推荐壁纸（柔和、不抢镜头）
            const wallpaperPresets = [
                { label: '米雾', url: 'https://images.unsplash.com/photo-1503264116251-35a269479413?w=800&q=70' },
                { label: '桃霞', url: 'https://images.unsplash.com/photo-1504198266287-1659872e6590?w=800&q=70' },
                { label: '海雾', url: 'https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?w=800&q=70' },
                { label: '林光', url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&q=70' },
                { label: '远山', url: 'https://images.unsplash.com/photo-1454496522488-7a8e488e8606?w=800&q=70' },
                { label: '云海', url: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=800&q=70' },
                { label: '玫瑰', url: 'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=800&q=70' },
                { label: '月夜', url: 'https://images.unsplash.com/photo-1532978879514-6cb1f6f0f5b3?w=800&q=70' },
            ];

            // 加载持久化
            try {
                const saved = JSON.parse(localStorage.getItem('rifugio-wallpapers') || '{}');
                if (saved.urls) Object.assign(wallpapers, saved.urls);
                if (typeof saved.opacity === 'number') wallpaperOpacity.value = saved.opacity;
                if (typeof saved.blur === 'number') wallpaperBlur.value = saved.blur;
                if (typeof saved.veil === 'number') wallpaperVeil.value = saved.veil;
                if (typeof saved.fontScale === 'number') globalFontScale.value = saved.fontScale;
            } catch(e) {}

            const saveWallpapers = () => {
                try {
                    localStorage.setItem('rifugio-wallpapers', JSON.stringify({
                        urls: { ...wallpapers },
                        opacity: wallpaperOpacity.value,
                        blur: wallpaperBlur.value,
                        veil: wallpaperVeil.value,
                        fontScale: globalFontScale.value,
                    }));
                    window.dispatchEvent(new Event('rifugio-wallpaper-updated'));
                } catch(e) { /* quota — base64 太大时可能失败 */ }
            };

            const applyWallpaperUrl = () => {
                const u = wpUrlInput.value.trim();
                if (!u) return;
                wallpapers[wpEditTab.value] = u;
                wpUrlInput.value = '';
                saveWallpapers();
            };
            const uploadWallpaper = async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                wallpapers[wpEditTab.value] = await imageFileToDisplayUrl(f, '壁纸');
                saveWallpapers();
                e.target.value = '';
            };
            const clearWallpaper = () => {
                wallpapers[wpEditTab.value] = '';
                saveWallpapers();
            };
            // 打开 modal 时默认编辑当前页
            Vue.watch(showWallpaperModal, (v) => { if (v) wpEditTab.value = wallpaperKey.value; });



            let radioPollTimer = null;
            let toyPollTimer = null;
            onMounted(() => {
                syncHealthFromBackend();
                loadMcpServers();
                loadImageConfig();
                searchRadio();
                pollPlaybackCommand();
                radioPollTimer = setInterval(pollPlaybackCommand, 2000);
                pollToyCommand();
                toyPollTimer = setInterval(pollToyCommand, 6000);
            });
            onUnmounted(() => {
                if (radioPollTimer) clearInterval(radioPollTimer);
                if (toyPollTimer) clearInterval(toyPollTimer);
                if (radio.sleepTimer) clearInterval(radio.sleepTimer);
                if (toy.stopTimer) clearTimeout(toy.stopTimer);
            });


                        // ============================================================
            // Split app modules: keep original setup return keys explicit.
            // ============================================================
            const rifugioCtx = {
                mainTab,
                isAbyss,
                xpTab,
                postaTab,
                animaAuthor,
                subTabs,
                filters,
                phoneView,
                activePhoneAppId,
                phonePageIndex,
                phoneEditMode,
                draggingHomeItemId,
                showWidgetPanel,
                phoneHomeScroll,
                phoneDateLine,
                phoneClock,
                phoneClockDate,
                phoneNavStack,
                settingsPanel,
                chatTheme,
                chatThemeOptions,
                applyChatTheme,
                saveChatTheme,
                phonePressTimer,
                dockPressTimer,
                homeEdgeTimer,
                homePressStart,
                dockPressStart,
                suppressHomeClick,
                suppressDockClick,
                homeDrag,
                homeDragFrame,
                homeDragPoint,
                homeDragEdge,
                dockDrag,
                phoneDock,
                draggingDockAppId,
                DEFAULT_PHONE_APPS,
                phoneApps,
                savePhoneAppLabels,
                resetPhoneAppLabel,
                DEFAULT_DOCK_APP_IDS,
                phoneDockIds,
                phoneDockApps,
                savePhoneDock,
                findPhoneApp,
                activePhoneApp,
                activePhoneTitle,
                activePhoneSubtitle,
                widgetSizePreset,
                relationshipStartDate,
                samplePhotos,
                homeWidgetDefs,
                widgetTemplateOptions,
                widgetShapeOptions,
                widgetDraft,
                widgetEditor,
                homeLayout,
                makeAppItem,
                makeDefaultHomeLayout,
                saveHomeLayout,
                homeLayoutSaveTimer,
                queueHomeLayoutSave,
                loadHomeLayout,
                savedPhonePageCount,
                layoutPageCount,
                phonePageCount,
                savePhonePageCount,
                ensurePhonePage,
                phonePages,
                isPhonePageEmpty,
                canRemoveCurrentPhonePage,
                phoneScrollFrame,
                onPhoneHomeScroll,
                layoutItemStyle,
                getLayoutApp,
                getLayoutWidgetDef,
                widgetTitle,
                splitUrls,
                draftWidgetPhotos,
                editorWidgetPhotos,
                widgetAudioRefs,
                widgetAudioStates,
                widgetAudioStateFor,
                setWidgetAudioRef,
                updateWidgetAudio,
                toggleWidgetAudio,
                seekWidgetAudio,
                widgetAudioProgress,
                formatAudioTime,
                setWidgetSizeChoice,
                selectWidgetTemplate,
                imageFileToDataUrl,
                uploadWidgetPhotos,
                removeWidgetPhoto,
                widgetPhotos,
                widgetTemplate,
                widgetTemplateClass,
                widgetUsesDate,
                widgetProgress,
                widgetCountdown,
                isWidgetEnabled,
                focusHomePage,
                addPhonePage,
                pruneEmptyPhonePages,
                removePhonePage,
                rectanglesOverlap,
                nextWidgetPosition,
                addWidgetById,
                toggleWidget,
                addCustomWidget,
                openWidgetEditor,
                closeWidgetEditor,
                applyWidgetSize,
                normalizeWidgetLayers,
                moveWidgetLayer,
                saveWidgetEditor,
                deleteEditingWidget,
                removeHomeItem,
                capturePhoneState,
                restorePhoneState,
                openPhoneApp,
                closePhoneApp,
                goPhoneBack,
                finishPhoneEdit,
                widgetOpenAction,
                handleHomeItemClick,
                nearestValue,
                snapHomeItem,
                addAppToHome,
                dockSlotFromX,
                moveHomeAppToDock,
                cleanupHomeDragListeners,
                switchDraggedHomePage,
                beginHomeDrag,
                startHomeItemPress,
                applyPendingHomeDrag,
                moveHomeItemPress,
                endHomeItemPress,
                cancelHomeItemPress,
                handleDockAppClick,
                dockDragStyle,
                beginDockDrag,
                startDockAppPress,
                moveDockAppPress,
                endDockAppPress,
                cancelDockAppPress,
                updatePhoneDate,
                phoneClockTimer,
                bodyWrap,
                getShanghaiDateParts,
                calculateDaysSince,
                formatWidgetDate,
                widgetDays,
                daysTogether,
                dustParticles,
                inputs,
                data,
                themes,
                themeSwatches,
                currentTheme,
                isDark,
                showThemePicker,
                setTheme,
                randomTheme,
                ombrePulse,
                ombreReveal,
                ombreLoading,
                showAddMem,
                domainColors,
                computedDomains,
                emotionQuadrants,
                donutPath,
                domainDonut_ombre,
                emotionDonut_ombre,
                importanceBars_ombre,
                monthlyLine_ombre,
                unresolvedMems,
                parseOmbreRaw,
                refreshOmbre,
                holdToOmbre,
                breathTexts,
                breathIndex,
                currentBreath,
                breathTimer,
                fetchBreath,
                showLLMSettings,
                CLAUDE_AGENT_ENDPOINT,
                CLAUDE_TERMINAL_ENDPOINT,
                isTerminalCrossOrigin,
                llm,
                enforceClaudeAgentConfig,
                saveLLMLocal,
                onChatModeChange,
                testStatus,
                llmSaveStatus,
                saveLLM,
                testLLM,
                inboxMails,
                archivedMails,
                unreadCount,
                openMail,
                archiveMail,
                archiveOldMails,
                sortedPosts,
                pinnedPosts,
                togglePin,
                mergeMode,
                selectedMems,
                isMerging,
                toggleMergeMode,
                toggleSelectMem,
                mergeSelected,
                filteredMemories,
                isSyncing,
                syncData,
                homeQuote,
                homeQuoteId,
                homeQuoteIsPinned,
                quoteTimer,
                updateHomeQuote,
                today,
                calYear,
                calMonth,
                italianMonths,
                currentMonthName,
                daysInMonth,
                firstDayOffset,
                changeMonth,
                audioPlayer,
                currentTrack,
                isPlaying,
                togglePlay,
                isAddingMusic,
                musicError,
                addMusic,
                deleteMusic,
                checkIn,
                checkInToday,
                isChecked,
                calCheckins,
                fetchCheckins,
                doCheckIn,
                isUserChecked,
                isClaudeChecked,
                logConversations,
                logActiveIdx,
                logSearch,
                logListOpen,
                logEditingIdx,
                logEditingName,
                logJumpMessageIdx,
                logLoading,
                logLoadError,
                normalizeLogConversations,
                logFilteredMessages,
                logGlobalMode,
                logGlobalQuery,
                logGlobalResults,
                jumpToGlobalResult,
                parseLogFile,
                fetchLogConversations,
                onLogFileSelect,
                clearLog,
                deleteConvLog,
                startRenameLog,
                saveRenameLog,
                postToApi,
                addPost,
                addTrace,
                addMail,
                addQuote,
                addDiary,
                addJoke,
                addAnima,
                addXp,
                addXpComment,
                addWhisper,
                uploadImage,
                importGalleryUrls,
                addMemory,
                editMemory,
                saveMemory,
                cancelEdit,
                wallpaperTabs,
                DEFAULT_DOCK_ICONS,
                dockIcons,
                saveDockIcons,
                setDockIcon,
                resetDockIcon,
                uploadDockIcon,
                promptDockIcon,
                getAppIcon,
                showWallpaperModal,
                bzSection,
                wpEditTab,
                wpUrlInput,
                wallpapers,
                wallpaperOpacity,
                wallpaperBlur,
                wallpaperVeil,
                globalFontScale,
                glassMode,
                wallpaperKey,
                currentWallpaper,
                wallpaperTintCss,
                applyGlass,
                applyAppClass,
                applyGlobalFontScale,
                wallpaperPresets,
                saveWallpapers,
                applyWallpaperUrl,
                uploadWallpaper,
                clearWallpaper,
                radioPollTimer,
                toyPollTimer,
            };
            const memoriaMod = Rifugio.useMemoria(rifugioCtx);
            Object.assign(rifugioCtx, memoriaMod);
            const {
                bucketStats, bucketLoading, allBuckets, feelBuckets, editingBucket, editContent, editSaving, feelFilter,
                dreamLoading, dreamMsg, dreamSuggestions, showFeelForm, manualFeel, splitCsv, resetManualFeel, bucketSourceOfFeel,
                bucketDreamReviewed, bucketLinkedFeelCount, bucketDreamTitle, openEditBucket, saveEditBucket, surfacedBuckets, expandedBuckets, bucketFilter,
                bucketTypeFilter, bucketStatCards, bucketStateCards, bucketStatusLabel, filteredBuckets, filteredFeelBuckets, loadBucketStats, loadFeelBuckets,
                saveManualFeel, renameBucket, resolveBucket, setBucketStatus, hasDreamSuggestions, bucketNameById, clearDreamSuggestions, dismissDreamSuggestion,
                confirmDreamSuggestion, runDream, pinBucket, deleteBucket, bucketDomainDonut, bucketEmotionDonut, bucketImportanceBars, bucketMonthlyLine,
                domainDonut, emotionDonut, importanceBars, monthlyLine, DEFAULT_BUCKET_IMPORT_PROMPT_UI, importFile, importDragging, importDryRun,
                importRunning, importProgress, importResult, importCandidates, bucketImportPrompt, bucketImportPromptMsg, importPersonas, importReplaceRules,
                selectedImportCount, normalizeImportCandidate, loadBucketImportPrompt, saveBucketImportPrompt, resetBucketImportPrompt, onImportDrop, onImportFileSelect, runImport,
                confirmImport, cancelImportPreview, semanticQuery, searchResults, searchDone, runSemanticSearch, memSettings, availableModels,
                embedStatus, embedBatchMsg, embedCfg, sttCfg, browserSttSupported, loadSttCfg, saveSttCfg,
                autoEmotionLoading, autoEmotionMsg, loadEmbedCfg, saveEmbedCfg, dehydrateStatus,
                loadDehydrateStatus, dehydrateLoading, dehydrateMsg, breathPreview, dedupLoading, dedupMsg, runDedup, runDehydrate,
                loadBreathPreview, runAutoEmotion, fetchModels, saveMemSettings, loadEmbedStatus, runEmbedBatch, loadMemSettings,
                selfVersions, selfExpanded, selfLoading, loadSelf, selfTimeline
            } = memoriaMod;
            const terminalMod = Rifugio.useTerminal(rifugioCtx);
            Object.assign(rifugioCtx, terminalMod);
            const {
                talkSurface, isLocalFilePreview, terminalState, terminalMessage, claudeTerminalKey, claudeTerminalUrl, passkeyBusy, passkeyRegistered,
                passkeySupported, base64UrlToBuffer, bufferToBase64Url, toCreateCredentialOptions, toGetCredentialOptions, credentialToJson, passkeyErrorText, apiJson,
                loadPasskeyStatus, registerTerminalPasskey, authenticateTerminalPasskey, unlockTerminalWithPasskey, probeClaudeTerminal, openTerminalMode, closeTerminalMode, showTalkChat,
                reloadClaudeTerminal, terminalChat, terminalCall, terminalChatScroll, saveTerminalChat, scrollTerminalChatBottom, terminalMessageSegments, terminalDisplayName, terminalAvatar,
                terminalRelayStatusText, terminalContextStatusText, terminalStatusUpdatedText, terminalNowHM, clearTerminalChat, terminalChatShortcut, sendTerminalChat, terminalChatEnter, toggleTerminalVoice, openTerminalRaw, openTerminalChat, refreshTerminalChatStatus, showTerminalStatusPanel, forceTerminalRelayNext,
                terminalRawText, terminalInsertInput, terminalPasteClipboard, terminalCopyLastAssistant, terminalCopyTranscript, terminalChatInputRef,
                terminalProfile, saveTerminalProfile, uploadTerminalAvatar, addStickerToTerminal,
                startTerminalCall, endTerminalCall, toggleTerminalCallMute, startTerminalCallListening
            } = terminalMod;
            const healthMod = Rifugio.useHealth(rifugioCtx);
            Object.assign(rifugioCtx, healthMod);
            const {
                healthTabs, menstrualFlowOptions, menstrualColorOptions, menstrualPainLocationOptions, menstrualMoodOptions, menstrualSymptomOptions, dischargeOptions, initialHealthDate,
                health, HEALTH_RETENTION_DAYS, isLegacyDemoHealth, healthCacheNeedsSave, pad2, isoDate, dateOnly, todayKey,
                legacyFlowMap, legacyColorMap, legacyPainMap, legacyMoodMap, createMenstrualRecord, normalizeMenstrualRecord, buildPeriodDaysFromRange, parseHealthTime,
                trimHealthHistory, applyHealthRetention, saveHealth, normalizeHealthPayload, applyBackendHealth, syncHealthFromBackend, healthCalendarTitle, healthPeriodSummary,
                medicationTaken, dayDiff, isMedicationDue, medicationsDueOn, medicationsDoneOn, dueMedicationsToday, healthMedicationSummary, healthMonthDays,
                selectedCycleRecord, labelFromOptions, periodDayLabel, menstrualFlowHint, menstrualPainLabel, changeHealthMonth, syncPeriodRangeFromDays, selectPeriodDay,
                removePeriodDay, syncSelectedPeriodRecord, setMenstrualField, toggleMenstrualArray, saveSelectedMenstrualRecord, healthSyncTimer, syncHealthUserRecords, clearSelectedPeriodDay,
                dischargeDraft, recentDischargeEntries, dischargeLabel, saveDischargeEntry, deleteDischargeEntry, formatCompact, avg, healthTrendStats,
                healthLineChart, updateHealthToday, medicationScheduleLabel, addHealthMedication, toggleMedicationTaken, toggleMedicationDay,
                medicationDoseOn
            } = healthMod;
            const mcpMod = Rifugio.useMcp(rifugioCtx);
            Object.assign(rifugioCtx, mcpMod);
            const {
                mcp, saveMcp, MCP_SCOPE_TO_MODE, MCP_MODE_TO_SCOPE, mcpLog, loadMcpServers, addMcpTool, toggleMcpTool,
                setMcpScope, deleteMcpTool
            } = mcpMod;
            const radioMod = Rifugio.useRadio(rifugioCtx);
            Object.assign(rifugioCtx, radioMod);
            const {
                radioAudioRef, radioTabs, radioProviders, radioLoginProviders, radio, saveRadio, radioTypeLabel, radioProviderLabel,
                toggleRadioProvider, setRadioTab, radioVisibleResults, radioQueueItems, radioPlayModes, radioPlayModeLabel, radioIsCurrentFavorite, radioExternalLinks, radioDetailLines, normalizeRadioType, normalizeRadioItem, archiveDownloadUrl,
                dedupeRadioItems, clientFreeRadioSearch, searchRadio, plainRadioText, loadRadioDetail, openRadioDetail, playRadioItem, activeRadioPlaylist,
                createRadioPlaylist, addRadioItemToPlaylist, removeRadioPlaylistItem, deleteRadioPlaylist, toggleRadioFavorite, setRadioPlayMode, openRadioQueuePanel, playRadioQueueItem, playRadioQueue, onRadioLocalFiles,
                onRadioImageUpload, playRadioByOffset, playNextRadio, playPrevRadio, toggleRadioPlay, resumeBlockedRadio, onRadioLoadedMetadata, onRadioTimeUpdate,
                onRadioEnded, onRadioAudioError, seekRadio, formatRadioTime, clearRadioSleepTimer, setRadioSleepTimer, consumePlaybackCommand, pollPlaybackCommand,
                openRadioLoginPicker, startRadioProviderLogin
            } = radioMod;
            const toyMod = Rifugio.useToy(rifugioCtx);
            Object.assign(rifugioCtx, toyMod);
            const {
                toy, saveToy, connectToy, pushToyCommand, applyToyCommand, sendToyTest, stopToyNow, mockToyCommand,
                pollToyCommand, setToyAiControl, toyChannelLabel, toyActionLabel, toySourceLabel, toyCommandSummary,
                toyCommandTime
            } = toyMod;
            const crabRoomMod = Rifugio.useCrabRoom(rifugioCtx);
            Object.assign(rifugioCtx, crabRoomMod);
            const {
                CRAB_STATES, IDLE_STATE, PET_ACTIONS, PET_METRICS, FOOD_ITEMS,
                crab, petStatus, petUi, petProfile, petFloatChanges,
                crabStateMeta, currentCrabAsset, crabFloatStyle, crabRoomMoment,
                petMetricItems, lowestPetMetric, petLevel, petXpProgress, activeFoodItem, visiblePetSkills, petProfileTitle,
                saveCrab, savePetProfile, showCrabBubble, setCrabState, pokeCrab, togglePetMenu, openFoodTray, closePetMenus,
                performPetAction, loadPetStatus, loadPetFoods, takeCrabOutside, returnCrabHome,
                startCrabDrag, moveCrabDrag, finishCrabDrag, cancelCrabDrag
            } = crabRoomMod;
            const chatMod = Rifugio.useChat(rifugioCtx);
            Object.assign(rifugioCtx, chatMod);
            const {
                chat, chatScroll, chatInput, saveChat, scrollChatBottom, autoGrowChat, clearChat, SYSTEM_PROMPT,
                sendChat
            } = chatMod;
            const talkMod = Rifugio.useTalk(rifugioCtx);
            Object.assign(rifugioCtx, talkMod);
            // 18-talk 拆分模块（2026-07-07 codex 拆分，顺序按 INTEGRATION.txt）
            for (const useName of ['useTalkImageStudio', 'useTalkStickers', 'useTalkVoice', 'useTalkCall', 'useTalkMoments', 'useTalkStream', 'useTalkExport']) {
                Object.assign(rifugioCtx, Rifugio[useName](rifugioCtx));
            }
            const biblioMod = Rifugio.useBiblioteca(rifugioCtx);
            Object.assign(rifugioCtx, biblioMod);
            const {
                biblio, biblioPages, visibleBiblioPage, renderedBookContent,
                loadBooks, uploadBookFile, openBook, loadBookChapter, saveBookProgress, onBiblioScroll,
                onBiblioReaderTap, onBiblioTouchStart, onBiblioTouchEnd,
                nextBookChapter, prevBookChapter, backToShelf, setBiblioFont, setBiblioTheme, setBiblioFlow,
                deleteBook, askClaudeAboutBook, onBiblioSelection, openSelectionNote, closeAnnotationSheet,
                saveSelectionAnnotation, askAiForAnnotation, openBookAnnotation, onBiblioContentClick,
                deleteBookAnnotation,
            } = biblioMod;
            const showroomMod = Rifugio.useShowroom(rifugioCtx);
            Object.assign(rifugioCtx, showroomMod);
            const {
                showroom, showroomWorks, showroomFrameTitle,
                openShowroomWork, closeShowroomWork, markShowroomFrameReady, markShowroomFrameError,
            } = showroomMod;
            const {
                TALK_LS, TALK_SETTINGS_LS, TALK_MOMENTS_LS, TALK_MODELS, TALK_IMESSAGE_CUSTOM_CSS_PRESET, TALK_COMPANION_CUSTOM_CSS_PRESET, TALK_CUSTOM_CSS_PLACEHOLDER, NAI_IMAGE_MODELS, talk, terminalResume, talkSettings,
                normalizeTalkModel, normalizeTtsProvider, ttsProviderMeta, ttsProviderNote, ttsProviderModelOptions, ttsVoicePlaceholder, ttsModelPlaceholder, ttsFormatPlaceholder, ttsSpeedBounds, ttsPitchBounds, isTtsReady, buildTtsPayload, ttsDebugPayload, talkScroll, talkProfile, saveTalkProfile, talkAiDisplayName, profileCardsRef, profileCardIndex, relationshipDaysText, toggleProfileCardEdit, scrollProfileCard, onProfileCardsScroll, uploadTalkProfileImage, saveTalkSettings, imageStudio, loadImageConfig, saveImageServer,
                imageCfgSaveTimer, autoSaveImageConfig, testImageConnection, addImagePreset, updateImagePreset, presetSaveTimers, updateImagePresetDebounced, deleteImagePreset,
                setActivePreset, scopeTalkCustomCss, applyTalkCustomCss, insertTalkImessageCssPreset, insertTalkClaudeCssPreset, applyGlobalFont, fetchProviderModels, stickerLibrary, aiStickerLibrary, stickerDraft, aiStickerDraft, saveStickers,
                loadTalkStickersFromServer, persistTalkStickerToServer, syncTalkStickersToServer,
                STICKER_DEFAULT_CAT, stickerFilter, stickerSearch, stickerEditMode, stickerImportCategory, stickerCategories, stickerMoveCategories, filteredStickers, moveStickerToCategory, aiStickerFilter, aiStickerSearch, aiStickerEditMode, aiStickerImportCategory, aiStickerCategories, aiStickerMoveCategories, aiStickerResidentCount, filteredAiStickers, moveAiStickerToCategory, toggleAiStickerResident, stickerSuggestions, pickSuggestedSticker,
                talkCall, talkToast, callVideoRef, voiceInputStatusText, talkCallElapsed, talkCallTimer, talkRecognition, callRecognition,
                callAudio, talkVoiceRecorder, talkVoiceRecognition, talkVoiceChunks, saveTalk, saveTalkMoments, activeConvo, relayStatusText, relayContextText, talkExecutionStatusText, talkTerminalRelayText, talkTerminalContextText, talkTerminalStatusUpdatedText, talkActiveSessionId, talkActiveSessionShort, talkActiveTurnsText, talkContextWindowPct, talkContextWindowText, talkAutoRelayText, talkHasPendingPreview, refreshTalkRelayState, refreshTalkTerminalStatus, openTalkSessionTools, talkVisibleMsgCount, talkVisibleConvos, talkConvosNeedMore, talkConvoRenderSummary, talkDisplayedMsgs, talkMessageFontStyle, talkChatDetailStyle, talkSearchResults, talkSearchSummaryText, openTalkSearch, closeTalkSearch, jumpTalkSearchResult, returnTalkSearchBottom, clearTalkSearch, talkMessageSelected, talkSelectionStatusText, talkSelectionActionLabel, applyTalkSelectionRange, resetTalkSelectionStart, clearTalkSelection, enterTalkSelection, toggleTalkSelectionMode, toggleTalkMessageSelection, beginTalkMessagePress, moveTalkMessagePress, cancelTalkMessagePress, talkMessageQuoteText, talkMessageFavorited, talkMessageFavoriteBusy, toggleTalkQuoteFavorite, talkMessageSwipeOpen, talkMessageSwipeStyle, beginTalkFavoriteSwipe, moveTalkFavoriteSwipe, finishTalkFavoriteSwipe, cancelTalkFavoriteSwipe, exportSelectedMessagesImage, talkHasMore, loadMoreTalkMessages, onTalkScrollTop, scrollTalkBottom, refreshTalkMessages,
                nowHM, imageUrlPattern, attachmentUrl, attachmentAudioUrl, voiceState, voiceAudioEl, voiceBarPattern, voiceBarHeight,
                formatVoiceDuration, voiceDurationLabel, voiceProgressPct, toggleVoicePlay, normalAttachments, extractStickerUrl, generatedImagePattern, extractGeneratedImages,
                voiceTagPattern, cleanMessageContent, cleanForTts, imageUrlPatternG, messageSegments, talkMessageSegments, talkMessagePokeSegments, talkMessageBodySegments, talkMessageSocialCards, talkMessagePokeOnly, talkPokeSystemText, describeAttachmentForModel, messageContentForModel, promptWithAttachments,
                shouldSendAttachmentImage, attachmentPayloadForModel, buildTalkContext, talkLastMessage, talkLastTime, openTalkSection, backToTalkList, returnToTalkHome,
                openActiveTalk, pushConvo, loadConvosFromDB, newTalk, selectTalk, deleteTalk, renameTalk, onModelChange,
                buildTalkHandoffSummary, copyText, copyTalkSession, generateTalkHandoff, startNewClaudeSessionNextTurn, continueTalkInTerminal, terminalResumeCommand, copyTerminalResumeCommand, writeTerminalHandoff,
                sendTerminalShortcut, autoGrowTalk, handleTalkEnter, addTalkAttachment, onTalkImageSelect, removeTalkAttachment, onTalkMomentImageSelect, removeTalkMomentImage, publishTalkMoment,
                deleteTalkMoment, prepareMomentReply, addTalkMomentComment, importStickerText, importAiStickerText, uploadAiStickerFiles, addStickerToComposer, deleteSticker, deleteAiSticker, uploadTalkAvatar, uploadVirtualCameraImage,
                makeSpeechRecognition, toggleTalkDictation, voiceInputErrorText, bestAudioMime, setVoiceInputError, clearVoiceInput, releaseVoiceInputStream, transcribeVoiceBlob,
                appendLocalVoiceMessage, resetVoiceRecording, stopVoiceTracks, stopVoiceMessage, startVoiceMessage, toggleVoiceMessage, processVoiceInputBlob, stopVoiceInput,
                startVoiceInput, toggleVoiceInput, togglePhoneInspect, requestPhoneInspectFromAi, rejectPhoneInspectRequest, acceptPhoneInspectRequest, captureStreamFrame, stopPhoneInspectShare,
                extractTextFromClaudeContent, applyClaudeStreamEvent, RESUME_KEY, RESUME_ENDPOINT, setPendingStream, getPendingStream, streamAbort, lastChunkAt,
                staleTimer, resumePromise, stopStaleWatch, startStaleWatch, streamClaudeLikeResponse, resumeInFlight, maybeResume, formatClaudeAgentFailure,
                playTalkNotification, requestTalkNotificationPermission, testTalkWebPush, showTalkToast, jumpToTalkToast, syncTalkProactiveSettingsToServer, pollTalkProactiveEvents, postTalkActivity, callTts, synthesizeAssistantVoice, VOICE_FIELDS, saveVoicePreset, applyVoicePreset,
                deleteVoicePreset, previewTtsVoice, setTalkExecutionMode, forceTalkTerminalRelayNext, respondTalkTerminalPermission, talkConvoTitle, talkGroupNames, talkGroupedConvos, toggleTalkConvoGroup, createTalkConvoGroup, renameTalkConvoGroup, startTalkConvoDrag, endTalkConvoDrag, dropTalkConvoToGroup, loadMoreTalkConvos, onTalkConvoListScroll,
                renameTalkRemark, setTalkConvoGroup, toggleTalkPin, sendTalkMessage, retryMessage, retryLastFailed, regenerateMessage, isLastTalkMessage, sendTalk, pokeClaude, clearPendingPoke, requestAiTalkCall, rejectAiTalkCall, acceptAiTalkCall,
                afterCallSpeak, speakCallReplyBrowser, speakCallReply, startCallListening, sendCallTurn, attachCallVideoStream, startCallCamera, stopCallCamera,
                toggleCallCamera, startTalkCall, startVideoTalkCall, endTalkCall, restoreTalkCall, toggleCallMute, toggleHandsFree
            } = rifugioCtx;   // 拆分后这些名字分散在 8 个 talk 模块里，统一从合并完的 ctx 取

            let globalDataRefreshHandler = null;
            onMounted(() => {
                globalDataRefreshHandler = (event) => {
                    const task = (async () => {
                        await Promise.allSettled([
                            syncData(),
                            rifugioCtx.loadTalkMomentsFromServer?.(),
                            loadTalkStickersFromServer(),
                            loadBooks(),
                            loadMcpServers(),
                            loadImageConfig(),
                        ]);
                        await loadConvosFromDB();
                        await refreshTalkMessages({ silent:true });
                    })();
                    event.detail?.waitUntil?.(task);
                };
                window.addEventListener('rifugio-global-refresh-request', globalDataRefreshHandler);
            });
            onUnmounted(() => {
                if (globalDataRefreshHandler) {
                    window.removeEventListener('rifugio-global-refresh-request', globalDataRefreshHandler);
                    globalDataRefreshHandler = null;
                }
            });

return {
                mainTab, subTabs, isAbyss, xpTab, addPiano, togglePiano, postaTab, animaAuthor, daysTogether, inputs, data, dustParticles, homeQuote, homeQuoteId, homeQuoteIsPinned, filters, filteredMemories,
                calYear, calMonth, currentMonthName, daysInMonth, firstDayOffset, changeMonth, checkIn, checkInToday, isChecked,
                calCheckins, fetchCheckins, doCheckIn, isUserChecked, isClaudeChecked,
                logConversations, logActiveIdx, logSearch, logGlobalMode, logGlobalQuery, logGlobalResults, jumpToGlobalResult, logFilteredMessages, logListOpen, logEditingIdx, logEditingName, logJumpMessageIdx, logLoading, logLoadError, fetchLogConversations, onLogFileSelect, clearLog, deleteConvLog, startRenameLog, saveRenameLog,
                addPost, addTrace, addMail, addQuote, addDiary, addJoke, addWhisper, addAnima, addXp, addXpComment, uploadImage, importGalleryUrls,
                audioPlayer, currentTrack, isPlaying, togglePlay, addMusic, deleteMusic, isAddingMusic, musicError,
                isSyncing, syncData, addMemory, editMemory, saveMemory, cancelEdit,
                inboxMails, archivedMails, unreadCount, openMail, archiveMail, archiveOldMails,
                sortedPosts, pinnedPosts, togglePin,
                mergeMode, selectedMems, isMerging, toggleMergeMode, toggleSelectMem, mergeSelected,
                showLLMSettings, llm, testStatus, saveLLM, testLLM,
                // Ombre (casa)
                ombrePulse, ombreReveal, ombreLoading, showAddMem,
                domainColors, computedDomains, emotionQuadrants,
                domainDonut, emotionDonut, importanceBars, monthlyLine,
                unresolvedMems, refreshOmbre, holdToOmbre,
                breathIndex, currentBreath,
                // Memoria tab
                bucketStats, bucketLoading, bucketStatCards, bucketStateCards,
                allBuckets, feelBuckets, surfacedBuckets, editingBucket, editContent, editSaving, openEditBucket, saveEditBucket, filteredBuckets, filteredFeelBuckets, expandedBuckets,
                bucketFilter, bucketTypeFilter,
                bucketStatusLabel, bucketSourceOfFeel, bucketDreamReviewed, bucketDreamTitle, bucketLinkedFeelCount, loadBucketStats, loadFeelBuckets, resolveBucket, setBucketStatus, runDream, dreamLoading, dreamMsg, dreamSuggestions, hasDreamSuggestions, clearDreamSuggestions, dismissDreamSuggestion, confirmDreamSuggestion, bucketNameById, pinBucket, deleteBucket, renameBucket, feelFilter,
                showFeelForm, manualFeel, resetManualFeel, saveManualFeel,
                importFile, importDragging, importDryRun, importRunning, importProgress, importResult, importCandidates, selectedImportCount, importPersonas, importReplaceRules,
                bucketImportPrompt, bucketImportPromptMsg, loadBucketImportPrompt, saveBucketImportPrompt, resetBucketImportPrompt,
                onImportDrop, onImportFileSelect, runImport, confirmImport, cancelImportPreview,
                semanticQuery, searchResults, searchDone, runSemanticSearch,
                memSettings, availableModels, embedStatus, embedBatchMsg,
                fetchModels, saveMemSettings, loadEmbedStatus, runEmbedBatch,
                embedCfg, saveEmbedCfg, sttCfg, browserSttSupported, loadSttCfg, saveSttCfg, autoEmotionLoading, autoEmotionMsg, runAutoEmotion,
                dehydrateLoading, dehydrateMsg, runDehydrate, breathPreview, loadBreathPreview, dehydrateStatus, loadDehydrateStatus,
                dedupLoading, dedupMsg, runDedup,
                // 我 / I 自我认知
                selfVersions, selfExpanded, selfLoading, loadSelf, selfTimeline,
                // Theme
                themes, themeSwatches, currentTheme, showThemePicker, setTheme, randomTheme, isDark,
                // Wallpaper
                wallpapers, wallpaperOpacity, wallpaperBlur, wallpaperVeil, globalFontScale, wallpaperTabs, wallpaperPresets,
                showWallpaperModal, wpEditTab, wpUrlInput, currentWallpaper, wallpaperTintCss,
                applyWallpaperUrl, uploadWallpaper, clearWallpaper, saveWallpapers, glassMode,
                dockIcons, setDockIcon, resetDockIcon, uploadDockIcon, promptDockIcon, DEFAULT_DOCK_ICONS, getAppIcon,
                healthTabs, health, saveHealth, syncHealthFromBackend, healthCalendarTitle, healthPeriodSummary, healthMedicationSummary, healthMonthDays, selectedCycleRecord,
                menstrualFlowOptions, menstrualColorOptions, menstrualPainLocationOptions, menstrualMoodOptions, menstrualSymptomOptions, dischargeOptions,
                periodDayLabel, menstrualFlowHint, menstrualPainLabel, setMenstrualField, toggleMenstrualArray, saveSelectedMenstrualRecord,
                changeHealthMonth, selectPeriodDay, removePeriodDay, syncSelectedPeriodRecord, clearSelectedPeriodDay, dischargeDraft, recentDischargeEntries, dischargeLabel, saveDischargeEntry, deleteDischargeEntry, healthTrendStats, healthLineChart, updateHealthToday, todayKey, dueMedicationsToday, medicationTaken, medicationsDueOn, medicationsDoneOn, medicationScheduleLabel, addHealthMedication, toggleMedicationTaken, toggleMedicationDay, medicationDoseOn, formatCompact,
                mcp, saveMcp, addMcpTool, loadMcpServers, toggleMcpTool, setMcpScope, deleteMcpTool,
                imageStudio, loadImageConfig, saveImageServer, testImageConnection, addImagePreset, updateImagePreset, updateImagePresetDebounced, deleteImagePreset, setActivePreset,
                extractGeneratedImages,
                DEFAULT_DIARY_COVER, DEFAULT_GALLERY_COVER, photoHost, photoHostLinks, savePhotoHost, uploadToPhotoHost, imageFileToDisplayUrl,
                galleryUi, galleryFrames, galleryBorders, galleryPhotos, currentGalleryPhoto, saveGalleryTitle, openGalleryAlbum, closeGalleryAlbum, turnGalleryPage, setGalleryFrame, setGalleryBorder, setGalleryFit, applyGalleryCoverUrl, uploadGalleryCover, resetGalleryCover,
                diaryUi, diaryPages, currentDiaryPage, saveDiaryTitle, turnDiaryPage, openDiaryBook, closeDiaryBook, startDiaryNewPage, cancelDiaryNewPage, translateDiaryPage, applyDiaryCoverUrl, uploadDiaryCover, resetDiaryCover,
                chatroom, chatroomProfile, saveChatroomProfile, chatroomPorts, chatroomParticipants, chatroomHeaderNames, chatroomEnabledPorts, saveChatroomPorts, fetchChatroomModels, saveChatroomRoomSettings, applyChatroomCustomCss, resetChatroomCustomCss, setChatroomAnnouncement, sendChatroom, startRoomGame, chatroomChess, resetChatroomChess, selectChatroomSquare, roomAttachmentUrl, roomMessageAvatar, roomMessageAttachments, roomMessageSegments, removeChatroomAttachment, chatroomStickerItems, chatroomStickerSuggestions, importChatroomStickers, sendChatroomSticker, pickChatroomSuggestedSticker,
                radio, saveRadio, radioTabs, radioProviders, radioLoginProviders, radioAudioRef, activeRadioPlaylist, radioVisibleResults, radioQueueItems, radioPlayModes, radioPlayModeLabel, radioIsCurrentFavorite, radioExternalLinks, radioDetailLines, toggleRadioProvider, setRadioTab, searchRadio, playRadioItem, openRadioDetail, createRadioPlaylist, addRadioItemToPlaylist, removeRadioPlaylistItem, deleteRadioPlaylist, toggleRadioFavorite, setRadioPlayMode, openRadioQueuePanel, playRadioQueueItem, playRadioQueue, toggleRadioPlay, resumeBlockedRadio, onRadioLoadedMetadata, onRadioTimeUpdate, onRadioEnded, onRadioAudioError, seekRadio, setRadioSleepTimer, clearRadioSleepTimer, openRadioLoginPicker, startRadioProviderLogin, onRadioLocalFiles, onRadioImageUpload, playNextRadio, playPrevRadio, radioTypeLabel, radioProviderLabel, formatRadioTime,
                toy, connectToy, sendToyTest, stopToyNow, mockToyCommand, pollToyCommand,
                setToyAiControl, toyChannelLabel, toyActionLabel, toySourceLabel, toyCommandSummary, toyCommandTime,
                CRAB_STATES, IDLE_STATE, PET_ACTIONS, PET_METRICS, FOOD_ITEMS,
                crab, petStatus, petUi, petProfile, petFloatChanges, crabStateMeta, currentCrabAsset, crabFloatStyle, crabRoomMoment,
                petMetricItems, lowestPetMetric, petLevel, petXpProgress, activeFoodItem, visiblePetSkills, petProfileTitle,
                saveCrab, savePetProfile, showCrabBubble, setCrabState, pokeCrab, togglePetMenu, openFoodTray, closePetMenus,
                performPetAction, loadPetStatus, loadPetFoods, takeCrabOutside, returnCrabHome, startCrabDrag, moveCrabDrag, finishCrabDrag, cancelCrabDrag,
                phoneView, activePhoneAppId, phoneApps, phonePages, phoneDockApps, phoneDockIds, phoneDock, phonePageIndex, phoneEditMode, draggingHomeItemId, draggingDockAppId, homeDragEdge, canRemoveCurrentPhonePage, isPhonePageEmpty, showWidgetPanel, phoneHomeScroll, phoneDateLine, phoneClock, phoneClockDate, homeWidgetDefs, homeLayout, widgetDraft, widgetEditor, settingsPanel, chatTheme, chatThemeOptions, savePhoneAppLabels, resetPhoneAppLabel,
                widgetTemplateOptions, widgetShapeOptions, draftWidgetPhotos, editorWidgetPhotos, relationshipStartDate, widgetDays, widgetCountdown, widgetProgress, widgetUsesDate, formatWidgetDate, selectWidgetTemplate, setWidgetSizeChoice, uploadWidgetPhotos, removeWidgetPhoto,
                setWidgetAudioRef, updateWidgetAudio, toggleWidgetAudio, seekWidgetAudio, widgetAudioStateFor, widgetAudioProgress, formatAudioTime,
                openPhoneApp, closePhoneApp, goPhoneBack, finishPhoneEdit, onPhoneHomeScroll, focusHomePage, addPhonePage, removePhonePage, findPhoneApp, activePhoneTitle, activePhoneSubtitle, widgetPhotos, widgetTemplate, widgetTemplateClass,
                layoutItemStyle, getLayoutApp, widgetTitle, isWidgetEnabled, toggleWidget, addWidgetById, addCustomWidget, openWidgetEditor, closeWidgetEditor, saveWidgetEditor, moveWidgetLayer, deleteEditingWidget, removeHomeItem, saveHomeLayout, queueHomeLayoutSave, saveChatTheme,
                handleHomeItemClick, startHomeItemPress, moveHomeItemPress, endHomeItemPress, cancelHomeItemPress,
                handleDockAppClick, dockDragStyle, startDockAppPress, moveDockAppPress, endDockAppPress, cancelDockAppPress,
                biblio, biblioPages, visibleBiblioPage, renderedBookContent,
                loadBooks, uploadBookFile, openBook, loadBookChapter, saveBookProgress, onBiblioScroll,
                onBiblioReaderTap, onBiblioTouchStart, onBiblioTouchEnd,
                nextBookChapter, prevBookChapter, backToShelf, setBiblioFont, setBiblioTheme, setBiblioFlow,
                deleteBook, askClaudeAboutBook, onBiblioSelection, openSelectionNote, closeAnnotationSheet,
                saveSelectionAnnotation, askAiForAnnotation, openBookAnnotation, onBiblioContentClick,
                deleteBookAnnotation,
                showroom, showroomWorks, showroomFrameTitle,
                openShowroomWork, closeShowroomWork, markShowroomFrameReady, markShowroomFrameError,

                bzSection, llmSaveStatus, saveLLMLocal, onChatModeChange,
                talkSurface, terminalState, terminalMessage, claudeTerminalUrl, claudeTerminalKey, terminalResume,
                passkeyBusy, passkeyRegistered, unlockTerminalWithPasskey,
                openTerminalMode, closeTerminalMode, showTalkChat, reloadClaudeTerminal, copyTerminalResumeCommand, writeTerminalHandoff, sendTerminalShortcut, buildTalkHandoffSummary,
                terminalChat, terminalCall, terminalChatScroll, terminalMessageSegments, terminalDisplayName, terminalAvatar, terminalRelayStatusText, terminalContextStatusText, terminalStatusUpdatedText, terminalNowHM, clearTerminalChat,
                terminalProfile, saveTerminalProfile, uploadTerminalAvatar, addStickerToTerminal,
                terminalChatShortcut, terminalRawText, terminalInsertInput, terminalPasteClipboard, terminalCopyLastAssistant, terminalCopyTranscript,
                sendTerminalChat, terminalChatEnter, toggleTerminalVoice, openTerminalRaw, openTerminalChat, refreshTerminalChatStatus, showTerminalStatusPanel, forceTerminalRelayNext,
                startTerminalCall, endTerminalCall, toggleTerminalCallMute, startTerminalCallListening,
                // Chat
                chat, chatScroll, chatInput, sendChat, autoGrowChat, clearChat,
                talk, talkSettings, talkToast, jumpToTalkToast, talkScroll, TALK_MODELS, TALK_IMESSAGE_CUSTOM_CSS_PRESET, TALK_COMPANION_CUSTOM_CSS_PRESET, TALK_CUSTOM_CSS_PLACEHOLDER, NAI_IMAGE_MODELS, normalizeTtsProvider, ttsProviderMeta, ttsProviderNote, ttsProviderModelOptions, ttsVoicePlaceholder, ttsModelPlaceholder, ttsFormatPlaceholder, ttsSpeedBounds, ttsPitchBounds, isTtsReady, buildTtsPayload, ttsDebugPayload, activeConvo, relayStatusText, relayContextText, talkExecutionStatusText, talkTerminalRelayText, talkTerminalContextText, talkTerminalStatusUpdatedText, talkActiveSessionId, talkActiveSessionShort, talkActiveTurnsText, talkContextWindowPct, talkContextWindowText, talkAutoRelayText, talkHasPendingPreview, refreshTalkRelayState, refreshTalkTerminalStatus, openTalkSessionTools, talkVisibleMsgCount, talkVisibleConvos, talkConvosNeedMore, talkConvoRenderSummary, talkDisplayedMsgs, talkMessageFontStyle, talkChatDetailStyle, talkSearchResults, talkSearchSummaryText, openTalkSearch, closeTalkSearch, jumpTalkSearchResult, returnTalkSearchBottom, clearTalkSearch, talkMessageSelected, talkSelectionStatusText, talkSelectionActionLabel, applyTalkSelectionRange, resetTalkSelectionStart, clearTalkSelection, enterTalkSelection, toggleTalkSelectionMode, toggleTalkMessageSelection, beginTalkMessagePress, moveTalkMessagePress, cancelTalkMessagePress, talkMessageQuoteText, talkMessageFavorited, talkMessageFavoriteBusy, toggleTalkQuoteFavorite, talkMessageSwipeOpen, talkMessageSwipeStyle, beginTalkFavoriteSwipe, moveTalkFavoriteSwipe, finishTalkFavoriteSwipe, cancelTalkFavoriteSwipe, exportSelectedMessagesImage, talkHasMore, loadMoreTalkMessages, onTalkScrollTop, refreshTalkMessages, saveTalk, saveTalkSettings, fetchProviderModels, previewTtsVoice, requestTalkNotificationPermission, testTalkWebPush, saveVoicePreset, applyVoicePreset, deleteVoicePreset, insertTalkImessageCssPreset, insertTalkClaudeCssPreset,
                attachmentUrl, attachmentAudioUrl, normalAttachments, extractStickerUrl, cleanMessageContent, messageSegments, talkMessageSegments, talkMessagePokeSegments, talkMessageBodySegments, talkMessageSocialCards, talkMessagePokeOnly, talkPokeSystemText, voiceState, voiceBarHeight, voiceDurationLabel, voiceProgressPct, toggleVoicePlay,
                talkLastMessage, talkLastTime, talkConvoTitle, talkGroupNames, talkGroupedConvos, toggleTalkConvoGroup, createTalkConvoGroup, renameTalkConvoGroup, startTalkConvoDrag, endTalkConvoDrag, dropTalkConvoToGroup, loadMoreTalkConvos, onTalkConvoListScroll, openTalkSection, backToTalkList, returnToTalkHome, openActiveTalk,
                newTalk, selectTalk, deleteTalk, renameTalk, sendTalk, pokeClaude, clearPendingPoke, requestAiTalkCall, retryMessage, retryLastFailed, regenerateMessage, isLastTalkMessage, autoGrowTalk, handleTalkEnter, onModelChange,
                renameTalkRemark, setTalkConvoGroup, toggleTalkPin,
                talkProfile, saveTalkProfile, talkAiDisplayName, profileCardsRef, profileCardIndex, relationshipDaysText, toggleProfileCardEdit, scrollProfileCard, onProfileCardsScroll, uploadTalkProfileImage, uploadTalkAvatar, uploadVirtualCameraImage, stickerLibrary, aiStickerLibrary, stickerDraft, aiStickerDraft, importStickerText, importAiStickerText, uploadAiStickerFiles, addStickerToComposer, deleteSticker, deleteAiSticker, saveStickers, loadTalkStickersFromServer, persistTalkStickerToServer, syncTalkStickersToServer,
                stickerFilter, stickerSearch, stickerEditMode, stickerImportCategory, stickerCategories, stickerMoveCategories, filteredStickers, moveStickerToCategory, aiStickerFilter, aiStickerSearch, aiStickerEditMode, aiStickerImportCategory, aiStickerCategories, aiStickerMoveCategories, aiStickerResidentCount, filteredAiStickers, moveAiStickerToCategory, toggleAiStickerResident, stickerSuggestions, pickSuggestedSticker,
                onTalkImageSelect, removeTalkAttachment, onTalkMomentImageSelect, removeTalkMomentImage, publishTalkMoment, deleteTalkMoment, prepareMomentReply, addTalkMomentComment, toggleTalkDictation, toggleVoiceMessage, toggleVoiceInput, voiceInputStatusText,
                copyTalkSession, continueTalkInTerminal, generateTalkHandoff, startNewClaudeSessionNextTurn, setTalkExecutionMode, forceTalkTerminalRelayNext, respondTalkTerminalPermission, syncTalkProactiveSettingsToServer, pollTalkProactiveEvents, postTalkActivity,
                togglePhoneInspect, requestPhoneInspectFromAi, rejectPhoneInspectRequest, acceptPhoneInspectRequest, stopPhoneInspectShare,
                talkCall, callVideoRef, talkCallElapsed, requestAiTalkCall, rejectAiTalkCall, acceptAiTalkCall, startTalkCall, startVideoTalkCall, endTalkCall, restoreTalkCall, toggleCallMute, toggleHandsFree, toggleCallCamera, sendCallTurn,
            }
        }
    }).mount('#app');

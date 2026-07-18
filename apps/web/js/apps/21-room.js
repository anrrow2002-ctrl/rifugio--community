// Crab Room · resident state, care system and draggable phone companion.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useCrabRoom = function(ctx) {
    const { reactive, computed, onMounted, onUnmounted, nextTick } = Vue;
    with (ctx) {
        const CRAB_STATES = [
            { id:'sleep',      label:'睡觉',   asset:'/pets/crab/sleep.png',      line:'翻过来睡一下……💤' },
            { id:'eating',     label:'吃饭',   asset:'/pets/crab/eating.gif',     line:'啊呜啊呜，吃得很认真。' },
            { id:'bathing',    label:'洗澡',   asset:'/pets/crab/bathing.gif',    line:'泡泡要堆到脑袋上。' },
            { id:'petting',    label:'摸摸',   asset:'/pets/crab/petting.gif',    line:'再摸一下也可以……♡' },
            { id:'studying',   label:'学习',   asset:'/pets/crab/studying.gif?v=crab-study-v2-20260714',   line:'这一页我马上就懂啦。' },
            { id:'playing',    label:'玩耍',   asset:'/pets/crab/playing.gif',    line:'把球丢过来！' },
            { id:'walking',    label:'遛弯',   asset:'/pets/crab/walking.gif',    line:'横着散步也算散步。' },
            { id:'bubbles',    label:'吹泡泡', asset:'/pets/crab/bubbles.gif',    line:'啵。一个很圆的泡泡。' },
            { id:'celebrate',  label:'庆祝',   asset:'/pets/crab/celebrate.gif',  line:'今天值得挥两下钳子。' },
            { id:'cleaning',   label:'打扫',   asset:'/pets/crab/cleaning.gif',   line:'小屋要住得干干净净。' },
            { id:'cooking',    label:'做饭',   asset:'/pets/crab/cooking.gif',    line:'锅里咕嘟咕嘟，马上就好。' },
            { id:'cool',       label:'耍酷',   asset:'/pets/crab/cool.gif',       line:'嗯，今天也很酷。' },
            { id:'cowboy',     label:'牛仔',   asset:'/pets/crab/cowboy.gif',     line:'这间小屋由本蟹守护。' },
            { id:'dancing',    label:'跳舞',   asset:'/pets/crab/dancing.gif',    line:'横着走也可以跳舞。' },
            { id:'decorating', label:'装修',   asset:'/pets/crab/decorating.gif', line:'这里再挂一点什么。' },
            { id:'engineer',   label:'修理',   asset:'/pets/crab/engineer.gif',   line:'让我看看是哪颗螺丝。' },
            { id:'falling',    label:'比心',   asset:'/pets/crab/falling.gif',    line:'喜欢你，给你一颗小心心。' },
            { id:'headshake',  label:'摇头',   asset:'/pets/crab/headshake.gif',  line:'不可以喔。' },
            { id:'idea',       label:'灵感',   asset:'/pets/crab/idea.gif',       line:'叮——想到了。' },
            { id:'listening',  label:'听歌',   asset:'/pets/crab/listening.gif',  line:'这段要再听一遍。' },
            { id:'loading',    label:'发呆',   asset:'/pets/crab/loading.gif',    line:'脑子正在转圈圈。' },
            { id:'superhero',  label:'英雄',   asset:'/pets/crab/superhero.gif',  line:'需要本蟹出场吗？' },
            { id:'surfing',    label:'冲浪',   asset:'/pets/crab/surfing.gif',    line:'客厅也能有浪。' },
            { id:'thinking',   label:'思考',   asset:'/pets/crab/thinking.gif',   line:'让我认真想一下。' },
            { id:'wizard',     label:'魔法',   asset:'/pets/crab/wizard.gif',     line:'小屋魔法，悄悄生效。' },
        ];
        const IDLE_STATE = { id:'idle', label:'日常', asset:'/pets/crab/idle.png', line:'没忙什么，只是在家陪你。' };

        const PET_ACTIONS = [
            { id:'feed',  label:'喂饭', glyph:'🍽', state:'eating',   gif:'eating.gif',   duration:3600, line:'今天想吃哪一种？', deltas:{ hunger:30 } },
            { id:'play',  label:'玩耍', glyph:'🧶', state:'playing',  gif:'playing.gif',  duration:3600, line:'来玩球啦！', deltas:{ mood:20 } },
            { id:'clean', label:'打扫', glyph:'🧹', state:'cleaning', gif:'cleaning.gif', duration:6200, line:'一起把小屋打扫干净。', deltas:{ clean:30 } },
            { id:'study', label:'学习', glyph:'📖', state:'studying', gif:'studying.gif?v=crab-study-v2-20260714', duration:3600, line:'今天学一点新东西。', deltas:{ knowledge:15 } },
            { id:'pet',   label:'摸摸', glyph:'♡',  state:'petting',  gif:'petting.gif',  duration:3600, line:'这里可以多摸两下。', deltas:{ mood:10, affection:5 } },
            { id:'bath',  label:'洗澡', glyph:'🫧', state:'bathing',  gif:'bathing.gif',  duration:3800, line:'温水和泡泡都准备好啦。', deltas:{ clean:50 } },
            { id:'walk',  label:'遛弯', glyph:'🌿', state:'walking',  gif:'walking.gif',  duration:3600, line:'出去横着走一圈。', deltas:{ mood:15 } },
        ];
        const PET_METRICS = [
            { key:'hunger',   label:'饱腹', glyph:'🍤', color:'#ee9b78' },
            { key:'mood',     label:'心情', glyph:'♡',  color:'#e58ba5' },
            { key:'clean',    label:'清洁', glyph:'✦',  color:'#71b9c8' },
            { key:'knowledge',label:'知识', glyph:'📖', color:'#8f83c7' },
        ];
        const FOOD_ITEMS = reactive([
            { id:'fish',       label:'小鱼',     asset:'/pets/crab/food-fish.png',        line:'小鱼今天很新鲜。' },
            { id:'seaweed',    label:'海藻',     asset:'/pets/crab/food-seaweed.png',     line:'脆脆的海藻卷。' },
            { id:'shrimp',     label:'虾',       asset:'/pets/crab/food-shrimp.png',      line:'一只胖乎乎的小虾。' },
            { id:'shellfish',  label:'贝肉',     asset:'/pets/crab/food-shellfish.png',        line:'藏在贝壳里的软软一口。' },
            { id:'starfish_cookie', label:'海星饼干', asset:'/pets/crab/food-starfish-cookie.png', line:'撒了海盐的星星饼干。' },
            { id:'ocean_jelly',label:'海洋果冻', asset:'/pets/crab/food-ocean-jelly.png', line:'会轻轻晃的薄荷果冻。' },
        ]);

        const clamp = (value, min=0, max=100) => Math.max(min, Math.min(max, Number(value) || 0));
        const saved = (() => {
            try { return JSON.parse(localStorage.getItem('rifugio-crab-room-v1') || '{}'); } catch(_) { return {}; }
        })();
        const cachedStatus = (() => {
            try { return JSON.parse(localStorage.getItem('rifugio-crab-pet-status-v1') || '{}'); } catch(_) { return {}; }
        })();
        const savedProfile = (() => {
            try { return JSON.parse(localStorage.getItem('rifugio-crab-profile-v1') || '{}'); } catch(_) { return {}; }
        })();
        const savedPetChat = (() => {
            try { return JSON.parse(localStorage.getItem('rifugio-crab-chat-v1') || '{}'); } catch(_) { return {}; }
        })();

        const crab = reactive({
            detached:!!saved.detached,
            returning:false,
            x:Number.isFinite(Number(saved.x)) ? Number(saved.x) : Math.max(18, window.innerWidth - 132),
            y:Number.isFinite(Number(saved.y)) ? Number(saved.y) : Math.max(92, window.innerHeight * .28),
            state:'idle', dynamicAsset:'', actionAsset:'',
            message:IDLE_STATE.line, bubble:true, dragged:false,
        });
        const petStatus = reactive({
            hunger:clamp(cachedStatus.hunger ?? 72),
            mood:clamp(cachedStatus.mood ?? 78),
            clean:clamp(cachedStatus.clean ?? 80),
            knowledge:clamp(cachedStatus.knowledge ?? 26),
            affection:clamp(cachedStatus.affection ?? 0, 0, 9999),
            xp:Math.max(0, Number(cachedStatus.xp) || 0),
            level:Math.max(0, Number(cachedStatus.level) || 0),
            next_level_xp:Math.max(0, Number(cachedStatus.next_level_xp) || 0),
            skills:Array.isArray(cachedStatus.skills) ? cachedStatus.skills : [],
            current_gif:String(cachedStatus.current_gif || ''),
            last_action_at:String(cachedStatus.last_action_at || ''),
            last_action_gif:'', last_action_msg:'',
            message:'', online:false, lastSync:0,
        });
        let localProfileEdited = savedProfile._edited === true;
        const petProfile = reactive({
            name:String(savedProfile.name || 'Clawd'),
            birthday:String(savedProfile.birthday || ''),
            father:String(savedProfile.father || savedProfile.dad || 'Companion'),
            mother:String(savedProfile.mother || savedProfile.mom || 'User'),
            species:String(savedProfile.species || '像素螃蟹'),
            personality:String(savedProfile.personality || '贪吃、爱装酷、学东西慢但认真、被摸会吹泡泡、深夜自己翻肚皮睡觉'),
            bio:String(savedProfile.bio || '刚刚来到 Rifugio 的小宝宝，正在慢慢认识这个世界。'),
        });
        const petUi = reactive({
            menuOpen:false, foodOpen:false, profileOpen:false, busy:false,
            activeFood:'', syncText:'',
            diaryOpen:false, diaryView:'cover', diaryLoading:false, diaryWriting:false, diaryMessage:'', diaryEntries:[],
            diaryForm:{ author:'mom', content:'', mood:'happy' },
            chatOpen:false, chatBusy:false, chatInput:'', chatKeyboardOpen:false, chatViewportStyle:{ '--crab-chat-height':'100dvh', '--crab-chat-top':'0px' },
            chatMessages:Array.isArray(savedPetChat.messages) ? savedPetChat.messages.slice(-40) : [],
            ai:{
                provider:'openai', base_url:'https://api.openai.com/v1', api_key:'', model:'gpt-4o-mini',
                daily_diary:false, daily_hour:22, loading:false, saving:false, testing:false, status:'',
                providers:[
                    { id:'openai', label:'OpenAI', base_url:'https://api.openai.com/v1', model:'gpt-4o-mini' },
                    { id:'deepseek', label:'DeepSeek', base_url:'https://api.deepseek.com/v1', model:'deepseek-chat' },
                    { id:'glm', label:'GLM 智谱', base_url:'https://open.bigmodel.cn/api/paas/v4', model:'glm-4-flash' },
                    { id:'gemini', label:'Gemini', base_url:'https://generativelanguage.googleapis.com/v1beta/openai', model:'gemini-2.5-flash' },
                    { id:'moonshot', label:'Moonshot', base_url:'https://api.moonshot.cn/v1', model:'moonshot-v1-8k' },
                    { id:'siliconflow', label:'硅基流动', base_url:'https://api.siliconflow.cn/v1', model:'' },
                    { id:'openrouter', label:'OpenRouter', base_url:'https://openrouter.ai/api/v1', model:'' },
                ],
            },
        });
        const petFloatChanges = reactive([]);
        const crabDrag = { active:false, pointerId:null, offsetX:0, offsetY:0, startX:0, startY:0, moved:false };
        let crabScrollLocked = false;
        const stopCrabTouchScroll = event => {
            if (crabScrollLocked && event.cancelable) event.preventDefault();
        };
        const lockCrabScroll = () => {
            if (crabScrollLocked) return;
            crabScrollLocked = true;
            document.documentElement.classList.add('pwa-drag-scroll-lock');
            document.body.classList.add('pwa-drag-scroll-lock');
            document.addEventListener('touchmove', stopCrabTouchScroll, { passive:false, capture:true });
        };
        const unlockCrabScroll = () => {
            if (!crabScrollLocked) return;
            crabScrollLocked = false;
            document.removeEventListener('touchmove', stopCrabTouchScroll, true);
            document.documentElement.classList.remove('pwa-drag-scroll-lock');
            document.body.classList.remove('pwa-drag-scroll-lock');
        };
        let stateTimer = null;
        let bubbleTimer = null;
        let activityTimer = null;
        let statusTimer = null;
        let statusSyncInFlight = false;
        let actionSerial = 0;
        let lastSeenActionAt = String(cachedStatus.last_action_at || '');
        let petChatBaseHeight = 0;
        const pendingPolledActions = [];

        const crabStateMeta = computed(() => CRAB_STATES.find(item => item.id === crab.state) || IDLE_STATE);
        const currentCrabAsset = computed(() => crab.actionAsset || crab.dynamicAsset || crabStateMeta.value.asset);
        const crabFloatStyle = computed(() => ({ left:Math.round(crab.x) + 'px', top:Math.round(crab.y) + 'px' }));
        const petMetricItems = computed(() => PET_METRICS.map(item => ({ ...item, value:clamp(petStatus[item.key]) })));
        const lowestPetMetric = computed(() => petMetricItems.value.reduce((lowest, item) => item.value < lowest.value ? item : lowest, petMetricItems.value[0]));
        const petLevel = computed(() => petStatus.level > 0 ? petStatus.level : Math.floor(petStatus.xp / 100) + 1);
        const petXpProgress = computed(() => {
            if (petStatus.next_level_xp > 0) return clamp((petStatus.xp / petStatus.next_level_xp) * 100);
            return clamp(petStatus.xp % 100);
        });
        const activeFoodItem = computed(() => FOOD_ITEMS.find(item => item.id === petUi.activeFood) || null);
        const petProfileTitle = computed(() => petProfile.name.trim() || '小螃蟹');
        const visiblePetSkills = computed(() => {
            let raw = petStatus.skills;
            if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = Object.keys(raw).filter(key => raw[key]);
            const skills = Array.isArray(raw) ? raw.map(item => typeof item === 'string' ? item : (item?.name || item?.id || '')).filter(Boolean) : [];
            if (petStatus.knowledge >= 80 && !skills.some(item => String(item).toLowerCase() === 'wizard')) skills.push('wizard');
            const labels = { wizard:'小小魔法师', engineer:'小小工程师', superhero:'百级小英雄', cleaner:'整理大师', scholar:'故事学者', explorer:'散步队长', foodie:'海味鉴赏家' };
            return [...new Set(skills)].map(id => ({ id, label:labels[String(id).toLowerCase()] || String(id) }));
        });
        const crabRoomMoment = computed(() => {
            const h = new Date().getHours();
            if (h < 6) return '夜深了，小螃蟹还留了一盏灯。';
            if (h < 11) return '早安。小屋刚刚醒来。';
            if (h < 17) return '阳光落在地毯上，适合慢慢生活。';
            if (h < 22) return '欢迎回来，屋里正暖着。';
            return '今天也辛苦了，坐一会儿吧。';
        });

        const saveCrab = () => {
            try { localStorage.setItem('rifugio-crab-room-v1', JSON.stringify({ detached:crab.detached, x:crab.x, y:crab.y })); } catch(_) {}
        };
        const savePetCache = () => {
            try {
                localStorage.setItem('rifugio-crab-pet-status-v1', JSON.stringify({
                    hunger:petStatus.hunger, mood:petStatus.mood, clean:petStatus.clean, knowledge:petStatus.knowledge,
                    affection:petStatus.affection, xp:petStatus.xp, level:petStatus.level,
                    next_level_xp:petStatus.next_level_xp, skills:petStatus.skills, current_gif:petStatus.current_gif,
                    last_action_at:petStatus.last_action_at,
                }));
            } catch(_) {}
        };
        const savePetProfile = () => {
            petProfile.name = petProfile.name.trim() || '小蟹';
            localProfileEdited = true;
            try { localStorage.setItem('rifugio-crab-profile-v1', JSON.stringify({ ...petProfile, _edited:true })); } catch(_) {}
            petUi.profileOpen = false;
            showCrabBubble('好啦，我的资料卡收好啦。');
        };
        const petProfilePayload = () => ({
            name:String(petProfile.name || '').slice(0, 40), birthday:String(petProfile.birthday || '').slice(0, 20),
            father:String(petProfile.father || '').slice(0, 60), mother:String(petProfile.mother || '').slice(0, 60),
            species:String(petProfile.species || '').slice(0, 50), personality:String(petProfile.personality || '').slice(0, 240),
            bio:String(petProfile.bio || '').slice(0, 240),
        });
        const diaryAuthorLabel = author => ({ mom:'妈妈', dad:'爸爸', clawd:petProfileTitle.value })[String(author || '').toLowerCase()] || '家人';
        const diaryAuthorGlyph = author => ({ mom:'🌷', dad:'🌙', clawd:'🦀' })[String(author || '').toLowerCase()] || '♡';
        const diaryMoodLabel = mood => ({ happy:'开心', calm:'安静', loved:'被爱', proud:'骄傲', tired:'困困', need_hug:'想抱抱' })[String(mood || '').toLowerCase()] || '小日常';
        const formatPetDiaryDate = raw => {
            const value = String(raw || '').trim();
            if (!value) return '今天';
            const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
            if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
            return parsed.toLocaleDateString('zh-CN', { month:'long', day:'numeric', weekday:'short' });
        };
        const loadPetDiary = async () => {
            petUi.diaryLoading = true;
            petUi.diaryMessage = '';
            try {
                const response = await fetch('/api/pet/diary?limit=30', { credentials:'same-origin', cache:'no-store' });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                const rows = Array.isArray(payload) ? payload : (payload.data || payload.diary || []);
                petUi.diaryEntries = Array.isArray(rows) ? rows : [];
            } catch(error) {
                petUi.diaryMessage = '记录本暂时打不开：' + (error?.message || '连接失败');
            } finally { petUi.diaryLoading = false; }
        };
        const openPetDiary = () => {
            closePetMenus();
            closePetChat();
            petUi.diaryOpen = true;
            petUi.diaryView = 'cover';
            loadPetDiary();
        };
        const openPetDiaryPages = () => {
            petUi.diaryView = 'pages';
            if (!petUi.diaryEntries.length) loadPetDiary();
        };
        const closePetDiary = () => {
            petUi.diaryOpen = false;
            petUi.diaryMessage = '';
        };
        const writePetDiary = async () => {
            const content = String(petUi.diaryForm.content || '').trim();
            if (!content || petUi.diaryWriting) return;
            petUi.diaryWriting = true;
            petUi.diaryMessage = '正在把今天夹进书页里…';
            try {
                const response = await fetch('/api/pet/diary', {
                    method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({ author:petUi.diaryForm.author, content:content.slice(0, 3000), mood:petUi.diaryForm.mood }),
                });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                petUi.diaryForm.content = '';
                petUi.diaryMessage = '这一页写好啦 ♡';
                await loadPetDiary();
                petUi.diaryMessage = '这一页写好啦 ♡';
                showCrabBubble('我会把今天好好记住的。');
            } catch(error) {
                petUi.diaryMessage = '没有写进去：' + (error?.message || '请稍后再试');
            } finally { petUi.diaryWriting = false; }
        };
        const askClawdToWriteDiary = async () => {
            if (petUi.diaryWriting) return;
            petUi.diaryWriting = true;
            petUi.diaryMessage = petProfileTitle.value + ' 正趴在纸上认真写字…';
            try {
                const response = await fetch('/api/pet/diary/generate', {
                    method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({ profile:petProfilePayload() }),
                });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                await loadPetDiary();
                petUi.diaryView = 'pages';
                petUi.diaryMessage = '宝宝日记写完啦 🦀';
                showCrabBubble('嘘，这是我自己写的今天。');
            } catch(error) {
                petUi.diaryMessage = '还没写成：' + (error?.message || '先检查养娃 API');
            } finally { petUi.diaryWriting = false; }
        };
        const savePetChatLocal = () => {
            try { localStorage.setItem('rifugio-crab-chat-v1', JSON.stringify({ messages:petUi.chatMessages.slice(-40) })); } catch(_) {}
        };
        const scrollPetChatBottom = () => nextTick(() => {
            const thread = document.querySelector('.crab-chat-thread');
            if (thread) thread.scrollTop = thread.scrollHeight;
        });
        const updatePetChatViewport = () => {
            if (!petUi.chatOpen) return;
            const viewport = window.visualViewport;
            const height = Math.max(300, Math.round(viewport?.height || window.innerHeight));
            const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
            if (!petChatBaseHeight) petChatBaseHeight = Math.max(height, window.innerHeight || height);
            petUi.chatKeyboardOpen = height < petChatBaseHeight - 96;
            petUi.chatViewportStyle = { '--crab-chat-height':height + 'px', '--crab-chat-top':top + 'px' };
            scrollPetChatBottom();
        };
        const lockPetChatPage = () => {
            document.documentElement.classList.add('pet-chat-scroll-lock');
            document.body.classList.add('pet-chat-scroll-lock');
        };
        const unlockPetChatPage = () => {
            document.documentElement.classList.remove('pet-chat-scroll-lock');
            document.body.classList.remove('pet-chat-scroll-lock');
            petUi.chatKeyboardOpen = false;
            petUi.chatViewportStyle = { '--crab-chat-height':'100dvh', '--crab-chat-top':'0px' };
            petChatBaseHeight = 0;
        };
        const focusPetChatInput = () => {
            updatePetChatViewport();
            [80,220,420].forEach(delay => setTimeout(updatePetChatViewport, delay));
        };
        const blurPetChatInput = () => {
            [80,260].forEach(delay => setTimeout(updatePetChatViewport, delay));
        };
        const openPetChat = () => {
            closePetMenus();
            petUi.diaryOpen = false;
            const viewport = window.visualViewport;
            petChatBaseHeight = Math.max(Math.round(viewport?.height || 0), window.innerHeight || 0, document.documentElement.clientHeight || 0);
            lockPetChatPage();
            petUi.chatOpen = true;
            if (!petUi.chatMessages.length) {
                petUi.chatMessages.push({ id:'hello-' + Date.now(), role:'assistant', content:'你回来啦。今天想和我说什么？' });
                savePetChatLocal();
            }
            nextTick(() => { updatePetChatViewport(); scrollPetChatBottom(); });
        };
        const closePetChat = () => {
            petUi.chatOpen = false;
            unlockPetChatPage();
        };
        const clearPetChat = () => {
            petUi.chatMessages.splice(0);
            petUi.chatMessages.push({ id:'hello-' + Date.now(), role:'assistant', content:'重新认识一下也没关系，我还是你的 ' + petProfileTitle.value + '。' });
            savePetChatLocal();
            scrollPetChatBottom();
        };
        const sendPetChat = async () => {
            const message = String(petUi.chatInput || '').trim().slice(0, 900);
            if (!message || petUi.chatBusy) return;
            const history = petUi.chatMessages.slice(-10).map(item => ({ role:item.role === 'assistant' ? 'assistant' : 'user', content:String(item.content || '').slice(0, 900) }));
            petUi.chatMessages.push({ id:'user-' + Date.now(), role:'user', content:message });
            petUi.chatInput = '';
            petUi.chatBusy = true;
            savePetChatLocal();
            scrollPetChatBottom();
            try {
                const response = await fetch('/api/pet/chat', {
                    method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({ message, history, caregiver:'mom', profile:petProfilePayload() }),
                });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                const reply = String(payload?.data?.message || payload?.message || '').trim();
                if (!reply) throw new Error('Clawd 没有说出话来');
                petUi.chatMessages.push({ id:'clawd-' + Date.now(), role:'assistant', content:reply.slice(0, 2000) });
                showCrabBubble(reply.slice(0, 48));
            } catch(error) {
                petUi.chatMessages.push({ id:'error-' + Date.now(), role:'assistant', error:true, content:'我刚刚没接上声音……' + (error?.message || '请检查养娃 API。') });
            } finally {
                petUi.chatBusy = false;
                savePetChatLocal();
                scrollPetChatBottom();
            }
        };
        const loadPetAiConfig = async () => {
            petUi.ai.loading = true;
            try {
                const response = await fetch('/api/settings/pet-ai', { credentials:'same-origin', cache:'no-store' });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                const data = payload.data || {};
                ['provider','base_url','api_key','model','daily_diary','daily_hour'].forEach(key => {
                    if (data[key] !== undefined && data[key] !== null) petUi.ai[key] = data[key];
                });
                petUi.ai.status = data.api_key ? '🔒 API Key 已在服务器加密保存' : '还没有配置养娃 API';
            } catch(error) { petUi.ai.status = '读取失败：' + (error?.message || '连接失败'); }
            finally { petUi.ai.loading = false; }
        };
        const applyPetAiPreset = id => {
            const preset = petUi.ai.providers.find(item => item.id === id);
            if (!preset) return;
            petUi.ai.provider = preset.id;
            petUi.ai.base_url = preset.base_url;
            petUi.ai.model = preset.model;
            petUi.ai.status = '已选择 ' + preset.label + '，填好 Key 后保存';
        };
        const savePetAiConfig = async () => {
            if (petUi.ai.saving) return;
            petUi.ai.saving = true;
            petUi.ai.status = '正在安全保存…';
            try {
                const response = await fetch('/api/settings/pet-ai', {
                    method:'PUT', credentials:'same-origin', headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({
                        provider:petUi.ai.provider, base_url:petUi.ai.base_url, api_key:petUi.ai.api_key,
                        model:petUi.ai.model, daily_diary:petUi.ai.daily_diary, daily_hour:petUi.ai.daily_hour,
                    }),
                });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                Object.assign(petUi.ai, payload.data || {});
                petUi.ai.status = '✓ 已加密保存，模型只拥有宝宝资料的只读上下文';
            } catch(error) { petUi.ai.status = '保存失败：' + (error?.message || '请检查配置'); }
            finally { petUi.ai.saving = false; }
        };
        const testPetAiConfig = async () => {
            if (petUi.ai.testing) return;
            petUi.ai.testing = true;
            petUi.ai.status = '正在轻轻叫醒 Clawd…';
            try {
                const response = await fetch('/api/settings/pet-ai/test', {
                    method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({ provider:petUi.ai.provider, base_url:petUi.ai.base_url, api_key:petUi.ai.api_key, model:petUi.ai.model }),
                });
                const payload = await response.json();
                if (!response.ok || payload?.ok === false) throw new Error(payload?.error || ('HTTP ' + response.status));
                petUi.ai.status = '✓ ' + (payload?.data?.message || 'Clawd 已醒来');
            } catch(error) { petUi.ai.status = '测试失败：' + (error?.message || '请检查接口'); }
            finally { petUi.ai.testing = false; }
        };
        const showCrabBubble = (line) => {
            crab.message = line || crabStateMeta.value.line;
            crab.bubble = true;
            clearTimeout(bubbleTimer);
            bubbleTimer = setTimeout(() => { crab.bubble = false; }, 4600);
        };
        const setCrabState = (id, temporary=true, duration=6200) => {
            const next = CRAB_STATES.find(item => item.id === id) || IDLE_STATE;
            crab.state = next.id;
            crab.dynamicAsset = '';
            showCrabBubble(next.line);
            clearTimeout(stateTimer);
            if (temporary && next.id !== 'idle') {
                stateTimer = setTimeout(() => {
                    crab.state = 'idle';
                    crab.message = IDLE_STATE.line;
                }, next.id === 'sleep' ? 16000 : duration);
            }
        };
        const cacheCrabAsset = (asset) => {
            const clean = String(asset || '').split('?')[0].split('#')[0];
            return clean.endsWith('/studying.gif') ? clean + '?v=crab-study-v2-20260714' : asset;
        };
        const gifAsset = (raw) => {
            const value = String(raw || '').trim();
            if (!value) return '';
            if (/^https?:\/\//i.test(value)) return value;
            const filename = value.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g, '');
            const stem = filename.replace(/\.(gif|png|webp)$/i, '').toLowerCase();
            if (stem === 'sleeping' || stem === 'sleep') return '/pets/crab/sleep.png';
            if (value.startsWith('/pets/')) return cacheCrabAsset(value);
            const aliases = { like:'falling.gif', heart:'falling.gif', love:'falling.gif', feed:'eating.gif', play:'playing.gif', bath:'bathing.gif', pet:'petting.gif', study:'studying.gif', walk:'walking.gif' };
            return cacheCrabAsset('/pets/crab/' + (aliases[stem] || (filename.includes('.') ? filename : filename + '.gif')));
        };
        const applyCurrentGif = (raw) => {
            const asset = gifAsset(raw);
            if (!asset) return;
            const stem = asset.split('?')[0].split('/').pop().replace(/\.(gif|png|webp)$/i, '');
            const match = CRAB_STATES.find(item => item.id === stem || item.asset === asset);
            if (match) {
                crab.state = match.id;
                crab.dynamicAsset = '';
            } else {
                crab.dynamicAsset = asset;
            }
        };
        const sourceValue = (source, names, fallback) => {
            for (const name of names) if (source && source[name] !== undefined && source[name] !== null) return source[name];
            return fallback;
        };
        const applyServerProfile = (profile) => {
            if (!profile || typeof profile !== 'object' || localProfileEdited) return;
            petProfile.name = String(profile.name || petProfile.name);
            petProfile.birthday = String(profile.birthday || petProfile.birthday);
            petProfile.father = String(profile.dad || profile.father || petProfile.father);
            petProfile.mother = String(profile.mom || profile.mother || petProfile.mother);
            petProfile.species = String(profile.species || petProfile.species);
            petProfile.personality = String(profile.personality || petProfile.personality);
            petProfile.bio = String(profile.bio || petProfile.bio);
        };
        const applyPetPayload = (payload) => {
            const source = payload?.status || payload?.pet || payload?.data || payload || {};
            petStatus.hunger = clamp(sourceValue(source, ['hunger','satiety','fullness'], petStatus.hunger));
            petStatus.mood = clamp(sourceValue(source, ['mood','happiness'], petStatus.mood));
            petStatus.clean = clamp(sourceValue(source, ['clean','cleanliness','hygiene'], petStatus.clean));
            petStatus.knowledge = clamp(sourceValue(source, ['knowledge','study','intelligence'], petStatus.knowledge));
            petStatus.affection = clamp(sourceValue(source, ['affection','love','friendship'], petStatus.affection), 0, 9999);
            petStatus.xp = Math.max(0, Number(sourceValue(source, ['xp','experience'], petStatus.xp)) || 0);
            petStatus.level = Math.max(0, Number(sourceValue(source, ['level'], petStatus.level)) || 0);
            petStatus.next_level_xp = Math.max(0, Number(sourceValue(source, ['next_level_xp','xp_to_next','level_xp'], petStatus.next_level_xp)) || 0);
            petStatus.skills = sourceValue(source, ['skills','unlocked_skills'], petStatus.skills) || [];
            petStatus.current_gif = String(sourceValue(payload, ['current_gif'], sourceValue(source, ['current_gif','gif'], petStatus.current_gif)) || '');
            petStatus.message = String(sourceValue(payload, ['message'], sourceValue(source, ['message'], '')) || '');
            applyServerProfile(sourceValue(payload, ['profile'], sourceValue(source, ['profile'], null)));
            petStatus.lastSync = Date.now();
            savePetCache();
            if (!petUi.busy && petStatus.current_gif) applyCurrentGif(petStatus.current_gif);
            return { source, payload:payload || {} };
        };
        const readLastAction = (payload) => {
            const source = payload?.status || payload?.pet || payload?.data || payload || {};
            return {
                at:String(sourceValue(payload, ['last_action_at'], sourceValue(source, ['last_action_at'], '')) || ''),
                gif:String(sourceValue(payload, ['last_action_gif'], sourceValue(source, ['last_action_gif'], '')) || ''),
                msg:String(sourceValue(payload, ['last_action_msg'], sourceValue(source, ['last_action_msg'], '')) || ''),
            };
        };
        const remoteActionDuration = (raw) => {
            const filename = String(raw || '').split('?')[0].split('/').pop();
            const local = PET_ACTIONS.find(item => String(item.gif).split('?')[0] === filename);
            return local?.duration || (filename === 'cleaning.gif' ? 6200 : 4200);
        };
        const releaseActionPlayback = () => {
            crab.actionAsset = '';
            petUi.activeFood = '';
            petUi.busy = false;
            const pending = pendingPolledActions.shift();
            if (pending) {
                setTimeout(() => playPolledAction(pending), 0);
                return;
            }
            if (petStatus.current_gif) applyCurrentGif(petStatus.current_gif);
            else applyNeedsState();
        };
        const playPolledAction = (event) => {
            if (!event || (!event.gif && !event.msg)) return;
            if (petUi.busy) {
                pendingPolledActions.push(event);
                return;
            }
            const asset = gifAsset(event.gif);
            const serial = ++actionSerial;
            petUi.busy = true;
            petUi.menuOpen = false;
            petUi.foodOpen = false;
            if (asset) crab.actionAsset = asset;
            showCrabBubble(event.msg || 'Clawd 刚刚完成了一件事。');
            setTimeout(() => {
                if (serial !== actionSerial) return;
                releaseActionPlayback();
            }, remoteActionDuration(event.gif));
        };
        const rememberLastAction = (payload, playWhenChanged=false) => {
            const event = readLastAction(payload);
            if (!event.at) return;
            const changed = event.at !== lastSeenActionAt;
            lastSeenActionAt = event.at;
            petStatus.last_action_at = event.at;
            petStatus.last_action_gif = event.gif;
            petStatus.last_action_msg = event.msg;
            savePetCache();
            if (playWhenChanged && changed) playPolledAction(event);
        };
        const loadPetFoods = async () => {
            try {
                const response = await fetch('/api/pet/foods', { credentials:'same-origin', cache:'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const payload = await response.json();
                const list = Array.isArray(payload) ? payload : (payload.foods || payload.items || payload.data || []);
                if (!Array.isArray(list)) return;
                list.forEach(remote => {
                    const id = String(remote.id || remote.item || remote.key || '');
                    const local = FOOD_ITEMS.find(item => item.id === id);
                    if (!local) return;
                    local.label = String(remote.label || remote.name || local.label);
                    local.value = Number(remote.hunger ?? remote.satiety ?? remote.fullness ?? remote.value ?? local.value ?? 0);
                });
            } catch(_) {}
        };
        const loadPetStatus = async (options={}) => {
            if (statusSyncInFlight) return;
            statusSyncInFlight = true;
            if (!options.quiet) petUi.syncText = '正在看看状态…';
            try {
                const response = await fetch('/api/pet/status', { credentials:'same-origin', cache:'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const payload = await response.json();
                applyPetPayload(payload);
                rememberLastAction(payload, true);
                petStatus.online = true;
                petUi.syncText = '刚刚同步';
            } catch(_) {
                petStatus.online = false;
                petUi.syncText = '本地陪伴中';
            } finally {
                statusSyncInFlight = false;
            }
        };
        const snapshotPetValues = () => ({
            hunger:petStatus.hunger, mood:petStatus.mood, clean:petStatus.clean, knowledge:petStatus.knowledge,
            affection:petStatus.affection, xp:petStatus.xp,
        });
        const pushPetFloat = (text, tone='good') => {
            const item = { id:'pet-float-' + Date.now() + '-' + Math.random().toString(16).slice(2), text, tone };
            petFloatChanges.push(item);
            setTimeout(() => {
                const index = petFloatChanges.findIndex(entry => entry.id === item.id);
                if (index >= 0) petFloatChanges.splice(index, 1);
            }, 1900);
        };
        const showPetChanges = (before, after, fallback={}) => {
            const labels = { hunger:'饱腹', mood:'心情', clean:'清洁', knowledge:'知识', affection:'好感', xp:'经验' };
            let shown = 0;
            Object.keys(labels).forEach(key => {
                const delta = Math.round((Number(after[key]) || 0) - (Number(before[key]) || 0));
                if (!delta) return;
                pushPetFloat((delta > 0 ? '+' : '') + delta + labels[key], delta > 0 ? 'good' : 'down');
                shown += 1;
            });
            if (!shown) Object.entries(fallback).forEach(([key, delta]) => pushPetFloat('+' + delta + (labels[key] || key)));
        };
        const applyLocalAction = (action) => {
            Object.entries(action.deltas || {}).forEach(([key, delta]) => {
                if (key === 'affection') petStatus[key] = clamp((petStatus[key] || 0) + delta, 0, 9999);
                else petStatus[key] = clamp((petStatus[key] || 0) + delta);
            });
            petStatus.xp = Math.max(0, petStatus.xp + 5);
            savePetCache();
        };
        const togglePetMenu = () => {
            if (petUi.busy) return;
            petUi.foodOpen = false;
            petUi.menuOpen = !petUi.menuOpen;
            if (petUi.menuOpen) showCrabBubble('想和我做什么？');
        };
        const openFoodTray = () => {
            if (petUi.busy) return;
            petUi.menuOpen = false;
            petUi.foodOpen = true;
            showCrabBubble('唔……每一种都想吃。');
        };
        const closePetMenus = () => { petUi.menuOpen = false; petUi.foodOpen = false; };
        const performPetAction = async (actionId, foodId='') => {
            const action = PET_ACTIONS.find(item => item.id === actionId);
            if (!action || petUi.busy) return;
            if (action.id === 'feed' && !foodId) { openFoodTray(); return; }
            const serial = ++actionSerial;
            const before = snapshotPetValues();
            const food = FOOD_ITEMS.find(item => item.id === foodId) || null;
            petUi.busy = true;
            petUi.menuOpen = false;
            petUi.foodOpen = false;
            petUi.activeFood = food?.id || '';
            const localActionAsset = '/pets/crab/' + action.gif;
            const localActionStartedAt = Date.now();
            crab.actionAsset = localActionAsset;
            setCrabState(action.state, false);
            let resolvedMessage = food ? ('选了' + food.label + '。' + food.line) : action.line;
            showCrabBubble(resolvedMessage);
            let mappedActionAsset = '';
            try {
                const response = await fetch('/api/pet/action', {
                    method:'POST', credentials:'same-origin',
                    headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify(action.id === 'feed' ? { action:action.id, item:food?.id || 'fish' } : { action:action.id }),
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const payload = await response.json();
                applyPetPayload(payload);
                rememberLastAction(payload, false);
                petStatus.online = true;
                const remoteGif = sourceValue(payload, ['action_gif'], sourceValue(payload?.status || payload?.pet || payload?.data || {}, ['action_gif'], ''));
                if (remoteGif) mappedActionAsset = gifAsset(remoteGif);
                resolvedMessage = payload.message || petStatus.message || action.line;
            } catch(_) {
                applyLocalAction(action);
                petStatus.online = false;
            }
            showPetChanges(before, snapshotPetValues(), action.deltas);
            const finishActionSequence = () => {
                if (serial !== actionSerial) return;
                releaseActionPlayback();
            };
            const finishLocalAction = () => {
                if (serial !== actionSerial) return;
                const assetKey = asset => String(asset || '').split('?')[0].split('/').pop();
                const shouldPlayMapped = mappedActionAsset && assetKey(mappedActionAsset) !== assetKey(localActionAsset);
                if (!shouldPlayMapped) { finishActionSequence(); return; }
                crab.actionAsset = mappedActionAsset;
                showCrabBubble(resolvedMessage);
                setTimeout(finishActionSequence, action.duration || 3800);
            };
            const localRemaining = Math.max(0, (action.duration || 3800) - (Date.now() - localActionStartedAt));
            setTimeout(finishLocalAction, localRemaining);
        };
        const applyNeedsState = () => {
            if (petUi.busy) return;
            if (petStatus.current_gif && petStatus.online) { applyCurrentGif(petStatus.current_gif); return; }
            const lowest = lowestPetMetric.value;
            if (lowest && lowest.value <= 55) {
                const stateMap = { hunger:'eating', mood:'headshake', clean:'cleaning', knowledge:'studying' };
                setCrabState(stateMap[lowest.key] || 'thinking', false);
                showCrabBubble(lowest.key === 'hunger' ? '肚子有一点空了……' : lowest.key === 'mood' ? '今天想多陪我玩一会儿。' : lowest.key === 'clean' ? '好像该洗洗、扫扫了。' : '今天也想学一点新东西。');
            } else {
                setCrabState('idle', false);
            }
        };

        const pokeCrab = togglePetMenu;
        const takeCrabOutside = () => {
            closePetMenus();
            crab.detached = true;
            crab.returning = false;
            crab.state = 'idle';
            crab.x = Math.min(Math.max(18, crab.x), Math.max(18, window.innerWidth - 126));
            crab.y = Math.min(Math.max(82, crab.y), Math.max(82, window.innerHeight - 164));
            showCrabBubble('抓到啦。现在可以把我拖到屏幕任何地方。');
            saveCrab();
        };
        const returnCrabHome = () => {
            if (crab.returning) return;
            closePetMenus();
            crab.returning = true;
            crab.state = 'idle';
            crab.x = Math.max(16, (window.innerWidth - 112) / 2);
            crab.y = Math.max(96, window.innerHeight * .36);
            setTimeout(() => {
                crab.detached = false;
                crab.returning = false;
                crab.message = '回家了。';
                crab.bubble = true;
                saveCrab();
                openPhoneApp(findPhoneApp('room'));
            }, 680);
        };
        const startCrabDrag = (event) => {
            if (crab.returning) return;
            event.preventDefault(); event.stopPropagation();
            lockCrabScroll();
            crabDrag.active = true;
            crabDrag.pointerId = event.pointerId;
            crabDrag.offsetX = event.clientX - crab.x;
            crabDrag.offsetY = event.clientY - crab.y;
            crabDrag.startX = event.clientX;
            crabDrag.startY = event.clientY;
            crabDrag.moved = false;
            crab.dragged = true;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch(_) {}
        };
        const moveCrabDrag = (event) => {
            if (!crabDrag.active || event.pointerId !== crabDrag.pointerId) return;
            event.preventDefault(); event.stopPropagation();
            const maxX = Math.max(12, window.innerWidth - 124);
            const maxY = Math.max(72, window.innerHeight - 154);
            crab.x = Math.max(12, Math.min(maxX, event.clientX - crabDrag.offsetX));
            crab.y = Math.max(72, Math.min(maxY, event.clientY - crabDrag.offsetY));
            if (Math.hypot(event.clientX - crabDrag.startX, event.clientY - crabDrag.startY) > 7) crabDrag.moved = true;
        };
        const finishCrabDrag = (event) => {
            if (!crabDrag.active || event.pointerId !== crabDrag.pointerId) return;
            event.preventDefault(); event.stopPropagation();
            const wasMoved = crabDrag.moved;
            crabDrag.active = false;
            crabDrag.pointerId = null;
            crab.dragged = false;
            unlockCrabScroll();
            saveCrab();
            if (!wasMoved) togglePetMenu();
        };
        const cancelCrabDrag = () => {
            crabDrag.active = false;
            crabDrag.pointerId = null;
            crab.dragged = false;
            unlockCrabScroll();
            saveCrab();
        };
        const clampCrabToScreen = () => {
            crab.x = Math.max(12, Math.min(Math.max(12, window.innerWidth - 124), crab.x));
            crab.y = Math.max(72, Math.min(Math.max(72, window.innerHeight - 154), crab.y));
            saveCrab();
        };

        Object.assign(petUi, {
            diaryAuthorLabel, diaryAuthorGlyph, diaryMoodLabel, formatPetDiaryDate,
            loadPetDiary, openPetDiary, openPetDiaryPages, closePetDiary, writePetDiary, askClawdToWriteDiary,
            openPetChat, closePetChat, clearPetChat, sendPetChat, focusPetChatInput, blurPetChatInput,
            loadPetAiConfig, applyPetAiPreset, savePetAiConfig, testPetAiConfig,
        });

        onMounted(() => {
            window.addEventListener('resize', clampCrabToScreen, { passive:true });
            window.addEventListener('pagehide', unlockCrabScroll, { passive:true });
            window.visualViewport?.addEventListener('resize', updatePetChatViewport, { passive:true });
            window.visualViewport?.addEventListener('scroll', updatePetChatViewport, { passive:true });
            loadPetStatus();
            loadPetFoods();
            loadPetAiConfig();
            statusTimer = setInterval(() => loadPetStatus({ quiet:true }), 10000);
            activityTimer = setInterval(() => {
                if (petUi.busy || petUi.menuOpen || petUi.foodOpen) return;
                if (crab.detached) {
                    if (petStatus.current_gif && petStatus.online) { applyCurrentGif(petStatus.current_gif); return; }
                    const desktopStates = ['idle','bubbles','cool','walking','falling','listening','thinking'];
                    setCrabState(desktopStates[Math.floor(Math.random() * desktopStates.length)]);
                    return;
                }
                if (activePhoneAppId.value !== 'room') return;
                if (petStatus.current_gif && petStatus.online) { applyCurrentGif(petStatus.current_gif); return; }
                if (lowestPetMetric.value?.value <= 55) { applyNeedsState(); return; }
                const hour = new Date().getHours();
                const everyday = (hour >= 23 || hour < 7)
                    ? ['sleep','sleep','thinking','bubbles']
                    : ['cleaning','cooking','decorating','listening','thinking','bubbles','sleep','falling'];
                setCrabState(everyday[Math.floor(Math.random() * everyday.length)]);
            }, 28000);
        });
        onUnmounted(() => {
            window.removeEventListener('resize', clampCrabToScreen);
            window.removeEventListener('pagehide', unlockCrabScroll);
            window.visualViewport?.removeEventListener('resize', updatePetChatViewport);
            window.visualViewport?.removeEventListener('scroll', updatePetChatViewport);
            unlockCrabScroll();
            unlockPetChatPage();
            clearInterval(activityTimer); clearInterval(statusTimer); clearTimeout(stateTimer); clearTimeout(bubbleTimer);
        });

        return {
            CRAB_STATES, IDLE_STATE, PET_ACTIONS, PET_METRICS, FOOD_ITEMS,
            crab, petStatus, petUi, petProfile, petFloatChanges,
            crabStateMeta, currentCrabAsset, crabFloatStyle, crabRoomMoment,
            petMetricItems, lowestPetMetric, petLevel, petXpProgress, activeFoodItem, visiblePetSkills, petProfileTitle,
            saveCrab, savePetProfile, showCrabBubble, setCrabState, pokeCrab, togglePetMenu, openFoodTray, closePetMenus,
            performPetAction, loadPetStatus, loadPetFoods, takeCrabOutside, returnCrabHome,
            startCrabDrag, moveCrabDrag, finishCrabDrag, cancelCrabDrag,
        };
    }
};

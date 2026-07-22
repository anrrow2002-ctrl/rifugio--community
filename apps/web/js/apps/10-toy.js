// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useToy = function(ctx) {
    const { reactive } = Vue;
    with (ctx) {
            // ============================================================
            // AI Toy · VPS dashboard → Mac BLE Bridge → SOSEXY
            // ============================================================
            const toy = reactive({
                connected:false,
                bridgeAlive:false,
                allowAiControl:false,
                intensity:20,
                channel:'vibrate',
                status:'正在检查 Mac 蓝牙桥…',
                error:'',
                deviceName:'SOSEXY',
                commands:[],
                busy:false,
                lastCheckedAt:'',
                stopTimer:null,
                // 失控模式（wild）：波形在 Mac 桥本地跑，这里只是启动器 + 看板。
                wildDuration:600,
                wildRunning:false,
                wildRemaining:null,
                wildMode:'',
                wildNote:'',
                wildBusy:false,
                wildEndsAt:0,
                wildStatusStale:false,
            });
            try {
                const savedToy = JSON.parse(localStorage.getItem('rifugio-toy-v2') || '{}');
                if (['suck','vibrate','current'].includes(savedToy.channel)) toy.channel = savedToy.channel;
                if (Number.isFinite(Number(savedToy.intensity))) toy.intensity = Math.max(0, Math.min(100, Number(savedToy.intensity)));
                if ([600,900,1200,1800].includes(Number(savedToy.wildDuration))) toy.wildDuration = Number(savedToy.wildDuration);
            } catch(_) {}
            const saveToy = () => {
                try { localStorage.setItem('rifugio-toy-v2', JSON.stringify({ channel:toy.channel, intensity:toy.intensity, wildDuration:toy.wildDuration })); } catch(_) {}
            };
            Vue.watch(() => [toy.channel, toy.intensity, toy.wildDuration], saveToy);
            const TOY_WILD_CHOICES = [
                { value:600, label:'10 分钟' },
                { value:900, label:'15 分钟' },
                { value:1200, label:'20 分钟' },
                { value:1800, label:'30 分钟' },
            ];
            let wildPollTimer = null;
            let wildTickTimer = null;

            const toyApi = async (path, options = {}) => {
                const response = await fetch('/api/toy' + path, { credentials:'include', cache:'no-store', ...options });
                let data = {};
                try { data = await response.json(); } catch(_) {}
                if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
                return data;
            };
            const applyToyState = (state = {}) => {
                toy.bridgeAlive = state.bridgeAlive === true;
                toy.connected = state.toyConnected === true;
                toy.allowAiControl = state.aiControlEnabled === true;
                toy.deviceName = state.deviceName || 'SOSEXY';
                toy.commands = Array.isArray(state.history) ? state.history : [];
                toy.lastCheckedAt = state.lastCheckedAt || '';
                if (toy.connected) toy.status = 'SOSEXY 已连接，手机可以查看和控制。';
                else if (toy.bridgeAlive) toy.status = 'Mac 桥在线；打开或重启玩具后会自动重连。';
                else toy.status = 'Mac 桥离线；请确认 Mac 已开机并保持唤醒。';
                if (state.lastError && !toy.bridgeAlive) toy.error = state.lastError;
            };
            const loadToyState = async (quiet = false) => {
                if (!quiet) { toy.busy = true; toy.error = ''; toy.status = '正在检查连接…'; }
                try {
                    const data = await toyApi('/state');
                    applyToyState(data.state);
                } catch(e) {
                    toy.bridgeAlive = false;
                    toy.connected = false;
                    toy.error = '状态检查失败：' + e.message;
                    toy.status = '暂时无法联系 VPS。';
                } finally { if (!quiet) toy.busy = false; }
            };
            // 打开/刷新时顺带看一眼桥上有没有正在跑的 wild（比如 Companion 从聊天里启动的），有就接管看板。
            const connectToy = () => { loadToyState(false); pollWildStatus().then(() => { if (toy.wildRunning) startWildPolling(); }).catch(() => {}); };
            const pollToyCommand = () => loadToyState(true);

            const sendToyTest = async () => {
                toy.busy = true;
                toy.error = '';
                try {
                    const data = await toyApi('/set', {
                        method:'POST',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ channel:toy.channel, intensity:Number(toy.intensity) }),
                    });
                    applyToyState(data.state);
                    toy.status = `${toyChannelLabel(toy.channel)}已设为 ${toy.intensity}/100。`;
                } catch(e) { toy.error = '发送失败：' + e.message; }
                finally { toy.busy = false; }
            };
            const stopToyNow = async () => {
                toy.busy = true;
                toy.error = '';
                try {
                    const data = await toyApi('/stop', {
                        method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ source:'user' }),
                    });
                    applyToyState(data.state);
                    toy.status = '已立即停止全部通道。';
                } catch(e) { toy.error = '紧急停止失败：' + e.message; }
                finally { toy.busy = false; }
            };
            // ── 失控模式：fire-and-forget 启动 + 只读看板 ─────────────────
            // 铁律：倒计时、断线、轮询失败都只影响“显示”；唯一会发 /stop 的入口
            // 是用户明确点击停止（stopToyWild → stopToyNow）。
            const stopWildTimers = () => {
                if (wildPollTimer) { clearInterval(wildPollTimer); wildPollTimer = null; }
                if (wildTickTimer) { clearInterval(wildTickTimer); wildTickTimer = null; }
            };
            const tickWildCountdown = () => {
                if (!toy.wildRunning) return;
                const left = Math.max(0, Math.round((toy.wildEndsAt - Date.now()) / 1000));
                toy.wildRemaining = left;
                if (left <= 0) toy.wildNote = '倒计时结束，等待 Mac 桥确认收尾…';
            };
            const pollWildStatus = async () => {
                try {
                    const data = await toyApi('/wild-status');
                    if (data.ok !== true) throw new Error('unavailable');
                    toy.wildStatusStale = false;
                    toy.connected = data.toyConnected === true;
                    toy.wildMode = data.mode || '';
                    if (data.running === true) {
                        toy.wildRunning = true;
                        if (data.remaining !== null && Number.isFinite(Number(data.remaining))) {
                            toy.wildRemaining = Math.max(0, Math.round(Number(data.remaining)));
                            toy.wildEndsAt = Date.now() + toy.wildRemaining * 1000;
                        }
                        toy.wildNote = '桥端本地运行中；关掉页面、断网都不影响。';
                        if (!wildTickTimer) wildTickTimer = setInterval(tickWildCountdown, 1000);
                    } else if (toy.wildRunning) {
                        toy.wildRunning = false;
                        toy.wildRemaining = null;
                        toy.wildNote = '本轮已结束（桥端确认）。';
                        stopWildTimers();
                    }
                } catch(_) {
                    // 轮询失败＝看板降级，绝不当作“已结束”，更不发送任何停止指令。
                    toy.wildStatusStale = true;
                    toy.wildNote = '状态暂时不可用（运行不受影响）';
                }
            };
            const startWildPolling = () => {
                if (!wildPollTimer) wildPollTimer = setInterval(pollWildStatus, 5000);
                if (!wildTickTimer) wildTickTimer = setInterval(tickWildCountdown, 1000);
            };
            const startToyWild = async () => {
                const duration = [600,900,1200,1800].includes(Number(toy.wildDuration)) ? Number(toy.wildDuration) : 600;
                toy.wildBusy = true;
                toy.error = '';
                try {
                    const data = await toyApi('/wild', {
                        method:'POST', headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ duration }),
                    });
                    if (data.state) applyToyState(data.state);
                    toy.wildRunning = true;
                    toy.wildRemaining = duration;
                    toy.wildEndsAt = Date.now() + duration * 1000;
                    toy.wildNote = '已启动：波形由 Mac 桥本地生成。';
                    startWildPolling();
                } catch(e) {
                    toy.error = '失控模式启动失败：' + e.message;
                } finally { toy.wildBusy = false; }
            };
            const stopToyWild = async () => {
                await stopToyNow();
                // 不在本地武断清状态：停止是否生效由桥说了算，立即拉一次真实状态，
                // 轮询确认 running=false 后才收口（stopToyNow 失败时页面会如实继续显示运行中）。
                if (!toy.error) toy.wildNote = '已发送停止，等待桥确认…';
                pollWildStatus();
            };
            const toyWildClock = () => {
                const seconds = Number(toy.wildRemaining);
                if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
                return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
            };
            const setToyAiControl = async () => {
                const enabled = !!toy.allowAiControl;
                toy.busy = true;
                toy.error = '';
                try {
                    const data = await toyApi('/ai-control', {
                        method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ enabled }),
                    });
                    applyToyState(data.state);
                    toy.status = enabled ? '已允许 Claude 控制；每次调用都会显示在下方。' : '已关闭 Claude 控制，并发送了立即停止。';
                } catch(e) {
                    toy.allowAiControl = !enabled;
                    toy.error = '授权修改失败：' + e.message;
                } finally { toy.busy = false; }
            };
            const mockToyCommand = () => loadToyState(false);
            const pushToyCommand = () => {};
            const applyToyCommand = () => {};
            const toyChannelLabel = (value) => ({ suck:'吮吸', vibrate:'震动', current:'电流' }[value] || value || '通道');
            const toyActionLabel = (value) => ({ set:'设置', sequence:'序列', flow:'连续曲线', wild:'失控模式', stop:'停止' }[value] || value || '调用');
            const toySourceLabel = (value) => ({ mcp:'Claude', user:'你', permission:'授权保护' }[value] || value || '系统');
            const toyCommandSummary = (cmd) => {
                if (cmd.action === 'set') return `${toyChannelLabel(cmd.channel)} · ${cmd.intensity}/100`;
                if (cmd.action === 'sequence') return `${Array.isArray(cmd.steps) ? cmd.steps.length : 0} 步序列`;
                if (cmd.action === 'flow') return `${Array.isArray(cmd.steps) ? cmd.steps.length : 0} 段曲线 · ${Number(cmd.duration || 0).toFixed(1)} 秒`;
                if (cmd.action === 'wild') return `${Number(cmd.duration || 0)} 秒 · 上限 ${cmd.ceiling}/100 · ${(cmd.channels || []).map(toyChannelLabel).join('＋')}`;
                return '全部通道归零';
            };
            const toyCommandTime = (cmd) => {
                try { return new Date(cmd.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
                catch(_) { return cmd.createdAt || ''; }
            };

        return { toy, saveToy, connectToy, pushToyCommand, applyToyCommand, sendToyTest, stopToyNow, mockToyCommand, pollToyCommand,
            setToyAiControl, toyChannelLabel, toyActionLabel, toySourceLabel, toyCommandSummary, toyCommandTime,
            TOY_WILD_CHOICES, startToyWild, stopToyWild, pollWildStatus, toyWildClock };
    }
};

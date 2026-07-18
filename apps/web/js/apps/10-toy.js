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
            });
            try {
                const savedToy = JSON.parse(localStorage.getItem('rifugio-toy-v2') || '{}');
                if (['suck','vibrate','current'].includes(savedToy.channel)) toy.channel = savedToy.channel;
                if (Number.isFinite(Number(savedToy.intensity))) toy.intensity = Math.max(0, Math.min(100, Number(savedToy.intensity)));
            } catch(_) {}
            const saveToy = () => {
                try { localStorage.setItem('rifugio-toy-v2', JSON.stringify({ channel:toy.channel, intensity:toy.intensity })); } catch(_) {}
            };
            Vue.watch(() => [toy.channel, toy.intensity], saveToy);

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
            const connectToy = () => loadToyState(false);
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
            setToyAiControl, toyChannelLabel, toyActionLabel, toySourceLabel, toyCommandSummary, toyCommandTime };
    }
};

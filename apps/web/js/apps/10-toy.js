// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useToy = function(ctx) {
    const { reactive } = Vue;
    with (ctx) {
            // ============================================================
            // AI Toy · Android Web Bluetooth first, optional remote bridge
            // ============================================================
            const TOY_SERVICE_UUID = '0000ee01-0000-1000-8000-00805f9b34fb';
            const TOY_WRITE_UUID = '0000ee03-0000-1000-8000-00805f9b34fb';
            const TOY_OPTIONAL_SERVICES = [
                TOY_SERVICE_UUID,
                '0000ee00-0000-1000-8000-00805f9b34fb',
                '0000ffe0-0000-1000-8000-00805f9b34fb',
            ];
            const TOY_CHANNEL_BYTES = {
                suck:[0x07, 0x08],
                vibrate:[0x01, 0x02],
                current:[0x03, 0x04],
            };
            const directSupported = Boolean(window.isSecureContext && navigator.bluetooth);
            const toyClientId = (() => {
                const key = 'rifugio-toy-direct-client';
                let value = sessionStorage.getItem(key);
                if (!value) {
                    value = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
                    sessionStorage.setItem(key, value);
                }
                return value;
            })();
            const toy = reactive({
                connected:false,
                directSupported,
                directOnline:false,
                transport:'none',
                bridgeAlive:false,
                bridgeConfigured:false,
                allowAiControl:false,
                intensity:20,
                channel:'vibrate',
                status:directSupported ? '点击“连接安卓蓝牙”选择 SOSEXY。' : '当前浏览器不支持 Web Bluetooth，正在检查外部蓝牙桥…',
                error:'',
                deviceName:'SOSEXY',
                commands:[],
                busy:false,
                lastCheckedAt:'',
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
                const savedToy = JSON.parse(localStorage.getItem('rifugio-toy-v3') || localStorage.getItem('rifugio-toy-v2') || '{}');
                if (['suck','vibrate','current'].includes(savedToy.channel)) toy.channel = savedToy.channel;
                if (Number.isFinite(Number(savedToy.intensity))) toy.intensity = Math.max(0, Math.min(100, Number(savedToy.intensity)));
                if ([600,900,1200,1800].includes(Number(savedToy.wildDuration))) toy.wildDuration = Number(savedToy.wildDuration);
            } catch(_) {}
            const saveToy = () => {
                try { localStorage.setItem('rifugio-toy-v3', JSON.stringify({ channel:toy.channel, intensity:toy.intensity, wildDuration:toy.wildDuration })); } catch(_) {}
            };
            Vue.watch(() => [toy.channel, toy.intensity, toy.wildDuration], saveToy);
            const TOY_WILD_CHOICES = [
                { value:600, label:'10 分钟' },
                { value:900, label:'15 分钟' },
                { value:1200, label:'20 分钟' },
                { value:1800, label:'30 分钟' },
            ];
            let bleDevice = null;
            let bleWriteCharacteristic = null;
            let directPollTimer = null;
            let directHeartbeatTimer = null;
            let bridgeWildPollTimer = null;
            let wildTickTimer = null;
            let directRunVersion = 0;

            const toyApi = async (path, options = {}) => {
                const response = await fetch('/api/toy' + path, { credentials:'include', cache:'no-store', ...options });
                let data = {};
                try { data = await response.json(); } catch(_) {}
                if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
                return data;
            };
            const postToyJson = (path, body) => toyApi(path, {
                method:'POST',
                headers:{ 'Content-Type':'application/json' },
                body:JSON.stringify(body || {}),
            });
            const applyToyState = (state = {}) => {
                toy.bridgeAlive = state.bridgeAlive === true;
                toy.bridgeConfigured = state.bridgeConfigured === true;
                toy.directOnline = state.directOnline === true;
                toy.allowAiControl = state.aiControlEnabled === true;
                toy.deviceName = state.deviceName || 'SOSEXY';
                toy.commands = Array.isArray(state.history) ? state.history : [];
                toy.lastCheckedAt = state.lastCheckedAt || '';
                if (bleWriteCharacteristic && bleDevice?.gatt?.connected) {
                    toy.connected = true;
                    toy.transport = 'direct';
                    toy.status = '安卓蓝牙已直连 SOSEXY。';
                    toy.error = '';
                } else {
                    toy.connected = state.toyConnected === true;
                    toy.transport = state.transport || 'none';
                    if (toy.transport === 'bridge') toy.status = '外部蓝牙桥已连接 SOSEXY。';
                    else if (toy.directSupported) toy.status = '点击“连接安卓蓝牙”选择附近的 SOSEXY。';
                    else if (toy.bridgeConfigured) toy.status = toy.bridgeAlive ? '外部蓝牙桥在线，等待玩具。' : '外部蓝牙桥离线。';
                    else toy.status = '当前浏览器不支持 Web Bluetooth，也没有配置外部蓝牙桥。';
                    if (state.lastError && !toy.directSupported) toy.error = state.lastError;
                }
            };
            const loadToyState = async (quiet = false) => {
                if (!quiet) { toy.busy = true; toy.error = ''; toy.status = '正在检查连接…'; }
                try {
                    const data = await toyApi('/state');
                    applyToyState(data.state);
                } catch(e) {
                    toy.error = '状态检查失败：' + e.message;
                } finally {
                    if (!quiet) toy.busy = false;
                }
            };

            const reportDirectState = async () => {
                if (!directSupported) return;
                try {
                    const data = await postToyJson('/direct/state', {
                        clientId:toyClientId,
                        supported:true,
                        connected:Boolean(bleWriteCharacteristic && bleDevice?.gatt?.connected),
                        wildRunning:toy.wildRunning,
                        wildEndsAt:toy.wildEndsAt,
                    });
                    if (data.state) applyToyState(data.state);
                } catch(_) {}
            };
            const reportDirectEvent = async (action, ok, details = {}, error = '') => {
                try {
                    const data = await postToyJson('/direct/event', { action, ok, details, error });
                    if (data.state) applyToyState(data.state);
                } catch(_) {}
            };

            const packetFor = (channel, intensity) => {
                const bytes = TOY_CHANNEL_BYTES[channel];
                if (!bytes) throw new Error('未知玩具通道');
                const value = Math.max(0, Math.min(100, Math.round(Number(intensity) || 0)));
                return new Uint8Array([0x01,0x01,0x00,0x02,0x00,bytes[0],0x11,value,0x00,bytes[1],0x11,0x01]);
            };
            const writeDirect = async (channel, intensity) => {
                if (!bleWriteCharacteristic || !bleDevice?.gatt?.connected) throw new Error('请先连接安卓蓝牙');
                const packet = packetFor(channel, intensity);
                if (bleWriteCharacteristic.properties?.writeWithoutResponse && bleWriteCharacteristic.writeValueWithoutResponse) {
                    await bleWriteCharacteristic.writeValueWithoutResponse(packet);
                } else {
                    await bleWriteCharacteristic.writeValue(packet);
                }
            };
            const stopDirectProgram = () => { directRunVersion += 1; };
            const stopDirectChannels = async () => {
                stopDirectProgram();
                for (const channel of Object.keys(TOY_CHANNEL_BYTES)) {
                    try { await writeDirect(channel, 0); } catch(_) {}
                }
                toy.wildRunning = false;
                toy.wildRemaining = null;
                toy.wildEndsAt = 0;
            };
            const directSleep = (seconds, version) => new Promise(resolve => {
                const endAt = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
                const tick = () => {
                    if (version !== directRunVersion) return resolve(false);
                    if (Date.now() >= endAt) return resolve(true);
                    setTimeout(tick, Math.min(100, endAt - Date.now()));
                };
                tick();
            });
            const runDirectSequence = async (steps, version) => {
                try {
                    for (const step of steps || []) {
                        if (version !== directRunVersion) break;
                        await writeDirect(step.channel, step.intensity);
                        if (!await directSleep(step.hold == null ? 1 : step.hold, version)) break;
                    }
                } finally {
                    if (version === directRunVersion) await stopDirectChannels();
                }
            };
            const runDirectFlow = async (steps, version) => {
                try {
                    for (const step of steps || []) {
                        if (version !== directRunVersion) break;
                        if (Object.prototype.hasOwnProperty.call(step, 'from')) {
                            const seconds = Math.max(0.08, Number(step.seconds) || 2);
                            const frames = Math.max(1, Math.round(seconds / 0.08));
                            for (let index = 0; index <= frames && version === directRunVersion; index += 1) {
                                const value = Number(step.from) + (Number(step.to) - Number(step.from)) * index / frames;
                                await writeDirect(step.channel, value);
                                if (!await directSleep(0.08, version)) break;
                            }
                        } else {
                            await writeDirect(step.channel, step.intensity);
                            if (!await directSleep(step.hold == null ? 1 : step.hold, version)) break;
                        }
                    }
                } finally {
                    if (version === directRunVersion) await stopDirectChannels();
                }
            };
            const runDirectWild = async (payload, version) => {
                const duration = Math.max(1, Math.min(1800, Number(payload.duration) || 600));
                const channels = Array.isArray(payload.channels) && payload.channels.length ? payload.channels : ['suck','vibrate'];
                const ceiling = Math.max(60, Math.min(90, Number(payload.ceiling) || 80));
                const endAt = Date.now() + duration * 1000;
                toy.wildRunning = true;
                toy.wildRemaining = duration;
                toy.wildEndsAt = endAt;
                toy.wildMode = 'direct';
                toy.wildNote = '安卓手机本地生成波形；请保持页面打开、手机唤醒。';
                try {
                    while (Date.now() < endAt && version === directRunVersion) {
                        const channel = channels[Math.floor(Math.random() * channels.length)];
                        const high = 20 + Math.floor(Math.random() * Math.max(1, ceiling - 19));
                        await writeDirect(channel, high);
                        if (!await directSleep(0.8 + Math.random() * 2.5, version)) break;
                        if (Math.random() < 0.35) {
                            await writeDirect(channel, 0);
                            if (!await directSleep(0.4 + Math.random(), version)) break;
                        }
                    }
                } finally {
                    if (version === directRunVersion) await stopDirectChannels();
                    toy.wildNote = version === directRunVersion ? '本轮已结束。' : '已停止。';
                    reportDirectState();
                }
            };
            const startDirectProgram = async (action, payload = {}) => {
                await stopDirectChannels();
                const version = directRunVersion;
                if (action === 'sequence') runDirectSequence(payload.steps, version).catch(error => {
                    toy.error = '序列执行失败：' + error.message;
                    stopDirectChannels();
                });
                else if (action === 'flow') runDirectFlow(payload.steps, version).catch(error => {
                    toy.error = '曲线执行失败：' + error.message;
                    stopDirectChannels();
                });
                else if (action === 'wild') runDirectWild(payload, version).catch(error => {
                    toy.error = '失控模式执行失败：' + error.message;
                    stopDirectChannels();
                });
            };

            const sendDirectResult = (command, ok, result, error) => postToyJson('/direct/result', {
                clientId:toyClientId,
                commandId:command.id,
                ok,
                result,
                error,
            });
            const executeQueuedDirectCommand = async (command) => {
                try {
                    if (!bleWriteCharacteristic || !bleDevice?.gatt?.connected) throw new Error('安卓蓝牙已断开');
                    if (command.action === 'set') {
                        await writeDirect(command.payload.channel, command.payload.intensity);
                        await sendDirectResult(command, true, { direct:true }, '');
                    } else if (command.action === 'stop') {
                        await stopDirectChannels();
                        await sendDirectResult(command, true, { direct:true, stopped:true }, '');
                    } else if (['sequence','flow','wild'].includes(command.action)) {
                        await startDirectProgram(command.action, command.payload || {});
                        await sendDirectResult(command, true, { direct:true, started:true }, '');
                    } else {
                        throw new Error('未知安卓蓝牙指令');
                    }
                    loadToyState(true);
                } catch(error) {
                    await sendDirectResult(command, false, null, error.message).catch(() => {});
                }
            };
            const pollDirectCommands = async () => {
                if (!bleWriteCharacteristic || !bleDevice?.gatt?.connected) return;
                try {
                    const data = await toyApi('/direct/commands?client_id=' + encodeURIComponent(toyClientId));
                    for (const command of data.commands || []) await executeQueuedDirectCommand(command);
                } catch(_) {}
            };
            const startDirectRelay = () => {
                if (!directPollTimer) directPollTimer = setInterval(pollDirectCommands, 900);
                if (!directHeartbeatTimer) directHeartbeatTimer = setInterval(reportDirectState, 5000);
                reportDirectState();
                pollDirectCommands();
            };
            const onDirectDisconnected = () => {
                stopDirectProgram();
                bleWriteCharacteristic = null;
                toy.connected = false;
                toy.directOnline = false;
                toy.transport = 'none';
                toy.status = '安卓蓝牙已断开，点击重新连接。';
                reportDirectEvent('disconnect', true);
                reportDirectState();
            };
            const connectDirectBluetooth = async () => {
                if (!directSupported) throw new Error('请使用支持 Web Bluetooth 的安卓 Chrome/Edge，并通过 localhost 或 HTTPS 打开');
                let device = bleDevice;
                if (!device) {
                    device = await navigator.bluetooth.requestDevice({
                        filters:[{ namePrefix:'SOSEXY' }],
                        optionalServices:TOY_OPTIONAL_SERVICES,
                    });
                }
                bleDevice = device;
                bleDevice.removeEventListener('gattserverdisconnected', onDirectDisconnected);
                bleDevice.addEventListener('gattserverdisconnected', onDirectDisconnected);
                const server = bleDevice.gatt.connected ? bleDevice.gatt : await bleDevice.gatt.connect();
                const services = await server.getPrimaryServices();
                bleWriteCharacteristic = null;
                for (const service of services) {
                    try {
                        bleWriteCharacteristic = await service.getCharacteristic(TOY_WRITE_UUID);
                        if (bleWriteCharacteristic) break;
                    } catch(_) {}
                }
                if (!bleWriteCharacteristic) throw new Error('已连接设备，但没有找到 EE03 控制特征');
                toy.connected = true;
                toy.directOnline = true;
                toy.transport = 'direct';
                toy.deviceName = bleDevice.name || 'SOSEXY';
                toy.status = '安卓蓝牙已直连 SOSEXY。';
                toy.error = '';
                startDirectRelay();
                await reportDirectEvent('connect', true, { transport:'direct' });
                await reportDirectState();
            };
            const connectToy = async () => {
                toy.busy = true;
                toy.error = '';
                try {
                    if (directSupported) await connectDirectBluetooth();
                    else await loadToyState(true);
                } catch(error) {
                    toy.error = error.name === 'NotFoundError'
                        ? '没有选择设备；请打开 SOSEXY 后重新点连接。'
                        : '蓝牙连接失败：' + error.message;
                    await reportDirectEvent('connect', false, { transport:'direct' }, error.message);
                } finally {
                    toy.busy = false;
                }
            };
            const pollToyCommand = () => loadToyState(true);

            const sendToyTest = async () => {
                toy.busy = true;
                toy.error = '';
                try {
                    if (toy.transport === 'direct') {
                        await writeDirect(toy.channel, Number(toy.intensity));
                        await reportDirectEvent('set', true, { channel:toy.channel, intensity:Number(toy.intensity) });
                    } else {
                        const data = await postToyJson('/set', { channel:toy.channel, intensity:Number(toy.intensity) });
                        applyToyState(data.state);
                    }
                    toy.status = `${toyChannelLabel(toy.channel)}已设为 ${toy.intensity}/100。`;
                } catch(e) {
                    toy.error = '发送失败：' + e.message;
                    if (toy.transport === 'direct') reportDirectEvent('set', false, { channel:toy.channel, intensity:Number(toy.intensity) }, e.message);
                } finally { toy.busy = false; }
            };
            const stopToyNow = async () => {
                toy.busy = true;
                toy.error = '';
                try {
                    if (toy.transport === 'direct') {
                        await stopDirectChannels();
                        await reportDirectEvent('stop', true, { intensity:0 });
                    } else {
                        const data = await postToyJson('/stop', { source:'user' });
                        applyToyState(data.state);
                    }
                    toy.status = '已立即停止全部通道。';
                    toy.wildNote = '已停止。';
                } catch(e) {
                    toy.error = '紧急停止失败：' + e.message;
                    if (toy.transport === 'direct') reportDirectEvent('stop', false, { intensity:0 }, e.message);
                } finally { toy.busy = false; }
            };

            const stopWildTimers = () => {
                if (bridgeWildPollTimer) { clearInterval(bridgeWildPollTimer); bridgeWildPollTimer = null; }
                if (wildTickTimer) { clearInterval(wildTickTimer); wildTickTimer = null; }
            };
            const tickWildCountdown = () => {
                if (!toy.wildRunning) return;
                const left = Math.max(0, Math.round((toy.wildEndsAt - Date.now()) / 1000));
                toy.wildRemaining = left;
                if (left <= 0 && toy.transport === 'direct') {
                    toy.wildRunning = false;
                    toy.wildNote = '本轮已结束。';
                    stopWildTimers();
                }
            };
            const pollWildStatus = async () => {
                if (toy.transport === 'direct') {
                    tickWildCountdown();
                    return;
                }
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
                        toy.wildNote = '外部桥本地运行中；关闭网页不影响。';
                        if (!wildTickTimer) wildTickTimer = setInterval(tickWildCountdown, 1000);
                    } else if (toy.wildRunning) {
                        toy.wildRunning = false;
                        toy.wildRemaining = null;
                        toy.wildNote = '本轮已结束（外部桥确认）。';
                        stopWildTimers();
                    }
                } catch(_) {
                    toy.wildStatusStale = true;
                    toy.wildNote = '状态暂时不可用（运行不受影响）';
                }
            };
            const startWildPolling = () => {
                if (toy.transport !== 'direct' && !bridgeWildPollTimer) bridgeWildPollTimer = setInterval(pollWildStatus, 5000);
                if (!wildTickTimer) wildTickTimer = setInterval(tickWildCountdown, 1000);
            };
            const startToyWild = async () => {
                const duration = [600,900,1200,1800].includes(Number(toy.wildDuration)) ? Number(toy.wildDuration) : 600;
                toy.wildBusy = true;
                toy.error = '';
                try {
                    if (toy.transport === 'direct') {
                        await startDirectProgram('wild', { duration, channels:['suck','vibrate'], ceiling:80 });
                        await reportDirectEvent('wild', true, { duration, channels:['suck','vibrate'], ceiling:80 });
                    } else {
                        const data = await postToyJson('/wild', { duration });
                        if (data.state) applyToyState(data.state);
                        toy.wildRunning = true;
                        toy.wildRemaining = duration;
                        toy.wildEndsAt = Date.now() + duration * 1000;
                        toy.wildNote = '已启动：波形由外部蓝牙桥本地生成。';
                    }
                    startWildPolling();
                } catch(e) {
                    toy.error = '失控模式启动失败：' + e.message;
                } finally { toy.wildBusy = false; }
            };
            const stopToyWild = async () => {
                await stopToyNow();
                if (!toy.error) {
                    toy.wildRunning = false;
                    toy.wildRemaining = null;
                    stopWildTimers();
                }
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
                    const data = await postToyJson('/ai-control', { enabled });
                    applyToyState(data.state);
                    toy.status = enabled
                        ? '已允许 AI/MCP 控制；安卓直连时请保持页面打开。'
                        : '已关闭 AI/MCP 控制，并发送了立即停止。';
                } catch(e) {
                    toy.allowAiControl = !enabled;
                    toy.error = '授权修改失败：' + e.message;
                } finally { toy.busy = false; }
            };
            const mockToyCommand = () => loadToyState(false);
            const pushToyCommand = () => {};
            const applyToyCommand = () => {};
            const toyChannelLabel = (value) => ({ suck:'吮吸', vibrate:'震动', current:'电流' }[value] || value || '通道');
            const toyActionLabel = (value) => ({ set:'设置', sequence:'序列', flow:'连续曲线', wild:'失控模式', stop:'停止', connect:'连接', disconnect:'断开' }[value] || value || '调用');
            const toySourceLabel = (value) => ({ mcp:'AI/MCP', user:'你', permission:'授权保护' }[value] || value || '系统');
            const toyCommandSummary = (cmd) => {
                if (cmd.action === 'set') return `${toyChannelLabel(cmd.channel)} · ${cmd.intensity}/100`;
                if (cmd.action === 'sequence') return `${Array.isArray(cmd.steps) ? cmd.steps.length : 0} 步序列`;
                if (cmd.action === 'flow') return `${Array.isArray(cmd.steps) ? cmd.steps.length : 0} 段曲线 · ${Number(cmd.duration || 0).toFixed(1)} 秒`;
                if (cmd.action === 'wild') return `${Number(cmd.duration || 0)} 秒 · 上限 ${cmd.ceiling || 80}/100 · ${(cmd.channels || []).map(toyChannelLabel).join('＋')}`;
                if (cmd.action === 'connect') return '安卓 Web Bluetooth';
                if (cmd.action === 'disconnect') return '安卓 Web Bluetooth';
                return '全部通道归零';
            };
            const toyCommandTime = (cmd) => {
                try { return new Date(cmd.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
                catch(_) { return cmd.createdAt || ''; }
            };

            loadToyState(true);

        return { toy, saveToy, connectToy, pushToyCommand, applyToyCommand, sendToyTest, stopToyNow, mockToyCommand, pollToyCommand,
            setToyAiControl, toyChannelLabel, toyActionLabel, toySourceLabel, toyCommandSummary, toyCommandTime,
            TOY_WILD_CHOICES, startToyWild, stopToyWild, pollWildStatus, toyWildClock };
    }
};

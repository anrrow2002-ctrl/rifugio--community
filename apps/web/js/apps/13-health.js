// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useHealth = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const healthTabs = [
                { id:'home', label:'主页' },
                { id:'cycle', label:'经期' },
                { id:'sleep', label:'睡眠' },
                { id:'steps', label:'步数' },
                { id:'heart', label:'心率' },
                { id:'meds', label:'用药' },
            ];
            const menstrualFlowOptions = [
                { id:'light', label:'点滴' },
                { id:'medium', label:'少量' },
                { id:'heavy', label:'中等' },
                { id:'very_heavy', label:'较多' },
            ];
            const menstrualColorOptions = [
                { id:'bright_red', label:'鲜红' },
                { id:'dark_red', label:'暗红' },
                { id:'brown', label:'褐色' },
                { id:'pink', label:'粉色' },
            ];
            const menstrualPainLocationOptions = [
                { id:'abdomen', label:'腹部' },
                { id:'waist', label:'腰部' },
                { id:'head', label:'头部' },
            ];
            const menstrualMoodOptions = [
                { id:'calm', label:'平静' },
                { id:'anxious', label:'焦虑' },
                { id:'irritable', label:'易怒' },
                { id:'low', label:'低落' },
                { id:'happy', label:'开心' },
                { id:'tired', label:'疲惫' },
            ];
            const menstrualSymptomOptions = [
                { id:'bloating', label:'胀气' },
                { id:'breast_tenderness', label:'乳房胀痛' },
                { id:'fatigue', label:'疲劳' },
                { id:'headache', label:'头痛' },
                { id:'appetite_change', label:'食欲变化' },
            ];
            const dischargeOptions = [
                { id:'dry', label:'偏干' },
                { id:'sticky', label:'黏稠' },
                { id:'creamy', label:'乳白' },
                { id:'watery', label:'水样' },
                { id:'egg_white', label:'蛋清样' },
                { id:'unusual', label:'异常/需观察' },
            ];
            const initialHealthDate = new Date();
            const health = reactive({
                tab:'home',
                viewYear:initialHealthDate.getFullYear(),
                viewMonth:initialHealthDate.getMonth(),
                selectedCycleDate:'',
                recordStatus:'',
                periodDays:{},
                dischargeDays:{},
                periodStart:'',
                periodEnd:'',
                flow:'未同步',
                cramps:'未同步',
                periodColor:'',
                mood:'未同步',
                sleepHours:0,
                sleepGoal:8,
                sleepSeries:[],
                sleepHistory:[],
                steps:0,
                stepGoal:8000,
                walkingSpeed:0,
                walkingHeartRate:0,
                stepsSeries:[],
                stepsHistory:[],
                heartRate:0,
                restingHeartRate:0,
                heartSeries:[],
                heartHistory:[],
                dataSource:'waiting',
                syncStatus:'等待后端同步，只保留最近 14 天健康数据',
                lastBackendSyncAt:'',
                medsEnabled:false,
                medName:'',
                medDose:'',
                medTakenToday:false,
                medications:[],
                medDraft:{ name:'', dose:'', time:'09:00', schedule:'daily', customDays:[{dow:0,label:'日',enabled:true,dose:''},{dow:1,label:'一',enabled:true,dose:''},{dow:2,label:'二',enabled:true,dose:''},{dow:3,label:'三',enabled:true,dose:''},{dow:4,label:'四',enabled:true,dose:''},{dow:5,label:'五',enabled:true,dose:''},{dow:6,label:'六',enabled:true,dose:''}] },
            });
            const HEALTH_RETENTION_DAYS = 14;
            const isLegacyDemoHealth = (data) => {
                const demoSteps = JSON.stringify([1900,3400,3000,1800,4200,2900,9100,1300,2400,1200,2500,1700,2000,2400]);
                const demoSleep = JSON.stringify([5.8,6.4,7.1,5.5,6.2,7.4,6.2,6.8,7.0,6.4,5.9,7.2,6.7,6.2]);
                const demoHeart = JSON.stringify([78,82,88,74,92,84,80,96,85,82,79,86,81,82]);
                return !data?.lastBackendSyncAt && (
                    JSON.stringify(data?.stepsSeries || []) === demoSteps ||
                    JSON.stringify(data?.sleepSeries || []) === demoSleep ||
                    JSON.stringify(data?.heartSeries || []) === demoHeart ||
                    (Number(data?.steps) === 2400 && Number(data?.heartRate) === 82 && Number(data?.sleepHours) === 6.2)
                );
            };
            let healthCacheNeedsSave = false;
            try {
                const cachedHealth = JSON.parse(localStorage.getItem('rifugio-health-v1') || '{}');
                if (cachedHealth && typeof cachedHealth === 'object') {
                    if (isLegacyDemoHealth(cachedHealth)) {
                        delete cachedHealth.stepsSeries; delete cachedHealth.sleepSeries; delete cachedHealth.heartSeries;
                        cachedHealth.stepsHistory = []; cachedHealth.sleepHistory = []; cachedHealth.heartHistory = [];
                        cachedHealth.steps = 0; cachedHealth.sleepHours = 0; cachedHealth.heartRate = 0; cachedHealth.restingHeartRate = 0;
                        cachedHealth.periodDays = {}; cachedHealth.periodStart = ''; cachedHealth.periodEnd = '';
                        cachedHealth.flow = '未同步'; cachedHealth.cramps = '未同步'; cachedHealth.periodColor = ''; cachedHealth.mood = '未同步';
                        cachedHealth.dataSource = 'waiting';
                        cachedHealth.syncStatus = '已清理旧版演示数据；等待后端同步真实健康数据';
                        healthCacheNeedsSave = true;
                    }
                    Object.assign(health, cachedHealth);
                }
            } catch(_) {}
            const pad2 = (n) => String(n).padStart(2, '0');
            const isoDate = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
            const dateOnly = (value) => value ? new Date(value + 'T00:00:00') : null;
            const todayKey = computed(() => isoDate(new Date()));
            const legacyFlowMap = { '点滴':'light', '少量':'light', '轻':'light', '中等':'medium', '中':'medium', '较多':'heavy', '多':'heavy', '重':'heavy', '极重':'very_heavy' };
            const legacyColorMap = { '鲜红':'bright_red', '暗红':'dark_red', '褐色':'brown', '粉色':'pink', '灰黑':'brown' };
            const legacyPainMap = { '无痛经':0, '无痛':0, '轻微':2, '明显':5, '严重':8 };
            const legacyMoodMap = { '平静':'calm', '敏感':'anxious', '低落':'low', '烦躁':'irritable', '开心':'happy' };
            const createMenstrualRecord = (date, seed = {}) => ({
                date,
                flow: seed.flow || 'medium',
                color: seed.color || 'bright_red',
                painLevel: Number.isFinite(Number(seed.painLevel)) ? Number(seed.painLevel) : 0,
                painLocations: Array.isArray(seed.painLocations) ? seed.painLocations : [],
                moods: Array.isArray(seed.moods) ? seed.moods : ['calm'],
                symptoms: Array.isArray(seed.symptoms) ? seed.symptoms : [],
                discharge: seed.discharge || '',
                note: seed.note || '',
                updatedAt: seed.updatedAt || new Date().toISOString(),
            });
            const normalizeMenstrualRecord = (date, record = {}) => createMenstrualRecord(date, {
                flow: legacyFlowMap[record.flow] || record.flow || legacyFlowMap[health.flow] || 'medium',
                color: legacyColorMap[record.color] || record.color || legacyColorMap[health.periodColor] || 'bright_red',
                painLevel: Number.isFinite(Number(record.painLevel)) ? Number(record.painLevel) : (legacyPainMap[record.cramps] ?? legacyPainMap[health.cramps] ?? 0),
                painLocations: Array.isArray(record.painLocations) ? record.painLocations : [],
                moods: Array.isArray(record.moods) ? record.moods : [legacyMoodMap[record.mood] || legacyMoodMap[health.mood] || 'calm'],
                symptoms: Array.isArray(record.symptoms) ? record.symptoms : [],
                discharge: record.discharge || '',
                note: record.note || '',
                updatedAt: record.updatedAt,
            });
            const buildPeriodDaysFromRange = () => {
                const out = {};
                const start = dateOnly(health.periodStart);
                const end = dateOnly(health.periodEnd);
                if (!start || !end) return out;
                for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                    out[isoDate(d)] = createMenstrualRecord(isoDate(d), {
                        color:legacyColorMap[health.periodColor] || 'bright_red',
                        flow:legacyFlowMap[health.flow] || 'medium',
                        painLevel:legacyPainMap[health.cramps] ?? 0,
                        moods:[legacyMoodMap[health.mood] || 'calm'],
                    });
                }
                return out;
            };
            const parseHealthTime = (value) => {
                const t = value ? Date.parse(String(value).slice(0, 10) + 'T00:00:00') : NaN;
                return Number.isFinite(t) ? t : 0;
            };
            const trimHealthHistory = (records, dateField = 'date') => {
                if (!Array.isArray(records)) return [];
                return records
                    .filter(Boolean)
                    .sort((a, b) => parseHealthTime(a?.[dateField]) - parseHealthTime(b?.[dateField]))
                    .slice(-HEALTH_RETENTION_DAYS);
            };
            const applyHealthRetention = () => {
                health.stepsHistory = trimHealthHistory(health.stepsHistory);
                health.sleepHistory = trimHealthHistory(health.sleepHistory);
                health.heartHistory = trimHealthHistory(health.heartHistory);
                health.stepsSeries = health.stepsHistory.map(r => Number(r.steps) || 0).slice(-HEALTH_RETENTION_DAYS);
                health.sleepSeries = health.sleepHistory.map(r => Number(r.hours) || 0).slice(-HEALTH_RETENTION_DAYS);
                health.heartSeries = health.heartHistory.map(r => Number(r.rate) || 0).slice(-HEALTH_RETENTION_DAYS);
                const latestStepRecord = health.stepsHistory[health.stepsHistory.length - 1] || {};
                const latestSleepRecord = health.sleepHistory[health.sleepHistory.length - 1] || {};
                const latestHeartRecord = health.heartHistory[health.heartHistory.length - 1] || {};
                health.steps = Number(latestStepRecord.steps) || Number(health.steps) || 0;
                health.walkingSpeed = Number(latestStepRecord.speed) || Number(health.walkingSpeed) || 0;
                health.walkingHeartRate = Number(latestStepRecord.heart) || Number(health.walkingHeartRate) || 0;
                health.sleepHours = Number(latestSleepRecord.hours) || Number(health.sleepHours) || 0;
                health.heartRate = Number(latestHeartRecord.rate) || Number(health.heartRate) || 0;
                health.restingHeartRate = Number(latestHeartRecord.resting) || Number(health.restingHeartRate) || 0;
            };
            if (!Array.isArray(health.sleepSeries)) health.sleepSeries = [];
            if (!Array.isArray(health.heartSeries)) health.heartSeries = [];
            if (!Array.isArray(health.stepsSeries)) health.stepsSeries = [];
            if (!Array.isArray(health.stepsHistory)) health.stepsHistory = [];
            if (!Array.isArray(health.sleepHistory)) health.sleepHistory = [];
            if (!Array.isArray(health.heartHistory)) health.heartHistory = [];
            applyHealthRetention();
            if (!health.periodDays || typeof health.periodDays !== 'object' || !Object.keys(health.periodDays).length) health.periodDays = buildPeriodDaysFromRange();
            Object.keys(health.periodDays || {}).forEach(key => { health.periodDays[key] = normalizeMenstrualRecord(key, health.periodDays[key]); });
            if (!health.selectedCycleDate) health.selectedCycleDate = Object.keys(health.periodDays).sort()[0] || todayKey.value;
            if (!Array.isArray(health.medications)) {
                health.medications = health.medName ? [{
                    id:'med-legacy',
                    name:health.medName,
                    dose:health.medDose,
                    time:'09:00',
                    schedule:'daily',
                    startDate:todayKey.value,
                    takenDates:health.medTakenToday ? [todayKey.value] : [],
                    enabled:true,
                }] : [];
            }
            health.medications.forEach(m => { if (!Array.isArray(m.takenDates)) m.takenDates = []; if (!m.startDate) m.startDate = todayKey.value; if (m.enabled === undefined) m.enabled = true; });
            if (!health.medDraft || typeof health.medDraft !== 'object') health.medDraft = { name:'', dose:'', time:'09:00', schedule:'daily', customDays:[{dow:0,label:'日',enabled:true,dose:''},{dow:1,label:'一',enabled:true,dose:''},{dow:2,label:'二',enabled:true,dose:''},{dow:3,label:'三',enabled:true,dose:''},{dow:4,label:'四',enabled:true,dose:''},{dow:5,label:'五',enabled:true,dose:''},{dow:6,label:'六',enabled:true,dose:''}] };
            if (!Array.isArray(health.medDraft.customDays) || health.medDraft.customDays.length !== 7) health.medDraft.customDays = [{dow:0,label:'日',enabled:true,dose:''},{dow:1,label:'一',enabled:true,dose:''},{dow:2,label:'二',enabled:true,dose:''},{dow:3,label:'三',enabled:true,dose:''},{dow:4,label:'四',enabled:true,dose:''},{dow:5,label:'五',enabled:true,dose:''},{dow:6,label:'六',enabled:true,dose:''}];
            if (!health.dischargeDays || typeof health.dischargeDays !== 'object') health.dischargeDays = {};
            const saveHealth = () => {
                applyHealthRetention();
                try { localStorage.setItem('rifugio-health-v1', JSON.stringify({ ...health })); } catch(_) {}
            };
            if (healthCacheNeedsSave) saveHealth();
            const normalizeHealthPayload = (payload = {}) => {
                const src = payload.health || payload.data || payload;
                if (!src || typeof src !== 'object') return null;
                return src;
            };
            const applyBackendHealth = (payload = {}) => {
                const src = normalizeHealthPayload(payload);
                if (!src) return false;
                if (Array.isArray(src.stepsHistory)) health.stepsHistory = src.stepsHistory;
                if (Array.isArray(src.sleepHistory)) health.sleepHistory = src.sleepHistory;
                if (Array.isArray(src.heartHistory)) health.heartHistory = src.heartHistory;
                if (src.periodDays && typeof src.periodDays === 'object') health.periodDays = src.periodDays;
                if (Array.isArray(src.medications)) health.medications = src.medications;
                if (src.goals && typeof src.goals === 'object') {
                    if (src.goals.steps) health.stepGoal = Number(src.goals.steps) || health.stepGoal;
                    if (src.goals.sleep) health.sleepGoal = Number(src.goals.sleep) || health.sleepGoal;
                }
                if (Number.isFinite(Number(src.steps))) health.steps = Number(src.steps);
                if (Number.isFinite(Number(src.sleepHours))) health.sleepHours = Number(src.sleepHours);
                if (Number.isFinite(Number(src.heartRate))) health.heartRate = Number(src.heartRate);
                if (Number.isFinite(Number(src.restingHeartRate))) health.restingHeartRate = Number(src.restingHeartRate);
                health.dataSource = 'backend';
                health.lastBackendSyncAt = new Date().toISOString();
                health.syncStatus = `已同步后端真实数据，仅保留最近 ${HEALTH_RETENTION_DAYS} 天`;
                applyHealthRetention();
                return true;
            };
            const syncHealthFromBackend = async () => {
                try {
                    const r = await fetch(`/api/health/summary?days=${HEALTH_RETENTION_DAYS}`, { credentials:'include', cache:'no-store' });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const j = await r.json().catch(() => ({}));
                    if (j.ok === false) throw new Error(j.error || 'health sync failed');
                    if (applyBackendHealth(j)) saveHealth();
                } catch(_) {
                    if (!health.lastBackendSyncAt) health.syncStatus = `后端未接通：这里不会再伪造健康数据，只等待真实同步；本机最多保留 ${HEALTH_RETENTION_DAYS} 天记录`;
                }
            };
            const healthCalendarTitle = computed(() => {
                return `${health.viewYear} · ${Number(health.viewMonth) + 1}月`;
            });
            const healthPeriodSummary = computed(() => {
                const keys = Object.keys(health.periodDays || {}).sort();
                const today = todayKey.value;
                if (keys.includes(today)) return '处于您的月经期';
                if (keys.length) {
                    const last = keys[keys.length - 1];
                    const next = new Date(last + 'T00:00:00');
                    next.setDate(next.getDate() + 28);
                    return `未在月经期，推测下次约 ${isoDate(next).slice(5).replace('-', '月')}日`;
                }
                return '暂无经期记录';
            });
            const medicationTaken = (med, dateKey) => Array.isArray(med?.takenDates) && med.takenDates.includes(dateKey);
            const dayDiff = (a, b) => Math.floor((dateOnly(a) - dateOnly(b)) / 86400000);
            const isMedicationDue = (med, dateKey) => {
                if (!health.medsEnabled || !med?.enabled || !dateKey) return false;
                if (med.schedule === 'asNeeded') return false;
                const start = med.startDate || todayKey.value;
                const diff = dayDiff(dateKey, start);
                if (diff < 0) return false;
                if (med.schedule === 'everyOtherDay') return diff % 2 === 0;
                if (med.schedule === 'weekly') return dateOnly(dateKey).getDay() === dateOnly(start).getDay();
                if (med.schedule === 'custom') { const dow = dateOnly(dateKey).getDay(); return !!(med.customDays?.[dow]?.enabled); }
                return true;
            };
            const medicationsDueOn = (dateKey) => health.medications.filter(m => isMedicationDue(m, dateKey));
            const medicationsDoneOn = (dateKey) => {
                const due = medicationsDueOn(dateKey);
                return !!due.length && due.every(m => medicationTaken(m, dateKey));
            };
            const dueMedicationsToday = computed(() => medicationsDueOn(todayKey.value));
            const healthMedicationSummary = computed(() => {
                if (!health.medsEnabled) return '暂无服药记录';
                if (!health.medications.length) return '已开启提醒，但还没有添加药物';
                const due = dueMedicationsToday.value;
                // 按需（asNeeded）药物不算"计划内"，但今天如果吃过，也不该被无视
                const takenAsNeeded = health.medications.filter(m => m.schedule === 'asNeeded' && medicationTaken(m, todayKey.value));
                if (!due.length) {
                    return takenAsNeeded.length ? `今日已按需服用 ${takenAsNeeded.length} 项药物` : '今日没有计划内用药';
                }
                const done = due.filter(m => medicationTaken(m, todayKey.value)).length;
                if (done === due.length) {
                    return takenAsNeeded.length ? `今日 ${done} 项用药已完成，另按需服 ${takenAsNeeded.length} 项` : `今日 ${done} 项用药已完成`;
                }
                return `您今日还有 ${due.length - done} 项未服药`;
            });
            const healthMonthDays = computed(() => {
                const now = new Date();
                const year = Number(health.viewYear) || now.getFullYear();
                const month = Number.isFinite(Number(health.viewMonth)) ? Number(health.viewMonth) : now.getMonth();
                const days = new Date(year, month + 1, 0).getDate();
                const firstOffset = new Date(year, month, 1).getDay();
                const blanks = Array.from({ length:firstOffset }, (_, i) => ({ key:'blank-' + i, blank:true, day:'', date:'' }));
                const actual = Array.from({ length:days }, (_, i) => {
                    const day = i + 1;
                    const date = new Date(year, month, day);
                    const key = isoDate(date);
                    const sleepIndex = Math.max(0, health.sleepSeries.length - days + i);
                    const stepIndex = Math.max(0, health.stepsSeries.length - days + i);
                const periodRecord = health.periodDays?.[key] || null;
                    return {
                        key,
                        day,
                        date:key,
                        today:key === todayKey.value,
                        period:!!periodRecord,
                        periodColor:periodRecord?.color || '',
                        periodFlow:periodRecord?.flow || '',
                        sleep:!!health.sleepSeries[sleepIndex],
                        steps:!!health.stepsSeries[stepIndex],
                        medDue:medicationsDueOn(key).length > 0,
                    };
                });
                return blanks.concat(actual);
            });
            const selectedCycleRecord = computed(() => health.periodDays?.[health.selectedCycleDate] || null);
            const labelFromOptions = (options, id) => options.find(o => o.id === id)?.label || '';
            const periodDayLabel = (color) => labelFromOptions(menstrualColorOptions, color) || '经期';
            const menstrualFlowHint = (flow) => ({
                light:'点滴：仅几处血迹，护垫很久才需要更换。',
                medium:'少量：常规更换，日常活动基本可控。',
                heavy:'中等：更换频率明显增加，可能有血块。',
                very_heavy:'较多：很快浸透或伴明显不适，建议重点观察。',
            }[flow] || '按当天真实感受快速记录即可。');
            const menstrualPainLabel = (level) => {
                const n = Number(level) || 0;
                if (n <= 0) return '无';
                if (n <= 3) return '轻';
                if (n <= 6) return '中';
                return '重';
            };
            const changeHealthMonth = (delta) => {
                const base = new Date(Number(health.viewYear) || new Date().getFullYear(), Number(health.viewMonth) || 0, 1);
                base.setMonth(base.getMonth() + Number(delta || 0));
                health.viewYear = base.getFullYear();
                health.viewMonth = base.getMonth();
                saveHealth();
            };
            const syncPeriodRangeFromDays = () => {
                const keys = Object.keys(health.periodDays || {}).sort();
                health.periodStart = keys[0] || '';
                health.periodEnd = keys[keys.length - 1] || '';
            };
            const selectPeriodDay = (day) => {
                if (!day || day.blank || !day.date) return;
                health.selectedCycleDate = day.date;
                if (!health.periodDays || typeof health.periodDays !== 'object') health.periodDays = {};
                if (!health.periodDays[day.date]) {
                    health.periodDays[day.date] = createMenstrualRecord(day.date);
                } else {
                    health.periodDays[day.date] = normalizeMenstrualRecord(day.date, health.periodDays[day.date]);
                }
                syncPeriodRangeFromDays();
                saveHealth();
            };
            const removePeriodDay = (day) => {
                if (!day || day.blank || !day.date || !health.periodDays?.[day.date]) return;
                delete health.periodDays[day.date];
                syncPeriodRangeFromDays();
                health.selectedCycleDate = day.date;
                health.recordStatus = '已取消这一天的经期';
                saveHealth();
            };
            const syncSelectedPeriodRecord = () => {
                const rec = selectedCycleRecord.value;
                if (rec) {
                    rec.updatedAt = new Date().toISOString();
                    health.flow = labelFromOptions(menstrualFlowOptions, rec.flow) || health.flow;
                    health.cramps = menstrualPainLabel(rec.painLevel);
                    health.mood = labelFromOptions(menstrualMoodOptions, rec.moods?.[0]) || health.mood;
                    health.periodColor = labelFromOptions(menstrualColorOptions, rec.color) || health.periodColor;
                }
                syncPeriodRangeFromDays();
                health.recordStatus = '已保存在本机';
                saveHealth();
            };
            const setMenstrualField = (field, value) => {
                const rec = selectedCycleRecord.value;
                if (!rec) return;
                rec[field] = value;
                syncSelectedPeriodRecord();
            };
            const toggleMenstrualArray = (field, value) => {
                const rec = selectedCycleRecord.value;
                if (!rec) return;
                if (!Array.isArray(rec[field])) rec[field] = [];
                const index = rec[field].indexOf(value);
                if (index >= 0) rec[field].splice(index, 1);
                else rec[field].push(value);
                syncSelectedPeriodRecord();
            };
            const saveSelectedMenstrualRecord = async () => {
                const rec = selectedCycleRecord.value;
                if (!rec) return;
                syncSelectedPeriodRecord();
                health.recordStatus = '已保存，正在尝试同步后端…';
                try {
                    const r = await fetch('/api/health/menstrual-records', {
                        method:'PUT',
                        headers:{ 'Content-Type':'application/json' },
                        credentials:'include',
                        body:JSON.stringify({
                            record: rec,
                            date: health.selectedCycleDate,
                            periodDays: health.periodDays,               // 整体同步，避免单条缺 date
                            medications: health.medications,             // 吃药记录也同步云端
                            goals: { steps: health.stepGoal, sleep: health.sleepGoal },
                        }),
                    });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const j = await r.json().catch(() => ({}));
                    if (j.ok === false) throw new Error(j.error || 'sync failed');
                    health.recordStatus = '已保存并同步后端';
                } catch(_) {
                    health.recordStatus = '已保存在本机；后端接口未接通时不会丢失。';
                }
                saveHealth();
            };
            // 吃药/目标改动后自动同步云端（防抖 1.2s）；月经在 saveSelectedMenstrualRecord 里已同步
            let healthSyncTimer = null;
            const syncHealthUserRecords = () => {
                fetch('/api/health/menstrual-records', {
                    method:'PUT', headers:{ 'Content-Type':'application/json' }, credentials:'include',
                    body:JSON.stringify({
                        periodDays: health.periodDays,
                        medications: health.medications,
                        goals: { steps: health.stepGoal, sleep: health.sleepGoal },
                    }),
                }).catch(() => {});
            };
            Vue.watch(() => [JSON.stringify(health.medications || []), health.stepGoal, health.sleepGoal], () => {
                clearTimeout(healthSyncTimer);
                healthSyncTimer = setTimeout(syncHealthUserRecords, 1200);
            });
            const clearSelectedPeriodDay = () => {
                if (!health.selectedCycleDate || !health.periodDays?.[health.selectedCycleDate]) return;
                removePeriodDay({ date:health.selectedCycleDate });
            };

            // 白带是经期之外的日子也要追踪的（排卵期参考），跟"经期记录"分开存，
            // 不再绑死在 periodDays 里、不需要先把某天标成经期才能记。
            const dischargeDraft = reactive({ date: todayKey.value, value: '', note: '' });
            const recentDischargeEntries = computed(() => {
                return Object.keys(health.dischargeDays || {})
                    .sort((a, b) => b.localeCompare(a))
                    .slice(0, 8)
                    .map(date => ({ date, ...health.dischargeDays[date] }));
            });
            const dischargeLabel = (id) => labelFromOptions(dischargeOptions, id) || '未记录';
            const saveDischargeEntry = () => {
                const date = dischargeDraft.date || todayKey.value;
                if (!dischargeDraft.value) { health.recordStatus = '先选一个白带状态再保存～'; return; }
                if (!health.dischargeDays || typeof health.dischargeDays !== 'object') health.dischargeDays = {};
                health.dischargeDays[date] = { discharge: dischargeDraft.value, note: dischargeDraft.note || '', updatedAt: new Date().toISOString() };
                saveHealth();
                health.recordStatus = `${date} 的白带记录已保存`;
                dischargeDraft.value = ''; dischargeDraft.note = '';
            };
            const deleteDischargeEntry = (date) => {
                if (!health.dischargeDays?.[date]) return;
                delete health.dischargeDays[date];
                saveHealth();
            };
            const formatCompact = (n) => {
                const value = Number(n) || 0;
                return value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(value);
            };
            const avg = (arr) => {
                const nums = arr.map(Number).filter(Number.isFinite);
                if (!nums.length) return 0;
                return nums.reduce((a,b) => a + b, 0) / nums.length;
            };
            const healthTrendStats = computed(() => {
                const steps7 = health.stepsHistory.slice(-7).map(r => Number(r.steps) || 0);
                const steps14 = health.stepsHistory.slice(-HEALTH_RETENTION_DAYS).map(r => Number(r.steps) || 0);
                const sleep7 = health.sleepSeries.slice(-7);
                const sleep14 = health.sleepSeries.slice(-HEALTH_RETENTION_DAYS);
                const heart7 = health.heartSeries.slice(-7);
                return {
                    stepsWeekAvg:Math.round(avg(steps7)),
                    stepsMonthAvg:Math.round(avg(steps14)),
                    stepsTwoWeekAvg:Math.round(avg(steps14)),
                    stepsBest:formatCompact(Math.max(...steps14, Number(health.steps) || 0)),
                    sleepWeekAvg:avg(sleep7).toFixed(1).replace(/\.0$/, ''),
                    sleepMonthAvg:avg(sleep14).toFixed(1).replace(/\.0$/, ''),
                    sleepTwoWeekAvg:avg(sleep14).toFixed(1).replace(/\.0$/, ''),
                    heartWeekAvg:Math.round(avg(heart7)),
                };
            });
            const healthLineChart = (series) => {
                const nums = (Array.isArray(series) ? series : []).slice(-HEALTH_RETENTION_DAYS).map(Number).filter(Number.isFinite);
                if (!nums.length) return { points:'', area:'', path:'', areaPath:'', dots:[] };
                const W = 320, H = 150, left = 18, right = 18, top = 18, bottom = 28;
                const min = Math.min(...nums);
                const max = Math.max(...nums);
                const spread = Math.max(1, max - min);
                const step = nums.length > 1 ? (W - left - right) / (nums.length - 1) : 0;
                const dots = nums.map((v, i) => ({
                    x:left + i * step,
                    y:top + (1 - (v - min) / spread) * (H - top - bottom),
                    value:v,
                    label:i === nums.length - 1 ? '今' : String(nums.length - i - 1),
                }));
                const points = dots.map(d => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' ');
                const smoothPath = dots.reduce((path, point, i) => {
                    if (i === 0) return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
                    const prev = dots[i - 1];
                    const cx = ((prev.x + point.x) / 2).toFixed(1);
                    return `${path} C ${cx} ${prev.y.toFixed(1)}, ${cx} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
                }, '');
                const areaPath = `${smoothPath} L ${dots[dots.length - 1].x.toFixed(1)} ${H - bottom} L ${dots[0].x.toFixed(1)} ${H - bottom} Z`;
                const area = `${dots[0].x.toFixed(1)},${H - bottom} ${points} ${dots[dots.length - 1].x.toFixed(1)},${H - bottom}`;
                return { points, area, path:smoothPath, areaPath, dots };
            };
            const updateHealthToday = (kind) => {
                const key = todayKey.value;
                if (kind === 'steps') {
                    let rec = health.stepsHistory.find(r => r.date === key);
                    if (!rec) {
                        rec = { date:key, steps:0, speed:0, heart:0 };
                        health.stepsHistory.push(rec);
                    }
                    rec.steps = Number(health.steps) || 0;
                    rec.speed = Number(health.walkingSpeed) || 0;
                    rec.heart = Number(health.walkingHeartRate) || 0;
                    health.stepsSeries = health.stepsHistory.slice(-HEALTH_RETENTION_DAYS).map(r => Number(r.steps) || 0);
                }
                if (kind === 'sleep') {
                    let rec = health.sleepHistory.find(r => r.date === key);
                    if (!rec) {
                        rec = { date:key, hours:0, bedtime:'', wake:'', quality:'同步' };
                        health.sleepHistory.push(rec);
                    }
                    rec.hours = Number(health.sleepHours) || 0;
                    health.sleepSeries = health.sleepHistory.slice(-HEALTH_RETENTION_DAYS).map(r => Number(r.hours) || 0);
                }
                if (kind === 'heart') {
                    let rec = health.heartHistory.find(r => r.date === key);
                    if (!rec) {
                        rec = { date:key, time:'', rate:0, resting:0, note:'同步' };
                        health.heartHistory.push(rec);
                    }
                    rec.rate = Number(health.heartRate) || 0;
                    rec.resting = Number(health.restingHeartRate) || 0;
                    health.heartSeries = health.heartHistory.slice(-HEALTH_RETENTION_DAYS).map(r => Number(r.rate) || 0);
                }
                saveHealth();
            };
            const medicationScheduleLabel = (med) => {
                if (med?.schedule === 'everyOtherDay') return '隔天';
                if (med?.schedule === 'weekly') return '每周';
                if (med?.schedule === 'asNeeded') return '按需';
                if (med?.schedule === 'custom') {
                    const labels = ['日','一','二','三','四','五','六'];
                    const on = (med.customDays || []).filter(d => d.enabled).map(d => labels[d.dow]);
                    return on.length === 7 ? '自定义·每天' : on.length ? '自定义·' + on.join('') : '自定义';
                }
                return '每天';
            };
            // 返回某个日期该药的剂量（custom 可能每天不同）
            const medicationDoseOn = (med, dateKey) => {
                if (med?.schedule === 'custom' && med.customDays) {
                    const dow = dateOnly(dateKey).getDay();
                    const day = med.customDays[dow];
                    if (day?.dose) return day.dose;
                }
                return med?.dose || '';
            };
            const addHealthMedication = () => {
                const name = String(health.medDraft?.name || '').trim();
                if (!name) return;
                const isCustom = health.medDraft.schedule === 'custom';
                health.medications.push({
                    id:'med-' + Date.now(),
                    name,
                    dose:String(health.medDraft.dose || '').trim(),
                    time:String(health.medDraft.time || '').trim() || '09:00',
                    schedule:health.medDraft.schedule || 'daily',
                    customDays: isCustom ? JSON.parse(JSON.stringify(health.medDraft.customDays)) : undefined,
                    startDate:todayKey.value,
                    takenDates:[],
                    enabled:true,
                });
                health.medDraft = { name:'', dose:'', time:'09:00', schedule:'daily', customDays:[{dow:0,label:'日',enabled:true,dose:''},{dow:1,label:'一',enabled:true,dose:''},{dow:2,label:'二',enabled:true,dose:''},{dow:3,label:'三',enabled:true,dose:''},{dow:4,label:'四',enabled:true,dose:''},{dow:5,label:'五',enabled:true,dose:''},{dow:6,label:'六',enabled:true,dose:''}] };
                health.medsEnabled = true;
                saveHealth();
            };
            const toggleMedicationTaken = (med, dateKey) => {
                if (!med) return;
                if (!Array.isArray(med.takenDates)) med.takenDates = [];
                const i = med.takenDates.indexOf(dateKey);
                if (i >= 0) med.takenDates.splice(i, 1);
                else med.takenDates.push(dateKey);
                saveHealth();
            };
            const toggleMedicationDay = (day) => {
                if (!day || day.blank || !day.date) return;
                const due = medicationsDueOn(day.date);
                if (!due.length) return;
                const allDone = due.every(m => medicationTaken(m, day.date));
                due.forEach((med) => {
                    if (!Array.isArray(med.takenDates)) med.takenDates = [];
                    const index = med.takenDates.indexOf(day.date);
                    if (allDone && index >= 0) med.takenDates.splice(index, 1);
                    if (!allDone && index < 0) med.takenDates.push(day.date);
                });
                saveHealth();
            };

        return { medicationDoseOn, healthTabs, menstrualFlowOptions, menstrualColorOptions, menstrualPainLocationOptions, menstrualMoodOptions, menstrualSymptomOptions, dischargeOptions, initialHealthDate, health, HEALTH_RETENTION_DAYS, isLegacyDemoHealth, healthCacheNeedsSave, pad2, isoDate, dateOnly, todayKey, legacyFlowMap, legacyColorMap, legacyPainMap, legacyMoodMap, createMenstrualRecord, normalizeMenstrualRecord, buildPeriodDaysFromRange, parseHealthTime, trimHealthHistory, applyHealthRetention, saveHealth, normalizeHealthPayload, applyBackendHealth, syncHealthFromBackend, healthCalendarTitle, healthPeriodSummary, medicationTaken, dayDiff, isMedicationDue, medicationsDueOn, medicationsDoneOn, dueMedicationsToday, healthMedicationSummary, healthMonthDays, selectedCycleRecord, labelFromOptions, periodDayLabel, menstrualFlowHint, menstrualPainLabel, changeHealthMonth, syncPeriodRangeFromDays, selectPeriodDay, removePeriodDay, syncSelectedPeriodRecord, setMenstrualField, toggleMenstrualArray, saveSelectedMenstrualRecord, healthSyncTimer, syncHealthUserRecords, clearSelectedPeriodDay, dischargeDraft, recentDischargeEntries, dischargeLabel, saveDischargeEntry, deleteDischargeEntry, formatCompact, avg, healthTrendStats, healthLineChart, updateHealthToday, medicationScheduleLabel, addHealthMedication, toggleMedicationTaken, toggleMedicationDay };
    }
};

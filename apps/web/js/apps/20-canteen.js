// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useCanteen = function(ctx) {
    const { reactive, computed, onMounted } = Vue;
    with (ctx) {
        const canteen = reactive({
            apps:[],
            orders:[],
            loading:false,
            status:'',
            draft:{ app:'manual', title:'', items:'', note:'' },
        });
        const canteenAppLabel = (id) => canteen.apps.find(app => app.id === id)?.name || id || '食堂';
        const activeCanteenApp = computed(() => canteen.apps.find(app => app.id === canteen.draft.app) || canteen.apps[0] || null);
        const loadCanteen = async () => {
            canteen.loading = true;
            try {
                const [appsRes, ordersRes] = await Promise.all([
                    fetch('/api/canteen/apps', { credentials:'include', cache:'no-store' }),
                    fetch('/api/canteen/orders', { credentials:'include', cache:'no-store' }),
                ]);
                const apps = await appsRes.json().catch(() => ({}));
                const orders = await ordersRes.json().catch(() => ({}));
                canteen.apps = Array.isArray(apps.apps) ? apps.apps : [];
                canteen.orders = Array.isArray(orders.orders) ? orders.orders : [];
                if (!canteen.apps.some(app => app.id === canteen.draft.app)) canteen.draft.app = canteen.apps[0]?.id || 'manual';
                canteen.status = canteen.orders.length ? `有 ${canteen.orders.length} 条点餐提案` : '还没有待确认点餐。';
            } catch(e) {
                canteen.status = '食堂同步失败：' + (e.message || 'unknown');
            } finally {
                canteen.loading = false;
            }
        };
        const canteenPendingOrders = computed(() => canteen.orders.filter(o => o.status === 'pending'));
        const canteenDoneOrders = computed(() => canteen.orders.filter(o => o.status !== 'pending'));
        const createCanteenDraft = async () => {
            const title = String(canteen.draft.title || '').trim();
            if (!title) { canteen.status = '先写想点什么'; return; }
            const items = String(canteen.draft.items || '').split(/\n|、|,/).map(x => x.trim()).filter(Boolean);
            const r = await fetch('/api/canteen/orders', {
                method:'POST',
                credentials:'include',
                headers:{ 'Content-Type':'application/json' },
                body:JSON.stringify({ app:canteen.draft.app, title, items, note:canteen.draft.note, source:'user' }),
            });
            const j = await r.json().catch(() => ({}));
            if (j.ok && j.order) {
                canteen.orders.unshift(j.order);
                canteen.draft.title = ''; canteen.draft.items = ''; canteen.draft.note = '';
                canteen.status = '已放进待确认。';
            }
        };
            const updateCanteenOrder = async (order, status) => {
                if (!order) return;
                order.status = status;
                order.updated_at = new Date().toISOString();
                canteen.status = status === 'accepted' ? `已确认「${order.title}」` : `已更新「${order.title}」`;
                try {
                await fetch('/api/canteen/orders/' + encodeURIComponent(order.id), {
                    method:'PUT',
                    credentials:'include',
                    headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({ status }),
                });
            } catch(_) {}
        };
        onMounted(loadCanteen);
        return { canteen, canteenAppLabel, activeCanteenApp, loadCanteen, canteenPendingOrders, canteenDoneOrders, createCanteenDraft, updateCanteenOrder };
    }
};

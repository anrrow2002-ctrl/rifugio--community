// Global data refresh control. Delegated so Vue may mount/unmount the home button.
(() => {
    let refreshing = false;

    const clearRuntimeCaches = async () => {
        if (!('caches' in window)) return;
        const names = await caches.keys().catch(() => []);
        await Promise.all(names.map(name => caches.delete(name).catch(() => false)));
    };

    const runGlobalRefresh = async (button) => {
        if (refreshing) return;
        refreshing = true;
        button.classList.add('refreshing');
        button.disabled = true;
        button.setAttribute('aria-label', '正在刷新全站数据');

        const tasks = [];
        const detail = {
            waitUntil(task) {
                if (task && typeof task.then === 'function') tasks.push(Promise.resolve(task));
            },
        };
        window.dispatchEvent(new CustomEvent('rifugio-global-refresh-request', { detail }));
        await Promise.resolve();

        try {
            await Promise.allSettled([clearRuntimeCaches(), ...tasks]);
        } finally {
            button.classList.remove('refreshing');
            button.classList.add('refreshed');
            button.disabled = false;
            button.setAttribute('aria-label', '刷新全站数据');
            refreshing = false;
            setTimeout(() => button.classList.remove('refreshed'), 900);
        }
    };

    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('#global-refresh-btn');
        if (!button) return;
        event.preventDefault();
        runGlobalRefresh(button);
    });
})();

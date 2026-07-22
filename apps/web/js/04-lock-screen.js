    (function() {
        const lockEl = document.getElementById('lock-screen');
        const relockBtn = document.getElementById('relock-btn');
        const pinControl = document.getElementById('lock-pin-control');
        const pinRow = document.getElementById('lock-pin-row');
        const pinInput = document.getElementById('lock-pin-input');
        const submitBtn = document.getElementById('lock-submit');
        const errEl = document.getElementById('lock-err');
        const pinSlots = Array.from(pinRow.querySelectorAll('.lock-pin-slot'));
        const themeColorMeta = document.getElementById('app-theme-color');

        const MIN_PASSWORD_LENGTH = 8;
        let checking = false;
        const nativeFetch = window.fetch.bind(window);
        let authReadyResolved = false;
        let resolveAuthReady;
        let authReady = new Promise(resolve => { resolveAuthReady = resolve; });

        function markAuthReady() {
            if (authReadyResolved) return;
            authReadyResolved = true;
            resolveAuthReady();
            window.dispatchEvent(new Event('refuge-authed'));
        }

        function markAuthRequired() {
            if (!authReadyResolved) return;
            authReadyResolved = false;
            authReady = new Promise(resolve => { resolveAuthReady = resolve; });
        }

        function protectedSameOriginRequest(input) {
            try {
                const raw = typeof input === 'string' ? input : input?.url;
                const url = new URL(raw, window.location.href);
                if (url.origin !== window.location.origin) return false;
                if (!/^\/(api|memory-api)(?:\/|$)/.test(url.pathname)) return false;
                return !/^\/api\/(?:auth(?:\/|$)|community\/health$)/.test(url.pathname);
            } catch (_) {
                return false;
            }
        }

        // Vue and its split modules mount before the PIN is entered. Hold protected
        // same-origin calls until authentication succeeds instead of producing a wall
        // of expected 401s. Cross-origin provider calls and auth routes are untouched.
        window.fetch = async function guardedFetch(input, init) {
            const protectedRequest = protectedSameOriginRequest(input);
            if (protectedRequest) await authReady;
            const response = await nativeFetch(input, init);
            if (protectedRequest && response.status === 401) {
                const body = await response.clone().text().catch(() => '');
                if (/\b(?:unauthorized|browser login required)\b/i.test(body)) {
                    markAuthRequired();
                    relock({ serverLogout:false });
                }
            }
            return response;
        };
        window.refugeAuthReady = () => authReady;
        function applyLockWallpaperFromStorage() {
            let lockUrl = '';
            try {
                const saved = JSON.parse(localStorage.getItem('rifugio-wallpapers') || '{}');
                lockUrl = saved?.urls?.['lock-screen'] || '';
            } catch (_) {}
            if (lockUrl) {
                lockEl.style.backgroundImage = `linear-gradient(rgba(249,247,242,.62), rgba(249,247,242,.82)), url("${String(lockUrl).replace(/"/g, '%22')}")`;
                lockEl.style.backgroundSize = 'cover';
                lockEl.style.backgroundPosition = 'center';
            } else {
                lockEl.style.backgroundImage = '';
                lockEl.style.backgroundSize = '';
                lockEl.style.backgroundPosition = '';
            }
        }
        applyLockWallpaperFromStorage();
        window.addEventListener('rifugio-wallpaper-updated', applyLockWallpaperFromStorage);
        const isLocalPreview = window.location.protocol === 'file:' ||
            ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
        if (isLocalPreview) {
            sessionStorage.setItem(LOCK_KEY, '1');
            lockEl.style.display = 'none';
            relockBtn.style.display = 'none';
            document.body.classList.remove('lock-active');
            if (themeColorMeta) themeColorMeta.content = '#FFF8FB';
            markAuthReady();
            return;
        }
        document.body.classList.add('lock-active');
        if (themeColorMeta) themeColorMeta.content = '#F9F7F2';

        function setLockFullHeight() {
            const fullHeight = Math.max(
                window.innerHeight || 0,
                document.documentElement.clientHeight || 0,
                window.screen?.height || 0
            );
            if (fullHeight) lockEl.style.setProperty('--lock-full-height', fullHeight + 'px');
        }

        function focusPin() {
            if (!pinInput) return;
            try { pinInput.focus({ preventScroll: true }); }
            catch (_) { pinInput.focus(); }
        }

        function renderPin() {
            const length = pinInput.value.length;
            pinSlots.forEach((slot, index) => {
                slot.classList.toggle('filled', index < length);
                slot.classList.toggle('active', document.activeElement === pinInput && index === Math.min(length, pinSlots.length - 1));
            });
        }

        function unlock() {
            sessionStorage.setItem(LOCK_KEY, '1');
            lockEl.classList.add('unlocked');
            relockBtn.classList.add('show');
            if (themeColorMeta) themeColorMeta.content = '#FFF8FB';
            pinInput.blur();
            setTimeout(() => {
                lockEl.style.display = 'none';
                document.body.classList.remove('lock-active');
            }, 380);
        }
        function relock({ serverLogout = true } = {}) {
            markAuthRequired();
            if (serverLogout) {
                nativeFetch('/api/auth/logout', { method:'POST', credentials:'include' }).catch(() => {});
            }
            sessionStorage.removeItem(LOCK_KEY);
            checking = false;
            pinInput.value = '';
            renderPin();
            errEl.classList.remove('show');
            document.body.classList.add('lock-active');
            if (themeColorMeta) themeColorMeta.content = '#F9F7F2';
            lockEl.style.display = 'flex';
            requestAnimationFrame(() => {
                lockEl.classList.remove('unlocked');
                relockBtn.classList.remove('show');
                setTimeout(focusPin, 100);
            });
        }
        relockBtn.addEventListener('click', () => relock());

        // 已经解锁过 → 仍要确认后端 cookie 有效；失效则重新输入 PIN
        if (sessionStorage.getItem(LOCK_KEY) === '1') {
            fetch('/api/auth/check').then(r => {
                if (r.ok) {
                    lockEl.style.display = 'none';
                    document.body.classList.remove('lock-active');
                    relockBtn.classList.add('show');
                    if (themeColorMeta) themeColorMeta.content = '#FFF8FB';
                    markAuthReady();
                } else {
                    sessionStorage.removeItem(LOCK_KEY);
                    setTimeout(focusPin, 100);
                }
            }).catch(() => {
                sessionStorage.removeItem(LOCK_KEY);
                setTimeout(focusPin, 100);
            });
        }

        async function check() {
            const val = pinInput.value;
            if (val.length < MIN_PASSWORD_LENGTH || checking) return;
            checking = true;
            try {
                const r = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ password: val }),
                });
                if (!r.ok) throw new Error(r.status === 429 ? 'too many attempts' : 'bad password');
                unlock();
                markAuthReady();
            } catch (_) {
                errEl.classList.add('show');
                pinControl.classList.add('shake');
                setTimeout(() => pinControl.classList.remove('shake'), 500);
                setTimeout(() => {
                    pinInput.value = '';
                    renderPin();
                    checking = false;
                    focusPin();
                }, 480);
                setTimeout(() => errEl.classList.remove('show'), 2200);
            }
        }

        pinInput.addEventListener('input', () => {
            pinInput.value = pinInput.value.slice(0, 96);
            renderPin();
        });
        pinInput.addEventListener('focus', renderPin);
        pinInput.addEventListener('blur', renderPin);
        pinInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') check();
        });
        submitBtn.addEventListener('click', check);
        pinControl.addEventListener('click', focusPin);
        lockEl.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            focusPin();
        });
        window.addEventListener('orientationchange', () => {
            setTimeout(setLockFullHeight, 320);
        });

        setLockFullHeight();
        renderPin();
        setTimeout(focusPin, 180);
    })();

        // iOS standalone + black-translucent can report a viewport shortened by
        // the status bar. Seed the real screen height before the first paint.
        (function () {
            var standalone = window.navigator.standalone === true ||
                window.matchMedia('(display-mode: standalone)').matches;
            if (!standalone) return;
            var fullHeight = Math.max(
                window.innerHeight || 0,
                document.documentElement.clientHeight || 0,
                window.screen && window.screen.height || 0,
                window.screen && window.screen.availHeight || 0
            );
            if (fullHeight) document.documentElement.style.setProperty('--app-h', fullHeight + 'px');
        })();

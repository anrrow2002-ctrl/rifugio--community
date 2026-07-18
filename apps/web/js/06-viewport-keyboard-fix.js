(function () {
    var vv = window.visualViewport;
    var root = document.documentElement;
    var standalone = window.navigator.standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;
    var maxViewportHeight = Math.max(
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        vv && vv.height || 0
    );

    function fullStandaloneHeight() {
        return Math.max(
            maxViewportHeight,
            window.innerHeight || 0,
            document.documentElement.clientHeight || 0,
            window.screen && window.screen.height || 0,
            window.screen && window.screen.availHeight || 0
        );
    }

    function setAppViewport() {
        var active = document.activeElement;
        var acceptsInput = active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.tagName === 'SELECT' ||
            active.isContentEditable
        );
        var visualTop = vv ? (vv.offsetTop || 0) : 0;
        var visualHeight = vv ? vv.height : window.innerHeight;
        if (!acceptsInput) {
            maxViewportHeight = Math.max(maxViewportHeight, visualHeight || 0, window.innerHeight || 0);
        }
        var stableHeight = standalone ? fullStandaloneHeight() : maxViewportHeight;
        var keyboardHeight = Math.max(0, stableHeight - visualHeight - visualTop);
        var keyboardOpen = !!(vv && acceptsInput && keyboardHeight > 120);

        root.style.setProperty('--visual-h', Math.max(0, visualHeight) + 'px');
        root.style.setProperty('--visual-top', visualTop + 'px');
        root.style.setProperty('--keyboard-h', (keyboardOpen ? keyboardHeight : 0) + 'px');

        // The phone shell remains stable while typing. Components that must
        // follow the keyboard use --visual-h / --keyboard-h instead.
        if (standalone || keyboardOpen) {
            root.style.setProperty('--app-h', stableHeight + 'px');
        } else {
            root.style.removeProperty('--app-h');
        }
        root.classList.toggle('keyboard-open', keyboardOpen);
    }

    setAppViewport();
    if (vv) {
        vv.addEventListener('resize', setAppViewport);
        vv.addEventListener('scroll', setAppViewport);
    }
    window.addEventListener('resize', setAppViewport);
    window.addEventListener('orientationchange', function () { setTimeout(setAppViewport, 120); });
    document.addEventListener('focusin', setAppViewport);
    document.addEventListener('focusout', function () { setTimeout(setAppViewport, 80); });
})();

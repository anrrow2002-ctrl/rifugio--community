// Galleria delle opere · 展厅. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useShowroom = function() {
    const { reactive, computed } = Vue;

    // Add public, redistributable works here. Personal gallery content belongs in private storage.
    const showroomWorks = Object.freeze([]);

    const showroom = reactive({
        view: 'list',
        current: null,
        frameLoading: false,
        frameError: false,
    });

    const showroomFrameTitle = computed(() => showroom.current
        ? `${showroom.current.title} · ${showroom.current.subtitle}`
        : '展厅作品');

    const openShowroomWork = work => {
        if (!work || !work.url) return;
        showroom.current = work;
        showroom.view = 'work';
        showroom.frameLoading = true;
        showroom.frameError = false;
    };

    const closeShowroomWork = () => {
        showroom.view = 'list';
        showroom.current = null;
        showroom.frameLoading = false;
        showroom.frameError = false;
    };

    const markShowroomFrameReady = () => {
        showroom.frameLoading = false;
        showroom.frameError = false;
    };

    const markShowroomFrameError = () => {
        showroom.frameLoading = false;
        showroom.frameError = true;
    };

    return {
        showroom,
        showroomWorks,
        showroomFrameTitle,
        openShowroomWork,
        closeShowroomWork,
        markShowroomFrameReady,
        markShowroomFrameError,
    };
};

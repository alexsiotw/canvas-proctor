(function (root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ProctorGuardSebCapturePolicy = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function readSebSettings(exam) {
        let settings = exam && exam.seb_settings ? exam.seb_settings : {};
        if (typeof settings === 'string') {
            try {
                settings = JSON.parse(settings);
            } catch (_) {
                settings = {};
            }
        }

        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return {};
        }
        return settings;
    }

    function hasDisplayCaptureApi(mediaDevices) {
        return !!(mediaDevices && typeof mediaDevices.getDisplayMedia === 'function');
    }

    function evaluateScreenCapture(exam, client, mediaDevices) {
        exam = exam || {};
        client = client || {};

        const settings = readSebSettings(exam);
        const requested = !!(exam.require_screen || exam.verify_desktop);
        const isSeb = !!client.isSEB;
        const isMobile = !!client.isMobileClient;
        const sebOptIn = isSeb && settings.allow_screen_capture === true;

        return {
            requested,
            isSeb,
            isMobile,
            sebOptIn,
            apiAvailable: hasDisplayCaptureApi(mediaDevices),
            // Normal desktop browsers retain their existing screen-share behavior.
            // SEB attempts only gain the step after the teacher deliberately enables
            // the high-risk capture exception in the generated .seb configuration.
            requireScreen: requested && !isMobile && (!isSeb || sebOptIn)
        };
    }

    return {
        evaluateScreenCapture,
        hasDisplayCaptureApi,
        readSebSettings
    };
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateScreenCapture,
    hasDisplayCaptureApi,
    readSebSettings
} = require('../public/js/sebCapturePolicy');

test('normal desktop browsers keep the existing required screen-share step', () => {
    const result = evaluateScreenCapture(
        { require_screen: true },
        { isSEB: false, isMobileClient: false },
        { getDisplayMedia() {} }
    );

    assert.equal(result.requireScreen, true);
    assert.equal(result.apiAvailable, true);
    assert.equal(result.sebOptIn, false);
});

test('SEB only requests display capture after the teacher opts in', () => {
    const disabled = evaluateScreenCapture(
        { require_screen: true, seb_settings: {} },
        { isSEB: true, isMobileClient: false },
        { getDisplayMedia() {} }
    );
    const enabled = evaluateScreenCapture(
        { require_screen: true, seb_settings: { allow_screen_capture: true } },
        { isSEB: true, isMobileClient: false },
        { getDisplayMedia() {} }
    );

    assert.equal(disabled.requireScreen, false);
    assert.equal(enabled.requireScreen, true);
    assert.equal(enabled.sebOptIn, true);
});

test('SEB policy supports JSONB values serialized as strings', () => {
    const exam = {
        verify_desktop: true,
        seb_settings: JSON.stringify({ allow_screen_capture: true })
    };
    const result = evaluateScreenCapture(
        exam,
        { isSEB: true, isMobileClient: false },
        {}
    );

    assert.equal(readSebSettings(exam).allow_screen_capture, true);
    assert.equal(result.requireScreen, true);
    assert.equal(result.apiAvailable, false);
});

test('phones and tablets never receive the desktop display-capture step', () => {
    const result = evaluateScreenCapture(
        { require_screen: true, seb_settings: { allow_screen_capture: true } },
        { isSEB: true, isMobileClient: true },
        { getDisplayMedia() {} }
    );

    assert.equal(result.requireScreen, false);
});

test('display capture capability check requires getDisplayMedia', () => {
    assert.equal(hasDisplayCaptureApi({ getDisplayMedia() {} }), true);
    assert.equal(hasDisplayCaptureApi({}), false);
    assert.equal(hasDisplayCaptureApi(null), false);
});

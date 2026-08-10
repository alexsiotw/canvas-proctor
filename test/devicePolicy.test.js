'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyDevice,
    deriveLegacyMobileFlags,
    didDeviceInstanceChange,
    evaluateDevicePolicy,
    hasFreshResumeApproval,
    normalizeDeviceAttestation,
    normalizeDevicePolicy,
    shouldRequireApprovalForExistingStart
} = require('../services/devicePolicy');

test('classifies desktop, iPhone, iPadOS desktop UA, and Android tablet', () => {
    assert.equal(classifyDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }).family, 'desktop');
    assert.equal(classifyDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }).family, 'phone');
    assert.equal(classifyDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5 }).family, 'tablet');
    assert.equal(classifyDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel Tablet)' }).family, 'tablet');
});

test('unknown policy values preserve the backward-compatible any-supported policy', () => {
    assert.equal(normalizeDevicePolicy('nonsense'), 'any_supported');
    assert.deepEqual(deriveLegacyMobileFlags('desktop_only'), { blockMobile: true, allowMobileDevices: false });
    assert.deepEqual(deriveLegacyMobileFlags('desktop_or_tablet'), { blockMobile: false, allowMobileDevices: true });
});

test('desktop-only policy blocks phones and tablets', () => {
    const result = evaluateDevicePolicy({ device_policy: 'desktop_only' }, { instanceId: 'pg-device-1234567890', family: 'phone', hasDisplayCapture: false });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'PRIMARY_DEVICE_NOT_ALLOWED');
});

test('desktop-or-tablet permits an iPad but not an iPhone', () => {
    assert.equal(evaluateDevicePolicy({ device_policy: 'desktop_or_tablet' }, { instanceId: 'pg-device-1234567890', family: 'tablet' }).allowed, true);
    assert.equal(evaluateDevicePolicy({ device_policy: 'desktop_or_tablet' }, { instanceId: 'pg-device-1234567890', family: 'phone' }).allowed, false);
});

test('second camera requirement blocks a mobile primary device instead of silently skipping pairing', () => {
    const result = evaluateDevicePolicy(
        { device_policy: 'any_supported', require_mobile_camera: true },
        { instanceId: 'pg-device-1234567890', family: 'tablet', hasDisplayCapture: false }
    );
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'SECOND_CAMERA_REQUIRES_DESKTOP');
});

test('screen capability is enforced at preflight and active capture at start', () => {
    const exam = { device_policy: 'desktop_only', require_screen_capability: true };
    const base = { instanceId: 'pg-device-1234567890', family: 'desktop' };
    assert.equal(evaluateDevicePolicy(exam, { ...base, hasDisplayCapture: false }).code, 'SCREEN_CAPTURE_UNAVAILABLE');
    assert.equal(evaluateDevicePolicy(exam, { ...base, hasDisplayCapture: true }).allowed, true);
    assert.equal(evaluateDevicePolicy(exam, { ...base, hasDisplayCapture: true, screenCaptureActive: false }, { requireActiveCapture: true }).code, 'SCREEN_CAPTURE_NOT_ACTIVE');
});

test('missing persistent device identity is rejected', () => {
    const result = evaluateDevicePolicy({ device_policy: 'any_supported' }, { family: 'desktop' });
    assert.equal(result.code, 'DEVICE_ATTESTATION_REQUIRED');
});

test('device attestation trusts the request user-agent, sanitizes ids, and bounds dimensions', () => {
    const result = normalizeDeviceAttestation({
        instance_id: 'pg-device-1234567890',
        platform: 'Win32',
        screen_width: 999999,
        max_touch_points: 2,
        has_display_capture: true
    }, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    assert.equal(result.instanceId, 'pg-device-1234567890');
    assert.equal(result.family, 'desktop');
    assert.equal(result.screenWidth, 20000);
    assert.equal(result.hasDisplayCapture, true);
});

test('device changes require two valid, distinct persistent ids', () => {
    assert.equal(didDeviceInstanceChange('pg-device-1234567890', 'pg-device-abcdefghij'), true);
    assert.equal(didDeviceInstanceChange('short', 'pg-device-abcdefghij'), false);
    assert.equal(didDeviceInstanceChange('pg-device-1234567890', 'pg-device-1234567890'), false);
});

test('strict existing sessions require approval and consume only a fresh instructor release', () => {
    const now = Date.parse('2026-08-09T20:00:00Z');
    const exam = { require_resume_approval: true };
    assert.equal(shouldRequireApprovalForExistingStart(exam, { status: 'started' }, now), true);
    assert.equal(shouldRequireApprovalForExistingStart(exam, { resume_approval_required: true }, now), false);
    const approved = { resume_approved_at: new Date(now - 30_000).toISOString() };
    assert.equal(hasFreshResumeApproval(approved, now), true);
    assert.equal(shouldRequireApprovalForExistingStart(exam, approved, now), false);
    assert.equal(hasFreshResumeApproval({ resume_approved_at: new Date(now - 10 * 60_000).toISOString() }, now), false);
});

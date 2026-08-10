'use strict';

const DEVICE_POLICIES = Object.freeze({
    DESKTOP_ONLY: 'desktop_only',
    DESKTOP_OR_TABLET: 'desktop_or_tablet',
    ANY_SUPPORTED: 'any_supported'
});

const VALID_DEVICE_POLICIES = new Set(Object.values(DEVICE_POLICIES));
const DEVICE_INSTANCE_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function normalizeDevicePolicy(value, fallback = DEVICE_POLICIES.ANY_SUPPORTED) {
    const normalized = String(value || '').trim().toLowerCase();
    return VALID_DEVICE_POLICIES.has(normalized) ? normalized : fallback;
}

function boundedInteger(value, min, max, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function sanitizeDeviceInstanceId(value) {
    const normalized = String(value || '').trim();
    return DEVICE_INSTANCE_PATTERN.test(normalized) ? normalized : null;
}

function classifyDevice({ userAgent = '', platform = '', maxTouchPoints = 0, mobileHint = '' } = {}) {
    const ua = String(userAgent || '');
    const reportedPlatform = String(platform || '');
    const touchPoints = boundedInteger(maxTouchPoints, 0, 20, 0);

    if (/iPhone|iPod/i.test(ua)) return { family: 'phone', os: 'ios' };
    if (/iPad/i.test(ua)) return { family: 'tablet', os: 'ios' };
    // Modern iPadOS can identify itself as Macintosh. Touch capability separates it
    // from an actual Mac without trusting a client-provided "family" label.
    if (/Macintosh/i.test(ua) && touchPoints > 1) return { family: 'tablet', os: 'ios' };
    if (/Android/i.test(ua)) {
        return { family: /Mobile/i.test(ua) ? 'phone' : 'tablet', os: 'android' };
    }
    if (/CrOS/i.test(ua)) return { family: 'desktop', os: 'chromeos' };
    if (/Windows/i.test(ua)) return { family: 'desktop', os: 'windows' };
    if (/Macintosh|Mac OS X/i.test(ua)) return { family: 'desktop', os: 'macos' };
    if (/Linux/i.test(ua)) return { family: 'desktop', os: 'linux' };
    if (String(mobileHint) === '?1') return { family: 'phone', os: 'unknown-mobile' };
    if (/Mobile/i.test(ua) || /iPhone|iPad|Android/i.test(reportedPlatform)) {
        return { family: 'phone', os: 'unknown-mobile' };
    }
    return { family: 'desktop', os: 'unknown' };
}

function normalizeDeviceAttestation(raw, request = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const userAgent = String(request.userAgent || '').slice(0, 1000);
    const platform = String(source.platform || '').slice(0, 120);
    const maxTouchPoints = boundedInteger(source.max_touch_points, 0, 20, 0);
    const classified = classifyDevice({
        userAgent,
        platform,
        maxTouchPoints,
        mobileHint: request.mobileHint || ''
    });

    return {
        instanceId: sanitizeDeviceInstanceId(source.instance_id),
        family: classified.family,
        os: classified.os,
        platform,
        userAgent,
        screenWidth: boundedInteger(source.screen_width, 0, 20000, 0),
        screenHeight: boundedInteger(source.screen_height, 0, 20000, 0),
        maxTouchPoints,
        hasDisplayCapture: source.has_display_capture === true,
        screenCaptureActive: source.screen_capture_active === true,
        isSeb: source.is_seb === true
    };
}

function evaluateDevicePolicy(exam, device, { requireActiveCapture = false } = {}) {
    const policy = normalizeDevicePolicy(exam && exam.device_policy);
    const family = device && device.family ? device.family : 'desktop';

    if (!device || !device.instanceId) {
        return {
            allowed: false,
            code: 'DEVICE_ATTESTATION_REQUIRED',
            message: 'ProctorGuard could not establish a persistent device identity. Reload the exam in the approved browser and try again.'
        };
    }

    if (policy === DEVICE_POLICIES.DESKTOP_ONLY && family !== 'desktop') {
        return {
            allowed: false,
            code: 'PRIMARY_DEVICE_NOT_ALLOWED',
            message: 'This exam requires a Windows, Mac, or Chromebook primary device. Phones and tablets are not permitted.'
        };
    }
    if (policy === DEVICE_POLICIES.DESKTOP_OR_TABLET && family === 'phone') {
        return {
            allowed: false,
            code: 'PRIMARY_DEVICE_NOT_ALLOWED',
            message: 'This exam allows computers and tablets, but not phones as the primary exam device.'
        };
    }
    if (exam && exam.require_mobile_camera && family !== 'desktop') {
        return {
            allowed: false,
            code: 'SECOND_CAMERA_REQUIRES_DESKTOP',
            message: 'This exam requires a separate mobile camera, so the primary exam device must be a computer.'
        };
    }
    if (exam && exam.require_screen_capability && !device.hasDisplayCapture) {
        return {
            allowed: false,
            code: 'SCREEN_CAPTURE_UNAVAILABLE',
            message: 'This exam requires screen recording, but this device or browser does not expose screen capture.'
        };
    }
    if (exam && exam.require_screen_capability && requireActiveCapture && !device.screenCaptureActive) {
        return {
            allowed: false,
            code: 'SCREEN_CAPTURE_NOT_ACTIVE',
            message: 'Screen recording must be active before this exam can begin.'
        };
    }
    return { allowed: true, code: null, message: null };
}

function deriveLegacyMobileFlags(policy) {
    const normalized = normalizeDevicePolicy(policy);
    return {
        blockMobile: normalized === DEVICE_POLICIES.DESKTOP_ONLY,
        allowMobileDevices: normalized !== DEVICE_POLICIES.DESKTOP_ONLY
    };
}

function didDeviceInstanceChange(previousId, currentId) {
    const previous = sanitizeDeviceInstanceId(previousId);
    const current = sanitizeDeviceInstanceId(currentId);
    return !!(previous && current && previous !== current);
}

function hasFreshResumeApproval(session, now = Date.now(), ttlMs = 5 * 60 * 1000) {
    const approvedAt = session && session.resume_approved_at
        ? new Date(session.resume_approved_at).getTime()
        : 0;
    return Number.isFinite(approvedAt) && approvedAt > 0 && now - approvedAt >= 0 && now - approvedAt < ttlMs;
}

function shouldRequireApprovalForExistingStart(exam, session, now = Date.now()) {
    if (!exam || !exam.require_resume_approval || !session) return false;
    if (session.resume_approval_required) return false;
    return !hasFreshResumeApproval(session, now);
}

module.exports = {
    DEVICE_POLICIES,
    classifyDevice,
    deriveLegacyMobileFlags,
    didDeviceInstanceChange,
    evaluateDevicePolicy,
    hasFreshResumeApproval,
    normalizeDeviceAttestation,
    normalizeDevicePolicy,
    sanitizeDeviceInstanceId,
    shouldRequireApprovalForExistingStart
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('student sends device continuity evidence at verification, start, and heartbeat', () => {
    const source = read('public/js/student.js');
    assert.match(source, /verify-code[\s\S]*device_profile: buildDeviceProfile\(\)/);
    assert.match(source, /verify-placement[\s\S]*device_profile: buildDeviceProfile\(\)/);
    assert.match(source, /\/api\/session\/start[\s\S]*screenCaptureActive: hasActiveScreenCapture\(\)/);
    assert.match(source, /\/api\/session\/heartbeat/);
    assert.match(source, /resume-approval-overlay/);
});

test('server enforces policy and exposes an instructor-owned approval endpoint', () => {
    const source = read('server.js');
    assert.match(source, /evaluateDevicePolicy\(exam, device/);
    assert.match(source, /app\.post\('\/api\/session\/heartbeat'/);
    assert.match(source, /app\.post\('\/api\/sessions\/:id\/approve-resume', requireInstructor/);
    assert.match(source, /e\.canvas_course_id = \$2 OR e\.canvas_course_id = \$3/);
    assert.match(source, /UNEXPECTED_EXIT_GRACE_MS = 30 \* 60 \* 1000/);
});

test('dashboard exposes explicit device choices and removes the ambiguous mobile toggle', () => {
    const source = read('public/js/app.js');
    assert.match(source, /id="device-policy"/);
    assert.match(source, /id="chk-require-screen-capability"/);
    assert.match(source, /id="chk-resume-approval"/);
    assert.doesNotMatch(source, /id="chk-allow-mobile"/);
    assert.match(source, /approveSessionResume/);
});

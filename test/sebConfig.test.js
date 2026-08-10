'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSebConfig,
    isSebUserAgent,
    normalizeSebSettings,
    setPlistKey
} = require('../services/sebConfig');

const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>startURL</key><string>https://old.example</string>
<key>URLFilterEnable</key><false/>
<key>showTaskBar</key><false/>
</dict></plist>`;

function hasKeyValue(xml, key, valuePattern) {
    return new RegExp(`<key>${key}<\\/key>\\s*${valuePattern}`).test(xml);
}

test('normalizes teacher settings and rejects malformed app entries', () => {
    const settings = normalizeSebSettings({
        url_filter_mode: 'allowlist',
        allowed_urls: ['wikipedia.org', 'WIKIPEDIA.ORG', '', 'desmos.com'],
        clipboard_mode: 'not-a-mode',
        popup_policy: 'new_window',
        allow_uploads: true,
        permitted_apps: [
            { title: 'Excel', executable: 'EXCEL.EXE', platform: 'windows', arguments: ['--safe', ''] },
            { title: 'Missing executable' }
        ]
    });

    assert.deepEqual(settings.allowed_urls, ['wikipedia.org', 'desmos.com']);
    assert.equal(settings.clipboard_mode, 'isolated');
    assert.equal(settings.popup_policy, 'new_window');
    assert.equal(settings.allow_uploads, true);
    assert.equal(settings.permitted_apps.length, 1);
    assert.equal(settings.permitted_apps[0].original_name, 'EXCEL.EXE');
    assert.deepEqual(settings.permitted_apps[0].arguments, ['--safe']);
});

test('recognizes real SEB user-agent formats without trusting a URL flag', () => {
    assert.equal(isSebUserAgent('Mozilla/5.0 Chrome/140.0 SEB/3.10.0'), true);
    assert.equal(isSebUserAgent('SafeExamBrowser/2.4.1'), true);
    assert.equal(isSebUserAgent('Mozilla/5.0 Chrome/140.0'), false);
    assert.equal(isSebUserAgent('Mozilla/5.0 notSEB/3.10'), false);
});

test('builds a complete allowlist policy and maps global lockdown options', () => {
    const xml = buildSebConfig({
        template: TEMPLATE,
        startUrl: 'https://proctor.example/student.html?token=a&seb=true',
        quitUrl: 'https://proctor.example/api/seb/quit',
        baseUrl: 'https://proctor.example',
        exam: {
            canvas_quiz_url: 'https://school.instructure.com/courses/1/quizzes/2',
            block_downloads: true,
            disable_printing: true,
            disable_clipboard: true,
            disable_right_click: true,
            only_one_screen: true,
            require_camera: true,
            require_mic: true,
            seb_settings: {
                url_filter_mode: 'allowlist',
                allowed_urls: ['wikipedia.org', 'https://desmos.com/*'],
                allow_uploads: true,
                allow_screen_capture: true,
                show_taskbar: false,
                permitted_apps: [{
                    title: 'Excel <Exam>',
                    platform: 'windows',
                    executable: 'EXCEL.EXE',
                    path: 'C:\\Program Files\\Office',
                    auto_start: true,
                    show_in_taskbar: true,
                    arguments: ['--safe']
                }]
            }
        }
    });

    assert.match(xml, /student\.html\?token=a&amp;seb=true/);
    assert.equal((xml.match(/<key>URLFilterEnable<\/key>/g) || []).length, 1);
    assert.ok(hasKeyValue(xml, 'URLFilterEnable', '<true\\/>'));
    assert.ok(hasKeyValue(xml, 'allowDownloads', '<false\\/>'));
    assert.ok(hasKeyValue(xml, 'allowUploads', '<true\\/>'));
    assert.ok(hasKeyValue(xml, 'allowPrint', '<false\\/>'));
    assert.ok(hasKeyValue(xml, 'clipboardPolicy', '<integer>1<\\/integer>'));
    assert.ok(hasKeyValue(xml, 'allowedDisplaysMaxNumber', '<integer>1<\\/integer>'));
    assert.ok(hasKeyValue(xml, 'enableRightMouse', '<false\\/>'));
    assert.ok(hasKeyValue(xml, 'showTaskBar', '<true\\/>'));
    assert.ok(hasKeyValue(xml, 'allowScreenSharing', '<true\\/>'));
    assert.ok(hasKeyValue(xml, 'enablePrintScreen', '<true\\/>'));
    assert.ok(hasKeyValue(xml, 'allowScreenCapture', '<true\\/>'));
    assert.match(xml, /<string>proctor\.example<\/string>/);
    assert.match(xml, /<string>school\.instructure\.com<\/string>/);
    assert.match(xml, /<string>wikipedia\.org<\/string>/);
    assert.match(xml, /Excel &lt;Exam&gt;/);
    assert.doesNotMatch(xml, /Excel <Exam>/);
});

test('builds block rules followed by an allow-all rule', () => {
    const xml = buildSebConfig({
        template: TEMPLATE,
        startUrl: 'https://proctor.example/student.html',
        quitUrl: 'https://proctor.example/api/seb/quit',
        baseUrl: 'https://proctor.example',
        exam: {
            seb_settings: {
                url_filter_mode: 'blocklist',
                blocked_urls: ['chat.example', 'ai.example']
            }
        }
    });

    const firstBlock = xml.indexOf('<string>chat.example</string>');
    const allowAll = xml.indexOf('<string>*</string>');
    assert.ok(firstBlock >= 0);
    assert.ok(allowAll > firstBlock);
    assert.match(xml, /<key>action<\/key>\s*<integer>0<\/integer>/);
    assert.match(xml, /<key>action<\/key>\s*<integer>1<\/integer>/);
});

test('replaces nested plist arrays without damaging following root keys', () => {
    const source = `<plist><dict>
<key>permittedProcesses</key><array><dict><key>arguments</key><array><dict><key>active</key><true/></dict></array></dict></array>
<key>showTaskBar</key><true/>
</dict></plist>`;
    const updated = setPlistKey(source, 'permittedProcesses', '<array></array>');

    assert.doesNotMatch(updated, /<key>arguments<\/key>/);
    assert.match(updated, /<key>permittedProcesses<\/key><array><\/array>/);
    assert.match(updated, /<key>showTaskBar<\/key><true\/>/);
});

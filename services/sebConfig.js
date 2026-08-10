'use strict';

const MAX_URL_RULES = 100;
const MAX_APPS = 25;

const DEFAULT_SEB_SETTINGS = Object.freeze({
    url_filter_mode: 'off',
    allowed_urls: [],
    blocked_urls: [],
    filter_embedded_content: false,
    allow_uploads: false,
    clipboard_mode: 'isolated',
    popup_policy: 'block',
    allow_navigation: false,
    allow_reload: true,
    allow_spellcheck: false,
    allow_find: true,
    allow_zoom: true,
    show_taskbar: false,
    show_wifi_control: false,
    allow_virtual_machine: false,
    allow_screen_capture: false,
    permitted_apps: []
});

const DEFAULT_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>`;

function asBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function cleanText(value, maxLength = 500) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function parseStringList(value, maxItems = MAX_URL_RULES, maxLength = 2048) {
    const items = Array.isArray(value)
        ? value
        : String(value || '').split(/\r?\n/);
    const seen = new Set();

    return items.reduce((result, item) => {
        const cleaned = cleanText(item, maxLength);
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key) || result.length >= maxItems) return result;
        seen.add(key);
        result.push(cleaned);
        return result;
    }, []);
}

function parseArguments(value) {
    return parseStringList(value, 20, 500);
}

function normalizePermittedApps(value) {
    if (!Array.isArray(value)) return [];

    return value.slice(0, MAX_APPS).reduce((apps, raw) => {
        if (!raw || typeof raw !== 'object') return apps;

        const executable = cleanText(raw.executable, 260);
        if (!executable) return apps;

        const platform = raw.platform === 'macos' ? 'macos' : 'windows';
        apps.push({
            platform,
            title: cleanText(raw.title || executable, 120),
            description: cleanText(raw.description, 300),
            executable,
            original_name: cleanText(raw.original_name || executable, 260),
            path: cleanText(raw.path, 500),
            identifier: cleanText(raw.identifier, 300),
            signature: cleanText(raw.signature, 1000),
            arguments: parseArguments(raw.arguments),
            auto_start: asBoolean(raw.auto_start, false),
            allow_running: asBoolean(raw.allow_running, false),
            allow_user_choose: asBoolean(raw.allow_user_choose, false),
            show_in_taskbar: asBoolean(raw.show_in_taskbar, true)
        });
        return apps;
    }, []);
}

function parseRawSettings(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }
    return typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function normalizeSebSettings(raw) {
    const source = parseRawSettings(raw);
    const urlFilterMode = ['off', 'allowlist', 'blocklist'].includes(source.url_filter_mode)
        ? source.url_filter_mode
        : DEFAULT_SEB_SETTINGS.url_filter_mode;
    const clipboardMode = ['blocked', 'isolated', 'system'].includes(source.clipboard_mode)
        ? source.clipboard_mode
        : DEFAULT_SEB_SETTINGS.clipboard_mode;
    const popupPolicy = ['block', 'same_window', 'new_window'].includes(source.popup_policy)
        ? source.popup_policy
        : DEFAULT_SEB_SETTINGS.popup_policy;

    return {
        url_filter_mode: urlFilterMode,
        allowed_urls: parseStringList(source.allowed_urls),
        blocked_urls: parseStringList(source.blocked_urls),
        filter_embedded_content: asBoolean(source.filter_embedded_content, DEFAULT_SEB_SETTINGS.filter_embedded_content),
        allow_uploads: asBoolean(source.allow_uploads, DEFAULT_SEB_SETTINGS.allow_uploads),
        clipboard_mode: clipboardMode,
        popup_policy: popupPolicy,
        allow_navigation: asBoolean(source.allow_navigation, DEFAULT_SEB_SETTINGS.allow_navigation),
        allow_reload: asBoolean(source.allow_reload, DEFAULT_SEB_SETTINGS.allow_reload),
        allow_spellcheck: asBoolean(source.allow_spellcheck, DEFAULT_SEB_SETTINGS.allow_spellcheck),
        allow_find: asBoolean(source.allow_find, DEFAULT_SEB_SETTINGS.allow_find),
        allow_zoom: asBoolean(source.allow_zoom, DEFAULT_SEB_SETTINGS.allow_zoom),
        show_taskbar: asBoolean(source.show_taskbar, DEFAULT_SEB_SETTINGS.show_taskbar),
        show_wifi_control: asBoolean(source.show_wifi_control, DEFAULT_SEB_SETTINGS.show_wifi_control),
        allow_virtual_machine: asBoolean(source.allow_virtual_machine, DEFAULT_SEB_SETTINGS.allow_virtual_machine),
        allow_screen_capture: asBoolean(source.allow_screen_capture, DEFAULT_SEB_SETTINGS.allow_screen_capture),
        permitted_apps: normalizePermittedApps(source.permitted_apps)
    };
}

function isSebUserAgent(userAgent) {
    const value = String(userAgent || '');
    return /(?:SafeExamBrowser|(?:^|\s)SEB\/\d)/i.test(value);
}

function escapeXml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function plistBoolean(value) {
    return value ? '<true/>' : '<false/>';
}

function plistInteger(value) {
    const integer = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
    return `<integer>${integer}</integer>`;
}

function plistString(value) {
    return `<string>${escapeXml(value)}</string>`;
}

function plistArray(values) {
    if (!values || values.length === 0) return '<array></array>';
    return `<array>\n${values.map(value => `\t\t${value}`).join('\n')}\n\t</array>`;
}

function plistDictionary(entries) {
    const content = entries.map(([key, value]) => `\t\t\t<key>${escapeXml(key)}</key>\n\t\t\t${value}`).join('\n');
    return `<dict>\n${content}\n\t\t</dict>`;
}

function findValueRange(plist, keyName) {
    const keyTag = `<key>${keyName}</key>`;
    const keyStart = plist.indexOf(keyTag);
    if (keyStart === -1) return null;

    let valueStart = keyStart + keyTag.length;
    while (/\s/.test(plist[valueStart] || '')) valueStart++;

    const selfClosing = plist.slice(valueStart).match(/^<(true|false)\s*\/>/);
    if (selfClosing) {
        return { keyStart, valueStart, valueEnd: valueStart + selfClosing[0].length };
    }

    const open = plist.slice(valueStart).match(/^<([A-Za-z][A-Za-z0-9]*)\b[^>]*>/);
    if (!open) return null;

    const tag = open[1];
    const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'g');
    tagPattern.lastIndex = valueStart;
    let depth = 0;
    let match;

    while ((match = tagPattern.exec(plist))) {
        const isClosing = match[0].startsWith('</');
        const isSelfClosing = match[0].endsWith('/>');
        if (isClosing) depth--;
        else if (!isSelfClosing) depth++;
        if (depth === 0) {
            return { keyStart, valueStart, valueEnd: tagPattern.lastIndex };
        }
    }

    return null;
}

function setPlistKey(plist, keyName, valueXml) {
    const range = findValueRange(plist, keyName);
    if (range) {
        return `${plist.slice(0, range.valueStart)}${valueXml}${plist.slice(range.valueEnd)}`;
    }

    return plist.replace(
        /(<\/dict>\s*<\/plist>\s*$)/,
        `\t<key>${escapeXml(keyName)}</key>\n\t${valueXml}\n$1`
    );
}

function patternForUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch (_) {
        return '';
    }
}

function uniquePatterns(patterns) {
    const seen = new Set();
    return patterns.reduce((result, pattern) => {
        const cleaned = cleanText(pattern, 2048);
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) return result;
        seen.add(key);
        result.push(cleaned);
        return result;
    }, []);
}

function makeFilterRule(action, expression) {
    return plistDictionary([
        ['active', plistBoolean(true)],
        ['regex', plistBoolean(false)],
        ['expression', plistString(expression)],
        ['action', plistInteger(action)]
    ]);
}

function buildFilterRules(policy, baseUrl, canvasQuizUrl) {
    if (policy.url_filter_mode === 'off') return [];

    if (policy.url_filter_mode === 'blocklist') {
        const blocks = uniquePatterns(policy.blocked_urls).map(pattern => makeFilterRule(0, pattern));
        return [...blocks, makeFilterRule(1, '*')];
    }

    const automatic = [
        patternForUrl(baseUrl),
        patternForUrl(canvasQuizUrl),
        'about:blank'
    ];
    return uniquePatterns([...automatic, ...policy.allowed_urls])
        .map(pattern => makeFilterRule(1, pattern));
}

function makePermittedApplication(application) {
    const argumentsXml = application.arguments.map(argument => plistDictionary([
        ['active', plistBoolean(true)],
        ['argument', plistString(argument)]
    ]));

    return plistDictionary([
        ['active', plistBoolean(true)],
        ['autostart', plistBoolean(application.auto_start)],
        ['iconInTaskbar', plistBoolean(application.show_in_taskbar)],
        ['runInBackground', plistBoolean(application.allow_running)],
        ['allowUserToChooseApp', plistBoolean(application.allow_user_choose)],
        ['strongKill', plistBoolean(false)],
        ['os', plistInteger(application.platform === 'macos' ? 0 : 1)],
        ['title', plistString(application.title)],
        ['description', plistString(application.description)],
        ['executable', plistString(application.executable)],
        ['originalName', plistString(application.original_name)],
        ['path', plistString(application.path)],
        ['identifier', plistString(application.identifier)],
        ['signature', plistString(application.signature)],
        ['arguments', plistArray(argumentsXml)]
    ]);
}

function buildSebConfig({ template, startUrl, quitUrl, baseUrl, exam = {} }) {
    const policy = normalizeSebSettings(exam.seb_settings);
    const permittedApps = policy.permitted_apps.map(makePermittedApplication);
    const filterRules = buildFilterRules(policy, baseUrl, exam.canvas_quiz_url);
    const popupPolicy = policy.popup_policy === 'new_window' ? 2 : (policy.popup_policy === 'same_window' ? 1 : 0);
    const globalClipboardBlocked = Boolean(exam.disable_clipboard);
    const clipboardPolicy = globalClipboardBlocked ? 1 : (policy.clipboard_mode === 'system' ? 0 : (policy.clipboard_mode === 'blocked' ? 1 : 2));
    const oneDisplay = Boolean(exam.only_one_screen);
    const showTaskbar = policy.show_taskbar || permittedApps.length > 0;
    const values = [
        ['startURL', plistString(startUrl)],
        ['quitURL', plistString(quitUrl)],
        ['quitURLConfirm', plistBoolean(false)],
        ['quitURLRestart', plistBoolean(false)],
        ['sebConfigPurpose', plistInteger(0)],
        ['allowDisplayMirroring', plistBoolean(!oneDisplay)],
        ['allowSecondaryDisplays', plistBoolean(!oneDisplay)],
        ['allowedDisplaysMaxNumber', plistInteger(oneDisplay ? 1 : 4)],
        ['allowDownloads', plistBoolean(!exam.block_downloads)],
        ['allowUploads', plistBoolean(policy.allow_uploads)],
        ['allowPrint', plistBoolean(!exam.disable_printing)],
        ['clipboardPolicy', plistInteger(clipboardPolicy)],
        ['enablePrivateClipboard', plistBoolean(clipboardPolicy !== 0)],
        ['enableRightMouse', plistBoolean(!exam.disable_right_click)],
        ['allowBrowsingBackForward', plistBoolean(policy.allow_navigation)],
        ['browserWindowAllowReload', plistBoolean(policy.allow_reload)],
        ['newBrowserWindowAllowReload', plistBoolean(policy.allow_reload)],
        ['showReloadButton', plistBoolean(policy.allow_reload)],
        ['newBrowserWindowByLinkPolicy', plistInteger(popupPolicy)],
        ['newBrowserWindowByScriptPolicy', plistInteger(popupPolicy)],
        ['blockPopUpWindows', plistBoolean(popupPolicy === 0)],
        ['allowSpellCheck', plistBoolean(policy.allow_spellcheck)],
        ['allowFind', plistBoolean(policy.allow_find)],
        ['enableZoomPage', plistBoolean(policy.allow_zoom)],
        ['enableZoomText', plistBoolean(policy.allow_zoom)],
        ['showTaskBar', plistBoolean(showTaskbar)],
        ['allowWlan', plistBoolean(policy.show_wifi_control)],
        ['allowVirtualMachine', plistBoolean(policy.allow_virtual_machine)],
        // Windows 3.x maps allowScreenSharing to its AllowWindowCapture switch,
        // which deactivates the window guard so a capture API can see the SEB
        // surface. enablePrintScreen controls the keyboard screenshot shortcut.
        // macOS uses the separate allowScreenCapture key (and may still override
        // it while Apple Assessment Mode is active).
        ['allowScreenSharing', plistBoolean(policy.allow_screen_capture)],
        ['enablePrintScreen', plistBoolean(policy.allow_screen_capture)],
        ['allowScreenCapture', plistBoolean(policy.allow_screen_capture)],
        ['allowVideoCapture', plistBoolean(Boolean(exam.require_camera || exam.verify_video))],
        ['allowAudioCapture', plistBoolean(Boolean(exam.require_mic || exam.verify_audio))],
        ['monitorProcesses', plistBoolean(true)],
        ['allowSwitchToApplications', plistBoolean(permittedApps.length > 0)],
        ['permittedProcesses', plistArray(permittedApps)],
        ['URLFilterEnable', plistBoolean(policy.url_filter_mode !== 'off' && filterRules.length > 0)],
        ['URLFilterEnableContentFilter', plistBoolean(policy.url_filter_mode !== 'off' && policy.filter_embedded_content)],
        ['URLFilterRules', plistArray(filterRules)]
    ];

    let config = typeof template === 'string' && /<plist\b/.test(template) ? template : DEFAULT_TEMPLATE;
    for (const [key, value] of values) {
        config = setPlistKey(config, key, value);
    }
    return config;
}

module.exports = {
    DEFAULT_SEB_SETTINGS,
    buildSebConfig,
    escapeXml,
    isSebUserAgent,
    normalizeSebSettings,
    setPlistKey
};

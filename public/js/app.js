let exams = [];
let liveStudents = {};
let currentLiveExamId = null;
let currentFullscreenSessionId = null;
let currentSessionsList = [];
let liveViewFilter = 'all'; // all | online | flagged
let liveViewLayout = 'grid'; // grid | large
let socket = io();

// The socket now requires an authenticated identity, which for an instructor comes
// from the session cookie. That cookie may not exist yet on the first load of a
// dashboard tab — the LTI launch establishes it — so the handshake can be rejected
// and, because socket.io only dials once, the page would sit there permanently
// silent until someone happened to refresh.
//
// An empty live view is indistinguishable from "no students are in the exam", which
// on a proctoring dashboard is the worst possible way to fail. So: retry, and if it
// still will not connect, say so instead of showing a convincing blank.
let pgSocketRetries = 0;

socket.on('connect_error', (err) => {
    pgSocketRetries++;
    console.warn(`[Socket] Connection refused (${err && err.message}). Attempt ${pgSocketRetries}.`);

    if (pgSocketRetries <= 4) {
        // Give the LTI launch time to establish the session, then dial again.
        setTimeout(() => {
            if (!socket.connected) socket.connect();
        }, 1500 * pgSocketRetries);
        return;
    }

    const banner = document.getElementById('pg-socket-banner') || (() => {
        const el = document.createElement('div');
        el.id = 'pg-socket-banner';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;padding:10px 16px;' +
            'background:var(--danger);color:#fff;font-size:13px;font-weight:600;text-align:center;';
        document.body.appendChild(el);
        return el;
    })();
    banner.innerHTML = 'Live monitoring is not connected &mdash; this view is not showing real-time activity. ' +
        '<a href="#" onclick="window.location.reload();return false;" style="color:#fff;text-decoration:underline;">Reload</a>';
});

socket.on('connect', () => {
    pgSocketRetries = 0;
    const banner = document.getElementById('pg-socket-banner');
    if (banner) banner.remove();
});

// Shared flag taxonomy + risk scoring (one source of truth for live, list, and detail views)
const FLAG_EVENT_TYPES = [
    'tab_blur', 'window_blur', 'fullscreen_exit', 'tab_switched', 'tab_blurred',
    'audio_violation', 'mic_muted', 'audio_threshold_exceeded',
    'error', 'fail', 'booted',
    'phone_detected', 'multiple_faces', 'no_face', 'gaze_off_screen',
    'clipboard', 'copy', 'paste', 'window_resize', 'browser_resize'
];

function isFlagEvent(type) {
    if (!type) return false;
    // Kept in step with getEventWeightCategory below — the flag count and the risk
    // score must never disagree about what counts as a violation.
    if (NON_BEHAVIOURAL_EVENT_TYPES.includes(normaliseEventType(type))) return false;
    if (type.startsWith('AI_')) return true;
    if (FLAG_EVENT_TYPES.includes(type)) return true;
    const t = normaliseEventType(type);
    if (t === 'tab_blocked' || t === 'incognito_blocked' ||
        t === 'multi_monitor_detected' || t === 'prohibited_process') return true;
    return t.includes('clipboard') || t.includes('copy') || t.includes('paste') ||
        t.includes('resize') || t.includes('blur') || t.includes('tab_switch');
}

// ================================================================
// Exam option icons.
//
// Ported verbatim from the extension's quiz-settings panel so the two surfaces
// show the same glyphs. The dashboard previously loaded these as <img> files from
// /icons/, which rendered as heavy filled shapes that did not match anything else
// in the UI. Inline stroke SVGs inherit currentColor, so they also pick up the
// selected/unselected state of their card instead of staying a fixed colour.
// ================================================================
const PG_ICONS = {
    cam:    `<svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    mic:    `<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    screen: `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M8 8l2 2 4-4"/></svg>`,
    traffic:`<svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    desk:   `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/><circle cx="12" cy="10" r="3"/></svg>`,
    fs:     `<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`,
    one:    `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    ntab:   `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18"/><line x1="16" y1="5" x2="16" y2="10"/></svg>`,
    ctab:   `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="12" y1="12" x2="12" y2="18"/></svg>`,
    print:  `<svg viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
    clip:   `<svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`,
    dl:     `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    cache:  `<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    rc:     `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="12"/><line x1="12" y1="12" x2="21" y2="12"/></svg>`,
    reen:   `<svg viewBox="0 0 24 24"><path d="M15 9l3 3-3 3"/><path d="M18 12H6"/><line x1="21" y1="3" x2="21" y2="21"/></svg>`,
    mobile: `<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
    vvid:   `<svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/><path d="M4 19l1.5 1.5L9 17"/></svg>`,
    vaud:   `<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><path d="M15 21l1.5 1.5L20 19"/></svg>`,
    vdesk:  `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="16" x2="12" y2="21"/><path d="M16 18l1.5 1.5L21 16"/></svg>`,
    vid:    `<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="3"/><path d="M15 9h4M15 12h4M15 15h3"/></svg>`,
    vsig:   `<svg viewBox="0 0 24 24"><path d="M3 17c1.5-2 2.5-4 4-4s2 3 3.5 3 2.5-3 4-3 2 2 3.5 4"/><line x1="3" y1="21" x2="21" y2="21"/></svg>`,
    calc:   `<svg viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8" y2="10" stroke-width="3"/><line x1="12" y1="10" x2="12" y2="10" stroke-width="3"/><line x1="16" y1="10" x2="16" y2="10" stroke-width="3"/><line x1="8" y1="14" x2="8" y2="14" stroke-width="3"/><line x1="12" y1="14" x2="12" y2="14" stroke-width="3"/><line x1="16" y1="14" x2="16" y2="18" stroke-width="3"/><line x1="8" y1="18" x2="8" y2="18" stroke-width="3"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`,
    wb:     `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M7 10l3 3 5-5"/></svg>`
};

// Which option each card shows, keyed by its visible label rather than by the icon
// filename it used to load — two of those files were reused for different options
// ("Mobile Camera" and "Allow Mobile Devices" both used secondary-mobile-camera.svg),
// so the filename cannot distinguish them.
const PG_ICON_BY_LABEL = {
    'Record Webcam': 'cam', 'Record Video': 'cam', 'Record Audio': 'mic',
    'Record Screen': 'screen', 'Record Web Traffic': 'traffic',
    'Room / Desk Scan': 'desk', 'Mobile Camera': 'desk',
    'Secondary Mobile Camera': 'desk',
    'Force Full Screen': 'fs', 'Only One Screen': 'one',
    'Disable New Tabs': 'ntab', 'Close Open Tabs': 'ctab',
    'Disable Printing': 'print', 'Disable Clipboard': 'clip',
    'Block Downloads': 'dl', 'Clear Cache': 'cache',
    'Disable Right Click': 'rc', 'Prevent Re-entry': 'reen',
    'Allow Mobile Devices': 'mobile',
    'Verify Video': 'vvid', 'Verify Audio': 'vaud', 'Verify Desktop': 'vdesk',
    'Verify ID': 'vid', 'Verify Signature': 'vsig',
    'Calculator': 'calc', 'Whiteboard': 'wb'
};

// Options that only the browser extension can enforce.
//
// The dashboard offered these as ordinary checkboxes, so an instructor could tick
// "Disable New Tabs", save, and reasonably believe tabs were blocked — when nothing
// in the web system can block a tab. Only the extension can, and it is currently
// paused for students. The extension's own settings panel already greys these out
// and labels them; the dashboard did not, which made it the less honest of the two
// surfaces about what it actually enforces.
const PG_EXTENSION_ONLY_LABELS = ['Record Web Traffic', 'Disable New Tabs', 'Close Open Tabs', 'Clear Cache'];

function applyOptionCardIcons(root) {
    if (!root) return;

    // Stroke icons, injected once. Inheriting currentColor is the point: the glyph
    // picks up its card's selected/unselected colour instead of being a fixed image.
    if (!document.getElementById('pg-option-icon-styles')) {
        const st = document.createElement('style');
        st.id = 'pg-option-icon-styles';
        st.textContent = `
            .proctorio-icon svg { width: 26px; height: 26px; fill: none; stroke: currentColor;
                stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; display: block; }
            .proctorio-card.pg-ext-only { opacity: 0.45; cursor: not-allowed; }
            .pg-ext-only-badge { font-size: 9px; font-weight: 700; color: var(--text-muted);
                margin-top: 2px; letter-spacing: 0.3px; }
        `;
        document.head.appendChild(st);
    }

    root.querySelectorAll('.proctorio-card').forEach(card => {
        const titleEl = card.querySelector('.proctorio-title');
        const iconEl = card.querySelector('.proctorio-icon');
        if (!titleEl || !iconEl) return;

        const label = titleEl.textContent.trim();
        const key = PG_ICON_BY_LABEL[label];
        if (key && PG_ICONS[key]) iconEl.innerHTML = PG_ICONS[key];

        if (PG_EXTENSION_ONLY_LABELS.includes(label)) {
            card.classList.add('pg-ext-only');
            card.removeAttribute('onclick');
            card.title = 'Needs the student browser extension, which is currently paused. ' +
                'Everything else on this page is enforced by ProctorGuard itself.';
            if (!titleEl.querySelector('.pg-ext-only-badge')) {
                titleEl.insertAdjacentHTML('beforeend', '<div class="pg-ext-only-badge">EXTENSION ONLY</div>');
            }
        }
    });
}

// m:ss for video offsets.
function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Escape text before it goes anywhere near innerHTML.
//
// Proctor log messages are student-supplied: the student's own browser posts
// `event_message` to /api/session/log, and the instructor's report view rendered it
// straight into an innerHTML template. A student could therefore log
// `<img src=x onerror=...>` and have it execute inside the instructor's
// authenticated session on this origin — which is privilege escalation from
// student to instructor, not just defacement. Annotations get the same treatment;
// they are instructor-authored, but there is no reason to leave the hole open.
// Only let same-origin paths and https URLs reach an href.
//
// The room-scan / ID / signature links in the report take their href from a log's
// event_message. The server writes those as internal paths, but event_message is
// also whatever the student's own browser posted to /api/session/log — so a student
// could log event_type 'room_scan_video' with a `javascript:` URL and have it run in
// the instructor's session the moment the link is clicked. Escaping the HTML does
// not help here; the scheme is the problem.
function safeUrl(value) {
    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (!raw) return '#';
    if (raw.startsWith('/') || /^https:\/\//i.test(raw)) return escapeHtml(raw);
    return '#';
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Diagnostics and lifecycle notes. These describe the software's own state, not
// the student's conduct, and must never raise a risk score.
//
// This list matters because 'error' is in FLAG_EVENT_TYPES: without it, a failed
// chunk upload or a damaged recording — infrastructure problems, often the
// student's wifi — would be counted as integrity flags against the person sitting
// the exam. A network fault is not cheating.
const NON_BEHAVIOURAL_EVENT_TYPES = [
    'heartbeat', 'info', 'system_error', 'upload_incomplete',
    'exam_ended', 'exam_started', 'screen_share_resolved', 'page_hidden'
];

// Normalise event types before matching.
//
// The extension reports human-readable types with capitals and spaces
// ("Tab Blocked", "Multi-Monitor Detected", "Incognito Blocked") while this
// taxonomy matches lowercase/underscore patterns. Unmatched types return null and
// computeSessionRisk skips them, so every violation the extension detected —
// blocked tabs, second monitors, incognito windows — was scoring zero and was
// missing from the instructor's flag count entirely.
function normaliseEventType(type) {
    return String(type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function getEventWeightCategory(type) {
    if (!type) return null;

    const norm = normaliseEventType(type);
    if (NON_BEHAVIOURAL_EVENT_TYPES.includes(norm)) return null;

    // Extension-reported lockdown violations.
    if (norm === 'tab_blocked' || norm === 'incognito_blocked') return 'away';
    if (norm === 'multi_monitor_detected' || norm === 'prohibited_process') return 'device';

    if (type.startsWith('AI_GAZE') || type === 'gaze_off_screen') return 'head';
    if (type.startsWith('AI_DEVICE') || type === 'phone_detected') return 'device';
    if (type.startsWith('AI_PEOPLE') || type === 'multiple_faces' || type === 'no_face') return 'face';
    if (type === 'audio_violation' || type === 'mic_muted' || type === 'audio_threshold_exceeded') return 'audio';
    if (['tab_blur', 'window_blur', 'fullscreen_exit', 'tab_switched', 'tab_blurred'].includes(type) ||
        (type.includes('blur') || type.includes('tab_switch'))) return 'away';
    if (type.includes('clipboard') || type.includes('copy') || type.includes('paste')) return 'copy';
    if (type.includes('resize')) return 'resize';
    if (type.includes('keystroke') || type.includes('key_')) return 'key';
    if (type.includes('leaving') || type.includes('room_left')) return 'room';
    if (isFlagEvent(type)) return 'other';
    return null;
}

/**
 * Unified risk model. Uses exam behavior weights when available.
 * Returns { score, tier, category, html, totalWarnings, focusWarnings, aiWarnings, audioWarnings, trustScore }
 */
function computeSessionRisk(session, exam = null) {
    const logs = Array.isArray(session.logs) ? session.logs : [];
    const weights = {
        away: exam && exam.weight_navigating_away != null ? Number(exam.weight_navigating_away) : 3,
        key: exam && exam.weight_keystrokes != null ? Number(exam.weight_keystrokes) : 1,
        copy: exam && exam.weight_copy_paste != null ? Number(exam.weight_copy_paste) : 4,
        resize: exam && exam.weight_browser_resize != null ? Number(exam.weight_browser_resize) : 2,
        head: exam && exam.weight_head_movement != null ? Number(exam.weight_head_movement) : 2,
        face: exam && exam.weight_multi_face != null ? Number(exam.weight_multi_face) : 3,
        room: exam && exam.weight_leaving_room != null ? Number(exam.weight_leaving_room) : 3,
        device: 5,
        audio: 3,
        other: 2
    };

    let score = 0;
    let focusWarnings = 0, aiWarnings = 0, audioWarnings = 0, totalWarnings = 0;

    logs.forEach(l => {
        const cat = getEventWeightCategory(l.event_type);
        if (!cat) return;
        totalWarnings++;
        if (cat === 'away') focusWarnings++;
        if (l.event_type && l.event_type.startsWith('AI_')) aiWarnings++;
        if (cat === 'audio') audioWarnings++;
        score += (weights[cat] != null ? weights[cat] : weights.other) * 4;
    });

    // Cap and tier
    score = Math.min(100, Math.round(score));
    let tier = 'Low';
    let category = 'low';
    let html = '<span class="badge badge-success">Low Risk</span>';
    if (score >= 50 || aiWarnings > 0 || audioWarnings > 2) {
        tier = 'High'; category = 'high';
        html = `<span class="badge badge-danger">High Risk (${totalWarnings} flags)</span>`;
    } else if (score >= 20 || totalWarnings > 0) {
        tier = 'Moderate'; category = 'moderate';
        html = `<span class="badge badge-warning">Mod Risk (${totalWarnings} flags)</span>`;
    }

    const trustScore = Math.max(0, 100 - score);
    return { score, tier, category, html, totalWarnings, focusWarnings, aiWarnings, audioWarnings, trustScore };
}

function getRiskInfo(session) {
    const exam = currentLiveExamId ? exams.find(e => e.id == currentLiveExamId) : null;
    return computeSessionRisk(session, exam);
}

// ================================================================
// Hand off a short-lived extension auth token to the ProctorGuard Chrome
// extension. This page only reaches this code while running inside a real,
// LTI-verified instructor session (that's what /api/extension/token itself
// requires — see server.js), so the extension never has to trust anything
// static. See extension/background.js's onMessageExternal listener and
// extension/manifest.json's externally_connectable for the receiving end.
//
// TODO: once ProctorGuard is published to the Chrome Web Store, replace this
// placeholder with the real extension ID from its Web Store listing page
// (chrome://extensions in developer mode also shows it for a locally-loaded
// copy, but that ID is only stable once the item is actually published).
const PG_EXTENSION_ID = 'REPLACE_WITH_PUBLISHED_EXTENSION_ID';

async function syncExtensionAuthToken() {
    try {
        const res = await fetch('/api/extension/token');
        if (!res.ok) return; // not an instructor session (e.g. student dashboard view) — nothing to hand off
        const { token, expiresIn } = await res.json();
        const expiresAt = Date.now() + expiresIn * 1000;

        // Post message so the extension's content script running on the page can relay it
        window.postMessage({ type: 'PG_SET_TOKEN', token, expiresAt }, "*");

        // Direct extension message fallback (if ID is configured)
        if (window.chrome && chrome.runtime && chrome.runtime.sendMessage && !PG_EXTENSION_ID.startsWith('REPLACE_WITH')) {
            chrome.runtime.sendMessage(PG_EXTENSION_ID, { type: 'PG_SET_TOKEN', token, expiresAt }, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[ProctorGuard] Extension not installed or unreachable via external message:', chrome.runtime.lastError.message);
                }
            });
        }
    } catch (e) {
        console.warn('[ProctorGuard] Failed to sync extension auth token:', e.message);
    }
}

// Refresh well before the ~20 minute token expiry so a teacher who leaves the
// dashboard tab open never sees a stale/expired token in the extension.
syncExtensionAuthToken();
setInterval(syncExtensionAuthToken, 10 * 60 * 1000);

// Put the real signed-in name in the top bar. index.html ships the placeholder
// text "Instructor", which every teacher saw regardless of who they were —
// software that produces evidence for integrity cases should at minimum be able
// to say whose session generated it.
async function loadIdentity() {
    try {
        const res = await fetch('/api/me');
        if (!res.ok) return;
        const me = await res.json();
        if (me.user_name) {
            const el = document.getElementById('user-name');
            if (el) el.textContent = me.user_name;
        }
        return me;
    } catch (e) {
        // Non-fatal: the placeholder stays, the dashboard still works.
        console.warn('[ProctorGuard] Could not load identity:', e.message);
        return null;
    }
}

async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 403) {
        const clone = res.clone();
        try {
            const data = await clone.json();
            if (data.needs_passcode) {
                sessionStorage.removeItem('dashboard_passcode_verified');
                document.getElementById('passcode-overlay').style.display = 'flex';
                document.getElementById('app').style.display = 'none';
                throw new Error('Passcode verification required');
            }
        } catch(e) {
            // Ignore parse error
        }
    }
    return res;
}

socket.on('snapshot_update', (data) => {
    // data: { exam_id, exam_session_id, student_canvas_id, screenshot_data_url }
    if(currentLiveExamId == data.exam_id) {
        liveStudents[data.exam_session_id] = { ...liveStudents[data.exam_session_id], screenshot: data.screenshot_data_url };
        updateLiveGrid();
        
        // Dynamically update the fullscreen modal in real-time acting as a live feed!
        if (currentFullscreenSessionId == data.exam_session_id) {
            document.getElementById('fullscreen-image').src = data.screenshot_data_url;
        }
    }
});

socket.on('student_status', (data) => {
    // data: { session_id, name, status }
    if(currentLiveExamId) {
        if(!liveStudents[data.session_id]) liveStudents[data.session_id] = { name: data.name };
        liveStudents[data.session_id].status = data.status;
        updateLiveGrid();
    }
});

socket.on('proctor_log', (data) => {
    showToast(`Alert: ${data.event_message}`, 'warning');
    
    if (currentLiveExamId && liveStudents[data.exam_session_id]) {
        const s = liveStudents[data.exam_session_id];
        if (!s.flagCount) s.flagCount = 0;
        
        const isFlag = isFlagEvent(data.event_type);
        if (isFlag) {
            s.flagCount++;
            s.hasFlags = true;
            s.lastFlagType = data.event_type;
            s.lastFlagMessage = data.event_message;
            
            // Update Flagged Warnings counter in header
            const flagsValEl = document.getElementById('stat-flagged-violations');
            if (flagsValEl) {
                const curr = parseInt(flagsValEl.innerText) || 0;
                flagsValEl.innerText = curr + 1;
            }
        }
        updateLiveGrid();
    }
});

// Auto-resize LTI iframe to avoid double scrollbars and locked scrolling in Canvas
function initLtiFrameResize() {
    const sendResize = () => {
        if (window.parent && window.parent !== window) {
            const height = document.body.scrollHeight || document.documentElement.scrollHeight;
            window.parent.postMessage(JSON.stringify({
                subject: "lti.frameResize",
                height: height
            }), "*");
        }
    };
    
    window.addEventListener('load', sendResize);
    window.addEventListener('resize', sendResize);
    
    // Also send resize whenever DOM changes
    const observer = new MutationObserver(sendResize);
    observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true
    });
    
    // Initial calls
    setTimeout(sendResize, 100);
    setTimeout(sendResize, 500);
    setTimeout(sendResize, 1000);
}

document.addEventListener('DOMContentLoaded', async () => {
    initLtiFrameResize();

    const overlay = document.getElementById('passcode-overlay');
    const app = document.getElementById('app');

    // Ask who we are before deciding what to show. Doing this first means we
    // either present the passcode prompt or the dashboard — never the dashboard
    // briefly followed by the prompt slamming over it, which is what happened
    // when this handler hid the overlay unconditionally and something async
    // raised it a moment later.
    const me = await loadIdentity();

    if (me && me.passcode_required) {
        overlay.style.display = 'flex';
        app.style.display = 'none';
        const input = document.getElementById('passcode-input');
        if (input) input.focus();
        return; // loadExams() runs after a successful passcode instead.
    }

    overlay.style.display = 'none';
    app.style.display = '';
    checkDatabaseCapacity();
    loadExams();
});

async function submitPasscode() {
    const passcode = document.getElementById('passcode-input').value;
    const errorEl = document.getElementById('passcode-error-msg');
    errorEl.style.display = 'none';
    
    try {
        const res = await fetch('/api/verify-passcode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            sessionStorage.setItem('dashboard_passcode_verified', 'true');
            document.getElementById('passcode-overlay').style.display = 'none';
            document.getElementById('app').style.display = '';
            checkDatabaseCapacity();
            loadExams();
        } else {
            errorEl.innerText = data.error || 'Incorrect passcode';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.innerText = 'Connection error';
        errorEl.style.display = 'block';
    }
}

async function checkDatabaseCapacity() {
    try {
        const res = await apiFetch('/api/db-status');
        const data = await res.json();
        const mbUsed = data.used_bytes / 1024 / 1024;
        if (mbUsed > 350) {
            const banner = document.createElement('div');
            banner.style.background = 'var(--danger)';
            banner.style.color = 'white';
            banner.style.padding = '12px 20px';
            banner.style.textAlign = 'center';
            banner.style.fontWeight = 'bold';
            banner.innerHTML = `⚠️ CRITICAL: Database Storage Running Low! (${mbUsed.toFixed(1)} MB / 500 MB limit). Please download and purge older recordings immediately to prevent data loss.`;
            document.body.insertBefore(banner, document.body.firstChild);
        }
    } catch(err) {
        console.error("Capacity check failed", err);
    }
}

let urlParams = new URLSearchParams(window.location.search);
let activeResourceLinkId = urlParams.get('resource_link_id');
let launchReturnUrl = urlParams.get('launch_presentation_return_url');
let contentItemReturnUrl = urlParams.get('content_item_return_url');
let ltiData = urlParams.get('lti_data');
let currentPlacementMapping = null;

async function checkActivePlacement() {
    if (!activeResourceLinkId) return;
    try {
        const res = await apiFetch(`/api/placements/${encodeURIComponent(activeResourceLinkId)}`);
        currentPlacementMapping = await res.json();
    } catch (err) {
        console.error('Failed to get active placement mapping', err);
    }
}

let canvasQuizzes = [];

async function loadExams() {
    await checkActivePlacement();
    
    // Fetch exams
    try {
        const res = await apiFetch('/api/exams');
        exams = await res.json();
    } catch (err) {
        console.error("Failed to load exams", err);
    }
    
    // Fetch Canvas quizzes
    try {
        const res = await apiFetch('/api/canvas-quizzes');
        if (res.ok) {
            canvasQuizzes = await res.json();
            if (!Array.isArray(canvasQuizzes)) canvasQuizzes = [];
        } else {
            console.warn("Canvas quizzes fetch failed, falling back to mock quizzes");
            canvasQuizzes = [];
        }
    } catch (err) {
        console.error("Failed to fetch Canvas quizzes, falling back to mock quizzes", err);
        canvasQuizzes = [];
    }
    
    // Safety check: if exams is not an array, it means authentication failed
    if (!Array.isArray(exams)) {
        const content = document.getElementById('content');
        if (content) {
            content.innerHTML = `
                <div style="padding: 40px; text-align: center; max-width: 600px; margin: 0 auto; margin-top: 50px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);">
                    <div style="font-size: 40px; margin-bottom: 20px;">⚠️</div>
                    <h2 style="font-family: var(--font-sans); color: var(--text-primary); margin-bottom: 15px;">Session Authentication Required</h2>
                    <p style="color: var(--text-secondary); line-height: 1.6; margin-bottom: 20px;">Your instructor session could not be verified.</p>
                    <p style="color: var(--text-secondary); line-height: 1.6;">Please launch ProctorGuard via the Canvas Course Navigation menu or click the dashboard links from within Canvas to establish a secure session.</p>
                </div>
            `;
        }
        return;
    }

    renderExams();

    // Auto-load exam dashboard if currentPlacementMapping specifies an exam_id
    if (currentPlacementMapping && currentPlacementMapping.exam_id) {
        const matchingExam = exams.find(ex => ex.id === currentPlacementMapping.exam_id);
        if (matchingExam) {
            loadExamDashboard(matchingExam.id);
            return;
        }
    }

    // Auto-load exam dashboard if quiz_id is in URL
    const targetQuizId = urlParams.get('quiz_id');
    if (targetQuizId && exams.length > 0) {
        const linkedExam = exams.find(ex => ex.canvas_quiz_url && ex.canvas_quiz_url.includes('/quizzes/' + targetQuizId));
        if (linkedExam) {
            loadExamDashboard(linkedExam.id);
            if (urlParams.get('view') === 'live') {
                setTimeout(() => {
                    const grid = document.getElementById('live-grid');
                    if (grid) grid.scrollIntoView({ behavior: 'smooth' });
                }, 500);
            } else {
                setTimeout(() => {
                    const reports = document.getElementById('report-content');
                    if (reports) reports.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 500);
            }
        }
    }
}

function getCourseQuizzes() {
    const courseId = activeResourceLinkId || urlParams.get('course_id') || 'demo_course';
    return [
        {
            id: 101,
            title: "Example of a New Quiz",
            type: "New Quiz",
            start_date: "Aug 9, 9:00 AM",
            end_date: "Aug 13, 8:59 AM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/101`
        },
        {
            id: 102,
            title: "Example of a Classic Quiz",
            type: "Classic Quiz",
            start_date: "Aug 20, 12:00 AM",
            end_date: "Aug 21, 11:59 PM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/102`
        },
        {
            id: 103,
            title: "Midterm Physics Examination",
            type: "Classic Quiz",
            start_date: "Sep 15, 10:00 AM",
            end_date: "Sep 15, 12:00 PM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/103`
        },
        {
            id: 104,
            title: "Final Term Assessment",
            type: "New Quiz",
            start_date: "Dec 10, 9:00 AM",
            end_date: "Dec 12, 5:00 PM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/104`
        }
    ];
}

function enableQuizProctoring(title, quizUrl) {
    showCreateExamModal();
    document.getElementById('exam-title').value = title;
    document.getElementById('exam-url').value = quizUrl;
}

function renderExams() {
    const content = document.getElementById('content');
    const quizzes = canvasQuizzes.length > 0 ? canvasQuizzes : getCourseQuizzes();
    
    let tbodyHtml = '';
    quizzes.forEach(q => {
        // Find if quiz is enabled in exams list
        const linkedExam = exams.find(ex => ex.canvas_quiz_url === q.quiz_url || ex.canvas_quiz_url.includes(`/quizzes/${q.id}`));
        
        let actionsHtml = '';
        let titleHtml = '';
        
        if (linkedExam) {
            // Enabled state (Dashboard, Settings, Disable buttons)
            titleHtml = `<a href="javascript:void(0)" onclick="loadExamDashboard(${linkedExam.id})" style="color: var(--accent); font-weight: 700; text-decoration:none; transition:var(--transition); font-size: 14px; font-family: var(--font-sans);">${escapeHtml(q.title)}</a>`;
            actionsHtml = `
                <div style="display:flex; gap:6px; justify-content:flex-end;">
                    <button class="btn btn-slate btn-sm" onclick="loadExamDashboard(${linkedExam.id})" style="font-weight:700;">Dashboard</button>
                    <button class="btn btn-slate btn-sm" onclick="showCreateExamModal(${linkedExam.id})" style="font-weight:700;">Settings</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteExam(${linkedExam.id})" style="font-weight:700;">Disable</button>
                </div>
            `;
        } else {
            // Disabled state (Enable button)
            titleHtml = `<span style="color: var(--text-primary); font-weight: 500; font-size: 14px; font-family: var(--font-sans);">${escapeHtml(q.title)}</span>`;
            actionsHtml = `
                <div style="display:flex; justify-content:flex-end; align-items:center; gap: 10px;">
                    <span style="color: #ea580c; font-size:16px;">➔</span>
                    <button class="btn btn-primary btn-sm" onclick="enableQuizProctoring(${JSON.stringify(String(q.title || '')).replace(/"/g, '&quot;')}, ${JSON.stringify(String(q.quiz_url || '')).replace(/"/g, '&quot;')})" style="font-weight:700; padding: 6px 18px;">Enable</button>
                </div>
            `;
        }
        
        tbodyHtml += `
            <tr style="border-bottom: 1px solid var(--border); transition:var(--transition);">
                <td style="padding: 16px; vertical-align:middle;">${titleHtml}</td>
                <td style="padding: 16px; color: var(--text-secondary); vertical-align:middle; font-size:13px;">${q.type}</td>
                <td style="padding: 16px; color: var(--text-secondary); vertical-align:middle; font-size:13px; line-height: 1.5;">
                    Start: ${q.start_date}<br>
                    End: ${q.end_date}
                </td>
                <td style="padding: 16px; vertical-align:middle;">${actionsHtml}</td>
            </tr>
        `;
    });

    content.innerHTML = `
        <div class="page-header" style="margin-bottom: 30px;">
            <div>
                <h1 class="page-title" style="font-family: var(--font-sans); font-size:24px; font-weight:700;">Canvas Quizzes</h1>
                <p class="page-subtitle" style="font-family: var(--font-sans);">Enable, configure, and monitor secure proctoring options for all quizzes in this course.</p>
            </div>
        </div>

        <div class="card" style="padding: 24px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); box-shadow:var(--shadow);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 15px;">
                <div style="font-size:14px; font-weight:700; color:var(--text-secondary); font-family: var(--font-sans);">
                    Course Quizzes (${quizzes.length})
                </div>
            </div>

            <!-- The Quizzes Table -->
            <div class="table-wrapper" style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="border-bottom: 2px solid var(--border); background: rgba(0, 0, 0, 0.01);">
                            <th style="font-family: var(--font-sans); font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:left;">Quiz Name</th>
                            <th style="font-family: var(--font-sans); font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:left;">Type</th>
                            <th style="font-family: var(--font-sans); font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:left;">Dates</th>
                            <th style="font-family: var(--font-sans); font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:right;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tbodyHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// THE NEW EXAM DASHBOARD (Master-Detail View)
function loadExamDashboard(examId) {
    const exam = exams.find(e => e.id == examId);
    if (!exam) return;
    
    currentLiveExamId = examId;
    liveStudents = {};
    socket.emit('join_teacher', examId);
    
    const content = document.getElementById('content');
    content.innerHTML = `
        <div class="page-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px;">
            <div>
                <button class="btn btn-secondary" style="margin-bottom: 12px;" onclick="closeExamDashboard()">← Back to Exams</button>
                <div style="display:flex; align-items:center; gap: 15px;">
                    <h1 class="page-title" style="font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${escapeHtml(exam.title)} Workspace</h1>
                    <button class="btn" id="status-toggle-btn" 
                        style="padding: 6px 16px; font-size: 12px; border-radius: 20px; font-weight: 700; border: none; cursor: pointer; transition: var(--transition);
                        ${exam.is_open ? 'background:var(--success); color:white;' : 'background:var(--danger); color:white;'}"
                        onclick="toggleExamStatus(${exam.id})">
                        ${exam.is_open ? '🔓 Exam is OPEN' : '🔒 Exam is CLOSED'}
                    </button>
                </div>
                <p class="page-subtitle">Access code: <strong style="color:var(--accent); font-family:monospace;">${exam.exam_code}</strong>
                    · <a href="/student.html?practice=1" target="_blank" style="color:var(--accent); font-weight:600;">Open practice system check</a>
                    <span style="color:var(--text-muted); font-size:12px;"> (share with students · not graded)</span>
                </p>
            </div>
        </div>

        <!-- ProctorGuard Navigation Tabbar -->
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 25px; padding: 0 16px;">
            <div style="display: flex; gap: 20px; align-items: center; height: 50px; font-size: 14px;">
                <div class="proctor-tab active" style="font-weight: 700; color: var(--accent); border-bottom: 3px solid var(--accent); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: default;">
                    Review Center
                </div>
                <div class="proctor-tab" onclick="showCreateExamModal(${exam.id})" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    Settings
                </div>
                <div class="proctor-tab" onclick="showAccommodationsPanel(${exam.id})" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    Accommodations
                </div>
                <div class="proctor-tab" onclick="exportExamReportsCsv(${exam.id})" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    Export CSV
                </div>
            </div>
        </div>

        <!-- Metrics Dashboard Row -->
        <div class="metrics-row" style="margin-top:20px;">
            <div class="card stat-card info">
                <div class="stat-value" id="stat-total-attempts">--</div>
                <div class="stat-label">Total Attempts</div>
            </div>
            <div class="card stat-card success">
                <div class="stat-value" id="stat-active-sessions">0</div>
                <div class="stat-label">Active Students</div>
            </div>
            <div class="card stat-card danger">
                <div class="stat-value" id="stat-flagged-violations">0</div>
                <div class="stat-label">Flagged Warnings</div>
            </div>
            <div class="card stat-card warning">
                <div class="stat-value" id="stat-integrity-rate">100%</div>
                <div class="stat-label">Integrity Rate</div>
            </div>
        </div>
        
        <div style="display: flex; flex-direction: column; gap: 30px; margin-top: 10px;">
            <!-- Live Monitoring Block -->
            <div class="card" style="padding: 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px; flex-wrap: wrap; gap: 12px;">
                    <h2 style="font-size: 18px; font-weight: 700; margin: 0;">Live Monitoring Feed</h2>
                    <div style="display:flex; align-items:center; gap:10px; flex-wrap: wrap;">
                        <div class="live-filter-group" style="display:flex; gap:4px; background:#f1f5f9; padding:3px; border-radius:8px;">
                            <button type="button" class="btn btn-sm live-filter-btn ${liveViewFilter==='all'?'btn-primary':'btn-secondary'}" data-filter="all" onclick="setLiveViewFilter('all')" style="padding:4px 10px; font-size:12px;">All</button>
                            <button type="button" class="btn btn-sm live-filter-btn ${liveViewFilter==='online'?'btn-primary':'btn-secondary'}" data-filter="online" onclick="setLiveViewFilter('online')" style="padding:4px 10px; font-size:12px;">Online</button>
                            <button type="button" class="btn btn-sm live-filter-btn ${liveViewFilter==='flagged'?'btn-primary':'btn-secondary'}" data-filter="flagged" onclick="setLiveViewFilter('flagged')" style="padding:4px 10px; font-size:12px;">Flagged first</button>
                        </div>
                        <div class="live-filter-group" style="display:flex; gap:4px; background:#f1f5f9; padding:3px; border-radius:8px;">
                            <button type="button" class="btn btn-sm ${liveViewLayout==='grid'?'btn-primary':'btn-secondary'}" onclick="setLiveViewLayout('grid')" style="padding:4px 10px; font-size:12px;" title="Compact grid">Grid</button>
                            <button type="button" class="btn btn-sm ${liveViewLayout==='large'?'btn-primary':'btn-secondary'}" onclick="setLiveViewLayout('large')" style="padding:4px 10px; font-size:12px;" title="Larger tiles">Large</button>
                        </div>
                        <button class="btn btn-warning-action btn-sm" onclick="sendBroadcastAnnouncement(${exam.id})">
                            Broadcast Alert
                        </button>
                        <span style="font-size:12px; color:var(--text-secondary);">Click feed to expand</span>
                    </div>
                </div>
                <div id="live-grid" class="session-grid ${liveViewLayout==='large' ? 'live-grid-large' : ''}"></div>
            </div>
            
            <!-- Reports Block -->
            <div class="card" style="padding: 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <h2 style="font-size: 18px; font-weight: 700; margin: 0;">Post-Exam Reports & Video Vault</h2>
                        <div id="submissions-ratio-badge" style="font-size: 13px; font-weight: 700; color: var(--warning); margin-top: 2px;">Submissions: loading...</div>
                    </div>
                    <div style="display:flex; gap: 10px;">
                        <button class="btn btn-primary" style="font-size:12px; padding: 8px 16px;" onclick="window.open('/api/exams/drive-folder', '_blank')">📁 Open Drive Vault</button>
                        <button class="btn btn-secondary" style="font-size:12px; padding: 8px 16px;" onclick="fetchReportData(${exam.id})">Refresh Reports</button>
                    </div>
                </div>
                
                <!-- Reports Search & Filters -->
                <div class="filter-search-container" style="margin-bottom: 20px; display: flex; gap: 12px;">
                    <input type="text" id="report-search-input" class="filter-input" placeholder="Search student by name..." />
                    <select id="report-risk-select" class="filter-select">
                        <option value="all">All Integrity Statuses</option>
                        <option value="low">🟢 Low Risk (Clean)</option>
                        <option value="moderate">🟡 Moderate Risk</option>
                        <option value="high">🔴 High Risk</option>
                    </select>
                </div>
                
                <div id="report-content"><div class="spinner"></div></div>
            </div>
        </div>
    `;
    
    updateLiveGrid();
    fetchReportData(examId);
}

function closeExamDashboard() {
    currentLiveExamId = null;
    loadExams();
}

// LIVE VIEW LOGIC
function getShortFlagLabel(type) {
    if (type === 'audio_violation') return '🗣️ Speaking';
    if (type === 'mic_muted') return '🔇 Mic Muted';
    if (type === 'tab_blur' || type === 'window_blur') return '🔒 Focus Lost';
    if (type === 'fullscreen_exit') return '🖥️ Fullscreen Exit';
    if (type.startsWith('AI_GAZE')) return '🤖 Eye Gaze Shift';
    if (type.startsWith('AI_DEVICE')) return '📱 Device Detected';
    if (type.startsWith('AI_PEOPLE')) return '👥 Person Anomaly';
    return type.toUpperCase();
}

function setLiveViewFilter(filter) {
    liveViewFilter = filter;
    updateLiveGrid();
}

function setLiveViewLayout(layout) {
    liveViewLayout = layout;
    const grid = document.getElementById('live-grid');
    if (grid) {
        grid.classList.toggle('live-grid-large', layout === 'large');
    }
    updateLiveGrid();
}

function updateLiveGrid() {
    if (!document.getElementById('live-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'live-pulse-style';
        style.textContent = `
            @keyframes live-pulse-flag {
                0% { border-color: rgba(239, 68, 68, 0.4); box-shadow: 0 0 5px rgba(239, 68, 68, 0.2); }
                50% { border-color: rgba(239, 68, 68, 1); box-shadow: 0 0 15px rgba(239, 68, 68, 0.5); }
                100% { border-color: rgba(239, 68, 68, 0.4); box-shadow: 0 0 5px rgba(239, 68, 68, 0.2); }
            }
            .live-grid-large { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) !important; }
            .live-grid-large .card-screenshot-container img,
            .live-grid-large .card-screenshot-container > div { height: 200px !important; }
        `;
        document.head.appendChild(style);
    }

    const grid = document.getElementById('live-grid');
    if(!grid) return;

    grid.classList.toggle('live-grid-large', liveViewLayout === 'large');

    let sessionIds = Object.keys(liveStudents);

    // Filter
    if (liveViewFilter === 'online') {
        sessionIds = sessionIds.filter(id => liveStudents[id].status === 'online');
    } else if (liveViewFilter === 'flagged') {
        sessionIds = sessionIds.filter(id => liveStudents[id].hasFlags || liveStudents[id].status === 'online');
    }

    // Sort: flagged first, then online, then by name
    sessionIds.sort((a, b) => {
        const sa = liveStudents[a], sb = liveStudents[b];
        const fa = sa.hasFlags ? 1 : 0, fb = sb.hasFlags ? 1 : 0;
        if (fa !== fb) return fb - fa;
        const oa = sa.status === 'online' ? 1 : 0, ob = sb.status === 'online' ? 1 : 0;
        if (oa !== ob) return ob - oa;
        return (sa.name || '').localeCompare(sb.name || '');
    });
    
    if (sessionIds.length === 0) {
        const emptyLabel = Object.keys(liveStudents).length === 0
            ? 'Live queue is empty. Waiting for students to authenticate...'
            : 'No students match this filter.';
        grid.innerHTML = `<div id="empty-grid-msg" style="color: var(--text-muted); font-size: 14px; grid-column:1/-1; padding:20px 0; text-align:center;">${emptyLabel}</div>`;
        const activeMetric = document.getElementById('stat-active-sessions');
        if (activeMetric) activeMetric.innerText = Object.keys(liveStudents).filter(id => liveStudents[id].status === 'online').length;
        return;
    }

    const emptyMsg = document.getElementById('empty-grid-msg');
    if (emptyMsg) emptyMsg.remove();

    // Remove cards not in filtered set or no longer live
    const cards = grid.querySelectorAll('.student-live-card');
    cards.forEach(card => {
        const id = card.id.replace('student-card-', '');
        if (!liveStudents[id] || !sessionIds.includes(id)) {
            card.remove();
        }
    });

    const imgH = liveViewLayout === 'large' ? 200 : 140;

    sessionIds.forEach(sessionId => {
        const s = liveStudents[sessionId];
        const statusColor = s.status === 'online' ? 'var(--success)' : 'var(--text-muted)';
        const safeName = (s.name || 'Student').replace(/'/g, "\\'");
        
        let content = '';
        if(s.screenshot) {
            content = `<img src="${s.screenshot}" style="width:100%; height:${imgH}px; object-fit:cover; border-radius: var(--radius-sm); cursor: pointer;" onclick="openFullscreenImg(this.src, ${sessionId})" />`;
        } else {
            content = `<div style="width:100%; height:${imgH}px; background:rgba(0,0,0,0.3); border-radius: var(--radius-sm); display:flex; align-items:center; justify-content:center; color:var(--text-muted); border:1px dashed var(--border);">No Signal</div>`;
        }

        const warningBtn = s.status === 'online' ? `
            <button class="btn btn-warning-action btn-xs" style="margin-top:10px; width:100%; justify-content:center;" onclick="openAlertComposer(${sessionId}, '${safeName}')">
                Send Alert
            </button>
        ` : '';

        const hasFlags = s.hasFlags || false;
        const ringClass = s.status === 'online' ? (hasFlags ? 'live-ring-flagged' : 'live-ring-online') : 'live-ring-offline';

        let cardStyle = "padding: 16px; background: rgba(30, 41, 59, 0.2); transition: all 0.3s;";
        if (s.status === 'online' && hasFlags) {
            cardStyle += " border: 1.5px solid #ef4444; box-shadow: 0 0 10px rgba(239, 68, 68, 0.3); animation: live-pulse-flag 1.5s infinite;";
        }

        const flagText = (s.status === 'online' && s.lastFlagType) ? `
            <div style="margin-top: 8px; font-size: 11px; padding: 6px 8px; border-radius: 4px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; display: flex; align-items: center; gap: 4px;">
                <strong>Alert:</strong> ${getShortFlagLabel(s.lastFlagType)}
            </div>
        ` : '';

        let card = document.getElementById('student-card-' + sessionId);
        if (!card) {
            card = document.createElement('div');
            card.id = 'student-card-' + sessionId;
            card.className = `card student-live-card ${ringClass}`;
            card.setAttribute('style', cardStyle);
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; margin-bottom:10px; align-items:center;">
                    <strong style="font-size: 14px; font-weight:600;">${s.name || 'Testing...'}</strong>
                    <span class="status-dot" style="width: 8px; height: 8px; background: ${statusColor}; border-radius: 50%; display:inline-block; box-shadow: 0 0 6px ${statusColor};"></span>
                </div>
                <div class="card-screenshot-container">${content}</div>
                <div class="card-flag-container">${flagText}</div>
                <div class="card-button-container">${warningBtn}</div>
            `;
            grid.appendChild(card);
        } else {
            card.className = `card student-live-card ${ringClass}`;
            card.setAttribute('style', cardStyle);
            
            const nameEl = card.querySelector('strong');
            if (nameEl && s.name) nameEl.textContent = s.name;

            const dot = card.querySelector('.status-dot');
            if (dot) {
                dot.style.background = statusColor;
                dot.style.boxShadow = `0 0 6px ${statusColor}`;
            }
            
            const screenshotContainer = card.querySelector('.card-screenshot-container');
            if (screenshotContainer) {
                const img = screenshotContainer.querySelector('img');
                if (s.screenshot) {
                    if (!img || img.src !== s.screenshot) {
                        screenshotContainer.innerHTML = content;
                    } else if (img && img.style.height !== imgH + 'px') {
                        img.style.height = imgH + 'px';
                    }
                } else {
                    if (img || screenshotContainer.innerHTML === '') {
                        screenshotContainer.innerHTML = content;
                    }
                }
            }
            
            const flagContainer = card.querySelector('.card-flag-container');
            if (flagContainer && flagContainer.innerHTML !== flagText) {
                flagContainer.innerHTML = flagText;
            }
            
            const buttonContainer = card.querySelector('.card-button-container');
            if (buttonContainer && buttonContainer.innerHTML !== warningBtn) {
                buttonContainer.innerHTML = warningBtn;
            }
        }
        // Keep DOM order: re-append in sorted order
        grid.appendChild(card);
    });

    const activeVal = Object.keys(liveStudents).filter(id => liveStudents[id].status === 'online').length;
    const activeMetric = document.getElementById('stat-active-sessions');
    if (activeMetric) activeMetric.innerText = activeVal;
}

function openAlertComposer(sessionId, studentName, broadcast = false, examId = null) {
    const templates = [
        'Please keep your eyes on the screen and remain in fullscreen mode.',
        'Your face is not clearly visible — please adjust your camera.',
        'Please return to the exam tab immediately.',
        'Background noise detected — please find a quieter space.',
        'Please put away any unauthorized devices or materials.'
    ];
    const title = broadcast ? 'Broadcast to all online students' : `Alert: ${studentName || 'Student'}`;
    const html = `
        <div class="modal-header">
            <h2 class="modal-title">${title}</h2>
            <button class="modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div style="padding: 8px 0 16px;">
            <label class="form-label">Message</label>
            <textarea id="alert-message-input" class="form-input" style="width:100%; min-height:90px; resize:vertical;" placeholder="Type an alert message...">${templates[0]}</textarea>
            <div style="margin-top:12px;">
                <div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">Quick templates</div>
                <div style="display:flex; flex-wrap:wrap; gap:6px;">
                    ${templates.map((t, i) => `<button type="button" class="btn btn-secondary btn-sm" style="font-size:11px;" onclick="document.getElementById('alert-message-input').value=${JSON.stringify(t)}">${t.slice(0, 36)}${t.length>36?'…':''}</button>`).join('')}
                </div>
            </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px solid var(--border); padding-top:14px;">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" id="btn-send-alert">Send Alert</button>
        </div>
    `;
    const modalContainer = document.getElementById('modal-content');
    modalContainer.style.maxWidth = '520px';
    modalContainer.style.width = '92%';
    modalContainer.style.padding = '';
    modalContainer.style.background = '';
    modalContainer.style.border = '';
    modalContainer.style.height = '';
    modalContainer.style.display = '';
    modalContainer.style.flexDirection = '';
    modalContainer.style.overflow = '';
    modalContainer.innerHTML = html;
    document.getElementById('modal-overlay').classList.add('active');
    const sendBtn = document.getElementById('btn-send-alert');
    if (sendBtn) {
        sendBtn.onclick = () => submitAlertComposer(!!broadcast, sessionId, examId, studentName || 'Student');
    }
}

function submitAlertComposer(broadcast, sessionId, examId, studentName) {
    const input = document.getElementById('alert-message-input');
    const msg = input ? input.value.trim() : '';
    if (!msg) {
        showToast('Please enter a message', 'warning');
        return;
    }
    if (broadcast) {
        socket.emit('instructor_broadcast', {
            exam_id: examId || currentLiveExamId,
            message: msg
        });
        showToast('Broadcast sent to all active students.', 'success');
    } else {
        socket.emit('instructor_warning', {
            exam_session_id: sessionId,
            message: msg
        });
        showToast(`Alert sent to ${studentName || 'student'}`, 'success');
    }
    closeModal();
}

function sendStudentWarning(sessionId, studentName) {
    openAlertComposer(sessionId, studentName, false, null);
}

function openFullscreenImg(src, sessionId) {
    currentFullscreenSessionId = sessionId;
    document.getElementById('fullscreen-image').src = src;
    document.getElementById('image-overlay').classList.add('active');
}

function closeImage() {
    currentFullscreenSessionId = null;
    document.getElementById('image-overlay').classList.remove('active');
}

// BROADCAST ANNOUNCEMENT
function sendBroadcastAnnouncement(examId) {
    openAlertComposer(null, null, true, examId);
}

// Report table icon assets
const attemptIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Attempt"><line x1="9" y1="6" x2="20" y2="6"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="18" x2="20" y2="18"></line><path d="M4 6h.01"></path><path d="M4 12h.01"></path><path d="M4 18h.01"></path><path d="M5 21H3a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2"></path></svg>`;
const scoreIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Score"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>`;
const annotationsIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Annotations"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"></path></svg>`;
const abnormalitiesIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Abnormalities"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
const trustScoreIcon = `<div style="display:inline-flex; align-items:center; gap:2px; color:var(--text-secondary);" title="Trust Score"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line><circle cx="12" cy="12" r="2" fill="currentColor"></circle></svg><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"></path></svg></div>`;
const alertsIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Alerts"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

const clipboardSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Copy Paste Detected"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>`;
const resizeSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Browser Resize Detected"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line></svg>`;
const tabSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Tab Unfocused"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const robotSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="AI/Face Alert"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4M8 15h.01M16 15h.01"></path></svg>`;
const audioSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Audio/Voice Alert"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;

function filterReports(examId) {
    const searchInput = document.getElementById('report-search-input');
    const riskSelect = document.getElementById('report-risk-select');
    const tableBody = document.getElementById('report-table-body');
    if (!tableBody) return;

    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const riskFilter = riskSelect ? riskSelect.value : 'all';

    let filtered = currentSessionsList;

    // Filter by name
    if (query) {
        filtered = filtered.filter(s => {
            const name = (s.student_name || s.student_canvas_id || '').toLowerCase();
            return name.includes(query);
        });
    }

    // Filter by risk
    if (riskFilter !== 'all') {
        filtered = filtered.filter(s => {
            const riskInfo = getRiskInfo(s);
            return riskInfo.category === riskFilter;
        });
    }

    const exam = exams.find(e => e.id == examId);
    let tbodyHtml = '';
    filtered.forEach(s => {
        const riskInfo = computeSessionRisk(s, exam);
        const trustScore = riskInfo.trustScore;

        // Graded meter rather than a bare percentage. A number alone forces the
        // instructor to read every row; a bar lets them find the outliers by
        // scrolling. Fill is proportional to trust, colour follows the risk tier,
        // so a full green bar means "nothing to look at here".
        const meterTier = riskInfo.category === 'high' ? 'high'
            : (riskInfo.category === 'moderate' ? 'mod' : 'low');
        const trustBarHtml = `
            <div class="pg-meter pg-meter-${meterTier}">
                <span class="pg-meter-value">${trustScore}%</span>
                <span class="pg-meter-track"><span class="pg-meter-fill" style="width: ${trustScore}%;"></span></span>
            </div>`;
        const rowSeverityClass = riskInfo.category === 'high' ? 'pg-row-high'
            : (riskInfo.category === 'moderate' ? 'pg-row-mod' : '');

        const submissionDate = new Date(s.started_at).toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric'
        });
        
        const logsList = s.logs || [];
        let alertIconsHtml = '';
        
        const hasCopyPaste = logsList.some(l => (l.event_type || '').includes('clipboard') || (l.event_type || '').includes('copy') || (l.event_type || '').includes('paste'));
        const hasResize = logsList.some(l => (l.event_type || '').includes('resize'));
        const hasUnfocus = logsList.some(l => (l.event_type || '').includes('blur') || (l.event_type || '').includes('tab_switch') || l.event_type === 'fullscreen_exit');
        const hasAI = logsList.some(l => (l.event_type || '').startsWith('AI_'));
        const hasAudio = logsList.some(l => l.event_type === 'audio_violation' || l.event_type === 'mic_muted');
        
        if (hasCopyPaste) alertIconsHtml += clipboardSvg;
        if (hasResize) alertIconsHtml += resizeSvg;
        if (hasUnfocus) alertIconsHtml += tabSvg;
        if (hasAI) alertIconsHtml += robotSvg;
        if (hasAudio) alertIconsHtml += audioSvg;
        
        if (!alertIconsHtml) {
            alertIconsHtml = `<span style="color: var(--text-muted); font-size: 12px;">—</span>`;
        } else {
            alertIconsHtml = `<div style="display: flex; gap: 8px; align-items: center;">${alertIconsHtml}</div>`;
        }

        const annCount = s.annotations ? s.annotations.length : 0;
        const statusLabel = s.status === 'completed' ? 'Completed' : (s.status || '—');
        
        tbodyHtml += `
            <tr class="${rowSeverityClass}" style="border-bottom: 1px solid var(--border);">
                <td style="padding: 12px 16px; cursor: pointer; text-align: center;" onclick="viewStudentReport(${s.id}, ${examId})" title="Open report">
                    <span style="color: var(--accent); font-weight:700;">View</span>
                </td>
                <td style="padding: 12px 16px; font-weight: 700; color: var(--text-primary);">${escapeHtml(s.student_name || s.student_canvas_id)}</td>
                <td style="padding: 12px 16px; color: var(--text-secondary);">${submissionDate}</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600;">${s.attempt_number || 1}</td>
                <td style="padding: 12px 16px; text-align: center; color: var(--text-secondary); font-size:12px;">${statusLabel}</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600; color: ${annCount > 0 ? 'var(--accent)' : 'var(--text-muted)'};">${annCount}</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600; color: ${riskInfo.totalWarnings > 0 ? 'var(--danger)' : 'var(--text-muted)'};">${riskInfo.totalWarnings}</td>
                <td style="padding: 12px 16px;" title="Risk score: ${riskInfo.score} — ${riskInfo.tier} risk">
                    ${trustBarHtml}
                </td>
                <td style="padding: 12px 16px;">${alertIconsHtml}</td>
            </tr>
        `;
    });

    if (filtered.length === 0) {
        tbodyHtml = '<tr><td colspan="9" style="text-align:center; padding: 30px; color:var(--text-muted);">No student reports match your filters.</td></tr>';
    }

    tableBody.innerHTML = tbodyHtml;
}

// REPORTS LOGIC
async function fetchReportData(examId) {
    if(!examId) return;
    const tableContainer = document.getElementById('report-content');
    if(!tableContainer) return;

    try {
        const res = await apiFetch(`/api/exams/${examId}/reports`);
        const data = await res.json();
        
        if (data.error) {
            tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Error loading reports: ${data.error}</div>`;
            return;
        }

        const sessions = data.sessions || [];
        const enrolledCount = data.enrolled_count || 0;
        
        currentSessionsList = sessions;
        
        // Compute and update stats metrics cards
        const totalAttemptsVal = sessions.length;
        let totalViolationsVal = 0;
        let flaggedAttemptsCount = 0;
        
        const examForRisk = exams.find(e => e.id == examId);
        sessions.forEach(s => {
            const risk = computeSessionRisk(s, examForRisk);
            totalViolationsVal += risk.totalWarnings;
            if (risk.totalWarnings > 0) flaggedAttemptsCount++;
        });

        const integrityRateVal = totalAttemptsVal > 0 ? Math.round(((totalAttemptsVal - flaggedAttemptsCount) / totalAttemptsVal) * 100) : 100;

        document.getElementById('stat-total-attempts').innerText = totalAttemptsVal;
        document.getElementById('stat-flagged-violations').innerText = totalViolationsVal;
        document.getElementById('stat-integrity-rate').innerText = `${integrityRateVal}%`;

        const submittedCount = sessions.filter(s => s.status === 'completed').length;
        const ratioBadge = document.getElementById('submissions-ratio-badge');
        if (ratioBadge) {
            ratioBadge.innerText = `Submissions: ${submittedCount} of ${enrolledCount || submittedCount} enrolled completed`;
        }

        tableContainer.innerHTML = `
            <div style="margin-top: 15px; margin-bottom: 25px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px; flex-wrap:wrap; gap:10px;">
                    <h2 style="font-size: 22px; font-weight: 800; color: var(--text-primary); margin: 0;">Exam Results</h2>
                    <button class="btn btn-secondary btn-sm" onclick="exportExamReportsCsv(${examId})">Export CSV</button>
                </div>
                
                <div style="background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 30px; box-shadow: var(--shadow);">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border);">
                        <div>
                            <strong style="font-size: 15px; color: var(--text-primary);">Attempts</strong>
                            <span style="font-size: 12px; color: var(--text-muted); margin-left: 8px;">${totalAttemptsVal} total</span>
                        </div>
                    </div>
                    
                    <div class="table-wrapper" style="overflow-x: auto;">
                        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                            <thead>
                                <tr style="border-bottom: 2px solid var(--border); background: #f8fafc; font-weight: 700; color: var(--text-secondary);">
                                    <th style="padding: 12px 16px; width: 60px; text-align: center;">Report</th>
                                    <th style="padding: 12px 16px;">Name</th>
                                    <th style="padding: 12px 16px;">Started</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;" title="Attempt #">${attemptIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 90px;">Status</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;" title="Annotations">${annotationsIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;" title="Flags">${abnormalitiesIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 95px;" title="Trust score">${trustScoreIcon}</th>
                                    <th style="padding: 12px 16px; width: 150px;" title="Alert types">${alertsIcon}</th>
                                </tr>
                            </thead>
                            <tbody id="report-table-body">
                                <!-- Loaded dynamically -->
                            </tbody>
                        </table>
                    </div>
                </div>

                <div style="display:none;">
                    <div style="padding: 40px; text-align: center; color: var(--text-muted); font-size: 13px;">
                        <div style="font-size: 24px; margin-bottom: 10px;">🗑️</div>
                        <strong style="color: var(--text-primary); font-size: 14px;">No Deleted attempts</strong><br>
                        <span style="font-size: 12px; margin-top: 4px; display:inline-block;">Check back later to see if there are any changes</span>
                    </div>
                </div>
            </div>
        `;

        // Bind filter event listeners if they exist
        const searchInput = document.getElementById('report-search-input');
        const riskSelect = document.getElementById('report-risk-select');
        
        if (searchInput && !searchInput.dataset.bound) {
            searchInput.dataset.bound = "true";
            searchInput.addEventListener('input', () => filterReports(examId));
        }
        if (riskSelect && !riskSelect.dataset.bound) {
            riskSelect.dataset.bound = "true";
            riskSelect.addEventListener('change', () => filterReports(examId));
        }

        // Trigger initial table rendering
        filterReports(examId);

    } catch (err) {
        console.error("Report fetch failed", err);
        tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Failed to load reports. Check server logs.</div>`;
    }
}

let activeLogFilterSeverity = 'all';
let activeLogFilterSearch = '';

function viewStudentReport(sessionId, examId) {
    const exam = exams.find(e => e.id == examId);
    const session = currentSessionsList.find(s => s.id == sessionId);
    if (!session) return;
    
    // Setup filter states
    activeLogFilterSeverity = 'all';
    activeLogFilterSearch = '';

    const logs = Array.isArray(session.logs) ? session.logs : [];
    const riskInfo = computeSessionRisk(session, exam);
    const riskScore = riskInfo.score;
    const riskTier = riskInfo.tier;
    let riskBadgeBg = 'rgba(16, 185, 129, 0.15)';
    let riskBadgeColor = '#10b981';
    let riskBadgeBorder = 'rgba(16, 185, 129, 0.3)';
    if (riskTier === 'High') { riskBadgeBg = 'rgba(239, 68, 68, 0.15)'; riskBadgeColor = '#ef4444'; riskBadgeBorder = 'rgba(239, 68, 68, 0.3)'; }
    else if (riskTier === 'Moderate') { riskBadgeBg = 'rgba(245, 158, 11, 0.15)'; riskBadgeColor = '#f59e0b'; riskBadgeBorder = 'rgba(245, 158, 11, 0.3)'; }

    // Native player enables timeline seek; Drive link offered as fallback
    const showVideo = (session.status === 'completed' || session.status === 'abandoned') && !session.video_archived;
    let videoContainerHtml = '';
    if (showVideo) {
        const primaryHtml = `<video id="report-video-player" src="/api/session/video-playback/${session.id}" controls style="width:100%; height:100%; object-fit:contain; background:#000;"></video>`;
        const driveLink = session.drive_file_id
            ? `<a href="https://drive.google.com/file/d/${session.drive_file_id}/view" target="_blank" style="font-size:11px; color:#1e40af; margin-left:8px;">Open in Drive</a>`
            : '';

        if (session.mobile_drive_file_id || true) {
            let mobileBlock = '';
            if (session.mobile_drive_file_id) {
                mobileBlock = `
                    <div style="width: 300px; flex-shrink: 0;">
                        <div style="font-size: 11px; font-weight: 600; color: #8b83a3; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;">Secondary Mobile Room View</div>
                        <div style="background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 4/3; border: 1px solid #e2dff0;">
                            <iframe src="https://drive.google.com/file/d/${session.mobile_drive_file_id}/preview" style="width:100%; height:100%; border:none;" allow="autoplay"></iframe>
                        </div>
                    </div>`;
            }
            // The primary recording gets the full width of this pane on its own row.
            //
            // It used to sit in a flex row as a sibling of the secondary camera, so the
            // two split the space 50/50 and both ended up too small to read screen text
            // in — which is the entire point of a screen recording. The secondary is a
            // supporting view; it belongs below at a fixed size, next to the evidence
            // panels, which also fills the dead space that was under them.
            //
            // 4/3 on the secondary matches what the phone actually records (the mobile
            // constraints ask for 640x480), so it no longer letterboxes inside a 16/9 box.
            videoContainerHtml = `
                <div style="width: 100%; margin-bottom: 18px;">
                    <div style="font-size: 11px; font-weight: 600; color: #8b83a3; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; white-space: nowrap;">
                        <span>Webcam / Screen Recording</span>
                        ${driveLink}
                        <span style="font-weight:400; text-transform:none; color:#8b83a3;">&mdash; click a block below to seek</span>
                    </div>
                    <div style="background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; border: 1px solid #e2dff0;">${primaryHtml}</div>
                    <div id="report-flag-strip" style="display:flex; gap:1px; height:18px; margin-top:8px; border-radius:3px; overflow:hidden; background:#e2dff0; cursor:pointer;"></div>
                    <div id="report-flag-axis" style="display:flex; justify-content:space-between; margin-top:4px; font-size:10px; color:#8b83a3; font-variant-numeric:tabular-nums;"></div>
                </div>
                <div id="report-secondary-row" style="display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; width: 100%;">
                    ${mobileBlock}
                    <div id="report-evidence-col" style="flex: 1; min-width: 260px;"></div>
                </div>`;
        }
    } else {
        videoContainerHtml = `
            <div style="margin-bottom: 20px; background: rgba(255, 255, 255, 0.02); border: 1px dashed #e2dff0; border-radius: 8px; padding: 30px; text-align: center; color: #8b83a3;">
                <span style="font-size: 32px; display:block; margin-bottom: 8px;">🎥</span>
                ${session.video_archived ? '<strong style="color:#241d38;">Video Footage Archived Off-Site</strong><br><span style="font-size:12px;">This recording was hard purged to reclaim storage space.</span>' : '<strong style="color:#241d38;">Video Recording Finalizing...</strong><br><span style="font-size:12px;">The footage is still being assembled and uploaded in the background.</span>'}
            </div>`;
    }

    // Extra panels (room scan, snapshots, ID verification, signature)
    let extraPanelsHtml = '';
    const roomScanLog = logs.find(l => l.event_type === 'room_scan_video');
    if (roomScanLog) {
        extraPanelsHtml += `
            <div style="background: rgba(139, 92, 246, 0.08); border: 1px solid rgba(139, 92, 246, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#c084fc;">Environment Room Scan</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#8b83a3;">360&deg; workspace scan completed before starting the exam.</p>
                </div>
                <a href="${safeUrl(roomScanLog.event_message)}" target="_blank" rel="noopener noreferrer" style="background: #8b5cf6; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    👁️ View Scan
                </a>
            </div>`;
    }
    const idVerificationLog = logs.find(l => l.event_type === 'verify_id_image');
    if (idVerificationLog) {
        extraPanelsHtml += `
            <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#065f46;">ID Verification Card</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#8b83a3;">Government or student ID image captured during pre-checks.</p>
                </div>
                <a href="${safeUrl(idVerificationLog.event_message)}" target="_blank" rel="noopener noreferrer" style="background: #10b981; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    👁️ View ID Image
                </a>
            </div>`;
    }
    const signatureLog = logs.find(l => l.event_type === 'verify_signature_image');
    if (signatureLog) {
        extraPanelsHtml += `
            <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#92400e;">Signature Agreement</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#8b83a3;">Digitally signed agreement before exam launch.</p>
                </div>
                <a href="${safeUrl(signatureLog.event_message)}" target="_blank" rel="noopener noreferrer" style="background: #f59e0b; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    👁️ View Signature
                </a>
            </div>`;
    }
    if (session.drive_snapshots_id) {
        extraPanelsHtml += `
            <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#1e40af;">DOM Quiz Screenshots</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#8b83a3;">ZIP folder containing full-page quiz capture screenshots.</p>
                </div>
                <a href="https://drive.google.com/uc?export=download&id=${session.drive_snapshots_id}" target="_blank" style="background: #5b3fa8; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    📥 Download ZIP
                </a>
            </div>`;
    }

    // Metrics stats
    const gazeCount = logs.filter(l => l.event_type.startsWith('AI_GAZE')).length;
    const deviceCount = logs.filter(l => l.event_type.startsWith('AI_DEVICE')).length;
    const voiceCount = logs.filter(l => l.event_type === 'audio_violation').length;
    const focusCount = logs.filter(l => ['tab_blur', 'window_blur', 'fullscreen_exit'].includes(l.event_type)).length;

    const modalContentHtml = `
        <div style="background: #f7f6fb; border-bottom: 1px solid #e2dff0; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 12px 12px 0 0;">
            <div style="display: flex; align-items: center; gap: 15px;">
                <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #5b3fa8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Proctored Exam Report: ${escapeHtml(session.student_name || session.student_canvas_id)}</h2>
                <span style="padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; background: ${riskBadgeBg}; color: ${riskBadgeColor}; border: 1px solid ${riskBadgeBorder}; text-transform: uppercase; letter-spacing: 0.05em;">
                    Risk: ${riskTier} (${riskScore})
                </span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 12px; color: #8b83a3; font-family: monospace;">Exam: ${escapeHtml(exam.title)} | Attempt ${session.attempt_number || 1} | ${new Date(session.started_at).toLocaleString()}</span>
                <button class="modal-close" onclick="closeModal()" style="background: transparent; border: none; color: #8b83a3; font-size: 28px; cursor: pointer; line-height: 1;">&times;</button>
            </div>
        </div>
        <div style="display: flex; flex: 1; overflow: hidden; background: #ffffff;">
            <!-- Left Pane: Media & Downloads -->
            <div style="flex: 1 1 auto; min-width: 0; padding: 24px; background: #f7f6fb; display: flex; flex-direction: column; overflow-y: auto; border-right: 1px solid #e2dff0;">
                ${videoContainerHtml}
                <div id="report-extra-panels">${extraPanelsHtml}</div>
            </div>

            <!-- Right Pane: Timeline & Filters & Annotations -->
            <div style="flex: 0 0 420px; display: flex; flex-direction: column; background: #f7f6fb; overflow: hidden;">
                <!-- Tabbar -->
                <div style="display: flex; background: #ffffff; border-bottom: 1px solid #e2dff0;">
                    <button id="tab-timeline-btn" onclick="switchReportTab('timeline')" style="flex: 1; padding: 12px; border: none; background: transparent; color: #5b3fa8; border-bottom: 2px solid #5b3fa8; font-weight: 700; font-size: 13px; cursor: pointer; outline: none;">Timeline</button>
                    <button id="tab-annotations-btn" onclick="switchReportTab('annotations')" style="flex: 1; padding: 12px; border: none; background: transparent; color: #8b83a3; border-bottom: 2px solid transparent; font-weight: 500; font-size: 13px; cursor: pointer; outline: none;">Annotations (${session.annotations ? session.annotations.length : 0})</button>
                </div>
                
                <!-- Timeline Section Container -->
                <div id="report-timeline-container" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
                    <div style="padding: 16px; border-bottom: 1px solid #e2dff0;">
                        <h4 style="margin: 0 0 10px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #8b83a3;">Proctoring Log Timeline</h4>

                        <!-- Metrics -->
                        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px;">
                            <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #241d38;">${gazeCount}</div>
                                <div style="font-size: 8px; color: #8b83a3; text-transform: uppercase;">Gaze</div>
                            </div>
                            <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #241d38;">${deviceCount}</div>
                                <div style="font-size: 8px; color: #8b83a3; text-transform: uppercase;">Devices</div>
                            </div>
                            <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #241d38;">${voiceCount}</div>
                                <div style="font-size: 8px; color: #8b83a3; text-transform: uppercase;">Speaking</div>
                            </div>
                            <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #241d38;">${focusCount}</div>
                                <div style="font-size: 8px; color: #8b83a3; text-transform: uppercase;">Tab Leaves</div>
                            </div>
                        </div>

                        <!-- Search & Filter -->
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="log-search-input" placeholder="Search events..." style="flex: 1; padding: 8px 12px; background: #ffffff; border: 1px solid #e2dff0; border-radius: 6px; color: #241d38; font-size: 13px; box-sizing: border-box; outline: none;" />
                            <select id="log-severity-select" style="padding: 8px 12px; background: #ffffff; border: 1px solid #e2dff0; border-radius: 6px; color: #241d38; font-size: 13px; cursor: pointer;">
                                <option value="all">All Events</option>
                                <option value="flag">Warnings / Flags</option>
                                <option value="info">Info Logs</option>
                            </select>
                        </div>
                    </div>
                    <div id="modal-timeline-list" style="flex: 1; overflow-y: auto; padding: 12px;">
                        <!-- Rendered dynamically -->
                    </div>
                </div>

                <!-- Annotations Section Container -->
                <div id="report-annotations-container" style="display: none; flex-direction: column; flex: 1; overflow: hidden;">
                    <div style="padding: 16px; border-bottom: 1px solid #e2dff0; display: flex; flex-direction: column; gap: 8px;">
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="new-annotation-note" placeholder="Add note at current playback time..." style="flex: 1; padding: 8px 12px; background: #ffffff; border: 1px solid #e2dff0; border-radius: 6px; color: #241d38; font-size: 13px; outline: none; box-sizing: border-box;" />
                            <button onclick="addAnnotation(${session.id}, ${exam.id})" style="padding: 8px 16px; background: #5b3fa8; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;">Add</button>
                        </div>
                        <div style="font-size: 11px; color: #8b83a3;">Annotations will lock to the exact video playback timestamp.</div>
                    </div>
                    <div id="modal-annotations-list" style="flex: 1; overflow-y: auto; padding: 12px;">
                        <!-- Rendered dynamically -->
                    </div>
                </div>
            </div>
        </div>
        <div style="background: #f7f6fb; border-top: 1px solid #e2dff0; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 0 0 12px 12px;">
            <div style="display:flex; gap: 8px; flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" onclick="exportSessionReport(${session.id}, ${exam.id})" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid #e2dff0;">Export Report</button>
                <button class="btn btn-secondary btn-sm" onclick="grantExtraAttempt(${exam.id}, ${JSON.stringify(String(session.student_canvas_id || '')).replace(/"/g, '&quot;')})" style="background: rgba(100, 116, 139, 0.15); color: #8b83a3; border: 1px solid #e2dff0;">+1 Override Pass</button>
                <button class="btn btn-danger btn-sm" onclick="deleteStudentAttempt(${session.id}, ${exam.id})" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Delete Session</button>
            </div>
            <button class="btn btn-primary btn-sm" onclick="closeModal()" style="background: #5b3fa8; color: white; border: none;">Done</button>
        </div>
    `;
    
    const modalOverlay = document.getElementById('modal-overlay');
    const modalContainer = document.getElementById('modal-content');
    // This is an evidence-review surface, not a dialog — it should use the display it
    // has. 1200px was capping the primary recording to roughly half the pane once the
    // secondary camera appeared, which made screen text in the recording unreadable.
    modalContainer.style.maxWidth = '1800px';
    modalContainer.style.width = '97%';
    modalContainer.style.padding = '0';
    modalContainer.style.background = '#ffffff';
    modalContainer.style.border = '1px solid #e2dff0';
    modalContainer.style.borderRadius = '12px';
    modalContainer.style.display = 'flex';
    modalContainer.style.flexDirection = 'column';
    modalContainer.style.height = '92vh';
    modalContainer.style.overflow = 'hidden';
    modalContainer.innerHTML = modalContentHtml;
    modalOverlay.classList.add('active');

    // Register active session-level timeline controllers
    window.switchReportTab = function(tabName) {
        const timelineBtn = document.getElementById('tab-timeline-btn');
        const annotationsBtn = document.getElementById('tab-annotations-btn');
        const timelineContainer = document.getElementById('report-timeline-container');
        const annotationsContainer = document.getElementById('report-annotations-container');
        
        if (tabName === 'timeline') {
            timelineBtn.style.color = '#5b3fa8';
            timelineBtn.style.borderBottom = '2px solid #5b3fa8';
            timelineBtn.style.fontWeight = '700';
            annotationsBtn.style.color = '#8b83a3';
            annotationsBtn.style.borderBottom = '2px solid transparent';
            annotationsBtn.style.fontWeight = '500';
            timelineContainer.style.display = 'flex';
            annotationsContainer.style.display = 'none';
        } else {
            timelineBtn.style.color = '#8b83a3';
            timelineBtn.style.borderBottom = '2px solid transparent';
            timelineBtn.style.fontWeight = '500';
            annotationsBtn.style.color = '#5b3fa8';
            annotationsBtn.style.borderBottom = '2px solid #5b3fa8';
            annotationsBtn.style.fontWeight = '700';
            timelineContainer.style.display = 'none';
            annotationsContainer.style.display = 'flex';
            renderAnnotations(session.id);
        }
    };

    window.seekVideo = function(seconds) {
        const video = document.getElementById('report-video-player');
        if (video) {
            video.currentTime = seconds;
            video.play().catch(() => {});
        } else {
            showToast("Primary video player not active or loading.", "info");
        }
    };

    window.renderAnnotations = async function(sessionId) {
        const list = document.getElementById('modal-annotations-list');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center; padding:20px; color:#8b83a3;"><div class="spinner"></div></div>';
        
        try {
            const res = await apiFetch(`/api/session/${sessionId}/annotations`);
            const data = await res.json();
            const annotations = data.annotations || [];
            
            // Update counts on tabbar
            const sessionInList = currentSessionsList.find(s => s.id == sessionId);
            if (sessionInList) {
                sessionInList.annotations = annotations;
                const annTabBtn = document.getElementById('tab-annotations-btn');
                if (annTabBtn) annTabBtn.innerText = `Annotations (${annotations.length})`;
            }
            
            if (annotations.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:35px; color:#8b83a3; font-size:13px;">No annotations left on this session yet. Type above to add one.</div>';
                return;
            }
            
            let html = '';
            annotations.forEach(a => {
                const min = Math.floor(a.timestamp_seconds / 60);
                const sec = a.timestamp_seconds % 60;
                const timeStr = min + ':' + sec.toString().padStart(2, '0');
                
                html += `
                    <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid #e2dff0; padding: 12px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
                        <div>
                            <span style="font-family: monospace; font-size:12px; font-weight:700; color:#5b3fa8; cursor:pointer; text-decoration: underline;" onclick="seekVideo(${a.timestamp_seconds})">[${timeStr}]</span>
                            <p style="margin: 4px 0 0 0; color:#241d38; font-size:13px; line-height: 1.4; word-break: break-word;">${escapeHtml(a.note)}</p>
                        </div>
                        <button onclick="deleteAnnotation(${a.id}, ${sessionId})" style="background:transparent; border:none; color:#ef4444; font-size:18px; cursor:pointer; line-height:1;" title="Delete note">&times;</button>
                    </div>
                `;
            });
            list.innerHTML = html;
        } catch (err) {
            list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--danger);">Error loading annotations.</div>';
        }
    };

    window.addAnnotation = async function(sessionId, examId) {
        const noteInput = document.getElementById('new-annotation-note');
        if (!noteInput) return;
        const note = noteInput.value.trim();
        if (!note) {
            showToast("Annotation note cannot be empty", "warning");
            return;
        }
        
        const video = document.getElementById('report-video-player');
        const timestamp_seconds = video ? Math.floor(video.currentTime) : 0;
        
        try {
            const res = await apiFetch(`/api/session/${sessionId}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp_seconds, note })
            });
            if (res.ok) {
                noteInput.value = '';
                showToast("Annotation added successfully.", "success");
                await renderAnnotations(sessionId);
                filterReports(examId);
            } else {
                showToast("Failed to add annotation", "warning");
            }
        } catch (err) {
            console.error(err);
            showToast("Error adding annotation", "warning");
        }
    };

    window.deleteAnnotation = async function(annotationId, sessionId) {
        if (!confirm("Are you sure you want to delete this annotation?")) return;
        try {
            const res = await apiFetch(`/api/session/${sessionId}/annotations/${annotationId}`, { method: 'DELETE' });
            if (res.ok) {
                showToast("Annotation deleted.", "success");
                await renderAnnotations(sessionId);
                if (currentLiveExamId) filterReports(currentLiveExamId);
            } else {
                showToast("Failed to delete annotation", "warning");
            }
        } catch (err) {
            console.error(err);
            showToast("Error deleting annotation", "warning");
        }
    };

    // Render logs timeline
    const renderLogsTimeline = () => {
        const timelineLogs = Array.isArray(session.logs) ? session.logs : [];
        const container = document.getElementById('modal-timeline-list');
        if (!container) return;

        let filteredLogs = timelineLogs;

        if (activeLogFilterSearch) {
            const query = activeLogFilterSearch.toLowerCase();
            filteredLogs = filteredLogs.filter(l => 
                l.event_message.toLowerCase().includes(query) || 
                l.event_type.toLowerCase().includes(query)
            );
        }

        if (activeLogFilterSeverity === 'flag') {
            filteredLogs = filteredLogs.filter(l => 
                ['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'error', 'fail'].includes(l.event_type) || 
                l.event_type.startsWith('AI_')
            );
        } else if (activeLogFilterSeverity === 'info') {
            filteredLogs = filteredLogs.filter(l => 
                !['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'error', 'fail'].includes(l.event_type) && 
                !l.event_type.startsWith('AI_')
            );
        }

        let logsHtml = '';
        filteredLogs.forEach(l => {
            if (l.event_type === 'room_scan_video') return;

            const isAI = l.event_type.startsWith('AI_');
            const isDanger = ['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'mic_muted', 'booted', 'error', 'fail', 'phone_detected', 'multiple_faces'].includes(l.event_type) || isAI;
            const isWarning = ['audio_threshold_exceeded', 'gaze_off_screen'].includes(l.event_type) || l.event_type.includes('transcript') || l.event_type.includes('voice') || l.event_type.includes('speaking') || l.event_type.includes('blur') || l.event_type.includes('focus');

            let borderColor = '#5b3fa8';
            let bgColor = 'rgba(59, 130, 246, 0.05)';
            if (isDanger) { borderColor = '#ef4444'; bgColor = 'rgba(239, 68, 68, 0.05)'; }
            else if (isWarning) { borderColor = '#f59e0b'; bgColor = 'rgba(245, 158, 11, 0.05)'; }

            // Calculate video offset.
            //
            // Anchored to when the recorder started, not when the attempt did. Setup —
            // camera warm-up and quiz load — happens before any footage exists, so
            // measuring from started_at made every flag land late by that lead-in. On a
            // 90-second attempt with a 9-second lead-in, "TAB BLUR at 1:38" seeked to
            // 1:47 of an 86-second video, i.e. past the end. Falls back to started_at
            // for attempts recorded before recording_started_at was captured.
            const videoEpoch = session.recording_started_at || session.started_at;
            const offsetSec = Math.max(0, Math.floor((new Date(l.event_timestamp) - new Date(videoEpoch)) / 1000));
            const min = Math.floor(offsetSec / 60);
            const sec = offsetSec % 60;
            const timeStr = min + ':' + sec.toString().padStart(2, '0');

            logsHtml += `
                <div style="padding: 10px 12px; margin-bottom: 8px; border-radius: 8px; background: ${bgColor}; border-left: 4px solid ${borderColor}; cursor: pointer; transition: transform 0.15s, background 0.15s;"
                     onclick="seekVideo(${offsetSec})"
                     onmouseenter="this.style.transform='translateX(4px)'; this.style.background='#faf8ff';"
                     onmouseleave="this.style.transform='translateX(0)'; this.style.background='${bgColor}';">
                    <div style="font-size: 11px; color: #8b83a3; margin-bottom: 4px;">[${timeStr}] - ${escapeHtml(String(l.event_type || '').replace(/_/g, ' ').toUpperCase())}</div>
                    <div style="font-size: 12px; line-height: 1.4; color: #241d38; word-break: break-word;">${escapeHtml(l.event_message)}</div>
                </div>
            `;
        });

        if (filteredLogs.filter(l => l.event_type !== 'room_scan_video').length === 0) {
            logsHtml = `<div style="text-align:center; padding:20px; color:#8b83a3; font-size:13px;">No matching events found.</div>`;
        }
        container.innerHTML = logsHtml;
    };

    // Initial log timeline draw
    renderLogsTimeline();

    // Move the evidence panels up beside the secondary camera.
    //
    // They are built after the video markup, so they cannot be interpolated into it —
    // relocating them afterwards keeps that ordering intact. When there is no
    // secondary camera the column is full width, and when there is no video at all the
    // target does not exist and the panels simply stay where they are.
    const evidenceCol = document.getElementById('report-evidence-col');
    const extraPanels = document.getElementById('report-extra-panels');
    if (evidenceCol && extraPanels && extraPanels.children.length > 0) {
        while (extraPanels.firstChild) evidenceCol.appendChild(extraPanels.firstChild);
        extraPanels.remove();
    }

    // Paint flag markers on scrubber once video metadata loads
    const reportVideo = document.getElementById('report-video-player');
    if (reportVideo) {
        // Segmented severity strip across the whole recording, matching the extension
        // panel: every block is green for a clean stretch or red for one containing a
        // flag. The previous version drew a few 3px ticks on an otherwise empty bar,
        // which read as broken — especially once the retheme made that bar white, so
        // the clean majority of the recording rendered as blank nothing.
        const paintMarkers = () => {
            const strip = document.getElementById('report-flag-strip');
            const axis = document.getElementById('report-flag-axis');
            if (!strip || !reportVideo.duration || !isFinite(reportVideo.duration)) return;

            const duration = reportVideo.duration;
            // Anchored to recording start, like the timeline markers — measuring from
            // started_at shifted every block by the setup lead-in.
            const epochMs = new Date(session.recording_started_at || session.started_at).getTime();

            const SEGMENTS = 64;
            const buckets = Array.from({ length: SEGMENTS }, () => []);
            logs.filter(l => isFlagEvent(l.event_type)).forEach(l => {
                const offset = (new Date(l.event_timestamp).getTime() - epochMs) / 1000;
                if (offset < 0 || offset > duration) return;
                const idx = Math.min(SEGMENTS - 1, Math.floor((offset / duration) * SEGMENTS));
                buckets[idx].push((l.event_type || '').replace(/_/g, ' '));
            });

            const segSec = duration / SEGMENTS;
            strip.innerHTML = buckets.map((hits, i) => {
                const at = Math.floor(i * segSec);
                const flagged = hits.length > 0;
                const title = flagged
                    ? `${formatClock(at)} — ${hits.join(', ')}`
                    : `${formatClock(at)} — no flags`;
                return `<div title="${escapeHtml(title)}" data-seek="${at}" style="flex:1; background:${flagged ? '#d32130' : '#17845a'};"></div>`;
            }).join('');

            // One delegated handler rather than an inline onclick per block.
            strip.onclick = (e) => {
                const cell = e.target.closest('[data-seek]');
                if (cell) seekVideo(parseInt(cell.dataset.seek, 10));
            };

            if (axis) {
                axis.innerHTML = [0, 0.25, 0.5, 0.75, 1]
                    .map(f => `<span>${formatClock(Math.floor(duration * f))}</span>`)
                    .join('');
            }
        };
        reportVideo.addEventListener('loadedmetadata', paintMarkers);
        if (reportVideo.readyState >= 1) paintMarkers();
    }

    // Bind log filter inputs
    const searchInput = document.getElementById('log-search-input');
    const severitySelect = document.getElementById('log-severity-select');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            activeLogFilterSearch = e.target.value;
            renderLogsTimeline();
        });
    }

    if (severitySelect) {
        severitySelect.addEventListener('change', (e) => {
            activeLogFilterSeverity = e.target.value;
            renderLogsTimeline();
        });
    }
}

function exportExamReportsCsv(examId) {
    const exam = exams.find(e => e.id == examId);
    if (!currentSessionsList || currentSessionsList.length === 0) {
        showToast('No reports to export yet', 'warning');
        return;
    }
    const rows = [
        ['Student', 'Canvas ID', 'Attempt', 'Status', 'Started', 'Flags', 'Trust %', 'Risk Tier', 'Risk Score', 'Annotations']
    ];
    currentSessionsList.forEach(s => {
        const r = computeSessionRisk(s, exam);
        rows.push([
            s.student_name || '',
            s.student_canvas_id || '',
            s.attempt_number || 1,
            s.status || '',
            s.started_at || '',
            r.totalWarnings,
            r.trustScore,
            r.tier,
            r.score,
            (s.annotations && s.annotations.length) || 0
        ]);
    });
    // Neutralise spreadsheet formulas before writing the cell.
    //
    // The quoting below is correct CSV, but Excel and Sheets still evaluate a field
    // beginning with = + - @ or a control character even inside quotes. Student names
    // come from Canvas and are student-editable in many configurations, so a name
    // like =HYPERLINK("http://…"&A1) would execute when an instructor opens the
    // exported report. Prefixing with an apostrophe makes it literal text.
    const csv = rows.map(row => row.map(cell => {
        let str = String(cell);
        if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
        str = str.replace(/"/g, '""');
        return `"${str}"`;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ProctorGuard_${(exam && exam.title) || examId}_reports.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('CSV export downloaded', 'success');
}

function exportSessionReport(sessionId, examId) {
    const exam = exams.find(e => e.id == examId);
    const session = currentSessionsList.find(s => s.id == sessionId);
    if (!session) return;
    const r = computeSessionRisk(session, exam);
    const logs = Array.isArray(session.logs) ? session.logs : [];
    const lines = [
        `ProctorGuard Session Report`,
        `Exam: ${(exam && exam.title) || examId}`,
        `Student: ${session.student_name || session.student_canvas_id}`,
        `Canvas ID: ${session.student_canvas_id || ''}`,
        `Attempt: ${session.attempt_number || 1}`,
        `Status: ${session.status || ''}`,
        `Started: ${session.started_at || ''}`,
        `Risk: ${r.tier} (score ${r.score}) | Trust: ${r.trustScore}% | Flags: ${r.totalWarnings}`,
        ``,
        `--- Event Timeline ---`
    ];
    logs.forEach(l => {
        if (l.event_type === 'room_scan_video') return;
        lines.push(`[${l.event_timestamp || ''}] ${l.event_type}: ${l.event_message || ''}`);
    });
    if (session.annotations && session.annotations.length) {
        lines.push(``, `--- Annotations ---`);
        session.annotations.forEach(a => {
            lines.push(`[${a.timestamp_seconds}s] ${a.note}`);
        });
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ProctorGuard_session_${sessionId}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Session report exported', 'success');
}

function showAccommodationsPanel(examId) {
    const exam = exams.find(e => e.id == examId);
    if (!exam) return;
    const modalContainer = document.getElementById('modal-content');
    modalContainer.style.maxWidth = '520px';
    modalContainer.style.width = '92%';
    modalContainer.style.padding = '';
    modalContainer.style.background = '';
    modalContainer.style.border = '';
    modalContainer.style.height = '';
    modalContainer.style.display = '';
    modalContainer.style.flexDirection = '';
    modalContainer.style.overflow = '';
    modalContainer.innerHTML = `
        <div class="modal-header">
            <h2 class="modal-title">Accommodations — ${escapeHtml(exam.title)}</h2>
            <button class="modal-close" onclick="closeModal()">&times;</button>
        </div>
        <p style="color:var(--text-secondary); font-size:13px; line-height:1.5; margin-bottom:16px;">
            Grant extra attempts for individual students (e.g. technical failure or accessibility needs).
            Enter the student's Canvas user ID as shown in Canvas gradebook / people.
        </p>
        <div class="form-group">
            <label class="form-label">Student Canvas ID</label>
            <input type="text" id="accommodation-student-id" class="form-input" placeholder="e.g. 12345" />
        </div>
        <div class="form-group">
            <label class="form-label">Notes (optional, for your records)</label>
            <textarea id="accommodation-notes" class="form-input" style="min-height:70px;" placeholder="e.g. Approved extra attempt — network outage"></textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px solid var(--border); padding-top:14px;">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="submitAccommodation(${examId})">Grant +1 Attempt</button>
        </div>
    `;
    document.getElementById('modal-overlay').classList.add('active');
}

async function submitAccommodation(examId) {
    const studentId = (document.getElementById('accommodation-student-id') || {}).value;
    if (!studentId || !studentId.trim()) {
        showToast('Enter a Canvas student ID', 'warning');
        return;
    }
    try {
        await apiFetch('/api/exams/' + examId + '/overrides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                student_canvas_id: studentId.trim(),
                notes: (document.getElementById('accommodation-notes') || {}).value || ''
            })
        });
        closeModal();
        showToast('Extra attempt granted for student ' + studentId.trim(), 'success');
    } catch (err) {
        console.error(err);
        showToast('Error granting accommodation', 'warning');
    }
}

async function deleteStudentAttempt(sessionId, examId) {
    if (!confirm("Are you sure you want to permanently delete this student attempt and all associated security logs? This cannot be undone.")) return;
    try {
        const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        if (res.ok) {
            closeModal();
            showToast("Student attempt deleted successfully.", "success");
            fetchReportData(examId);
        } else {
            showToast("Failed to delete attempt", "warning");
        }
    } catch (err) {
        console.error(err);
        showToast("Error deleting attempt", "warning");
    }
}

function showCreateExamModal(examId = null) {
    const exam = examId ? exams.find(e => e.id == examId) : null;
    const defaultCode = exam ? exam.exam_code : Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Set wider modal size for spacious card layout
    const modalContainer = document.getElementById('modal-content');
    modalContainer.style.maxWidth = '900px';
    modalContainer.style.width = '95%';

    // Settings values
    const verifyVideo = exam ? exam.verify_video : false;
    const verifyAudio = exam ? exam.verify_audio : false;
    const verifyDesktop = exam ? exam.verify_desktop : false;
    const verifyId = exam ? exam.verify_id : false;
    const verifySignature = exam ? exam.verify_signature : false;
    const allowCalculator = exam ? exam.allow_calculator : false;
    const allowWhiteboard = exam ? exam.allow_whiteboard : false;
    const behaviorPreset = exam ? exam.behavior_preset : 'Recommended';
    
    const weightNavigatingAway = exam && exam.weight_navigating_away !== undefined ? exam.weight_navigating_away : 3;
    const weightKeystrokes = exam && exam.weight_keystrokes !== undefined ? exam.weight_keystrokes : 1;
    const weightCopyPaste = exam && exam.weight_copy_paste !== undefined ? exam.weight_copy_paste : 4;
    const weightBrowserResize = exam && exam.weight_browser_resize !== undefined ? exam.weight_browser_resize : 2;
    const weightHeadMovement = exam && exam.weight_head_movement !== undefined ? exam.weight_head_movement : 2;
    const weightMultiFace = exam && exam.weight_multi_face !== undefined ? exam.weight_multi_face : 3;
    const weightLeavingRoom = exam && exam.weight_leaving_room !== undefined ? exam.weight_leaving_room : 3;

    const html = `
        <div class="modal-header">
            <h2 class="modal-title" style="font-family: var(--font-sans); font-size:20px; font-weight:700;">${exam ? 'Edit Exam Settings' : 'Enable Proctoring'}</h2>
            <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div style="max-height: 70vh; overflow-y: auto; padding-right: 8px;">
            <div class="form-group">
                <label class="form-label">Exam Title</label>
                <input type="text" id="exam-title" class="form-input" placeholder="e.g. Midterm Physics" value="${exam ? escapeHtml(exam.title) : ''}">
            </div>
            <div class="form-group" style="display: flex; gap: 10px;">
                <div style="flex:1;">
                    <label class="form-label">Access Code</label>
                    <input type="text" id="exam-code" class="form-input" value="${defaultCode}">
                </div>
                <div style="flex:1;">
                    <label class="form-label">Max Attempts</label>
                    <input type="number" id="max-attempts" class="form-input" value="${exam ? exam.max_attempts : 1}" min="1">
                </div>
                <div style="flex:1;">
                    <label class="form-label">Boot Limit (Tab Leaves)</label>
                    <input type="number" id="max-violations" class="form-input" value="${exam ? exam.max_violations : 0}" min="0">
                    <div style="font-size:9px; color:var(--text-muted); margin-top:2px;">0 = Unlimited (no boot)</div>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">LMS Quiz URL</label>
                <input type="text" id="exam-url" class="form-input" placeholder="https://canvas.instructure.com/courses/1/quizzes/1" value="${exam ? escapeHtml(exam.canvas_quiz_url) : ''}">
            </div>
            <div class="form-group">
                <label class="form-label">Canvas Quiz Password / Access Code (Optional)</label>
                <input type="text" id="quiz-password" class="form-input" placeholder="e.g. SECURE-WWI-QUIZ" value="${exam && exam.canvas_quiz_password ? exam.canvas_quiz_password : ''}">
                <div class="form-hint">If your Canvas quiz requires a password/access code to start, enter it here.</div>
            </div>

            <!-- Quick exam presets -->
            <div class="form-group" style="background:#f8fafc; border:1px solid var(--border); border-radius:8px; padding:14px;">
                <label class="form-label" style="margin-bottom:8px;">Quick preset (optional)</label>
                <p style="font-size:11px; color:var(--text-muted); margin:0 0 10px 0;">Applies a recommended set of recording, lockdown, and behavior options. You can still customize below.</p>
                <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:8px;">
                    <button type="button" class="btn btn-secondary btn-sm" onclick="applyExamPreset('standard')">Standard</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="applyExamPreset('strict')">Strict</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="applyExamPreset('open')">Open book</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="applyExamPreset('seb')">SEB only</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="applyExamPreset('companion')">Companion</button>
                </div>
            </div>
            
            <!-- Accordion Section 1: Exam Settings -->
            <div class="proctorio-section" id="section-exam-settings">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-exam-settings')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Exam Settings</div>
                            <div class="proctorio-section-subtitle">Recording, lockdown, and pre-exam verification. Prefer leaving these fixed once students begin.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <!-- Recording Options -->
                    <h4 style="margin: 0 0 6px 0; font-family: var(--font-sans); font-size:13px; font-weight:700; color:var(--text-primary);">What to record during the exam</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Streams captured while the student is in the quiz.</p>
                    <div class="proctorio-grid">
                        <div class="proctorio-card ${!exam || exam.require_camera ? 'selected' : ''}" id="card-camera" onclick="toggleProctorioOption('chk-camera', 'card-camera')" title="Record student webcam">
                            <div class="proctorio-icon"><img src="icons/record-video.svg" alt="" /></div>
                            <div class="proctorio-title">Record Webcam</div>
                            <input type="checkbox" id="chk-camera" ${!exam || exam.require_camera ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${!exam || exam.require_mic ? 'selected' : ''}" id="card-mic" onclick="toggleProctorioOption('chk-mic', 'card-mic')" title="Record student microphone">
                            <div class="proctorio-icon"><img src="icons/record-audio.svg" alt="" /></div>
                            <div class="proctorio-title">Record Audio</div>
                            <input type="checkbox" id="chk-mic" ${!exam || exam.require_mic ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${!exam || exam.require_screen ? 'selected' : ''}" id="card-screen" onclick="toggleProctorioOption('chk-screen', 'card-screen')" title="Record full desktop screen">
                            <div class="proctorio-icon"><img src="icons/record-screen.svg" alt="" /></div>
                            <div class="proctorio-title">Record Screen</div>
                            <input type="checkbox" id="chk-screen" ${!exam || exam.require_screen ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.record_web_traffic ? 'selected' : ''}" id="card-ext-traffic" onclick="toggleProctorioOption('chk-ext-traffic', 'card-ext-traffic')" title="Record all visited URLs">
                            <div class="proctorio-icon"><img src="icons/record-web-traffic.svg" alt="" /></div>
                            <div class="proctorio-title">Record Web Traffic</div>
                            <input type="checkbox" id="chk-ext-traffic" ${exam && exam.record_web_traffic ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.require_room_scan ? 'selected' : ''}" id="card-room-scan" onclick="toggleProctorioOption('chk-room-scan', 'card-room-scan')" title="Require environment check video before starting">
                            <div class="proctorio-icon"><img src="icons/room-scan.svg" alt="" /></div>
                            <div class="proctorio-title">Room / Desk Scan</div>
                            <input type="checkbox" id="chk-room-scan" ${exam && exam.require_room_scan ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.require_mobile_camera ? 'selected' : ''}" id="card-mobile" onclick="toggleProctorioOption('chk-mobile', 'card-mobile')" title="Require secondary phone camera during exam">
                            <div class="proctorio-icon"><img src="icons/secondary-mobile-camera.svg" alt="" /></div>
                            <div class="proctorio-title">Mobile Camera</div>
                            <input type="checkbox" id="chk-mobile" ${exam && exam.require_mobile_camera ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>

                    <!-- Lock Down Options -->
                    <h4 style="margin: 20px 0 6px 0; font-family: var(--font-sans); font-size:13px; font-weight:700; color:var(--text-primary);">Lock Down Options</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Enforce strict browser behavior guidelines during the assessment.</p>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(5, 1fr);">
                        <div class="proctorio-card ${!exam || exam.require_fullscreen ? 'selected' : ''}" id="card-fs" onclick="toggleProctorioOption('chk-fs', 'card-fs')" title="Prevent window resizing">
                            <div class="proctorio-icon"><img src="icons/force-fullscreen.svg" alt="" /></div>
                            <div class="proctorio-title">Force Full Screen</div>
                            <input type="checkbox" id="chk-fs" ${!exam || exam.require_fullscreen ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.only_one_screen ? 'selected' : ''}" id="card-one-screen" onclick="toggleProctorioOption('chk-one-screen', 'card-one-screen')" title="Block secondary/dual displays">
                            <div class="proctorio-icon"><img src="icons/only-one-screen.svg" alt="" /></div>
                            <div class="proctorio-title">Only One Screen</div>
                            <input type="checkbox" id="chk-one-screen" ${exam && exam.only_one_screen ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.disable_new_tabs ? 'selected' : ''}" id="card-ext-newtabs" onclick="toggleProctorioOption('chk-ext-newtabs', 'card-ext-newtabs')" title="Prevent opening new tabs">
                            <div class="proctorio-icon"><img src="icons/disable-new-tabs.svg" alt="" /></div>
                            <div class="proctorio-title">Disable New Tabs</div>
                            <input type="checkbox" id="chk-ext-newtabs" ${exam && exam.disable_new_tabs ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.close_open_tabs ? 'selected' : ''}" id="card-ext-closetabs" onclick="toggleProctorioOption('chk-ext-closetabs', 'card-ext-closetabs')" title="Force close all other open tabs">
                            <div class="proctorio-icon"><img src="icons/close-open-tabs.svg" alt="" /></div>
                            <div class="proctorio-title">Close Open Tabs</div>
                            <input type="checkbox" id="chk-ext-closetabs" ${exam && exam.close_open_tabs ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.disable_printing ? 'selected' : ''}" id="card-printing" onclick="toggleProctorioOption('chk-printing', 'card-printing')" title="Block and hide printing">
                            <div class="proctorio-icon"><img src="icons/disable-printing.svg" alt="" /></div>
                            <div class="proctorio-title">Disable Printing</div>
                            <input type="checkbox" id="chk-printing" ${exam && exam.disable_printing ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.disable_clipboard ? 'selected' : ''}" id="card-clipboard" onclick="toggleProctorioOption('chk-clipboard', 'card-clipboard')" title="Block copy, cut, and paste">
                            <div class="proctorio-icon"><img src="icons/disable-clipboard.svg" alt="" /></div>
                            <div class="proctorio-title">Disable Clipboard</div>
                            <input type="checkbox" id="chk-clipboard" ${exam && exam.disable_clipboard ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.block_downloads ? 'selected' : ''}" id="card-downloads" onclick="toggleProctorioOption('chk-downloads', 'card-downloads')" title="Block file downloading">
                            <div class="proctorio-icon"><img src="icons/block-downloads.svg" alt="" /></div>
                            <div class="proctorio-title">Block Downloads</div>
                            <input type="checkbox" id="chk-downloads" ${exam && exam.block_downloads ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.clear_cache ? 'selected' : ''}" id="card-ext-cache" onclick="toggleProctorioOption('chk-ext-cache', 'card-ext-cache')" title="Clear browser cache upon completion">
                            <div class="proctorio-icon"><img src="icons/clear-cache.svg" alt="" /></div>
                            <div class="proctorio-title">Clear Cache</div>
                            <input type="checkbox" id="chk-ext-cache" ${exam && exam.clear_cache ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${!exam || exam.disable_right_click ? 'selected' : ''}" id="card-rc" onclick="toggleProctorioOption('chk-rc', 'card-rc')" title="Block right click / context menu">
                            <div class="proctorio-icon"><img src="icons/block-navigation.svg" alt="" /></div>
                            <div class="proctorio-title">Disable Right Click</div>
                            <input type="checkbox" id="chk-rc" ${!exam || exam.disable_right_click ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.prevent_reentry ? 'selected' : ''}" id="card-reentry" onclick="toggleProctorioOption('chk-reentry', 'card-reentry')" title="Block re-entry after exit">
                            <div class="proctorio-icon"><img src="icons/prevent-reentry.svg" alt="" /></div>
                            <div class="proctorio-title">Prevent Re-entry</div>
                            <input type="checkbox" id="chk-reentry" ${exam && exam.prevent_reentry ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.allow_mobile_devices ? 'selected' : ''}" id="card-allow-mobile" onclick="toggleProctorioOption('chk-allow-mobile', 'card-allow-mobile')" title="Allow iPad/iPhone/Android browsers; skips extension lockdown on those devices">
                            <div class="proctorio-icon"><img src="icons/secondary-mobile-camera.svg" alt="" /></div>
                            <div class="proctorio-title">Allow Mobile Devices</div>
                            <input type="checkbox" id="chk-allow-mobile" ${exam && exam.allow_mobile_devices ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>

                    <!-- Verification Options -->
                    <h4 style="margin: 20px 0 6px 0; font-family: var(--font-sans); font-size:13px; font-weight:700; color:var(--text-primary);">Pre-exam checks (before recording starts)</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Hardware and identity steps students complete in the setup wizard.</p>
                    <div class="proctorio-grid">
                        <div class="proctorio-card ${verifyVideo ? 'selected' : ''}" id="card-verify-video" onclick="toggleProctorioOption('chk-verify-video', 'card-verify-video')" title="Check camera feed before start">
                            <div class="proctorio-icon"><img src="icons/record-video.svg" alt="" /></div>
                            <div class="proctorio-title">Check Webcam</div>
                            <input type="checkbox" id="chk-verify-video" ${verifyVideo ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifyAudio ? 'selected' : ''}" id="card-verify-audio" onclick="toggleProctorioOption('chk-verify-audio', 'card-verify-audio')" title="Check microphone level before start">
                            <div class="proctorio-icon"><img src="icons/record-audio.svg" alt="" /></div>
                            <div class="proctorio-title">Check Mic</div>
                            <input type="checkbox" id="chk-verify-audio" ${verifyAudio ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifyDesktop ? 'selected' : ''}" id="card-verify-desktop" onclick="toggleProctorioOption('chk-verify-desktop', 'card-verify-desktop')" title="Check screen share before start">
                            <div class="proctorio-icon"><img src="icons/record-screen.svg" alt="" /></div>
                            <div class="proctorio-title">Check Screen Share</div>
                            <input type="checkbox" id="chk-verify-desktop" ${verifyDesktop ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifyId ? 'selected' : ''}" id="card-verify-id" onclick="toggleProctorioOption('chk-verify-id', 'card-verify-id')" title="Capture photo ID before start">
                            <div class="proctorio-icon"><img src="icons/secondary-mobile-camera.svg" alt="" /></div>
                            <div class="proctorio-title">Photo ID</div>
                            <input type="checkbox" id="chk-verify-id" ${verifyId ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifySignature ? 'selected' : ''}" id="card-verify-signature" onclick="toggleProctorioOption('chk-verify-signature', 'card-verify-signature')" title="Digital integrity signature before start">
                            <div class="proctorio-icon"><img src="icons/block-navigation.svg" alt="" /></div>
                            <div class="proctorio-title">Signature</div>
                            <input type="checkbox" id="chk-verify-signature" ${verifySignature ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>

                    <!-- In-Quiz Tools -->
                    <h4 style="margin: 20px 0 6px 0; font-family: var(--font-sans); font-size:13px; font-weight:700; color:var(--text-primary);">In-Quiz Tools</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Allowed digital tools for students within the secure frame.</p>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(6, 1fr);">
                        <div class="proctorio-card ${allowCalculator ? 'selected' : ''}" id="card-allow-calculator" onclick="toggleProctorioOption('chk-allow-calculator', 'card-allow-calculator')" title="Provide scientific calculator tool">
                            <div class="proctorio-icon">📊</div>
                            <div class="proctorio-title">Calculator</div>
                            <input type="checkbox" id="chk-allow-calculator" ${allowCalculator ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${allowWhiteboard ? 'selected' : ''}" id="card-allow-whiteboard" onclick="toggleProctorioOption('chk-allow-whiteboard', 'card-allow-whiteboard')" title="Provide digital whiteboard notepad">
                            <div class="proctorio-icon">📝</div>
                            <div class="proctorio-title">Whiteboard</div>
                            <input type="checkbox" id="chk-allow-whiteboard" ${allowWhiteboard ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>
                </div>
            </div>

            <!-- Accordion Section 2: Behavior Settings -->
            <div class="proctorio-section collapsed" id="section-behavior-settings">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-behavior-settings')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Behavior & Risk Weights</div>
                            <div class="proctorio-section-subtitle">How heavily each flag type counts toward trust score and risk tier.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <input type="hidden" id="behavior-preset" value="${behaviorPreset}" />
                    
                    <!-- Presets Grid -->
                    <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 24px;">
                        <div class="proctorio-card ${behaviorPreset === 'Recommended' ? 'selected' : ''} preset-card" id="preset-recommended" onclick="selectBehaviorPreset('Recommended')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Recommended</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Lenient' ? 'selected' : ''} preset-card" id="preset-lenient" onclick="selectBehaviorPreset('Lenient')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Lenient</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Moderate' ? 'selected' : ''} preset-card" id="preset-moderate" onclick="selectBehaviorPreset('Moderate')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Moderate</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Group Exam' ? 'selected' : ''} preset-card" id="preset-group-exam" onclick="selectBehaviorPreset('Group Exam')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Group Exam</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Open Note' ? 'selected' : ''} preset-card" id="preset-open-note" onclick="selectBehaviorPreset('Open Note')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Open Note</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Custom' ? 'selected' : ''} preset-card" id="preset-custom" onclick="selectBehaviorPreset('Custom')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Custom</div>
                        </div>
                    </div>

                    <h4 style="margin: 0 0 12px 0; font-family: var(--font-sans); font-size:13px; font-weight:700; color:var(--text-primary);">Flag sensitivity (1 = light, 5 = heavy)</h4>
                    
                    <!-- Sliders / Segments list -->
                    <div id="metrics-sliders-container">
                        <!-- Navigating Away -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">🌐</span>
                                <span class="metric-label-title">Navigating Away</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-navigating-away" value="${weightNavigatingAway}" />
                                <div class="metric-segment" id="seg-navigating-away-1" onclick="updateMetricSlider('navigating-away', 1)"></div>
                                <div class="metric-segment" id="seg-navigating-away-2" onclick="updateMetricSlider('navigating-away', 2)"></div>
                                <div class="metric-segment" id="seg-navigating-away-3" onclick="updateMetricSlider('navigating-away', 3)"></div>
                                <div class="metric-segment" id="seg-navigating-away-4" onclick="updateMetricSlider('navigating-away', 4)"></div>
                                <div class="metric-segment" id="seg-navigating-away-5" onclick="updateMetricSlider('navigating-away', 5)"></div>
                            </div>
                        </div>

                        <!-- Keystrokes -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">⌨️</span>
                                <span class="metric-label-title">Keystrokes</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-keystrokes" value="${weightKeystrokes}" />
                                <div class="metric-segment" id="seg-keystrokes-1" onclick="updateMetricSlider('keystrokes', 1)"></div>
                                <div class="metric-segment" id="seg-keystrokes-2" onclick="updateMetricSlider('keystrokes', 2)"></div>
                                <div class="metric-segment" id="seg-keystrokes-3" onclick="updateMetricSlider('keystrokes', 3)"></div>
                                <div class="metric-segment" id="seg-keystrokes-4" onclick="updateMetricSlider('keystrokes', 4)"></div>
                                <div class="metric-segment" id="seg-keystrokes-5" onclick="updateMetricSlider('keystrokes', 5)"></div>
                            </div>
                        </div>

                        <!-- Copy & Paste -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">📋</span>
                                <span class="metric-label-title">Copy & Paste</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-copy-paste" value="${weightCopyPaste}" />
                                <div class="metric-segment" id="seg-copy-paste-1" onclick="updateMetricSlider('copy-paste', 1)"></div>
                                <div class="metric-segment" id="seg-copy-paste-2" onclick="updateMetricSlider('copy-paste', 2)"></div>
                                <div class="metric-segment" id="seg-copy-paste-3" onclick="updateMetricSlider('copy-paste', 3)"></div>
                                <div class="metric-segment" id="seg-copy-paste-4" onclick="updateMetricSlider('copy-paste', 4)"></div>
                                <div class="metric-segment" id="seg-copy-paste-5" onclick="updateMetricSlider('copy-paste', 5)"></div>
                            </div>
                        </div>

                        <!-- Browser Resize -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">🖥️</span>
                                <span class="metric-label-title">Browser Resize</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-browser-resize" value="${weightBrowserResize}" />
                                <div class="metric-segment" id="seg-browser-resize-1" onclick="updateMetricSlider('browser-resize', 1)"></div>
                                <div class="metric-segment" id="seg-browser-resize-2" onclick="updateMetricSlider('browser-resize', 2)"></div>
                                <div class="metric-segment" id="seg-browser-resize-3" onclick="updateMetricSlider('browser-resize', 3)"></div>
                                <div class="metric-segment" id="seg-browser-resize-4" onclick="updateMetricSlider('browser-resize', 4)"></div>
                                <div class="metric-segment" id="seg-browser-resize-5" onclick="updateMetricSlider('browser-resize', 5)"></div>
                            </div>
                        </div>

                        <!-- Head Movement -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">👤</span>
                                <span class="metric-label-title">Head Movement</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-head-movement" value="${weightHeadMovement}" />
                                <div class="metric-segment" id="seg-head-movement-1" onclick="updateMetricSlider('head-movement', 1)"></div>
                                <div class="metric-segment" id="seg-head-movement-2" onclick="updateMetricSlider('head-movement', 2)"></div>
                                <div class="metric-segment" id="seg-head-movement-3" onclick="updateMetricSlider('head-movement', 3)"></div>
                                <div class="metric-segment" id="seg-head-movement-4" onclick="updateMetricSlider('head-movement', 4)"></div>
                                <div class="metric-segment" id="seg-head-movement-5" onclick="updateMetricSlider('head-movement', 5)"></div>
                            </div>
                        </div>

                        <!-- Multi-Face -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">👥</span>
                                <span class="metric-label-title">Multi-Face</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-multi-face" value="${weightMultiFace}" />
                                <div class="metric-segment" id="seg-multi-face-1" onclick="updateMetricSlider('multi-face', 1)"></div>
                                <div class="metric-segment" id="seg-multi-face-2" onclick="updateMetricSlider('multi-face', 2)"></div>
                                <div class="metric-segment" id="seg-multi-face-3" onclick="updateMetricSlider('multi-face', 3)"></div>
                                <div class="metric-segment" id="seg-multi-face-4" onclick="updateMetricSlider('multi-face', 4)"></div>
                                <div class="metric-segment" id="seg-multi-face-5" onclick="updateMetricSlider('multi-face', 5)"></div>
                            </div>
                        </div>

                        <!-- Leaving the Room -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">🚪</span>
                                <span class="metric-label-title">Leaving the Room</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-leaving-room" value="${weightLeavingRoom}" />
                                <div class="metric-segment" id="seg-leaving-room-1" onclick="updateMetricSlider('leaving-room', 1)"></div>
                                <div class="metric-segment" id="seg-leaving-room-2" onclick="updateMetricSlider('leaving-room', 2)"></div>
                                <div class="metric-segment" id="seg-leaving-room-3" onclick="updateMetricSlider('leaving-room', 3)"></div>
                                <div class="metric-segment" id="seg-leaving-room-4" onclick="updateMetricSlider('leaving-room', 4)"></div>
                                <div class="metric-segment" id="seg-leaving-room-5" onclick="updateMetricSlider('leaving-room', 5)"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Accordion Section 3: Advanced Integrations & Custom Instructions -->
            <div class="proctorio-section collapsed" id="section-advanced">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-advanced')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Lockdown Environment & Instructions</div>
                            <div class="proctorio-section-subtitle">SEB, Chrome extension, companion app, and student instructions. Prefer one primary lockdown path.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <p style="font-size:12px; color:var(--text-secondary); background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; padding:10px 12px; margin:0 0 16px 0;">
                        Tip: SEB, the Chrome extension, and the desktop companion overlap. Enable the one that matches your policy (or extension + companion for max lockdown). Requiring all three increases support load.
                    </p>
                    <!-- Safe Exam Browser -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <h4 style="font-family: var(--font-sans); font-size:14px; font-weight:700; color:var(--text-primary); margin:0; display:flex; align-items:center; gap:6px;"><img src="icons/block-navigation.svg" style="width: 16px; height: 16px;" /> Require Safe Exam Browser (SEB)</h4>
                                <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 0 0;">Forces students to launch and complete the quiz inside SEB</p>
                            </div>
                            <div>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                                    <input type="checkbox" id="chk-seb" ${exam && exam.require_seb ? 'checked' : ''} onchange="toggleSebSection()" style="opacity: 0; width: 0; height: 0;" />
                                    <span class="switch-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${exam && exam.require_seb ? '#2563eb' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                                </label>
                            </div>
                        </div>
                        
                        <div id="seb-options-container" style="display: ${exam && exam.require_seb ? 'block' : 'none'}; margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 12px;">
                            <p style="font-size:12px; color:var(--text-muted); margin:0;">SEB enforces its own lockdown. Use Lock Down Options above for download/clipboard rules that apply outside SEB.</p>
                        </div>
                    </div>

                    <!-- Chrome Extension Toggle -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <h4 style="font-family: var(--font-sans); font-size:14px; font-weight:700; color:var(--text-primary); margin:0; display:flex; align-items:center; gap:6px;"><img src="icons/disable-extensions.svg" style="width: 16px; height: 16px;" /> Require Secure Chrome Extension</h4>
                                <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 0 0;">Enables advanced browser lockdown and web traffic analysis</p>
                            </div>
                            <div>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                                    <input type="checkbox" id="chk-extension" ${!exam || exam.require_extension ? 'checked' : ''} onchange="toggleExtensionSection()" style="opacity: 0; width: 0; height: 0;" />
                                    <span class="switch-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${!exam || exam.require_extension ? '#2563eb' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                                </label>
                            </div>
                        </div>
                        <div id="extension-options-container" style="display: ${!exam || exam.require_extension ? 'block' : 'none'}; margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 12px;">
                            <div class="proctorio-grid">
                                <div class="proctorio-card ${exam && exam.disable_extensions ? 'selected' : ''}" id="card-ext-extensions" onclick="toggleProctorioOption('chk-ext-extensions', 'card-ext-extensions')" title="Disable all other Chrome extensions">
                                    <div class="proctorio-icon"><img src="icons/disable-extensions.svg" alt="" /></div>
                                    <div class="proctorio-title">Disable Extensions</div>
                                    <input type="checkbox" id="chk-ext-extensions" ${exam && exam.disable_extensions ? 'checked' : ''} style="display:none;" />
                                </div>
                                <div class="proctorio-card ${exam && exam.prevent_incognito ? 'selected' : ''}" id="card-ext-incognito" onclick="toggleProctorioOption('chk-ext-incognito', 'card-ext-incognito')" title="Block exam access in Incognito mode">
                                    <div class="proctorio-icon"><img src="icons/prevent-incognito.svg" alt="" /></div>
                                    <div class="proctorio-title">Prevent Incognito</div>
                                    <input type="checkbox" id="chk-ext-incognito" ${exam && exam.prevent_incognito ? 'checked' : ''} style="display:none;" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Desktop Companion App -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <h4 style="font-family: var(--font-sans); font-size:14px; font-weight:700; color:var(--text-primary); margin:0; display:flex; align-items:center; gap:6px;"><img src="icons/record-screen.svg" style="width: 16px; height: 16px;" /> Require Secure Desktop Companion App</h4>
                                <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 0 0;">Lock down background applications, secondary screens, and check VM setups</p>
                            </div>
                            <div>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                                    <input type="checkbox" id="chk-companion" ${exam && exam.require_companion_app ? 'checked' : ''} onchange="toggleCompanionSection()" style="opacity: 0; width: 0; height: 0;" />
                                    <span class="switch-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${exam && exam.require_companion_app ? '#2563eb' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                                </label>
                            </div>
                        </div>
                        
                        <div id="companion-options-container" style="display: ${exam && exam.require_companion_app ? 'block' : 'none'}; margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 12px;">
                            <div style="display: flex; gap: 16px; margin-bottom: 12px;">
                                <div style="flex: 1;">
                                    <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-primary); display:block; margin-bottom:4px;">Allowed Apps (Comma separated)</label>
                                    <input type="text" id="allowed-apps" class="form-input" style="width:100%;" placeholder="e.g. calc, winword" value="${exam && exam.allowed_apps ? exam.allowed_apps : ''}" />
                                </div>
                                <div style="flex: 1;">
                                    <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-primary); display:block; margin-bottom:4px;">Blocked Apps (Comma separated)</label>
                                    <input type="text" id="blocked-apps" class="form-input" style="width:100%;" placeholder="e.g. discord, zoom" value="${exam && exam.blocked_apps ? exam.blocked_apps : ''}" />
                                </div>
                            </div>
                            <div class="form-group" style="margin-top: 12px;">
                                <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-primary); display:block; margin-bottom:4px;">Allowed Websites (inside Companion App)</label>
                                <textarea id="allowed-urls" class="form-input" style="height: 80px; font-family: monospace; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; background: var(--bg-primary); color: var(--text-primary); resize: vertical;" placeholder="https://www.google.com&#10;https://wikipedia.org">${exam && exam.allowed_urls ? exam.allowed_urls : ''}</textarea>
                                <div class="form-hint" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">List full URLs or domains allowed inside the companion app browser (one per line).</div>
                            </div>
                        </div>
                    </div>

                    <!-- Custom Instructions -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <h4 style="font-family: var(--font-sans); font-size:14px; font-weight:700; color:var(--text-primary); margin:0;">📝 Custom Instructions (Optional)</h4>
                        <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 10px 0;">Add custom instructions for students to read before starting the quiz.</p>
                        <textarea id="additional-instructions" class="form-input" style="height: 80px; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; background: var(--bg-primary); color: var(--text-primary); resize: vertical;" placeholder="e.g. You are allowed to use one blank sheet of scratch paper.">${exam && exam.additional_instructions ? exam.additional_instructions : ''}</textarea>
                    </div>
                </div>
            </div>
        </div>

        <div style="margin-top: 32px; text-align: right; border-top: 1px solid var(--border); padding-top: 15px;">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="saveExam(${examId})">${exam ? 'Save Changes' : 'Enable Proctoring'}</button>
        </div>
    `;

    // Toggle logic functions exposed to window
    window.toggleProctorioSection = function(sectionId) {
        const el = document.getElementById(sectionId);
        if (el) {
            el.classList.toggle('collapsed');
        }
    };

    window.selectBehaviorPreset = function(presetName) {
        document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
        const selectedCard = document.getElementById('preset-' + presetName.toLowerCase().replace(/\s+/g, '-'));
        if (selectedCard) {
            selectedCard.classList.add('selected');
        }
        
        document.getElementById('behavior-preset').value = presetName;
        
        const presets = {
            'Recommended': { away: 3, key: 1, copy: 4, resize: 2, head: 2, face: 3, room: 3 },
            'Lenient': { away: 1, key: 0, copy: 1, resize: 0, head: 0, face: 1, room: 1 },
            'Moderate': { away: 2, key: 1, copy: 2, resize: 1, head: 1, face: 2, room: 2 },
            'Group Exam': { away: 1, key: 1, copy: 2, resize: 1, head: 0, face: 0, room: 0 },
            'Open Note': { away: 0, key: 0, copy: 0, resize: 0, head: 0, face: 0, room: 0 },
            'Custom': null
        };
        
        const w = presets[presetName];
        if (w) {
            updateMetricSlider('navigating-away', w.away, false);
            updateMetricSlider('keystrokes', w.key, false);
            updateMetricSlider('copy-paste', w.copy, false);
            updateMetricSlider('browser-resize', w.resize, false);
            updateMetricSlider('head-movement', w.head, false);
            updateMetricSlider('multi-face', w.face, false);
            updateMetricSlider('leaving-room', w.room, false);
        }
    };

    window.updateMetricSlider = function(metricId, val, triggerCustom = true) {
        // If they click on a segment, automatically set to Custom preset if it isn't already Custom
        const presetInput = document.getElementById('behavior-preset');
        if (triggerCustom && presetInput && presetInput.value !== 'Custom') {
            document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
            const customCard = document.getElementById('preset-custom');
            if (customCard) customCard.classList.add('selected');
            presetInput.value = 'Custom';
        }

        const input = document.getElementById('weight-' + metricId);
        if (input) {
            input.value = val;
        }
        
        for (let i = 1; i <= 5; i++) {
            const seg = document.getElementById('seg-' + metricId + '-' + i);
            if (!seg) continue;
            
            seg.className = 'metric-segment';
            if (i <= val) {
                if (val <= 2) {
                    seg.classList.add('active-green');
                } else if (val === 3) {
                    seg.classList.add('active-orange');
                } else {
                    seg.classList.add('active-red');
                }
            }
        }
    };

    window.toggleExtensionSection = function() {
        const chk = document.getElementById('chk-extension');
        const slider = chk.nextElementSibling;
        const container = document.getElementById('extension-options-container');
        if (chk && container) {
            container.style.display = chk.checked ? 'block' : 'none';
            slider.style.backgroundColor = chk.checked ? '#2563eb' : '#cbd5e1';
        }
    };

    window.toggleSebSection = function() {
        const chk = document.getElementById('chk-seb');
        const slider = chk.nextElementSibling;
        const container = document.getElementById('seb-options-container');
        if (chk && container) {
            container.style.display = chk.checked ? 'block' : 'none';
            slider.style.backgroundColor = chk.checked ? '#2563eb' : '#cbd5e1';
        }
    };

    window.toggleCompanionSection = function() {
        const chk = document.getElementById('chk-companion');
        const slider = chk.nextElementSibling;
        const container = document.getElementById('companion-options-container');
        if (chk && container) {
            container.style.display = chk.checked ? 'block' : 'none';
            slider.style.backgroundColor = chk.checked ? '#2563eb' : '#cbd5e1';
        }
    };

    document.getElementById('modal-content').innerHTML = html;
    applyOptionCardIcons(document.getElementById('modal-content'));

    // Initialize metric segments visually
    setTimeout(() => {
        updateMetricSlider('navigating-away', weightNavigatingAway, false);
        updateMetricSlider('keystrokes', weightKeystrokes, false);
        updateMetricSlider('copy-paste', weightCopyPaste, false);
        updateMetricSlider('browser-resize', weightBrowserResize, false);
        updateMetricSlider('head-movement', weightHeadMovement, false);
        updateMetricSlider('multi-face', weightMultiFace, false);
        updateMetricSlider('leaving-room', weightLeavingRoom, false);
    }, 50);

    document.getElementById('modal-overlay').classList.add('active');
}
 
function toggleProctorioOption(checkboxId, cardId) {
    const chk = document.getElementById(checkboxId);
    const card = document.getElementById(cardId);
    if (chk && card) {
        chk.checked = !chk.checked;
        if (chk.checked) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    }
}

function setOptionChecked(checkboxId, cardId, checked) {
    const chk = document.getElementById(checkboxId);
    const card = document.getElementById(cardId);
    if (chk) chk.checked = !!checked;
    if (card) {
        if (checked) card.classList.add('selected');
        else card.classList.remove('selected');
    }
}

/** Apply a full exam configuration preset (recording + lockdown + behavior + environment). */
function applyExamPreset(name) {
    const presets = {
        standard: {
            camera: true, mic: true, screen: true, traffic: false, room: false, mobile: false,
            fs: true, oneScreen: true, newTabs: true, closeTabs: true, printing: true, clipboard: true,
            downloads: true, cache: false, rc: true, reentry: false,
            verifyVideo: true, verifyAudio: true, verifyDesktop: true, verifyId: false, verifySig: false,
            seb: false, extension: true, companion: false,
            behavior: 'Recommended'
        },
        strict: {
            camera: true, mic: true, screen: true, traffic: true, room: true, mobile: true,
            fs: true, oneScreen: true, newTabs: true, closeTabs: true, printing: true, clipboard: true,
            downloads: true, cache: true, rc: true, reentry: true,
            verifyVideo: true, verifyAudio: true, verifyDesktop: true, verifyId: true, verifySig: true,
            seb: false, extension: true, companion: true,
            behavior: 'Moderate'
        },
        open: {
            camera: true, mic: false, screen: false, traffic: false, room: false, mobile: false,
            fs: false, oneScreen: false, newTabs: false, closeTabs: false, printing: false, clipboard: false,
            downloads: false, cache: false, rc: false, reentry: false,
            verifyVideo: true, verifyAudio: false, verifyDesktop: false, verifyId: false, verifySig: false,
            seb: false, extension: true, companion: false,
            behavior: 'Open Note'
        },
        seb: {
            camera: true, mic: true, screen: false, traffic: false, room: false, mobile: false,
            fs: true, oneScreen: true, newTabs: true, closeTabs: true, printing: true, clipboard: true,
            downloads: true, cache: false, rc: true, reentry: false,
            verifyVideo: true, verifyAudio: true, verifyDesktop: false, verifyId: false, verifySig: false,
            seb: true, extension: false, companion: false,
            behavior: 'Recommended'
        },
        companion: {
            camera: true, mic: true, screen: true, traffic: false, room: false, mobile: false,
            fs: true, oneScreen: true, newTabs: true, closeTabs: true, printing: true, clipboard: true,
            downloads: true, cache: false, rc: true, reentry: false,
            verifyVideo: true, verifyAudio: true, verifyDesktop: true, verifyId: false, verifySig: false,
            seb: false, extension: true, companion: true,
            behavior: 'Recommended'
        }
    };
    const p = presets[name];
    if (!p) return;

    setOptionChecked('chk-camera', 'card-camera', p.camera);
    setOptionChecked('chk-mic', 'card-mic', p.mic);
    setOptionChecked('chk-screen', 'card-screen', p.screen);
    setOptionChecked('chk-ext-traffic', 'card-ext-traffic', p.traffic);
    setOptionChecked('chk-room-scan', 'card-room-scan', p.room);
    setOptionChecked('chk-mobile', 'card-mobile', p.mobile);
    setOptionChecked('chk-fs', 'card-fs', p.fs);
    setOptionChecked('chk-one-screen', 'card-one-screen', p.oneScreen);
    setOptionChecked('chk-ext-newtabs', 'card-ext-newtabs', p.newTabs);
    setOptionChecked('chk-ext-closetabs', 'card-ext-closetabs', p.closeTabs);
    setOptionChecked('chk-printing', 'card-printing', p.printing);
    setOptionChecked('chk-clipboard', 'card-clipboard', p.clipboard);
    setOptionChecked('chk-downloads', 'card-downloads', p.downloads);
    setOptionChecked('chk-ext-cache', 'card-ext-cache', p.cache);
    setOptionChecked('chk-rc', 'card-rc', p.rc);
    setOptionChecked('chk-reentry', 'card-reentry', p.reentry);
    setOptionChecked('chk-verify-video', 'card-verify-video', p.verifyVideo);
    setOptionChecked('chk-verify-audio', 'card-verify-audio', p.verifyAudio);
    setOptionChecked('chk-verify-desktop', 'card-verify-desktop', p.verifyDesktop);
    setOptionChecked('chk-verify-id', 'card-verify-id', p.verifyId);
    setOptionChecked('chk-verify-signature', 'card-verify-signature', p.verifySig);

    const setSwitch = (id, on) => {
        const chk = document.getElementById(id);
        if (!chk) return;
        chk.checked = on;
        const slider = chk.nextElementSibling;
        if (slider) slider.style.backgroundColor = on ? '#2563eb' : '#cbd5e1';
    };
    setSwitch('chk-seb', p.seb);
    setSwitch('chk-extension', p.extension);
    setSwitch('chk-companion', p.companion);
    if (typeof window.toggleSebSection === 'function') window.toggleSebSection();
    if (typeof window.toggleExtensionSection === 'function') window.toggleExtensionSection();
    if (typeof window.toggleCompanionSection === 'function') window.toggleCompanionSection();

    if (typeof window.selectBehaviorPreset === 'function') {
        window.selectBehaviorPreset(p.behavior);
    }
    showToast(`Applied “${name}” preset — review and save when ready`, 'success');
}
async function saveExam(examId = null) {
    const payload = {
        title: document.getElementById('exam-title').value,
        canvas_quiz_url: document.getElementById('exam-url').value,
        exam_code: document.getElementById('exam-code').value,
        max_attempts: parseInt(document.getElementById('max-attempts').value) || 1,
        max_violations: parseInt(document.getElementById('max-violations').value) || 0,
        canvas_quiz_password: document.getElementById('quiz-password').value.trim(),
        require_camera: document.getElementById('chk-camera').checked,
        require_mic: document.getElementById('chk-mic').checked,
        require_screen: document.getElementById('chk-screen').checked,
        disable_right_click: document.getElementById('chk-rc').checked,
        require_fullscreen: document.getElementById('chk-fs').checked,
        require_seb: document.getElementById('chk-seb').checked,
        disable_clipboard: document.getElementById('chk-clipboard').checked,
        disable_printing: document.getElementById('chk-printing').checked,
        only_one_screen: document.getElementById('chk-one-screen').checked,
        block_downloads: document.getElementById('chk-downloads').checked,
        prevent_reentry: document.getElementById('chk-reentry').checked,
        require_room_scan: document.getElementById('chk-room-scan').checked,
        require_mobile_camera: document.getElementById('chk-mobile') ? document.getElementById('chk-mobile').checked : false,
        allow_mobile_devices: document.getElementById('chk-allow-mobile') ? document.getElementById('chk-allow-mobile').checked : false,
        require_extension: document.getElementById('chk-extension').checked,
        record_web_traffic: document.getElementById('chk-ext-traffic') ? document.getElementById('chk-ext-traffic').checked : false,
        disable_new_tabs: document.getElementById('chk-ext-newtabs') ? document.getElementById('chk-ext-newtabs').checked : false,
        close_open_tabs: document.getElementById('chk-ext-closetabs') ? document.getElementById('chk-ext-closetabs').checked : false,
        disable_extensions: document.getElementById('chk-ext-extensions') ? document.getElementById('chk-ext-extensions').checked : false,
        prevent_incognito: document.getElementById('chk-ext-incognito') ? document.getElementById('chk-ext-incognito').checked : false,
        clear_cache: document.getElementById('chk-ext-cache') ? document.getElementById('chk-ext-cache').checked : false,
        require_companion_app: document.getElementById('chk-companion').checked,
        allowed_apps: document.getElementById('allowed-apps') ? document.getElementById('allowed-apps').value.trim() : null,
        blocked_apps: document.getElementById('blocked-apps') ? document.getElementById('blocked-apps').value.trim() : null,
        allowed_urls: document.getElementById('allowed-urls') ? document.getElementById('allowed-urls').value.trim() : '',
        additional_instructions: document.getElementById('additional-instructions') ? document.getElementById('additional-instructions').value.trim() : '',
        
        verify_video: document.getElementById('chk-verify-video') ? document.getElementById('chk-verify-video').checked : false,
        verify_audio: document.getElementById('chk-verify-audio') ? document.getElementById('chk-verify-audio').checked : false,
        verify_desktop: document.getElementById('chk-verify-desktop') ? document.getElementById('chk-verify-desktop').checked : false,
        verify_id: document.getElementById('chk-verify-id') ? document.getElementById('chk-verify-id').checked : false,
        verify_signature: document.getElementById('chk-verify-signature') ? document.getElementById('chk-verify-signature').checked : false,
        allow_calculator: document.getElementById('chk-allow-calculator') ? document.getElementById('chk-allow-calculator').checked : false,
        allow_whiteboard: document.getElementById('chk-allow-whiteboard') ? document.getElementById('chk-allow-whiteboard').checked : false,
        behavior_preset: document.getElementById('behavior-preset') ? document.getElementById('behavior-preset').value : 'Recommended',
        weight_navigating_away: parseInt(document.getElementById('weight-navigating-away') ? document.getElementById('weight-navigating-away').value : 3),
        weight_keystrokes: parseInt(document.getElementById('weight-keystrokes') ? document.getElementById('weight-keystrokes').value : 1),
        weight_copy_paste: parseInt(document.getElementById('weight-copy-paste') ? document.getElementById('weight-copy-paste').value : 4),
        weight_browser_resize: parseInt(document.getElementById('weight-browser-resize') ? document.getElementById('weight-browser-resize').value : 2),
        weight_head_movement: parseInt(document.getElementById('weight-head-movement') ? document.getElementById('weight-head-movement').value : 2),
        weight_multi_face: parseInt(document.getElementById('weight-multi-face') ? document.getElementById('weight-multi-face').value : 3),
        weight_leaving_room: parseInt(document.getElementById('weight-leaving-room') ? document.getElementById('weight-leaving-room').value : 3)
    };

    if(!payload.title || !payload.canvas_quiz_url) return alert('Fill all fields');

    try {
        const url = examId ? `/api/exams/${examId}` : '/api/exams';
        const method = examId ? 'PATCH' : 'POST';
        
        const res = await apiFetch(url, {
            method: method, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if(res.ok) {
            const saved = await res.json().catch(() => ({}));
            closeModal();
            loadExams();

            // Saving writes to two places: this database and the Canvas quiz
            // itself (which is where "required to view results" is cleared). If
            // the Canvas half failed, saying "Settings updated!" is a lie that
            // sends the teacher away believing the quiz is configured.
            if (saved && saved.canvas_sync_ok === false) {
                showToast(
                    `Saved here, but Canvas was not updated: ${saved.canvas_sync_error || 'unknown error'}. Check the quiz settings in Canvas.`,
                    'error'
                );
            } else {
                showToast(examId ? 'Settings updated!' : 'Exam configured securely!', 'success');
            }

            // If we are in the dashboard, we might want to stay there
            if (currentLiveExamId && examId == currentLiveExamId) {
                // The exams array is reloaded by loadExams, but we need to re-render the current view
                setTimeout(() => loadExamDashboard(currentLiveExamId), 500); 
            }
        }
    } catch(err) {
        console.error(err);
    }
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
    // Reset inline styles that may have been set by the immersive report view
    const mc = document.getElementById('modal-content');
    if (mc) {
        mc.style.padding = '';
        mc.style.background = '';
        mc.style.border = '';
        mc.style.borderRadius = '';
        mc.style.display = '';
        mc.style.flexDirection = '';
        mc.style.height = '';
        mc.style.overflow = '';
        mc.style.maxWidth = '';
        mc.style.width = '';
    }
}

async function toggleExamStatus(id) {
    const exam = exams.find(e => e.id == id);
    if (!exam) return;
    
    const newStatus = !exam.is_open;
    try {
        const res = await apiFetch(`/api/exams/${id}/status`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_open: newStatus })
        });
        
        if (res.ok) {
            const updatedExam = await res.json();
            // Update local state
            exam.is_open = updatedExam.is_open;
            
            // If we are currently in the dashboard for this exam, re-render it
            if (currentLiveExamId == id) {
                loadExamDashboard(id);
            } else {
                renderExams();
            }
            
            showToast(`Exam is now ${updatedExam.is_open ? 'OPEN' : 'CLOSED'}`, 'success');
        }
    } catch (err) {
        console.error(err);
        showToast('Failed to toggle status', 'warning');
    }
}

async function deleteExam(id) {
    if(confirm('WARNING: Are you sure you want to completely delete this exam and all student video recordings? This is permanent.')) {
        try {
            await apiFetch('/api/exams/' + id, {method: 'DELETE'});
            loadExams();
            showToast('Exam completely deleted.', 'success');
        } catch(e) {
            console.error(e);
        }
    }
}

async function grantExtraAttempt(examId, studentCanvasId) {
    if(!confirm("Are you sure you want to grant this specific student an additional attempt?")) return;
    try {
        await apiFetch('/api/exams/' + examId + '/overrides', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_canvas_id: studentCanvasId })
        });
        showToast('Attempt Override Granted Successfully!', 'success');
    } catch(err) {
        console.error(err);
        showToast('Error granting attempt', 'warning');
    }
}

function showToast(msg, type='info') {
    const el = document.createElement('div');
    el.style.background = type === 'success' ? 'var(--success)' : (type === 'warning' ? 'var(--warning)' : 'var(--text-primary)');
    el.style.color = 'white';
    el.style.padding = '12px 20px';
    el.style.borderRadius = 'var(--radius)';
    el.style.boxShadow = 'var(--shadow)';
    el.style.fontSize = '14px';
    el.innerText = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

async function linkPlacement(examId) {
    if (!activeResourceLinkId) return;
    try {
        const res = await apiFetch('/api/placements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource_link_id: activeResourceLinkId, exam_id: examId })
        });
        if (res.ok) {
            showToast('Successfully linked Canvas placement to this exam!', 'success');
            const mapping = await res.json();
            currentPlacementMapping = mapping;
            
            if (contentItemReturnUrl) {
                const exam = exams.find(e => e.id == examId);
                const examTitle = exam ? exam.title : 'ProctorGuard Assignment';
                const launchUrl = window.location.origin + '/lti/launch';
                window.location.href = `/api/placements/lti-return?content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}&exam_title=${encodeURIComponent(examTitle)}&launch_url=${encodeURIComponent(launchUrl)}`;
            } else if (launchReturnUrl) {
                const exam = exams.find(e => e.id == examId);
                const examTitle = exam ? exam.title : 'ProctorGuard Assignment';
                const launchUrl = window.location.origin + '/lti/launch';
                const returnRedirectUrl = `${launchReturnUrl}?return_type=lti_launch_url&url=${encodeURIComponent(launchUrl)}&title=${encodeURIComponent(examTitle)}&text=${encodeURIComponent(examTitle)}`;
                
                // Redirect top/parent frame to finalize and close selection modal
                if (window.parent && window.parent !== window) {
                    window.parent.location.href = returnRedirectUrl;
                } else {
                    window.location.href = returnRedirectUrl;
                }
            } else {
                loadExams();
            }
        } else {
            showToast('Failed to save link mapping', 'warning');
        }
    } catch (err) {
        console.error(err);
        showToast('Connection error', 'warning');
    }
}

function embedExamSelection(examId) {
    if (!contentItemReturnUrl) return;
    const exam = exams.find(e => e.id == examId);
    const examTitle = exam ? exam.title : 'ProctorGuard Assignment';
    // Embed the exam_id in the launch URL returned to Canvas
    const launchUrl = `${window.location.origin}/lti/launch?exam_id=${examId}`;
    let targetUrl = `/api/placements/lti-return?content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}&exam_title=${encodeURIComponent(examTitle)}&launch_url=${encodeURIComponent(launchUrl)}`;
    if (ltiData) {
        targetUrl += `&lti_data=${encodeURIComponent(ltiData)}`;
    }
    window.location.href = targetUrl;
}

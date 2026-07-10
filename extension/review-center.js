// ================================================================
// review-center.js — NEVER statically declared in manifest.json's
// content_scripts. It is injected programmatically by background.js,
// only after content.js's teacher-context probe reports this tab looks
// like a teacher/TA/admin viewing a quiz/gradebook page. This is where
// all review-center/quiz-settings networking lives — keeping it out of
// static injection means a student's own exam page never receives this
// file's source at all.
//
// AUTH: there is no static secret anywhere in this file. Every API call
// attaches a short-lived JWT (chrome.storage.local: pgExtToken) that the
// ProctorGuard dashboard mints from a real, LTI-verified instructor
// session and hands to the extension via externally_connectable (see
// background.js's onMessageExternal listener). If no valid token is
// stored, callers must prompt the teacher to open the dashboard rather
// than silently failing or falling back to anything static.
// ================================================================
(function () {
// Idempotency guard: background.js may attempt injection more than once
// (e.g. repeated navigation events) — make re-injection into the same
// tab/frame a harmless no-op instead of re-registering everything.
if (window.__pgReviewCenterLoaded) return;
window.__pgReviewCenterLoaded = true;

const PG_API_BASE = 'https://proctor.siotw.net';

const PG_DEBUG = false;
if (!PG_DEBUG) {
  console.log = function () {};
}

// Reads the current extension auth token from storage. Returns null if missing or
// expired — callers must treat that as "prompt the teacher to reconnect", not retry
// with anything else.
function getExtensionToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['pgExtToken', 'pgExtTokenExpiresAt'], (r) => {
      if (!r.pgExtToken || !r.pgExtTokenExpiresAt || Date.now() >= r.pgExtTokenExpiresAt) {
        resolve(null);
      } else {
        resolve(r.pgExtToken);
      }
    });
  });
}

// Thrown/returned by callers when getExtensionToken() comes back null, so the UI can
// show a clear "reconnect" prompt instead of a generic failure.
const PG_NO_TOKEN = Symbol('PG_NO_TOKEN');

// Proxy fetch through background service worker to avoid cross-origin issues in content scripts
function bgFetch(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'FETCH_URL', url }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response ? (response.error || `HTTP ${response.status}`) : 'No response from background'));
        return;
      }
      try {
        resolve(JSON.parse(response.body));
      } catch(e) {
        reject(new Error('Invalid JSON from server'));
      }
    });
  });
}

// Shared helper for every session-report call site below. Throws a clearly-flagged
// error (err.pgNoToken) when there's no valid extension token, so callers can render
// a "reconnect ProctorGuard" prompt instead of a generic fetch-failure message.
async function fetchSessionReport(quizId) {
  const token = await getExtensionToken();
  if (!token) {
    const err = new Error('ProctorGuard needs to reconnect — open your dashboard at proctor.siotw.net, then try again.');
    err.pgNoToken = true;
    throw err;
  }
  return bgFetch(`${PG_API_BASE}/api/canvas-native/session-report?quiz_id=${quizId}&token=${encodeURIComponent(token)}`);
}
// --- Exam Review Center Integration ---
async function initExamReviewCenterIntegration() {
  const url = window.location.href;

  if (!isCanvasTeacherContext()) {
    console.log('[ProctorGuard RC] Student context detected, skipping Review Center integration.');
    return;
  }

  // Must contain /quizzes/<id> but NOT be on take/history/edit/moderation subpages
  if (!url.includes('/quizzes/')) {
    console.log('[ProctorGuard RC] Not a quiz page, skipping.');
    return;
  }
  if (/\/quizzes\/\d+\/(take|history|edit|moderate|statistics|submissions)/.test(url)) {
    console.log('[ProctorGuard RC] Quiz subpage detected, skipping.');
    return;
  }
  
  const idMatch = url.match(/\/quizzes\/(\d+)/);
  if (!idMatch) return;
  const quizId = idMatch[1];

  console.log(`[ProctorGuard RC] Quiz page detected, quizId=${quizId}. Setting up Review Center hijack.`);

  let sessions = null; // null = still loading
  let loadError = null;

  // Start fetching in background immediately (via service worker to avoid CORS)
  fetchSessionReport(quizId)
    .then(data => {
      sessions = data.sessions || [];
      console.log(`[ProctorGuard RC] Fetched ${sessions.length} sessions.`);
      const modal = document.getElementById('proctor-review-center-modal');
      if (modal) updateReviewCenterModalBody(modal, sessions, null);
    })
    .catch(err => {
      console.error('[ProctorGuard RC] Failed to fetch sessions:', err);
      sessions = [];
      loadError = 'Could not fetch exam reports: ' + err.message;
      const modal = document.getElementById('proctor-review-center-modal');
      if (modal) updateReviewCenterModalBody(modal, sessions, loadError);
    });

  let hijacked = false;

  const tryHijack = () => {
    if (hijacked) return;

    const links = Array.from(document.querySelectorAll('a'));
    const nativeLink = links.find(a => a.textContent.trim().includes('Proctor Review Center'));

    if (!nativeLink) {
      // Fallback: inject our own button into the sidebar
      const rightSide = document.getElementById('right-side');
      if (rightSide && !document.getElementById('proctorguard-review-center-card')) {
        injectSidebarFallbackLink(rightSide);
      }
      return;
    }

    hijacked = true;
    console.log('[ProctorGuard RC] Found native link, hijacking:', nativeLink.href);

    // Nuke the href so browser won't navigate
    nativeLink.href = 'javascript:void(0)';
    nativeLink.removeAttribute('target');
    nativeLink.style.cursor = 'pointer';

    // Use capture-phase listener on the parent to intercept BEFORE Canvas's own handlers
    nativeLink.parentNode.addEventListener('click', (e) => {
      if (e.target === nativeLink || nativeLink.contains(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.log('[ProctorGuard RC] Intercepted click, opening modal.');
        openExamReviewCenterModal(sessions, loadError);
      }
    }, true);

    // Also attach directly to the link as a belt-and-suspenders
    nativeLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      openExamReviewCenterModal(sessions, loadError);
    }, true);

    console.log('[ProctorGuard RC] Hijack complete.');
  };

  // Poll + observe for the link
  const obs = new MutationObserver(tryHijack);
  obs.observe(document.body, { childList: true, subtree: true });

  let attempts = 0;
  const retryInterval = setInterval(() => {
    attempts++;
    tryHijack();
    if (hijacked || attempts >= 30) {
      clearInterval(retryInterval);
      obs.disconnect();
      if (!hijacked) console.warn('[ProctorGuard RC] Could not find native link after 15s. Fallback injected if sidebar found.');
    }
  }, 500);

  tryHijack();
}

function injectSidebarFallbackLink(rightSide) {
  const container = rightSide.querySelector('.right-side-list') || rightSide;
  
  const li = document.createElement('div');
  li.id = 'proctorguard-review-center-card';
  li.style.margin = '10px 0';
  li.innerHTML = `
    <a href="#" class="btn button" style="display: flex; align-items: center; gap: 6px; font-weight: bold; color: #10b981; cursor: pointer;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 7l-7 5 7 5V7z"></path>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
      </svg>
      ProctorGuard Review Center (Embedded)
    </a>
  `;
  
  container.appendChild(li);
  li.querySelector('a').addEventListener('click', (e) => {
    e.preventDefault();
    const url = window.location.href;
    const idMatch = url.match(/\/quizzes\/(\d+)/);
    if (!idMatch) return;
    const quizId = idMatch[1];
    
    openExamReviewCenterModal(null, null);
    
    fetchSessionReport(quizId)
      .then(d => {
        const modal = document.getElementById('proctor-review-center-modal');
        if (modal) updateReviewCenterModalBody(modal, d.sessions || [], null);
      })
      .catch(err => {
        const modal = document.getElementById('proctor-review-center-modal');
        if (modal) updateReviewCenterModalBody(modal, [], 'Failed to load reports: ' + err.message);
      });
  });
}

// ============================================================
// REVIEW CENTER MODAL — Proctorio-style table layout
// ============================================================
function openExamReviewCenterModal(sessions, loadError) {
  const existing = document.getElementById('proctor-review-center-modal');
  if (existing) existing.remove();

  if (!document.getElementById('proctor-review-center-styles')) {
    const style = document.createElement('style');
    style.id = 'proctor-review-center-styles';
    style.innerHTML = `
      #proctor-review-center-modal *,
      #proctor-report-modal * { box-sizing: border-box; }

      /* ---- Overlay ---- */
      #proctor-review-center-modal {
        position: fixed; inset: 0; z-index: 999990;
        background: rgba(10,14,26,0.98);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        color: #1a1a2e;
      }

      /* ---- Shell ---- */
      .prc-shell {
        background: #fff;
        border-radius: 8px;
        width: 96%; max-width: 1100px;
        height: 86vh;
        display: flex; flex-direction: column;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        animation: prcFadeIn .2s ease;
      }
      @keyframes prcFadeIn { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }

      /* ---- Top nav ---- */
      .prc-nav {
        display: flex; align-items: center;
        background: #fff;
        border-bottom: 1px solid #e2e8f0;
        padding: 0 20px;
        height: 44px;
        gap: 4px;
        flex-shrink: 0;
      }
      .prc-nav-tab {
        display: flex; align-items: center; gap: 6px;
        padding: 0 14px; height: 44px;
        font-size: 13px; font-weight: 500; color: #4a5568;
        cursor: pointer; border: none; background: transparent;
        border-bottom: 3px solid transparent;
        transition: color .15s, border-color .15s;
      }
      .prc-nav-tab.active { color: #2563eb; border-bottom-color: #2563eb; font-weight: 600; }
      .prc-nav-tab svg { opacity: .7; }
      .prc-nav-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
      .prc-close-btn {
        background: none; border: none; cursor: pointer;
        color: #718096; font-size: 20px; line-height: 1;
        padding: 4px 6px; border-radius: 4px;
        transition: background .15s;
      }
      .prc-close-btn:hover { background: #f0f0f0; }

      /* ---- Section header ---- */
      .prc-section-header {
        padding: 14px 20px;
        border-bottom: 1px solid #e2e8f0;
        flex-shrink: 0;
      }
      .prc-section-header h2 {
        margin: 0 0 2px 0; font-size: 17px; font-weight: 700; color: #1a1a2e;
      }
      .prc-section-header p { margin: 0; font-size: 12px; color: #718096; }

      /* ---- Table area ---- */
      .prc-table-area {
        flex: 1; overflow-y: auto; padding: 0;
      }

      /* Section sub-header inside table area */
      .prc-sub-section {
        padding: 16px 20px 6px;
      }
      .prc-sub-section h3 {
        margin: 0 0 2px 0; font-size: 14px; font-weight: 700; color: #1a1a2e;
      }
      .prc-sub-section p { margin: 0; font-size: 12px; color: #718096; }
      .prc-sub-row-right { float: right; display:flex; align-items: center; gap: 8px; font-size: 12px; color: #718096; }

      /* ---- Data table ---- */
      .prc-data-table {
        width: 100%; border-collapse: collapse;
        font-size: 13px;
      }
      .prc-data-table thead tr {
        background: #f7fafc;
        border-top: 1px solid #e2e8f0;
        border-bottom: 1px solid #e2e8f0;
      }
      .prc-data-table thead th {
        padding: 10px 16px;
        color: #718096; font-weight: 600; font-size: 12px;
        text-align: left; white-space: nowrap;
      }
      .prc-data-table thead th.icon-col { text-align: center; width: 40px; }
      .prc-data-table tbody tr {
        border-bottom: 1px solid #edf2f7;
        transition: background .1s;
        cursor: default;
      }
      .prc-data-table tbody tr:nth-child(even) { background: #fafbfc; }
      .prc-data-table tbody tr:hover { background: #f7fafc; }
      .prc-data-table td {
        padding: 12px 16px;
        vertical-align: middle; color: #2d3748;
      }
      .prc-data-table td.icon-col { text-align: center; }
      .prc-data-table td a { color: #2563eb; font-weight: 500; text-decoration: none; }
      .prc-data-table td a:hover { text-decoration: underline; }

      /* Coloured stat numbers */
      .prc-stat { font-size: 13px; font-weight: 600; }
      .prc-stat.blue   { color: #3182ce; }
      .prc-stat.green  { color: #38a169; }
      .prc-stat.gray   { color: #718096; }
      .prc-stat.red    { color: #e53e3e; }

      /* Suspicious bar */
      .prc-susp-wrap { display:flex; align-items: center; gap: 6px; }
      .prc-susp-bar-outer {
        width: 60px; height: 10px;
        background: #e2e8f0; border-radius: 999px; overflow: hidden;
      }
      .prc-susp-bar-inner {
        height: 100%; border-radius: 999px;
        transition: width .3s;
      }
      .prc-susp-bar-inner.low    { background: #38a169; }
      .prc-susp-bar-inner.medium { background: #d69e2e; }
      .prc-susp-bar-inner.high   { background: #e53e3e; }

      /* Icon row badges */
      .prc-icon-row {
        display: flex; align-items: center; gap: 4px;
      }
      .prc-icon-badge {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border-radius: 4px;
        border: 1px solid #e2e8f0; color: #718096;
        cursor: default; position: relative;
      }
      .prc-icon-badge:hover { border-color: #2563eb; color: #2563eb; background: #eff4ff; }

      /* Action eye button */
      .prc-eye-btn {
        display: inline-flex; align-items: center; justify-content: center;
        background: none; border: none; cursor: pointer;
        color: #718096; padding: 4px; border-radius: 4px;
        transition: color .15s;
      }
      .prc-eye-btn:hover { color: #2563eb; }

      /* Review detail button */
      .prc-review-btn {
        background: none; border: 1px solid #cbd5e0;
        color: #4a5568; font-size: 12px; font-weight: 600;
        padding: 5px 12px; border-radius: 4px; cursor: pointer;
        transition: all .15s;
      }
      .prc-review-btn:hover { background: #2563eb; color: #fff; border-color: #2563eb; }

      /* Empty states */
      .prc-empty-state {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; padding: 48px; gap: 10px;
        color: #a0aec0;
      }
      .prc-empty-state svg { opacity: .4; }
      .prc-empty-state p { margin: 0; font-size: 14px; }
      .prc-empty-state small { color: #d69e2e; font-size: 12px; }

      /* Inline Detail layout adjustments — detail view takes over the whole shell */
      .prc-shell {
        transition: height 0.2s ease, max-width 0.2s ease;
      }
      .prc-shell.prc-detail-open {
        height: 96vh;
        max-width: 1400px;
      }
      .prc-shell.prc-detail-open .prc-section-header,
      .prc-shell.prc-detail-open .prc-table-area {
        display: none;
      }
      .prc-back-btn {
        display: flex; align-items: center; gap: 6px;
        background: none; border: none; cursor: pointer;
        color: #4a5568; font-size: 13px; font-weight: 600;
        padding: 6px 10px; border-radius: 6px;
        transition: background .15s, color .15s;
      }
      .prc-back-btn:hover { background: #f0f4fa; color: #2563eb; }
    `;
    document.head.appendChild(style);
  }

  const modal = document.createElement('div');
  modal.id = 'proctor-review-center-modal';
  modal.innerHTML = `
    <div class="prc-shell">
      <div class="prc-nav">
        <button class="prc-nav-tab active">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect></svg>
          ProctorGuard Review Center
        </button>
        <div class="prc-nav-right">
          <button class="prc-close-btn" id="prc-modal-close">&times;</button>
        </div>
      </div>
      <div class="prc-section-header">
        <div class="prc-sub-row-right" id="prc-row-count"></div>
        <h2>Completed Attempts</h2>
        <p>Proctored exam sessions for this quiz</p>
      </div>
      <div class="prc-table-area">
        <table class="prc-data-table">
          <thead>
            <tr>
              <th class="icon-col"><input type="checkbox" class="prc-row-check-all" /></th>
              <th class="icon-col"></th>
              <th>Student</th>
              <th>Submitted</th>
              <th>Recordings</th>
              <th>Alerts</th>
              <th>Risk</th>
              <th style="width:80px"></th>
            </tr>
          </thead>
          <tbody id="prc-tbody">
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  document.getElementById('prc-modal-close').addEventListener('click', () => modal.remove());
  updateReviewCenterModalBody(modal, sessions, loadError);
}

function _prcAlertCount(logs) {
  const alertTypes = ['tab_blur','window_blur','fullscreen_exit','Tab Blocked','audio_violation','clipboard_attempt','copy_attempt','paste_attempt','right_click','print_attempt','keyboard_shortcut_blocked'];
  return (logs || []).filter(l => alertTypes.includes(l.event_type)).length;
}
function _prcAnnotationCount(logs) {
  return (logs || []).filter(l => l.event_type === 'annotation').length;
}
function _prcAbnormalCount(logs) {
  const types = ['phone_detected','multiple_faces','no_face','AI_PEOPLE','gaze_off_screen','audio_threshold_exceeded','mobile_camera_lost'];
  return (logs || []).filter(l => types.includes(l.event_type)).length;
}
function _prcIconRowHtml(session) {
  const hasVideo = !!session.drive_file_id;
  const hasMobile = !!session.mobile_drive_file_id;
  const hasRoomScan = !!session.room_scan_drive_file_id;
  let icons = '';
  if (hasVideo) icons += `<span class="prc-icon-badge" title="Screen/Webcam Recording"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg></span>`;
  if (hasMobile) icons += `<span class="prc-icon-badge" title="Mobile Room Camera"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg></span>`;
  if (hasRoomScan) icons += `<span class="prc-icon-badge" title="Room Scan"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path></svg></span>`;
  return icons || '<span style="color:#cbd5e0;font-size:12px;">—</span>';
}

function updateReviewCenterModalBody(modalEl, sessions, loadError) {
  const tbody = modalEl.querySelector('#prc-tbody');
  const rowCount = modalEl.querySelector('#prc-row-count');
  if (!tbody) return;

  if (loadError) {
    const isReconnect = /reconnect/i.test(loadError);
    const hint = isReconnect
      ? `<a href="https://proctor.siotw.net" target="_blank" rel="noopener">Open proctor.siotw.net</a> to reconnect, then reopen this Review Center.`
      : 'Check ProctorGuard server connection';
    tbody.innerHTML = `<tr><td colspan="8"><div class="prc-empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p>${loadError}</p><small>${hint}</small></div></td></tr>`;
    return;
  }
  if (sessions === null) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="prc-empty-state"><p>Loading student proctored reports...</p></div></td></tr>`;
    return;
  }

  if (rowCount) rowCount.textContent = `Rows per page: 25   1${sessions.length > 0 ? `–${sessions.length}` : ''} of ${sessions.length}`;

  if (sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="prc-empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><p>No proctored attempts recorded for this exam yet.</p><small>Check back later to see if there are any changes</small></div></td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  sessions.forEach(s => {
    const submissionDate = new Date(s.started_at).toLocaleDateString('en-US', {month:'2-digit',day:'2-digit',year:'numeric'});
    const alertCount = _prcAlertCount(s.logs);
    const annotCount = _prcAnnotationCount(s.logs);
    const abnormCount = _prcAbnormalCount(s.logs);
    const calcScore = (alertCount * 5) + (abnormCount * 2);
    const suspPct = Math.min(100, s.riskScore || calcScore);
    const suspClass = suspPct >= 70 ? 'high' : suspPct >= 30 ? 'medium' : 'low';
    const suspColor = suspPct >= 70 ? '#e53e3e' : suspPct >= 30 ? '#d69e2e' : '#38a169';
    const iconRow = _prcIconRowHtml(s);
    const alertClass = alertCount > 0 ? 'red' : 'gray';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="icon-col"><input type="checkbox" class="prc-row-check" /></td>
      <td class="icon-col">
        <button class="prc-eye-btn prc-open-detail" data-student-id="${s.student_canvas_id}" data-session-id="${s.id}" title="View session detail">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        </button>
      </td>
      <td>
        <div style="font-weight:700;color:#1a202c;line-height:1.2;margin-bottom:2px;">${s.student_name.split(' ')[0]}</div>
        <div style="font-weight:700;color:#1a202c;line-height:1.2;">${s.student_name.split(' ').slice(1).map(n=>n[0]+'.').join(' ')}</div>
      </td>
      <td>
        <div style="color:#4a5568;font-size:13px;line-height:1.4;">${new Date(s.started_at).toLocaleDateString('en-US', {month:'short',day:'numeric'})},</div>
        <div style="color:#4a5568;font-size:13px;line-height:1.4;">${new Date(s.started_at).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}).toLowerCase()}</div>
      </td>
      <td>
        <div class="prc-icon-row">${iconRow}</div>
      </td>
      <td>
        <div style="display:inline-flex; flex-direction:column; align-items:center; justify-content:center; padding:4px 10px; border-radius:12px; background:${alertCount>=10 ? '#fff5f5' : alertCount>0 ? '#fffaf0' : '#f0fff4'}; color:${alertCount>=10 ? '#c53030' : alertCount>0 ? '#b7791f' : '#2f855a'}; font-size:11px; font-weight:700; line-height:1.2;">
          <div>${alertCount}</div>
          <div>alerts</div>
        </div>
      </td>
      <td>
        <div class="prc-susp-wrap">
          <div class="prc-susp-bar-outer"><div class="prc-susp-bar-inner ${suspClass}" style="width:${suspPct}%;"></div></div>
          <span style="color:${suspColor}; font-size:12px; font-weight:700;">${suspPct}%</span>
        </div>
      </td>
      <td style="text-align:right;">
        <button class="prc-review-btn prc-open-detail" data-student-id="${s.student_canvas_id}" data-session-id="${s.id}" style="background:none; color:#2563eb; font-weight:700; border:none; padding:4px 8px; cursor:pointer;">Review</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Bind all open-detail triggers — embed detail view inline below the table
  modalEl.querySelectorAll('.prc-open-detail').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const studentId = el.getAttribute('data-student-id');
      const sessionId = el.getAttribute('data-session-id');
      const studentSessions = sessions.filter(s => s.student_canvas_id === studentId);
      openInlineStudentDetail(modalEl, studentSessions, sessionId);
    });
  });
}

async function refreshReviewCenterData(modalEl) {
  const url = window.location.href;
  const idMatch = url.match(/\/quizzes\/(\d+)/);
  if (!idMatch) return;
  const quizId = idMatch[1];
  try {
    const data = await fetchSessionReport(quizId);
    updateReviewCenterModalBody(modalEl, data.sessions || [], null);
  } catch(e) {
    updateReviewCenterModalBody(modalEl, [], e.message || 'Failed to refresh reports from server.');
  }
}

// ============================================================
// INLINE STUDENT DETAIL — embeds below the Review Center table
// ============================================================
function openInlineStudentDetail(rcModal, sessions, initialSessionId) {
  if (!sessions || sessions.length === 0) return;

  const shell = rcModal.querySelector('.prc-shell');
  if (!shell) return;

  // Add the detail-open class to adjust layout heights
  shell.classList.add('prc-detail-open');

  // Remove any existing inline detail
  const existing = shell.querySelector('#prc-inline-detail');
  if (existing) existing.remove();

  // Create inline detail container
  const container = document.createElement('div');
  container.id = 'prc-inline-detail';
  container.style.cssText = `
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    background: #fff;
    min-height: 0;
  `;

  // Ensure styles are injected
  injectPrmStyles();

  // Build the shell inside the inline container. Open the specific attempt the user
  // clicked on (initialSessionId), falling back to the most recent attempt only if
  // no specific row was targeted.
  const sortedSessions = sessions.slice().sort((a, b) => b.attempt_number - a.attempt_number);
  const firstSession = (initialSessionId && sessions.find(s => String(s.id) === String(initialSessionId)))
    || sortedSessions[0];
  const attemptOptions = sortedSessions.map(s => `<option value="${s.id}" ${String(s.id) === String(firstSession.id) ? 'selected' : ''}>Attempt ${s.attempt_number}</option>`).join('');

  container.innerHTML = `
    <div class="prm-header">
      <button id="prm-close-btn" class="prc-back-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        Back to list
      </button>
      <strong style="font-size:14px; color:#1a1a2e; display:flex; align-items:center; gap:6px;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        Proctored Exam Report
      </strong>
      <div style="flex:1"></div>
      <select id="prm-attempt-select" class="prm-attempt-select">${attemptOptions}</select>
    </div>
    <div class="prm-stats-row" id="prm-stats-row"><!-- filled dynamically --></div>
    <div class="prm-body" style="flex: 1; min-height: 0;">
      <div class="prm-left">
        <div class="prm-video-area" id="prm-video-area"><!-- filled dynamically --></div>
        <div class="prm-timeline" id="prm-timeline"><!-- filled dynamically --></div>
      </div>
      <div class="prm-right">
        <div class="prm-tabs" id="prm-tabs">
          <button class="prm-tab-btn active" data-tab="abnormalities">Abnormalities</button>
          <button class="prm-tab-btn" data-tab="alerts">Alerts</button>
          <button class="prm-tab-btn" data-tab="verification">Verification</button>
        </div>
        <div id="prm-panel-abnormalities" class="prm-tab-panel active"></div>
        <div id="prm-panel-alerts"   class="prm-tab-panel"></div>
        <div id="prm-panel-verification" class="prm-tab-panel"></div>
      </div>
    </div>
  `;

  shell.appendChild(container);

  container.querySelector('#prm-close-btn').addEventListener('click', () => {
    container.remove();
    shell.classList.remove('prc-detail-open');
  });

  container.querySelectorAll('.prm-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.prm-tab-btn').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.prm-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      container.querySelector(`#prm-panel-${btn.dataset.tab}`).classList.add('active');
    });
  });

  container.querySelector('#prm-attempt-select').addEventListener('change', (e) => {
    const sel = sessions.find(s => String(s.id) === e.target.value);
    if (sel) loadSessionInModal(container, sel);
  });

  loadSessionInModal(container, firstSession);
}


function injectPrmStyles() {
  if (document.getElementById('proctor-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'proctor-modal-styles';
  style.innerHTML = `
    #proctor-report-modal {
      position: fixed; inset: 0; z-index: 999999;
      background: rgba(10,14,26,0.98);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      color: #2d3748;
    }
    .prm-shell {
      background: #fff;
      border-radius: 8px;
      width: 98%; max-width: 1200px;
      height: 90vh;
      display: flex; flex-direction: column;
      overflow: hidden;
      box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      animation: prmFadeIn .2s ease;
    }
    @keyframes prmFadeIn { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
    .prm-header {
      display: flex; align-items: center;
      padding: 0 20px;
      height: 50px; min-height: 50px;
      border-bottom: 1px solid #e2e8f0;
      background: #fff;
      gap: 12px;
    }
    .prm-header h3 {
      margin: 0; font-size: 15px; font-weight: 700; color: #1a1a2e; flex: 1;
    }
    .prm-attempt-select {
      padding: 5px 10px;
      border: 1px solid #cbd5e0; border-radius: 4px;
      font-size: 13px; color: #4a5568; background: #f7fafc;
      cursor: pointer;
    }
    .prm-close-btn {
      background: none; border: none; cursor: pointer;
      color: #718096; font-size: 22px; line-height: 1;
      padding: 4px 6px; border-radius: 4px;
      transition: background .15s;
    }
    .prm-close-btn:hover { background: #f0f0f0; color: #e53e3e; }
    /* ---- Row header (stats) ---- */
    .prm-stats-row {
      display: flex; align-items: center;
      padding: 8px 20px;
      border-bottom: 1px solid #e2e8f0;
      background: #f7fafc;
      gap: 28px; flex-shrink: 0;
    }
    .prm-stat-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .prm-stat-icon { color: #718096; }
    .prm-stat-val { font-weight: 700; color: #2d3748; }
    .prm-stat-label { color: #718096; font-size: 12px; }
    .prm-susp-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 700;
    }
    .prm-susp-pill.low    { background: #c6f6d5; color: #276749; }
    .prm-susp-pill.medium { background: #fefcbf; color: #975a16; }
    .prm-susp-pill.high   { background: #fed7d7; color: #9b2c2c; }

    /* ---- Body layout ---- */
    .prm-body {
      flex: 1; display: flex; overflow: hidden;
    }
    .prm-left {
      flex: 1; display: flex; flex-direction: column;
      background: #1a1a2e; overflow: hidden;
      border-right: 1px solid #e2e8f0;
    }
    .prm-video-area {
      flex: 1; display: flex; gap: 0; overflow: hidden;
      position: relative;
    }
    .prm-video-primary {
      flex: 1; background: #0d0d1a;
      display: flex; flex-direction: row; align-items: center; justify-content: center;
      gap: 10px; padding: 10px;
    }
    .prm-video-primary video {
      width: 100%; height: 100%; object-fit: contain;
      background: #000;
    }
    .prm-webcam-thumb {
      flex: 1; height: 100%;
      background: #111; border: 2px solid #2d3748;
      border-radius: 4px; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      color: #4a5568; font-size: 11px; text-align: center;
    }
    .prm-webcam-thumb video { width: 100%; height: 100%; object-fit: contain; }
    .prm-vid-main-container {
      flex: 2; height: 100%;
      display: flex; align-items: center; justify-content: center;
    }
    .prm-no-video {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; color: #4a5568; font-size: 13px;
    }
    .prm-no-video-icon {
      width: 90px; height: 90px; border-radius: 50%;
      background: #2d3748; display: flex; align-items: center; justify-content: center;
    }

    /* ---- Timeline ---- */
    .prm-timeline {
      height: 80px; background: #111827; flex-shrink: 0;
      border-top: 1px solid #2d3748;
      display: flex; flex-direction: column; padding: 6px 12px;
      gap: 4px; overflow: hidden;
    }
    .prm-timeline-bar {
      height: 12px; border-radius: 2px; display: flex;
      gap: 1px; overflow: hidden;
    }
    .prm-timeline-seg {
      flex: 1; background: #22c55e; border-radius: 1px;
      transition: background .15s; cursor: pointer; position: relative;
    }
    .prm-timeline-seg:hover { opacity: .8; }
    .prm-timeline-seg.alert { background: #ef4444; }
    .prm-timeline-seg.warn  { background: #f59e0b; }
    .prm-timeline-labels {
      display: flex; justify-content: space-between;
      font-size: 10px; color: #6b7280;
    }

    /* ---- Right panel (tabs) ---- */
    .prm-right {
      width: 320px; min-width: 280px; max-width: 360px;
      display: flex; flex-direction: column;
      background: #fff; overflow: hidden;
    }
    .prm-tabs {
      display: flex; border-bottom: 1px solid #e2e8f0;
      overflow-x: auto; flex-shrink: 0;
    }
    .prm-tab-btn {
      flex-shrink: 0;
      padding: 8px 14px; font-size: 11px; font-weight: 600;
      color: #718096; border: none; background: none;
      border-bottom: 3px solid transparent; cursor: pointer;
      transition: color .15s, border-color .15s;
      text-transform: uppercase; letter-spacing: .03em;
      white-space: nowrap;
    }
    .prm-tab-btn.active { color: #2563eb; border-bottom-color: #2563eb; }
    .prm-tab-btn:hover:not(.active) { color: #2d3748; }
    .prm-tab-panel { display: none; flex: 1; overflow-y: auto; padding: 14px; }
    .prm-tab-panel.active { display: block; }

    /* ---- Log items inside tab panel ---- */
    .prm-log-item {
      padding: 8px 10px 8px 12px;
      margin-bottom: 6px; border-radius: 4px;
      border-left: 3px solid #e2e8f0;
      background: #f7fafc; cursor: pointer;
      transition: background .12s;
    }
    .prm-log-item:hover { background: #edf2f7; }
    .prm-log-item.alert { border-left-color: #e53e3e; background: #fff5f5; }
    .prm-log-item.alert:hover { background: #fed7d7; }
    .prm-log-item.warn  { border-left-color: #d69e2e; background: #fffff0; }
    .prm-log-item.warn:hover  { background: #fefcbf; }
    .prm-log-item.info  { border-left-color: #3182ce; background: #ebf8ff; }
    .prm-log-time { font-size: 10px; color: #a0aec0; margin-bottom: 2px; }
    .prm-log-type { font-size: 11px; font-weight: 700; color: #4a5568; text-transform: uppercase; letter-spacing: .03em; }
    .prm-log-msg  { font-size: 12px; color: #4a5568; line-height: 1.4; margin-top: 2px; word-break: break-word; }

    /* Score tab */
    .prm-score-card {
      background: #f7fafc; border-radius: 8px; padding: 16px;
      margin-bottom: 12px; border: 1px solid #e2e8f0;
    }
    .prm-score-card h4 { margin: 0 0 6px; font-size: 13px; font-weight: 700; color: #2d3748; }
    .prm-score-card p  { margin: 0; font-size: 22px; font-weight: 800; color: #2563eb; }
    .prm-score-card small { font-size: 11px; color: #718096; }

    /* Abnormality chip */
    .prm-abnorm-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 600; margin: 3px;
      background: #fed7d7; color: #9b2c2c;
    }

    /* Empty panel */
    .prm-panel-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 32px; gap: 8px;
      color: #a0aec0; text-align: center;
    }
    .prm-panel-empty p { margin: 0; font-size: 13px; }
  `;
  document.head.appendChild(style);
}

async function loadSessionInModal(modal, session) {
  const videoArea    = modal.querySelector('#prm-video-area');
  const statsRow     = modal.querySelector('#prm-stats-row');
  const timeline     = modal.querySelector('#prm-timeline');

  if (!videoArea) return;

  // <video src="..."> can't carry an Authorization header, so the token has to ride
  // in the URL here — acceptable specifically because it's short-lived and scoped,
  // unlike the old static secret this replaces.
  const token = await getExtensionToken();
  if (!token) {
    videoArea.innerHTML = `<div class="prm-no-video">ProctorGuard needs to reconnect — open your dashboard at proctor.siotw.net, then reopen this review.</div>`;
    return;
  }

  // ------- VIDEO AREA -------
  const hasVideo   = !!session.drive_file_id;
  const hasMobile  = !!session.mobile_drive_file_id;
  const videoSrc   = `${PG_API_BASE}/api/session/video-playback/${session.id}?token=${encodeURIComponent(token)}`;
  const mobileSrc  = `${PG_API_BASE}/api/session/mobile-video-playback/${session.id}?token=${encodeURIComponent(token)}`;

  if (hasVideo) {
    videoArea.innerHTML = `
      <div class="prm-video-primary">
        ${hasMobile ? `<div class="prm-webcam-thumb"><video id="prm-vid-mobile" controls playsinline muted src="${mobileSrc}"></video></div>` : ''}
        <div class="prm-vid-main-container" style="flex:${hasMobile ? '2' : '1'};">
          <video id="prm-vid-main" controls playsinline>
            <source src="${videoSrc}" type="video/webm">
            <source src="${videoSrc}" type="video/mp4">
          </video>
        </div>
      </div>
    `;
  } else {
    videoArea.innerHTML = `
      <div class="prm-video-primary">
        <div class="prm-no-video">
          <div class="prm-no-video-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4a5568" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
          <span style="color:#6b7280;font-size:13px;">No Video Recorded</span>
        </div>
      </div>
    `;
  }

  const mainVid = modal.querySelector('#prm-vid-main');

  // ------- STATS ROW -------
  const alertCnt = _prcAlertCount(session.logs);
  const annotCnt = _prcAnnotationCount(session.logs);
  const abnCnt   = _prcAbnormalCount(session.logs);
  const calcScore = (alertCnt * 5) + (abnCnt * 2);
  const suspPct  = session.riskScore || Math.min(100, calcScore);
  const suspCls  = suspPct >= 70 ? 'high' : suspPct >= 30 ? 'medium' : 'low';
  const started  = new Date(session.started_at);
  const ended    = session.end_time ? new Date(session.end_time) : null;
  
  let durationSec = null;
  if (ended) {
    durationSec = Math.floor((ended - started) / 1000);
  } else if (session.logs && session.logs.length > 0) {
    const lastLogTime = Math.max(...session.logs.map(l => new Date(l.event_timestamp).getTime()));
    if (lastLogTime && !isNaN(lastLogTime)) {
      durationSec = Math.floor((lastLogTime - started.getTime()) / 1000);
    }
  }
  const durStr   = durationSec ? `${Math.floor(durationSec/60)}m ${durationSec%60}s` : 'N/A';

  statsRow.innerHTML = `
    <div class="prm-stat-item">
      <svg class="prm-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span class="prm-stat-val">${started.toLocaleDateString()}</span>
      <span class="prm-stat-label">${started.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
    </div>
    <div class="prm-stat-item">
      <svg class="prm-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <span class="prm-stat-val">${durStr}</span>
      <span class="prm-stat-label">Duration</span>
    </div>
    <div class="prm-stat-item">
      <svg class="prm-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span class="prm-stat-val" style="color:${alertCnt>0?'#e53e3e':'#2d3748'}">${alertCnt}</span>
      <span class="prm-stat-label">Alerts</span>
    </div>
    <div class="prm-stat-item">
      <svg class="prm-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="prm-stat-val">${abnCnt}</span>
      <span class="prm-stat-label">Abnormalities</span>
    </div>
    <div class="prm-stat-item">
      <span class="prm-susp-pill ${suspCls}">${suspPct}% Suspicious</span>
    </div>
    <div class="prm-stat-item" style="margin-left:auto">
      <span style="font-size:12px;color:#718096;">Attempt <strong>${session.attempt_number}</strong></span>
    </div>
  `;

  // ------- TIMELINE -------
  const logs     = session.logs || [];
  const dSec     = durationSec || 120;
  const segments = 60;
  const secPerSeg = dSec / segments;

  let tlBars = '';
  for (let i = 0; i < segments; i++) {
    const segStart = i * secPerSeg;
    const segEnd   = (i + 1) * secPerSeg;
    const segLogs  = logs.filter(l => {
      const off = Math.max(0, (new Date(l.event_timestamp) - started) / 1000);
      return off >= segStart && off < segEnd;
    });
    const hasAlert = segLogs.some(l => _prcAlertCount([l]) > 0);
    const hasWarn  = segLogs.some(l => _prcAbnormalCount([l]) > 0);
    const segClass = hasAlert ? 'alert' : hasWarn ? 'warn' : '';
    const seekSec  = Math.round(segStart);
    tlBars += `<div class="prm-timeline-seg ${segClass}" data-seek="${seekSec}" title="${seekSec}s"></div>`;
  }

  const tlLabels = [];
  for (let i = 0; i <= 4; i++) {
    const sec = Math.round((i / 4) * dSec);
    const m   = Math.floor(sec / 60);
    const s   = sec % 60;
    tlLabels.push(`<span>${m}:${String(s).padStart(2,'0')}</span>`);
  }

  timeline.innerHTML = `
    <div class="prm-timeline-bar" id="prm-tl-bar">${tlBars}</div>
    <div class="prm-timeline-bar" id="prm-tl-bar2">${tlBars}</div>
    <div class="prm-timeline-labels">${tlLabels.join('')}</div>
  `;

  timeline.querySelectorAll('.prm-timeline-seg').forEach(seg => {
    seg.addEventListener('click', () => {
      const seek = parseInt(seg.dataset.seek, 10);
      if (mainVid) { mainVid.currentTime = seek; mainVid.play(); }
    });
  });

  if (mainVid) {
    mainVid.addEventListener('loadedmetadata', function() {
      const realDur = this.duration;
      if (realDur && realDur > 0) {
        const secPerSeg = realDur / segments;
        let newTlBars = '';
        for (let i = 0; i < segments; i++) {
          const segStart = i * secPerSeg;
          const segEnd   = (i + 1) * secPerSeg;
          const segLogs  = logs.filter(l => {
            let off = Math.max(0, (new Date(l.event_timestamp) - started) / 1000);
            if (off >= realDur) off = Math.max(0, realDur - 0.1);
            return off >= segStart && off < segEnd;
          });
          const hasAlert = segLogs.some(l => _prcAlertCount([l]) > 0);
          const hasWarn  = segLogs.some(l => _prcAbnormalCount([l]) > 0);
          const segClass = hasAlert ? 'alert' : hasWarn ? 'warn' : '';
          const seekSec  = Math.round(segStart);
          newTlBars += `<div class="prm-timeline-seg ${segClass}" data-seek="${seekSec}" title="${seekSec}s"></div>`;
        }
        
        const tlLabels = [];
        for (let i = 0; i <= 4; i++) {
          const sec = Math.round((i / 4) * realDur);
          const m   = Math.floor(sec / 60);
          const s   = sec % 60;
          tlLabels.push(`<span>${m}:${String(s).padStart(2,'0')}</span>`);
        }
        
        timeline.innerHTML = `
          <div class="prm-timeline-bar" id="prm-tl-bar">${newTlBars}</div>
          <div class="prm-timeline-bar" id="prm-tl-bar2">${newTlBars}</div>
          <div class="prm-timeline-labels">${tlLabels.join('')}</div>
        `;
        
        timeline.querySelectorAll('.prm-timeline-seg').forEach(seg => {
          seg.addEventListener('click', () => {
            const seek = parseInt(seg.dataset.seek, 10);
            mainVid.currentTime = seek; mainVid.play();
          });
        });

        // Update sidebar log timestamps if they exceed video duration
        modal.querySelectorAll('.prm-log-item').forEach(el => {
            const rawOff = parseInt(el.dataset.rawOff, 10);
            if (rawOff > realDur) {
                const cappedOff = Math.max(0, Math.floor(realDur));
                const m = Math.floor(cappedOff / 60);
                const s = cappedOff % 60;
                const ts = `${m}:${String(s).padStart(2,'0')}`;
                const tsSpan = el.querySelector('.prm-log-ts');
                if (tsSpan) {
                    tsSpan.innerText = ts;
                }
            }
        });
      }
    });
  }

  // ------- HELPER: log item -------
  const alertTypes = ['tab_blur','window_blur','fullscreen_exit','Tab Blocked','audio_violation','clipboard_attempt','copy_attempt','paste_attempt','right_click','print_attempt','keyboard_shortcut_blocked'];
  const abnTypes   = ['phone_detected','multiple_faces','no_face','AI_PEOPLE','gaze_off_screen','audio_threshold_exceeded','mobile_camera_lost'];
  const alertLabels = {
    tab_blur: 'Tab Leave/Blur', window_blur: 'Window Focus Lost', fullscreen_exit: 'Fullscreen Exited',
    'Tab Blocked': 'Tab Blocked', audio_violation: 'Audio/Voice Detected',
    clipboard_attempt: 'Clipboard Attempt', copy_attempt: 'Copy Attempt', paste_attempt: 'Paste Attempt',
    right_click: 'Right Click', print_attempt: 'Print Attempt', keyboard_shortcut_blocked: 'Keyboard Shortcut Blocked'
  };
  const abnLabels = {
    phone_detected: 'Phone Detected', multiple_faces: 'Multiple Faces', no_face: 'No Face Detected',
    AI_PEOPLE: 'AI-Detected Person', gaze_off_screen: 'Gaze Off-Screen', audio_threshold_exceeded: 'Loud Audio',
    mobile_camera_lost: 'Mobile Camera Lost'
  };

  const makeLogEl = (log, index) => {
    const off  = Math.max(0, Math.floor((new Date(log.event_timestamp) - started) / 1000));
    const m    = Math.floor(off / 60);
    const s    = off % 60;
    const ts   = `${m}:${String(s).padStart(2,'0')}`;
    const isAl = alertTypes.includes(log.event_type);
    const isAb = abnTypes.includes(log.event_type);
    
    let severity = 'Low';
    let sevColor = '#38a169'; // green
    let sevBg = '#f0fff4';
    if (['tab_blur','window_blur','fullscreen_exit','Tab Blocked'].includes(log.event_type)) {
      severity = 'High'; sevColor = '#c53030'; sevBg = '#fff5f5';
    } else if (['clipboard_attempt','copy_attempt','paste_attempt','right_click','print_attempt'].includes(log.event_type)) {
      severity = 'Med'; sevColor = '#dd6b20'; sevBg = '#fffaf0';
    }
    
    if (!isAl) {
      severity = 'Info'; sevColor = '#3182ce'; sevBg = '#ebf8ff';
    }
    
    const label= alertLabels[log.event_type] || abnLabels[log.event_type] || log.event_type.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
    const el   = document.createElement('div');
    
    let details = `<span class="prm-log-ts">${ts}</span> · ${isAl ? 'Violation #' + (index + 1) : 'Logged event'}`;
    // The mockup had "0:25 · 3 sec · Violation #1" and "Browser minimized". We can put log.event_message if available, or a generic duration.
    let desc = log.event_message ? log.event_message : (isAl ? 'Proctoring rule triggered' : 'Event recorded');

    el.innerHTML = `
      <div style="padding:16px 20px; border-bottom:1px solid #e2e8f0; display:flex; flex-direction:column; gap:4px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="width:8px; height:8px; border-radius:50%; background:${sevColor};"></div>
          <div style="font-weight:700; color:#1a202c; font-size:14px;">${label}</div>
        </div>
        <div style="color:#718096; font-size:12px; margin-left:16px; margin-bottom:6px;">${details}</div>
        <div style="display:flex; align-items:center; gap:8px; margin-left:16px;">
          <div style="padding:4px 12px; border-radius:12px; background:${sevBg}; color:${sevColor}; font-size:12px; font-weight:700; white-space:nowrap; display:inline-flex; align-items:center; justify-content:center;">${severity}</div>
          <div style="color:#4a5568; font-size:13px; line-height:1.4;">${desc}</div>
        </div>
      </div>
    `;
    el.className = 'prm-log-item';
    el.dataset.rawOff = off;
    el.style.cursor = 'pointer';
    el.title = 'Click to seek video to this timestamp';
    el.addEventListener('mouseover', () => el.style.background = '#f7fafc');
    el.addEventListener('mouseout', () => el.style.background = '');
    el.addEventListener('click', () => {
      if (mainVid) {
        let seekTime = off;
        if (!isNaN(mainVid.duration) && mainVid.duration > 0) {
            seekTime = Math.min(off, Math.max(0, mainVid.duration - 1));
        }
        mainVid.currentTime = seekTime; 
        mainVid.play(); 
      }
    });
    return el;
  };

  // ------- PANELS -------

  // Abnormalities
  const pAbnorm = modal.querySelector('#prm-panel-abnormalities');
  if (pAbnorm) {
    const abnLogs = logs.filter(l => abnTypes.includes(l.event_type));
    if (abnLogs.length === 0) {
      pAbnorm.innerHTML = `<div class="prm-panel-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p>No abnormalities detected.</p></div>`;
    } else {
      pAbnorm.innerHTML = '<div style="margin-bottom:10px;">' + [...new Set(abnLogs.map(l=>l.event_type))].map(t => `<span class="prm-abnorm-chip">${abnLabels[t]||t} (${abnLogs.filter(l=>l.event_type===t).length})</span>`).join('') + '</div>';
      abnLogs.forEach((l, i) => pAbnorm.appendChild(makeLogEl(l, i)));
    }
  }

  // Alerts
  const pAlerts = modal.querySelector('#prm-panel-alerts');
  if (pAlerts) {
    const alertLogs = logs.filter(l => alertTypes.includes(l.event_type));
    if (alertLogs.length === 0) {
      pAlerts.innerHTML = `<div class="prm-panel-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><p>No alerts triggered during this attempt.</p></div>`;
    } else {
      pAlerts.innerHTML = '';
      alertLogs.forEach((l, index) => {
        pAlerts.appendChild(makeLogEl(l, index));
      });
    }
  }

  // Verification
  const pVerif = modal.querySelector('#prm-panel-verification');
  if (pVerif) {
    let vHtml = '';
    if (session.verify_id_image) {
      vHtml += `<div class="prm-score-card"><h4>ID Captured</h4><img src="${session.verify_id_image}" style="max-width:100%;border-radius:4px;margin-top:8px;"></div>`;
    }
    if (session.verify_signature_image) {
      vHtml += `<div class="prm-score-card"><h4>Signature: ${session.verify_signature_name || 'Captured'}</h4><img src="${session.verify_signature_image}" style="max-width:100%;border-radius:4px;margin-top:8px;background:#fff;"></div>`;
    }
    if (!session.verify_id_image && !session.verify_signature_image) {
      vHtml = `<div class="prm-panel-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg><p>No ID or Signature captured.</p></div>`;
    }
    pVerif.innerHTML = vHtml;
  }
}



// ================================================================
// Quiz Editor: Inject ProctorGuard Settings Tab (Proctorio-style)
// ================================================================

function findQuizTabNav() {
  // Try many selectors in order of specificity
  const selectors = [
    '#quiz_tabs .ui-tabs-nav',
    '#quiz_tabs > ul',
    '#quiz_tabs ul',
    '.quiz-edit-header-tabs ul',
    '.quiz-edit-header ul',
    '[data-component="QuizTabs"] ul',
    '[data-testid="quiz-tabs"] ul',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) { console.log('[ProctorGuard] Found tab nav via:', sel); return el; }
  }
  // Fallback: find a <ul role="tablist"> that contains quiz-relevant links
  const allTabLists = document.querySelectorAll('ul[role="tablist"], ul.nav-tabs, ul.quiz-tabs');
  for (const ul of allTabLists) {
    const text = ul.textContent.toLowerCase();
    if (text.includes('detail') || text.includes('question') || text.includes('settings')) {
      console.log('[ProctorGuard] Found tab nav via role/class fallback:', ul);
      return ul;
    }
  }
  // Last resort: any ul inside #content that has ≥2 li>a children
  const contentUls = document.querySelectorAll('#content ul, #main ul, .content-body ul');
  for (const ul of contentUls) {
    const links = ul.querySelectorAll('li > a');
    if (links.length >= 2 && links.length <= 6) {
      const text = ul.textContent.toLowerCase();
      if (text.includes('detail') || text.includes('question') || text.includes('mastery')) {
        console.log('[ProctorGuard] Found tab nav via last-resort heuristic:', ul);
        return ul;
      }
    }
  }
  return null;
}

let detailsModified = false;
function initDetailsTabModifications() {
  const checkbox = document.getElementById('quiz_require_lockdown_browser');
  if (!checkbox) return;
  if (detailsModified) return;
  detailsModified = true;

  console.log('[ProctorGuard] Modifying Canvas Details tab for ProctorGuard...');

  // 1. Change label text from "Require Secure Proctor Mode" to "Require ProctorGuard"
  const label = checkbox.parentElement;
  if (label && label.tagName === 'LABEL') {
    for (const node of label.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.includes('Require Secure Proctor Mode')) {
        node.textContent = ' Require ProctorGuard';
      }
    }
  }

  // 2. Hide old lockdown browser suboptions completely
  const suboptions = document.getElementById('lockdown_browser_suboptions');
  if (suboptions) {
    suboptions.style.display = 'none';
    // Use MutationObserver to keep it hidden even if Canvas scripts try to show it
    const subObs = new MutationObserver(() => {
      if (suboptions.style.display !== 'none') {
        suboptions.style.display = 'none';
      }
    });
    subObs.observe(suboptions, { attributes: true, attributeFilter: ['style'] });
  }

  // 3. Setup the link next to it to navigate to our settings tab
  let toggle = document.getElementById('proctor_settings_toggle');
  if (!toggle) {
    toggle = document.createElement('a');
    toggle.id = 'proctor_settings_toggle';
    toggle.href = '#';
    toggle.style.color = '#0374B5';
    toggle.style.fontSize = '13px';
    toggle.style.marginLeft = '8px';
    toggle.style.fontWeight = 'bold';
    toggle.style.textDecoration = 'none';
    if (label) {
      label.parentNode.insertBefore(toggle, label.nextSibling);
    }
  }
  
  toggle.textContent = '(see settings)';
  
  const updateToggleVisibility = () => {
    toggle.style.display = checkbox.checked ? 'inline-block' : 'none';
  };
  checkbox.addEventListener('change', updateToggleVisibility);
  updateToggleVisibility();

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    const tabLink = document.getElementById('proctorguard_tab_link');
    if (tabLink) {
      tabLink.click();
    }
  });
}

function initQuizEditorIntegration() {
  const url = window.location.href;
  const isEdit = /\/courses\/\d+\/quizzes\/\d+\/edit/.test(url);
  const isNew  = /\/courses\/\d+\/quizzes\/new/.test(url);
  if (!isEdit && !isNew) return;

  console.log('[ProctorGuard] Quiz editor detected. URL:', url);
  let injected = false;
  const quizMatch = url.match(/\/quizzes\/(\d+)\//);
  const quizId = quizMatch ? quizMatch[1] : null;
  console.log('[ProctorGuard] Quiz ID:', quizId);

  const tryInject = () => {
    // Run Details tab modifications if they haven't been run yet
    initDetailsTabModifications();

    if (injected) return;
    if (document.getElementById('proctorguard_tab_li')) { injected = true; return; }
    const tabNav = findQuizTabNav();
    if (tabNav) {
      injected = true;
      injectProctorGuardTab(tabNav, quizId);
    }
  };

  const obs = new MutationObserver(tryInject);
  obs.observe(document.body, { childList: true, subtree: true });

  // Try at intervals for up to 10 seconds as Canvas may be slow to render
  let attempts = 0;
  const retryInterval = setInterval(() => {
    attempts++;
    console.log('[ProctorGuard] Tab injection attempt', attempts);
    tryInject();
    if (injected || attempts >= 20) {
      clearInterval(retryInterval);
      obs.disconnect();
      if (!injected) console.warn('[ProctorGuard] Could not find tab bar after 10 seconds. DOM state:', document.body.innerHTML.substring(0, 500));
    }
  }, 500);

  tryInject(); // immediate attempt
}

function injectProctorGuardTab(tabNav, quizId) {
  // --- Inject styles ---
  if (!document.getElementById('pg-ext-styles')) {
    const st = document.createElement('style');
    st.id = 'pg-ext-styles';
    st.textContent = `
      #proctorguard_tab_panel{font-family:'Outfit','Plus Jakarta Sans',Arial,sans-serif;font-size:13px;color:#333;background:#fff;padding:28px 32px;line-height:1.5;}
      .pg-sec-title{font-size:16px;font-weight:700;color:#1a1a1a;margin:0 0 6px 0;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
      .pg-arrow{font-size:10px;display:inline-block;transition:transform 0.2s;}
      .pg-divider{border:none;border-top:1px solid #e0e0e0;margin:20px 0;}
      .pg-exam-warn{position:sticky;top:0;z-index:10;background:#e8eefd;border:1px solid #2563eb;color:#2563eb;padding:10px;border-radius:4px;font-size:13px;font-weight:600;margin-bottom:18px;}
      .pg-sub-title{font-size:14px;font-weight:700;color:#1a1a1a;margin:20px 0 8px 0;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
      .pg-note{font-size:12px;color:#2563eb;margin:6px 0 16px 0;}
      .pg-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px;}
      .pg-lbl{cursor:pointer;display:inline-block;position:relative;}
      .pg-chk{position:absolute;opacity:0;width:0;height:0;}
      .pg-card{display:flex;flex-direction:column;align-items:center;justify-content:center;width:118px;min-height:108px;padding:14px 8px 10px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;box-sizing:border-box;transition:all 0.15s;text-align:center;user-select:none;}
      .pg-card:hover{border-color:#bbb;background:#fafafa;}
      .pg-chk:checked+.pg-card{background:#e8eefd;border:2px solid #2563eb;}
      .pg-chk:checked+.pg-card svg{stroke:#2563eb!important;}
      .pg-chk:checked+.pg-card .pg-ct{color:#2563eb;}
      .pg-icon{width:38px;height:38px;margin-bottom:9px;display:flex;align-items:center;justify-content:center;}
      .pg-icon svg{width:34px;height:34px;stroke:#333;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;}
      .pg-ct{font-size:11.5px;font-weight:600;color:#333;line-height:1.3;}
      .pg-savebar{margin-top:28px;padding-top:16px;border-top:1px solid #e0e0e0;display:flex;align-items:center;gap:14px;justify-content:flex-end;}
      #pg-save-btn{background:#2563eb;color:#fff;border:none;padding:9px 22px;font-size:13px;font-weight:700;border-radius:4px;cursor:pointer;font-family:inherit;}
      #pg-save-btn:hover{background:#1d4ed8;}
      #pg-save-btn:disabled{background:#9db8d2;cursor:default;}
      #pg-save-ok{font-size:13px;color:#2e7d32;font-weight:600;display:none;}
      #pg-save-err{font-size:13px;color:#c0392b;font-weight:600;display:none;}
      .pg-prof-note{color:#555;font-size:13px;margin:0 0 4px 0;}
      .pg-prof-sub{color:#888;font-size:12px;margin:0;}
    `;
    document.head.appendChild(st);
  }

  // --- Inject tab link ---
  const li = document.createElement('li');
  li.setAttribute('role','tab');
  li.id = 'proctorguard_tab_li';
  li.innerHTML = `<a href="#proctorguard_tab_panel" id="proctorguard_tab_link" style="font-family:inherit;">ProctorGuard Settings</a>`;
  tabNav.appendChild(li);

  // SVG icon library
  const ic = {
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
    vvid:   `<svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/><path d="M4 19l1.5 1.5L9 17"/></svg>`,
    vaud:   `<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><path d="M15 21l1.5 1.5L20 19"/></svg>`,
    vdesk:  `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="16" x2="12" y2="21"/><path d="M16 18l1.5 1.5L21 16"/></svg>`,
    vid:    `<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="3"/><path d="M15 9h4M15 12h4M15 15h3"/></svg>`,
    vsig:   `<svg viewBox="0 0 24 24"><path d="M3 17c1.5-2 2.5-4 4-4s2 3 3.5 3 2.5-3 4-3 2 2 3.5 4"/><line x1="3" y1="21" x2="21" y2="21"/></svg>`,
    calc:   `<svg viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8" y2="10" stroke-width="3"/><line x1="12" y1="10" x2="12" y2="10" stroke-width="3"/><line x1="16" y1="10" x2="16" y2="10" stroke-width="3"/><line x1="8" y1="14" x2="8" y2="14" stroke-width="3"/><line x1="12" y1="14" x2="12" y2="14" stroke-width="3"/><line x1="16" y1="14" x2="16" y2="18" stroke-width="3"/><line x1="8" y1="18" x2="8" y2="18" stroke-width="3"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`,
    wb:     `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M7 10l3 3 5-5"/></svg>`
  };

  const card = (id, key, label) =>
    `<label class="pg-lbl" for="${id}"><input type="checkbox" class="pg-chk" id="${id}"><div class="pg-card"><div class="pg-icon">${ic[key]}</div><div class="pg-ct">${label}</div></div></label>`;

  // --- Build panel HTML ---
  const panel = document.createElement('div');
  panel.id = 'proctorguard_tab_panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="pg-sec-title" data-pg-body="pg-prof"><span class="pg-arrow">&#9660;</span>&nbsp;Saved Profiles</div>
    <div id="pg-prof">
      <p class="pg-prof-note" style="margin-bottom:8px;">You have not saved any profiles yet :(</p>
      <p class="pg-prof-sub">Saving ProctorGuard settings profiles allows you to apply your favorite exam settings with a single click.</p>
      <button style="margin-top:14px;background:#fff;color:#2563eb;border:1px solid #2563eb;padding:6px 14px;border-radius:4px;cursor:pointer;font-weight:600;">Create profile</button>
    </div>
    <hr class="pg-divider">
    <div class="pg-sec-title" data-pg-body="pg-main"><span class="pg-arrow">&#9660;</span>&nbsp;ProctorGuard Exam Settings</div>
    <div id="pg-main">
      <p class="pg-exam-warn">Exam settings can not be changed once the first candidate has started the exam.</p>
      <div class="pg-sub-title" data-pg-body="pg-rec"><span class="pg-arrow">&#9660;</span>&nbsp;Recording Options</div>
      <div id="pg-rec">
        <div class="pg-grid">
          ${card('pg_cam','cam','Record Video')}${card('pg_mic','mic','Record Audio')}${card('pg_screen','screen','Record Screen')}${card('pg_traffic','traffic','Record Web Traffic')}${card('pg_desk','desk','Secondary Mobile Camera')}
        </div>
        <p class="pg-note" data-pg-desc="rec">Secondary Mobile Camera will require the candidate to show their entire exam environment at intervals based on the option selected.</p>
      </div>
      <div class="pg-sub-title" data-pg-body="pg-lock"><span class="pg-arrow">&#9660;</span>&nbsp;Lock Down Options</div>
      <div id="pg-lock">
        <div class="pg-grid">
          ${card('pg_fs','fs','Force Full Screen')}${card('pg_one','one','Only One Screen')}${card('pg_ntab','ntab','Disable New Tabs')}${card('pg_ctab','ctab','Close Open Tabs')}${card('pg_print','print','Disable Printing')}${card('pg_clip','clip','Disable Clipboard')}${card('pg_dl','dl','Block Downloads')}${card('pg_cache','cache','Clear Cache')}${card('pg_rc','rc','Disable Right Click')}${card('pg_reen','reen','Prevent Re-entry')}
        </div>
        <p class="pg-note" data-pg-desc="lock">Close Open Tabs prevents access to unauthorized material by requiring any other webpages to be closed before starting the exam.</p>
      </div>
      <div class="pg-sub-title" data-pg-body="pg-verify"><span class="pg-arrow">&#9660;</span>&nbsp;Verification Options</div>
      <div id="pg-verify">
        <div class="pg-grid">
          ${card('pg_vvid','vvid','Verify Video')}${card('pg_vaud','vaud','Verify Audio')}${card('pg_vdesk','vdesk','Verify Desktop')}${card('pg_vid','vid','Verify ID')}${card('pg_vsig','vsig','Verify Signature')}
        </div>
        <p class="pg-note" data-pg-desc="verify">These options determine what will be verified prior to the exam.</p>
      </div>
      <div class="pg-sub-title" data-pg-body="pg-tools"><span class="pg-arrow">&#9660;</span>&nbsp;In-Quiz Tools</div>
      <div id="pg-tools">
        <div class="pg-grid">${card('pg_calc','calc','Calculator')}${card('pg_wb','wb','Whiteboard')}</div>
        <p class="pg-note" data-pg-desc="tools">These options enable helper tools inside the quiz player interface.</p>
      </div>
      <div class="pg-savebar">
        <span id="pg-save-err"></span>
        <span id="pg-save-ok">&#10003; Settings saved successfully!</span>
        <button id="pg-save-btn" type="button">Save ProctorGuard Settings</button>
      </div>
    </div>
  `;

  // --- Insert Panel ---
  // Find a good container to append the panel to (the wrapper around the tabs)
  const tabContainer = tabNav.closest('#quiz_tabs, .quiz-edit-header-tabs, [data-component="QuizTabs"], .quiz-edit-header, [role="tablist"]')?.parentElement || tabNav.parentElement;
  
  if (tabContainer) {
    // Append it at the end of the tab container so it acts as a tab panel
    tabContainer.appendChild(panel);
  } else {
    document.body.appendChild(panel);
  }

  // Collapse section toggles
  panel.querySelectorAll('[data-pg-body]').forEach(title => {
    title.addEventListener('click', () => {
      const bodyId = title.getAttribute('data-pg-body');
      const body = document.getElementById(bodyId);
      if (!body) return;
      const arrow = title.querySelector('.pg-arrow');
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? '' : 'none';
      if (arrow) arrow.style.transform = isHidden ? '' : 'rotate(-90deg)';
    });
  });

  // Tab click handler — show our panel, hide Canvas panels
  const tabLink = document.getElementById('proctorguard_tab_link');
  const tabLiEl = document.getElementById('proctorguard_tab_li');
  
  tabLink.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    
    // Hide all other Canvas quiz tab panels
    if (tabContainer) {
      // Find anything that looks like a tab panel in this container
      const panels = tabContainer.querySelectorAll('[role="tabpanel"], .tab-pane, :scope > div');
      panels.forEach(p => {
        // Don't hide our own panel, and don't hide the nav bar itself!
        if (p.id !== 'proctorguard_tab_panel' && !p.contains(tabNav)) { 
          p.style.display = 'none'; 
        }
      });
      // Remove active states from other tabs
      tabNav.querySelectorAll('li, a').forEach(l => {
        l.classList.remove('ui-tabs-active','ui-state-active','active','active-tab');
        l.setAttribute('aria-selected', 'false');
      });
    }
    
    panel.style.display = 'block';
    tabLiEl.classList.add('ui-tabs-active','ui-state-active','active');
    tabLink.classList.add('active');
    tabLink.setAttribute('aria-selected', 'true');
    
    if (quizId) loadPGSettings(quizId);
  });

  // When other Canvas tabs are clicked, hide our panel
  tabNav.querySelectorAll('li > a, li, button[role="tab"]').forEach(btn => {
    if (btn.id === 'proctorguard_tab_link' || btn.id === 'proctorguard_tab_li') return;
    btn.addEventListener('click', () => {
      panel.style.display = 'none';
      tabLiEl.classList.remove('ui-tabs-active','ui-state-active','active');
      tabLink.classList.remove('active');
      tabLink.setAttribute('aria-selected', 'false');
    });
  });

  // Card descriptions dynamically updating the note paragraph
  const descriptions = {
    pg_cam: "Record Video will record the candidate's webcam feed during the exam.",
    pg_mic: "Record Audio will record the candidate's microphone audio during the exam.",
    pg_screen: "Record Screen will record the candidate's desktop screen during the exam.",
    pg_traffic: "Record Web Traffic will capture all network requests and URLs visited by the candidate during the exam.",
    pg_desk: "Secondary Mobile Camera will require the candidate to show their entire exam environment at intervals based on the option selected.",
    pg_fs: "Force Full Screen requires the exam to be taken in full screen mode, preventing access to other apps.",
    pg_one: "Only One Screen prevents candidates from using dual or multiple monitor setups.",
    pg_ntab: "Disable New Tabs prevents candidates from opening new browser tabs or windows during the exam.",
    pg_ctab: "Close Open Tabs prevents access to unauthorized material by requiring any other webpages to be closed before starting the exam.",
    pg_print: "Disable Printing disables the browser printing function to prevent exam content leaks.",
    pg_clip: "Disable Clipboard prevents copying, pasting, and cutting text during the exam.",
    pg_dl: "Block Downloads blocks any file downloads during the exam session.",
    pg_cache: "Clear Cache clears browser cache and history upon completing the exam.",
    pg_rc: "Disable Right Click disables right-clicking to prevent context menus from being opened.",
    pg_reen: "Prevent Re-entry prevents candidates from re-entering the exam if they exit before submitting.",
    pg_vvid: "Verify Video ensures the webcam is working and a face is clearly visible before starting.",
    pg_vaud: "Verify Audio checks the microphone volume level and functionality before starting.",
    pg_vdesk: "Verify Desktop requires checking the screen sharing permission and desktop state before starting.",
    pg_vid: "Verify ID requires the candidate to show a valid photo identification card to the webcam.",
    pg_vsig: "Verify Signature requires the candidate to sign a digital agreement before entering the exam.",
    pg_calc: "Calculator enables a basic or scientific calculator inside the exam player.",
    pg_wb: "Whiteboard enables a digital scratchpad/whiteboard tool for notes during the exam."
  };

  const defaults = {
    rec: "Secondary Mobile Camera will require the candidate to show their entire exam environment at intervals based on the option selected.",
    lock: "Close Open Tabs prevents access to unauthorized material by requiring any other webpages to be closed before starting the exam.",
    verify: "These options determine what will be verified prior to the exam.",
    tools: "These options enable helper tools inside the quiz player interface."
  };

  panel.querySelectorAll('.pg-lbl').forEach(label => {
    const checkbox = label.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    const id = checkbox.id;
    const section = label.closest('#pg-rec, #pg-lock, #pg-verify, #pg-tools');
    if (!section) return;
    const note = section.querySelector('.pg-note');
    if (!note) return;
    const sectionKey = note.getAttribute('data-pg-desc');
    
    label.addEventListener('mouseenter', () => {
      if (descriptions[id]) {
        note.textContent = descriptions[id];
      }
    });
    label.addEventListener('mouseleave', () => {
      note.textContent = defaults[sectionKey] || '';
    });
  });

  // Save button
  document.getElementById('pg-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('pg-save-btn');
    const ok  = document.getElementById('pg-save-ok');
    const err = document.getElementById('pg-save-err');
    if (!quizId) { err.textContent = 'Cannot save: Quiz ID not found. Save the quiz in Canvas first.'; err.style.display='inline'; return; }
    btn.disabled=true; btn.textContent='Saving...'; ok.style.display='none'; err.style.display='none';

    // Auto-check and trigger native checkbox on the Details tab
    const nativeCheckbox = document.getElementById('quiz_require_lockdown_browser');
    if (nativeCheckbox) {
      nativeCheckbox.checked = true;
      nativeCheckbox.dispatchEvent(new Event('change'));
    }

    const chk = id => { const el=document.getElementById(id); return el ? el.checked : false; };
    let maxAttempts = 1;
    const maCb = document.getElementById('multiple_attempts_option');
    if (maCb && maCb.checked) {
      const limCb = document.getElementById('limit_attempts_option');
      if (limCb && limCb.checked) { const ai=document.getElementById('quiz_allowed_attempts'); const p=ai?parseInt(ai.value,10):1; maxAttempts=isNaN(p)||p<=0?1:p; }
      else maxAttempts = 10000;
    }
    const titleEl = document.getElementById('quiz_title');
    const cMatch = window.location.pathname.match(/\/courses\/(\d+)/);
    const payload = {
      require_camera: chk('pg_cam'), require_mic: chk('pg_mic'), require_screen: chk('pg_screen'),
      require_fullscreen: chk('pg_fs'), disable_right_click: chk('pg_rc'), require_seb: false,
      disable_clipboard: chk('pg_clip'), disable_printing: chk('pg_print'), only_one_screen: chk('pg_one'),
      block_downloads: chk('pg_dl'), prevent_reentry: chk('pg_reen'), require_mobile_camera: chk('pg_desk'),
      record_web_traffic: chk('pg_traffic'), close_open_tabs: chk('pg_ctab'), disable_new_tabs: chk('pg_ntab'),
      clear_cache: chk('pg_cache'), verify_video: chk('pg_vvid'), verify_audio: chk('pg_vaud'),
      verify_desktop: chk('pg_vdesk'), verify_id: chk('pg_vid'), verify_signature: chk('pg_vsig'),
      allow_calculator: chk('pg_calc'), allow_whiteboard: chk('pg_wb'),
      max_attempts: maxAttempts,
      canvas_quiz_url: window.location.href.replace('/edit',''),
      title: titleEl ? titleEl.value : 'Untitled Quiz',
      canvas_course_id: cMatch ? cMatch[1] : ''
    };
    try {
      const token = await getExtensionToken();
      if (!token) throw new Error('ProctorGuard needs to reconnect — open your dashboard at proctor.siotw.net, then try saving again.');
      const res = await fetch(`${PG_API_BASE}/api/canvas-native/exam/${quizId}`, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`}, body:JSON.stringify(payload)
      });
      if (res.ok) { ok.style.display='inline'; setTimeout(()=>{ ok.style.display='none'; }, 4000); }
      else { const d=await res.json().catch(()=>{}); throw new Error((d&&d.error)||`Server error ${res.status}`); }
    } catch(e) { err.textContent=`Save failed: ${e.message}`; err.style.display='inline'; }
    btn.textContent='Save ProctorGuard Settings'; btn.disabled=false;
  });

  console.log('[ProctorGuard] Settings tab injected successfully.');
}

async function loadPGSettings(quizId) {
  try {
    const token = await getExtensionToken();
    if (!token) { console.log('[ProctorGuard] No extension token yet — open the dashboard once to connect.'); return; }
    const res = await fetch(`${PG_API_BASE}/api/canvas-native/exam/${quizId}`, { headers:{'Authorization':`Bearer ${token}`} });
    if (!res.ok) return;
    const d = await res.json();
    if (d.error) return;
    const s = (id, val) => { const el=document.getElementById(id); if(el) el.checked=!!val; };
    s('pg_cam',d.require_camera); s('pg_mic',d.require_mic); s('pg_screen',d.require_screen);
    s('pg_fs',d.require_fullscreen); s('pg_rc',d.disable_right_click); s('pg_clip',d.disable_clipboard);
    s('pg_print',d.disable_printing); s('pg_one',d.only_one_screen); s('pg_dl',d.block_downloads);
    s('pg_reen',d.prevent_reentry); s('pg_desk',d.require_mobile_camera); s('pg_traffic',d.record_web_traffic);
    s('pg_ctab',d.close_open_tabs); s('pg_ntab',d.disable_new_tabs); s('pg_cache',d.clear_cache);
    s('pg_vvid',d.verify_video); s('pg_vaud',d.verify_audio); s('pg_vdesk',d.verify_desktop);
    s('pg_vid',d.verify_id); s('pg_vsig',d.verify_signature);
    s('pg_calc',d.allow_calculator); s('pg_wb',d.allow_whiteboard);
    console.log('[ProctorGuard] Settings loaded.');
  } catch(e) { console.log('[ProctorGuard] Could not load settings:', e); }
}

// --- Start all integrations ---
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initExamReviewCenterIntegration();
    initQuizEditorIntegration();
  });
} else {
  initExamReviewCenterIntegration();
  initQuizEditorIntegration();
}

})(); // end review-center.js IIFE

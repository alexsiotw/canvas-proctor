// ================================================================
// content.js — broadly injected on every matched page (student exam
// pages included). This file intentionally contains NO API secrets
// and NO code that talks to the ProctorGuard backend's teacher-only
// endpoints. That logic lives in review-center.js, which is only
// injected programmatically (via background.js) into tabs where
// isCanvasTeacherContext() below has already returned true — so a
// student inspecting this file's source never sees the shared secret
// or any review-center networking code at all, because it was never
// sent to their browser in the first place.
// ================================================================

// Debug logging is off by default so a public release doesn't spam
// session data and internal state to the console of every Canvas page.
const PG_DEBUG = false;
if (!PG_DEBUG) {
  console.log = function () {};
}

// Inject extension presence flag in document element
document.documentElement.dataset.proctorExtensionInstalled = "true";

// Listen to page postMessage events (sent by LTI student page or Canvas page)
window.addEventListener("message", (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "START_EXAM_LOCKDOWN") {
    console.log("[Content Script] Relaying START_EXAM to background worker...");
    chrome.runtime.sendMessage({
      type: "START_EXAM",
      examId: data.examId,
      token: data.token,
      settings: data.settings
    }, (response) => {
      console.log("[Content Script] Background response:", response);
    });
  } 
  
  else if (data.type === "END_EXAM_LOCKDOWN") {
    console.log("[Content Script] Relaying END_EXAM to background worker...");
    chrome.runtime.sendMessage({ type: "END_EXAM" }, (response) => {
      console.log("[Content Script] Background response:", response);
    });
  }
});

// Check status from background and sync exam settings
let examActive = false;
let examSettings = {};

function syncExamStatus() {
  chrome.runtime.sendMessage({ type: "CHECK_EXTENSION_STATUS" }, (response) => {
    if (chrome.runtime.lastError) return; // Extension context invalidated
    if (response && response.active) {
      examActive = true;
      examSettings = response.settings || {};
      enablePageRestrictions();
      enforceExamUI();
    } else {
      examActive = false;
      examSettings = {};
      restoreExamUI();
    }
  });
}

// Check every 1 second to update restrictions state
setInterval(syncExamStatus, 1000);
syncExamStatus();

// Listen to broadcasts from background (settings updates, exam end)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXAM_SETTINGS_UPDATE") {
    examSettings = message.settings || {};
    examActive = true;
    enablePageRestrictions();
    sendResponse({ received: true });
  } else if (message.type === "EXAM_ENDED") {
    examActive = false;
    examSettings = {};
    restoreExamUI();
    sendResponse({ received: true });
  } else if (message.type === "DISPLAY_VIOLATION") {
    window.postMessage({ type: "EXTENSION_DISPLAY_VIOLATION", displayCount: message.displayCount }, "*");
    sendResponse({ received: true });
  } else if (message.type === "DISPLAY_RESOLVED") {
    window.postMessage({ type: "EXTENSION_DISPLAY_RESOLVED" }, "*");
    sendResponse({ received: true });
  }
  return true;
});

function enablePageRestrictions() {
  // Prevent Right Click (only if disable_right_click is set, or always for DevTools protection)
  if (examSettings.disable_right_click !== false) {
    document.addEventListener("contextmenu", preventContextMenu, true);
  }

  // Prevent Copy / Cut / Paste (only if disable_clipboard is set)
  if (examSettings.disable_clipboard) {
    document.addEventListener("copy", preventClipboard, true);
    document.addEventListener("cut", preventClipboard, true);
    document.addEventListener("paste", preventClipboard, true);
  }

  // Always block DevTools shortcuts; block printing only if disable_printing is set
  document.addEventListener("keydown", blockKeyboardShortcuts, true);

  // Prevent printing via CSS injection if disable_printing is enabled
  if (examSettings.disable_printing && !document.getElementById('proctor-no-print-style')) {
    const style = document.createElement('style');
    style.id = 'proctor-no-print-style';
    style.textContent = '@media print { body { display: none !important; } }';
    document.head.appendChild(style);
    window.addEventListener('beforeprint', (e) => { e.preventDefault(); }, true);
  }
}

function enforceExamUI() {
  if (!examActive) return;

  // 1. Hide Canvas navigation & expand main layout
  if (!document.getElementById('proctor-hide-nav-style')) {
    const style = document.createElement('style');
    style.id = 'proctor-hide-nav-style';
    style.textContent = `
      #header, #left-side, .ic-app-nav-toggle-and-crumbs, #breadcrumbs { display: none !important; }
      #wrapper, #wrapper-container, body.ic-fixed-layout #wrapper { margin-left: 0 !important; padding-left: 0 !important; }
      .ic-app-main-content { margin-left: 0 !important; }
      .ic-Layout-wrapper { max-width: 100% !important; margin: 0 !important; padding: 20px !important; }
      .ic-Layout-columns { margin: 0 !important; }
    `;
    document.head.appendChild(style);
  }

  // 2. Automatically click "Take the Quiz" or "Take the Quiz Again"
  const takeBtn = document.getElementById('take_quiz_link');
  if (takeBtn && !takeBtn.dataset.proctorAutoClicked) {
    takeBtn.dataset.proctorAutoClicked = "true";
    takeBtn.click();
  }
}

function restoreExamUI() {
  const style = document.getElementById('proctor-hide-nav-style');
  if (style) style.remove();
}

function preventContextMenu(e) {
  if (examActive) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function preventClipboard(e) {
  if (examActive && examSettings.disable_clipboard) {
    e.preventDefault();
    e.stopPropagation();
    window.postMessage({
      type: "EXTENSION_WARNING",
      message: "Clipboard actions are disabled during this proctored exam."
    }, "*");
  }
}

function preventDefaultAction(e) {
  if (examActive) {
    e.preventDefault();
    e.stopPropagation();
    window.postMessage({
      type: "EXTENSION_WARNING",
      message: "This action is disabled under Secure Proctor Mode."
    }, "*");
  }
}

function blockKeyboardShortcuts(e) {
  if (!examActive) return;

  // F12
  if (e.keyCode === 123) {
    triggerBlock(e, "Developer Tools (F12)");
  }
  
  // Ctrl+Shift+I / Cmd+Opt+I (DevTools)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.keyCode === 73) {
    triggerBlock(e, "Developer Tools");
  }

  // Ctrl+Shift+J / Cmd+Opt+J (DevTools Console)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.keyCode === 74) {
    triggerBlock(e, "Developer Tools Console");
  }

  // Ctrl+Shift+C / Cmd+Opt+C (DevTools Inspect)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.keyCode === 67) {
    triggerBlock(e, "Developer Tools Inspect");
  }

  // Ctrl+S / Cmd+S (Save Page)
  if ((e.ctrlKey || e.metaKey) && e.keyCode === 83) {
    triggerBlock(e, "Save Page");
  }

  // Ctrl+P / Cmd+P (Print Page)
  if ((e.ctrlKey || e.metaKey) && e.keyCode === 80) {
    triggerBlock(e, "Print Page");
  }
}

function triggerBlock(e, shortcutName) {
  e.preventDefault();
  e.stopPropagation();
  window.postMessage({
    type: "EXTENSION_WARNING",
    message: `Shortcut "${shortcutName}" is disabled during the exam.`
  }, "*");
}

// Detect whether the current Canvas page is being viewed by a teacher/TA/admin,
// as opposed to a student. Read via DOM (Canvas's ENV JS object lives in the page's
// main world and isn't reachable from this isolated-world content script), so we
// parse the inline ENV script tag Canvas always renders server-side.
function isCanvasTeacherContext() {
  try {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent;
      if (!text || !text.includes('current_user_roles')) continue;
      const match = text.match(/"current_user_roles"\s*:\s*(\[[^\]]*\])/);
      if (match) {
        const roles = JSON.parse(match[1]);
        return roles.some(r => ['teacher', 'ta', 'admin', 'designer'].includes(r));
      }
    }
  } catch (e) { /* fall through to DOM heuristic below */ }

  // Fallback: elements Canvas only renders for users with edit/manage permissions on the quiz.
  return !!document.querySelector('a.edit_assignment_link, a[href*="/moderate"], .quiz-edit-button, #quiz-edit-link');
}

// ----------------------------------------------------------------
// Conditionally request injection of review-center.js (the file that
// holds the shared secret + all teacher-only networking). We only ask
// background.js to inject it when this page looks like a teacher/TA/
// admin context AND the URL is one where the review center or quiz
// editor settings tab is actually relevant. A student's own exam page
// never triggers this, so review-center.js's source is never sent to
// their browser at all — not merely hidden behind a UI check.
(function maybeRequestReviewCenterInjection() {
  const url = window.location.href;
  const isRelevantPage = /\/quizzes\//.test(url) || /\/gradebook\/speed_grader/.test(url);
  if (!isRelevantPage) return;

  const request = () => {
    if (!isCanvasTeacherContext()) return;
    chrome.runtime.sendMessage({ type: 'REQUEST_REVIEW_CENTER_INJECTION' }, () => {
      if (chrome.runtime.lastError) { /* tab/context gone, ignore */ }
    });
  };

  // Canvas's ENV script tag / teacher-only DOM markers may not be present yet at
  // document_start, so check now and again shortly after the DOM settles.
  request();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', request);
  } else {
    setTimeout(request, 500);
  }
})();

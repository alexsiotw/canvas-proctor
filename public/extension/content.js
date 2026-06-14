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

// Listen to messages from the background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "DISPLAY_VIOLATION") {
    // Forward the display violation to the page
    window.postMessage({
      type: "EXTENSION_DISPLAY_VIOLATION",
      displayCount: message.displayCount
    }, "*");
    sendResponse({ received: true });
  } else if (message.type === "DISPLAY_RESOLVED") {
    // Forward display resolution to the page
    window.postMessage({
      type: "EXTENSION_DISPLAY_RESOLVED"
    }, "*");
    sendResponse({ received: true });
  }
  return true;
});

// Check status from background to decide if we should block browser actions
let examActive = false;
function updateExamStatus() {
  chrome.runtime.sendMessage({ type: "CHECK_EXTENSION_STATUS" }, (response) => {
    if (response && response.active) {
      examActive = true;
      enablePageRestrictions();
    } else {
      examActive = false;
    }
  });
}

// Check every 1 second to update restrictions state
setInterval(updateExamStatus, 1000);
updateExamStatus();

function enablePageRestrictions() {
  // Prevent Right Click
  document.addEventListener("contextmenu", preventDefaultAction, true);

  // Prevent Copy / Cut / Paste
  document.addEventListener("copy", preventDefaultAction, true);
  document.addEventListener("cut", preventDefaultAction, true);
  document.addEventListener("paste", preventDefaultAction, true);

  // Prevent keyboard shortcuts (F12, DevTools, Printing, Saving)
  document.addEventListener("keydown", blockKeyboardShortcuts, true);
}

function preventDefaultAction(e) {
  if (examActive) {
    e.preventDefault();
    e.stopPropagation();
    // Dispatch a warning message to the client
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

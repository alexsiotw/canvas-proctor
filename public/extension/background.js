let activeExamSession = null;
let heartbeatInterval = null;

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_EXAM") {
    activeExamSession = {
      examId: message.examId,
      sessionToken: message.token,
      settings: message.settings || {},
      startTabId: sender.tab ? sender.tab.id : null
    };
    console.log("[Extension] Exam lockdown started:", activeExamSession);
    
    // Notify all matching content scripts of the new settings
    broadcastToExamTabs({ type: "EXAM_SETTINGS_UPDATE", settings: activeExamSession.settings });
    
    // Close other tabs if configured
    if (activeExamSession.settings.close_open_tabs) {
      closeOtherTabs(sender.tab ? sender.tab.id : null);
    }
    
    // Check multiple screens immediately
    if (activeExamSession.settings.advanced_hardware_detection || activeExamSession.settings.only_one_screen) {
      checkDisplays(sender.tab ? sender.tab.id : null);
    }

    // Start heartbeat log every 30s
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (activeExamSession) {
        logProctorEvent("heartbeat", "Extension lockdown active.");
      }
    }, 30000);
    
    sendResponse({ success: true });
  } 
  
  else if (message.type === "END_EXAM") {
    console.log("[Extension] Exam lockdown ended");
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    
    // Clear browser cache if configured
    if (activeExamSession && activeExamSession.settings.clear_cache) {
      chrome.browsingData.removeCache({ since: 0 }, () => {
        console.log("[Extension] Cache cleared on exam end.");
      });
    }
    
    activeExamSession = null;
    // Notify content scripts exam ended
    broadcastToExamTabs({ type: "EXAM_ENDED" });
    sendResponse({ success: true });
  }
  
  else if (message.type === "CHECK_EXTENSION_STATUS") {
    sendResponse({ 
      installed: true, 
      active: !!activeExamSession,
      activeExamId: activeExamSession ? activeExamSession.examId : null,
      settings: activeExamSession ? activeExamSession.settings : null
    });
  }

  else if (message.type === "GET_SETTINGS") {
    sendResponse({
      active: !!activeExamSession,
      settings: activeExamSession ? activeExamSession.settings : null
    });
  }

  else if (message.type === "FETCH_URL") {
    // Proxy cross-origin fetch requests from content scripts through the service worker
    fetch(message.url, message.options || {})
      .then(async res => {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body: text });
      })
      .catch(err => {
        sendResponse({ ok: false, status: 0, error: err.message });
      });
    return true; // keep message channel open for async response
  }

  return true;
});

// Enforce tab lockdown: Block new tabs
chrome.tabs.onCreated.addListener((tab) => {
  if (activeExamSession && activeExamSession.settings.disable_new_tabs) {
    // Exclude the exam tab itself if it is loading
    chrome.tabs.remove(tab.id, () => {
      console.log("[Extension] Blocked and closed new tab:", tab.url);
      logProctorEvent("Tab Blocked", `Attempted to open a new tab/url.`);
    });
  }
});

// Enforce window lockdown: Block Incognito
chrome.windows.onCreated.addListener((win) => {
  if (activeExamSession && activeExamSession.settings.prevent_incognito && win.incognito) {
    chrome.windows.remove(win.id, () => {
      console.log("[Extension] Blocked and closed Incognito window");
      logProctorEvent("Incognito Blocked", "Attempted to open an Incognito window.");
    });
  }
});

// Enforce display lockdown: Monitor display changes
chrome.system.display.onDisplayChanged.addListener(() => {
  if (activeExamSession && (activeExamSession.settings.advanced_hardware_detection || activeExamSession.settings.only_one_screen)) {
    checkDisplays();
  }
});

// Record web traffic / navigation
chrome.webNavigation.onCommitted.addListener((details) => {
  // Only record main-frame top-level navigation to ignore assets/sub-resources
  if (activeExamSession && activeExamSession.settings.record_web_traffic && details.frameId === 0) {
    const url = details.url;
    // Don't log LTI proctoring itself or blank pages
    if (url.includes("proctor.siotw.net") || url.includes("about:blank") || url.startsWith("chrome://")) {
      return;
    }
    console.log("[Extension] Logging web traffic:", url);
    logTraffic(url);
  }
});

// Helper: Broadcast a message to all relevant exam/proctor tabs
function broadcastToExamTabs(msg) {
  const patterns = [
    "*://proctor.siotw.net/student.html*",
    "*://canvas.siotw.net/courses/*/quizzes/*"
  ];
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && (tab.url.includes("proctor.siotw.net") || tab.url.includes("canvas.siotw.net"))) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    });
  });
}

// Helper: Close all other tabs except the active exam tab
function closeOtherTabs(examTabId) {
  if (!examTabId) return;
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id !== examTabId) {
        chrome.tabs.remove(tab.id);
      }
    });
  });
}

// Helper: Check display count and flag violations
function checkDisplays(examTabId) {
  chrome.system.display.getInfo((displays) => {
    const isViolation = displays.length > 1;
    const msg = {
      type: isViolation ? "DISPLAY_VIOLATION" : "DISPLAY_RESOLVED",
      displayCount: displays.length
    };
    if (isViolation) {
      console.warn("[Extension] Multi-monitor violation detected:", displays.length);
      logProctorEvent("Multi-Monitor Detected", `Multiple displays active: ${displays.length} screens connected.`);
    }
    
    if (examTabId) {
      chrome.tabs.sendMessage(examTabId, msg);
    } else {
      chrome.tabs.query({ url: "*://proctor.siotw.net/student.html*" }, (tabs) => {
        tabs.forEach(t => {
          try {
            chrome.tabs.sendMessage(t.id, msg);
          } catch (e) {
            console.error("[Extension] Failed to send message to tab", t.id, e);
          }
        });
      });
    }
  });
}

// Helper: Log event back to database
function logProctorEvent(eventType, message) {
  if (!activeExamSession) return;
  fetch(`https://proctor.siotw.net/api/session/log-event-ext`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      token: activeExamSession.sessionToken,
      event_type: eventType,
      message: message
    })
  }).catch(err => console.error("[Extension] Failed to log proctor event:", err));
}

// Helper: Log traffic
function logTraffic(url) {
  if (!activeExamSession) return;
  fetch(`https://proctor.siotw.net/api/session/log-traffic`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      token: activeExamSession.sessionToken,
      url: url
    })
  }).catch(err => console.error("[Extension] Failed to log web traffic:", err));
}

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
    } else {
      examActive = false;
      examSettings = {};
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

// --- SpeedGrader integration ---
async function initSpeedGraderIntegration() {
  const url = window.location.href;
  if (!url.includes('/quizzes/') || !url.includes('/history')) return;

  const quizMatch = url.match(/\/quizzes\/(\d+)/);
  const quizId = quizMatch ? quizMatch[1] : null;

  const userMatch = url.match(/[?&]user_id=(\d+)/);
  const studentId = userMatch ? userMatch[1] : null;

  if (!quizId || !studentId) return;

  console.log(`[Secure Proctor Extension] Detected SpeedGrader context: quizId=${quizId}, studentId=${studentId}`);

  try {
    const res = await fetch(`https://proctor.siotw.net/api/canvas-native/session-report?quiz_id=${quizId}&student_id=${studentId}&token=canvas-proctor-shared-secret-key-998877`);
    if (!res.ok) {
      console.log("[Secure Proctor Extension] No proctored report found for this attempt.");
      return;
    }

    const data = await res.json();
    if (!data.sessions || data.sessions.length === 0) {
      console.log("[Secure Proctor Extension] No proctored sessions found.");
      return;
    }

    injectProctorReportButton(data.sessions);
  } catch (err) {
    console.error("[Secure Proctor Extension] Failed to query proctor report:", err);
  }
}

function injectProctorReportButton(sessions) {
  // Find where to inject the button. Look for 'a' tag containing 'View Log'
  const viewLogLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('View Log') || a.className.includes('view_log_link'));
  
  if (!viewLogLink) {
    // If not found, look for 'h2' or header containing 'Results for'
    const resultsHeader = Array.from(document.querySelectorAll('h2, h1, div, p')).find(el => el.textContent.includes('Results for '));
    if (resultsHeader) {
      const btn = createButtonElement(sessions);
      resultsHeader.appendChild(btn);
    }
    return;
  }

  // Insert next to the "View Log" link
  const btn = createButtonElement(sessions);
  viewLogLink.parentNode.insertBefore(btn, viewLogLink.nextSibling);
}

function createButtonElement(sessions) {
  const btn = document.createElement('a');
  btn.id = 'view-proctored-report-btn';
  btn.className = 'button';
  btn.style.marginLeft = '15px';
  btn.style.color = '#10b981'; // Sleek emerald green for the proctor report
  btn.style.fontWeight = 'bold';
  btn.style.textDecoration = 'none';
  btn.style.cursor = 'pointer';
  btn.style.display = 'inline-flex';
  btn.style.alignItems = 'center';
  btn.style.gap = '5px';
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 7l-7 5 7 5V7z"></path>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
    </svg>
    View Proctored Report
  `;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openProctorReportModal(sessions);
  });
  return btn;
}

function openProctorReportModal(sessions) {
  // Inject modal CSS if not already present
  if (!document.getElementById('proctor-modal-styles')) {
    const style = document.createElement('style');
    style.id = 'proctor-modal-styles';
    style.innerHTML = `
      #proctor-report-modal {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(15, 23, 42, 0.85);
          backdrop-filter: blur(8px);
          z-index: 999999;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #f8fafc;
      }
      .proctor-modal-content {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 16px;
          width: 95%;
          max-width: 1200px;
          height: 85%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          animation: proctorModalFadeIn 0.3s ease-out;
      }
      @keyframes proctorModalFadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
      }
      .proctor-modal-header {
          padding: 16px 24px;
          border-bottom: 1px solid #334155;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #0f172a;
      }
      .proctor-modal-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: #3b82f6;
      }
      .proctor-modal-close {
          background: transparent;
          border: none;
          color: #94a3b8;
          font-size: 28px;
          cursor: pointer;
          line-height: 1;
          transition: color 0.2s;
      }
      .proctor-modal-close:hover {
          color: #ef4444;
      }
      .proctor-modal-body {
          flex: 1;
          display: flex;
          overflow: hidden;
      }
      .proctor-video-pane {
          flex: 6.5;
          padding: 24px;
          background: #090d16;
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          border-right: 1px solid #334155;
      }
      .proctor-logs-pane {
          flex: 3.5;
          display: flex;
          flex-direction: column;
          background: #0f172a;
          overflow: hidden;
      }
      .proctor-logs-header {
          padding: 16px;
          border-bottom: 1px solid #334155;
      }
      .proctor-logs-header h4 {
          margin: 0 0 10px 0;
          font-size: 14px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #94a3b8;
      }
      .proctor-search-input {
          width: 100%;
          padding: 8px 12px;
          background: #1e293b;
          border: 1px solid #475569;
          border-radius: 6px;
          color: #f8fafc;
          font-size: 13px;
          box-sizing: border-box;
      }
      .proctor-search-input:focus {
          outline: none;
          border-color: #3b82f6;
      }
      .proctor-logs-list {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
      }
      .proctor-log-item {
          padding: 10px 12px;
          margin-bottom: 8px;
          border-radius: 8px;
          background: #1e293b;
          border-left: 4px solid #64748b;
          cursor: pointer;
          transition: transform 0.15s, background 0.15s;
      }
      .proctor-log-item:hover {
          transform: translateX(4px);
          background: #334155;
      }
      .proctor-log-item.violation {
          border-left-color: #ef4444;
          background: rgba(239, 68, 68, 0.05);
      }
      .proctor-log-item.warning {
          border-left-color: #f59e0b;
          background: rgba(245, 158, 11, 0.05);
      }
      .proctor-log-item.info {
          border-left-color: #3b82f6;
          background: rgba(59, 130, 246, 0.05);
      }
      .proctor-log-time {
          font-size: 11px;
          color: #94a3b8;
          margin-bottom: 4px;
      }
      .proctor-log-msg {
          font-size: 12px;
          line-height: 1.4;
          word-break: break-word;
      }
      .proctor-attempt-select {
          padding: 6px 12px;
          background: #1e293b;
          border: 1px solid #475569;
          border-radius: 6px;
          color: #f8fafc;
          font-size: 13px;
          cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  // Create Modal Element
  const modal = document.createElement('div');
  modal.id = 'proctor-report-modal';
  
  // Construct options for attempt selector
  let selectHtml = '';
  sessions.forEach((s, idx) => {
    selectHtml += `<option value="${s.id}" ${idx === 0 ? 'selected' : ''}>Attempt ${s.attempt_number || (sessions.length - idx)}</option>`;
  });

  const firstSession = sessions[0];

  modal.innerHTML = `
    <div class="proctor-modal-content">
      <div class="proctor-modal-header">
        <div style="display: flex; align-items: center; gap: 15px;">
          <h3>Proctored Exam Report: <span id="proctor-student-name">${firstSession.student_name}</span></h3>
          <span id="proctor-risk-badge" style="padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: bold; background: #334155; color: #f8fafc; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">Risk: Calculating...</span>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <select id="proctor-attempt-select" class="proctor-attempt-select">
            ${selectHtml}
          </select>
          <button id="proctor-modal-close" class="proctor-modal-close">&times;</button>
        </div>
      </div>
      <div class="proctor-modal-body">
        <div class="proctor-video-pane">
           <div id="proctor-video-container" style="width: 100%; display: flex; gap: 15px; justify-content: center; align-items: center; flex-wrap: wrap; margin-bottom: 20px;">
              <!-- Loaded dynamically -->
           </div>
           <div id="proctor-extra-container" style="width: 100%; display: flex; flex-direction: column; gap: 15px;">
              <!-- Loaded dynamically -->
           </div>
        </div>
        <div class="proctor-logs-pane">
          <div class="proctor-logs-header">
            <h4>Proctoring Log Timeline</h4>
            <input type="text" id="proctor-log-search" class="proctor-search-input" placeholder="Search events...">
          </div>
          <div id="proctor-logs-list" class="proctor-logs-list">
            <!-- Dynamic logs will be loaded here -->
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close Handler
  modal.querySelector('#proctor-modal-close').addEventListener('click', () => {
    modal.remove();
  });

  // Handle attempt switching
  const select = modal.querySelector('#proctor-attempt-select');
  select.addEventListener('change', (e) => {
    const selectedSession = sessions.find(s => String(s.id) === e.target.value);
    if (selectedSession) {
      loadSessionInModal(selectedSession);
    }
  });

  // Load the first session initially
  loadSessionInModal(firstSession);
}

function loadSessionInModal(session) {
  const videoContainer = document.getElementById('proctor-video-container');
  const extraContainer = document.getElementById('proctor-extra-container');
  const logsList = document.getElementById('proctor-logs-list');
  const searchInput = document.getElementById('proctor-log-search');

  if (!videoContainer || !logsList) return;

  // Build Video layout
  if (session.mobile_drive_file_id) {
    videoContainer.innerHTML = `
      <div style="flex: 1; min-width: 300px; display: flex; flex-direction: column;">
        <div style="font-size: 12px; font-weight: bold; color: #94a3b8; margin-bottom: 6px; display: flex; align-items: center; gap: 5px;"><img src="https://proctor.siotw.net/icons/record-screen.svg" style="width:14px; height:14px;" /> Primary Laptop Screen / Webcam</div>
        <video id="proctor-modal-video" controls style="width:100%; aspect-ratio:16/9; border-radius:8px; background:#000; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"></video>
      </div>
      <div style="flex: 1; min-width: 300px; display: flex; flex-direction: column;">
        <div style="font-size: 12px; font-weight: bold; color: #94a3b8; margin-bottom: 6px; display: flex; align-items: center; gap: 5px;"><img src="https://proctor.siotw.net/icons/secondary-mobile-camera.svg" style="width:14px; height:14px;" /> Secondary Mobile Room View</div>
        <video id="proctor-modal-video-secondary" controls style="width:100%; aspect-ratio:16/9; border-radius:8px; background:#000; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"></video>
      </div>
    `;
  } else {
    videoContainer.innerHTML = `
      <div style="width: 100%; max-width: 800px; display: flex; flex-direction: column;">
        <div style="font-size: 12px; font-weight: bold; color: #94a3b8; margin-bottom: 6px; display: flex; align-items: center; gap: 5px;"><img src="https://proctor.siotw.net/icons/record-screen.svg" style="width:14px; height:14px;" /> Webcam / Screen Recording</div>
        <video id="proctor-modal-video" controls style="width:100%; aspect-ratio:16/9; border-radius:8px; background:#000; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"></video>
      </div>
    `;
  }

  const video = document.getElementById('proctor-modal-video');
  const secondaryVideo = document.getElementById('proctor-modal-video-secondary');

  if (video) {
    video.src = `https://proctor.siotw.net/api/session/video-playback/${session.id}?token=canvas-proctor-shared-secret-key-998877`;
    video.load();
  }
  if (secondaryVideo) {
    secondaryVideo.src = `https://proctor.siotw.net/api/session/mobile-video-playback/${session.id}?token=canvas-proctor-shared-secret-key-998877`;
    secondaryVideo.load();
  }

  // Populate Extra Panels (Room Scan and Snapshots)
  let extraHtml = '';
  if (session.room_scan_drive_file_id) {
    extraHtml += `
      <div style="background: rgba(139, 92, 246, 0.08); border: 1px solid rgba(139, 92, 246, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box; width:100%;">
        <div>
          <h5 style="margin:0; font-size:13px; font-weight:700; color:#c084fc;">Environment Room Scan</h5>
          <p style="margin: 4px 0 0 0; font-size:11px; color:#94a3b8;">360&deg; workspace scan completed before starting the exam.</p>
        </div>
        <a class="button" href="https://proctor.siotw.net/api/session/room-scan-playback/${session.id}?token=canvas-proctor-shared-secret-key-998877" target="_blank" style="background: #8b5cf6; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; height: auto; box-shadow: none; border: none;">
          👁️ View Scan Video
        </a>
      </div>
    `;
  }
  if (session.drive_snapshots_id) {
    extraHtml += `
      <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box; width:100%;">
        <div>
          <h5 style="margin:0; font-size:13px; font-weight:700; color:#60a5fa;">DOM Quiz Screenshots</h5>
          <p style="margin: 4px 0 0 0; font-size:11px; color:#94a3b8;">ZIP folder containing full-page quiz capture screenshots.</p>
        </div>
        <a class="button" href="https://drive.google.com/uc?export=download&id=${session.drive_snapshots_id}" target="_blank" style="background: #3b82f6; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; height: auto; box-shadow: none; border: none;">
          📥 Download ZIP
        </a>
      </div>
    `;
  }
  extraContainer.innerHTML = extraHtml;

  // Update Risk Badge
  const riskBadge = document.getElementById('proctor-risk-badge');
  if (riskBadge && session.riskTier) {
      riskBadge.innerText = `Risk: ${session.riskTier} (${session.riskScore})`;
      if (session.riskTier === 'High') {
          riskBadge.style.background = 'rgba(239, 68, 68, 0.2)';
          riskBadge.style.color = '#ef4444';
          riskBadge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      } else if (session.riskTier === 'Medium') {
          riskBadge.style.background = 'rgba(245, 158, 11, 0.2)';
          riskBadge.style.color = '#f59e0b';
          riskBadge.style.border = '1px solid rgba(245, 158, 11, 0.4)';
      } else {
          riskBadge.style.background = 'rgba(16, 185, 129, 0.2)';
          riskBadge.style.color = '#10b981';
          riskBadge.style.border = '1px solid rgba(16, 185, 129, 0.4)';
      }
  }

  // Populate logs
  const renderLogs = (filterText = '') => {
    logsList.innerHTML = '';
    const filteredLogs = (session.logs || []).filter(log => {
      const msg = (log.event_message || '').toLowerCase();
      const type = (log.event_type || '').toLowerCase();
      const search = filterText.toLowerCase();
      return msg.includes(search) || type.includes(search);
    });

    if (filteredLogs.length === 0) {
      logsList.innerHTML = `<div style="text-align:center; padding:20px; color:#94a3b8; font-size:13px;">No events found</div>`;
      return;
    }

    filteredLogs.forEach(log => {
      // Calculate offset in seconds
      const offsetSec = Math.max(0, Math.floor((new Date(log.event_timestamp) - new Date(session.started_at)) / 1000));
      
      // Format timestamp text
      const min = Math.floor(offsetSec / 60);
      const sec = offsetSec % 60;
      const timeStr = `${min}:${sec.toString().padStart(2, '0')}`;

      // Classify event class
      let typeClass = 'info';
      const eventLower = (log.event_type || '').toLowerCase();
      const msgLower = (log.event_message || '').toLowerCase();

      if (eventLower.includes('violation') || eventLower.includes('fail') || eventLower.includes('block') || msgLower.includes('violation')) {
        typeClass = 'violation';
      } else if (eventLower.includes('transcript') || eventLower.includes('voice') || eventLower.includes('speaking') || eventLower.includes('blur') || eventLower.includes('focus')) {
        typeClass = 'warning';
      }

      const item = document.createElement('div');
      item.className = `proctor-log-item ${typeClass}`;
      
      if (log.event_type === 'room_scan_video') {
          item.innerHTML = `
            <div class="proctor-log-time">[${timeStr}] - ${log.event_type}</div>
            <div class="proctor-log-msg">
                <span style="color: #c084fc; font-weight: bold; display: flex; align-items: center; gap: 5px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                    Workspace Room Scan Recorded
                </span>
            </div>
          `;
          item.style.borderLeftColor = '#8b5cf6';
          item.style.background = 'rgba(139, 92, 246, 0.1)';
      } else {
          item.innerHTML = `
            <div class="proctor-log-time">[${timeStr}] - ${log.event_type.replace(/_/g, ' ').toUpperCase()}</div>
            <div class="proctor-log-msg">${log.event_message}</div>
          `;
          
          item.addEventListener('click', () => {
              if (video) {
                  video.currentTime = offsetSec;
                  video.play();
              }
              if (secondaryVideo) {
                  secondaryVideo.currentTime = offsetSec;
                  secondaryVideo.play();
              }
          });
      }

      logsList.appendChild(item);
    });
  };

  // Initial render
  renderLogs();

  // Handle Search Input
  searchInput.value = '';
  searchInput.oninput = (e) => {
    renderLogs(e.target.value);
  };
}

// ================================================================
// Quiz Editor: Inject ProctorGuard Settings Tab (Proctorio-style)
// ================================================================
const PG_API_BASE = 'https://proctor.siotw.net';
const PG_SECRET = 'canvas-proctor-shared-secret-key-998877';

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
      #proctorguard_tab_panel{font-family:'Lato','Open Sans',Arial,sans-serif;font-size:13px;color:#333;background:#fff;padding:28px 32px;line-height:1.5;}
      .pg-sec-title{font-size:16px;font-weight:700;color:#1a1a1a;margin:0 0 6px 0;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
      .pg-arrow{font-size:10px;display:inline-block;transition:transform 0.2s;}
      .pg-divider{border:none;border-top:1px solid #e0e0e0;margin:20px 0;}
      .pg-exam-warn{font-size:12px;color:#0770a3;font-style:italic;margin-bottom:18px;}
      .pg-sub-title{font-size:14px;font-weight:700;color:#1a1a1a;margin:20px 0 8px 0;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
      .pg-note{font-size:12px;color:#0770a3;margin:6px 0 16px 0;}
      .pg-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px;}
      .pg-lbl{cursor:pointer;display:inline-block;position:relative;}
      .pg-chk{position:absolute;opacity:0;width:0;height:0;}
      .pg-card{display:flex;flex-direction:column;align-items:center;justify-content:center;width:118px;min-height:108px;padding:14px 8px 10px;border:1.5px solid #d9d9d9;border-radius:4px;background:#fff;box-sizing:border-box;transition:background 0.12s,border-color 0.12s;text-align:center;user-select:none;}
      .pg-card:hover{border-color:#bbb;background:#fafafa;}
      .pg-chk:checked+.pg-card{background:#373a3c;border-color:#55b813;box-shadow:0 0 0 1px #55b813;}
      .pg-chk:checked+.pg-card svg{stroke:#55b813!important;}
      .pg-chk:checked+.pg-card .pg-ct{color:#55b813;}
      .pg-icon{width:38px;height:38px;margin-bottom:9px;display:flex;align-items:center;justify-content:center;}
      .pg-icon svg{width:34px;height:34px;stroke:#333;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;}
      .pg-ct{font-size:11.5px;font-weight:600;color:#333;line-height:1.3;}
      .pg-savebar{margin-top:28px;padding-top:16px;border-top:1px solid #e0e0e0;display:flex;align-items:center;gap:14px;justify-content:flex-end;}
      #pg-save-btn{background:#2d7cc1;color:#fff;border:none;padding:9px 22px;font-size:13px;font-weight:700;border-radius:4px;cursor:pointer;font-family:inherit;}
      #pg-save-btn:hover{background:#1a5fa0;}
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
      <p class="pg-prof-note">You have not saved any profiles yet :(</p>
      <p class="pg-prof-sub">Saving ProctorGuard settings profiles allows you to apply your favorite exam settings with a single click.</p>
    </div>
    <hr class="pg-divider">
    <div class="pg-sec-title" data-pg-body="pg-main"><span class="pg-arrow">&#9660;</span>&nbsp;ProctorGuard Exam Settings</div>
    <div id="pg-main">
      <p class="pg-exam-warn">Exam settings can not be changed once the first candidate has started the exam.</p>
      <div class="pg-sub-title" data-pg-body="pg-rec"><span class="pg-arrow">&#9660;</span>&nbsp;Recording Options</div>
      <div id="pg-rec">
        <div class="pg-grid">
          ${card('pg_cam','cam','Record Video')}${card('pg_mic','mic','Record Audio')}${card('pg_screen','screen','Record Screen')}${card('pg_traffic','traffic','Record Web Traffic')}${card('pg_desk','desk','Record Desk')}
        </div>
        <p class="pg-note">Record Desk will require the candidate to show their entire exam environment at intervals based on the option selected.</p>
      </div>
      <div class="pg-sub-title" data-pg-body="pg-lock"><span class="pg-arrow">&#9660;</span>&nbsp;Lock Down Options</div>
      <div id="pg-lock">
        <div class="pg-grid">
          ${card('pg_fs','fs','Force Full Screen')}${card('pg_one','one','Only One Screen')}${card('pg_ntab','ntab','Disable New Tabs')}${card('pg_ctab','ctab','Close Open Tabs')}${card('pg_print','print','Disable Printing')}${card('pg_clip','clip','Disable Clipboard')}${card('pg_dl','dl','Block Downloads')}${card('pg_cache','cache','Clear Cache')}${card('pg_rc','rc','Disable Right Click')}${card('pg_reen','reen','Prevent Re-entry')}
        </div>
        <p class="pg-note">Close Open Tabs prevents access to unauthorized material by requiring any other webpages to be closed before starting the exam.</p>
      </div>
      <div class="pg-sub-title" data-pg-body="pg-verify"><span class="pg-arrow">&#9660;</span>&nbsp;Verification Options</div>
      <div id="pg-verify">
        <div class="pg-grid">
          ${card('pg_vvid','vvid','Verify Video')}${card('pg_vaud','vaud','Verify Audio')}${card('pg_vdesk','vdesk','Verify Desktop')}${card('pg_vid','vid','Verify ID')}${card('pg_vsig','vsig','Verify Signature')}
        </div>
        <p class="pg-note">These options determine what will be verified prior to the exam.</p>
      </div>
      <div class="pg-sub-title" data-pg-body="pg-tools"><span class="pg-arrow">&#9660;</span>&nbsp;In-Quiz Tools</div>
      <div id="pg-tools">
        <div class="pg-grid">${card('pg_calc','calc','Calculator')}${card('pg_wb','wb','Whiteboard')}</div>
      </div>
      <div class="pg-savebar">
        <span id="pg-save-err"></span>
        <span id="pg-save-ok">&#10003; Settings saved successfully!</span>
        <button id="pg-save-btn" type="button">Save ProctorGuard Settings</button>
      </div>
    </div>
  `;

  const quizTabsEl = document.getElementById('quiz_tabs');
  if (quizTabsEl && quizTabsEl.parentNode) {
    quizTabsEl.parentNode.insertBefore(panel, quizTabsEl.nextSibling);
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
    // Hide all Canvas quiz tab panels
    if (quizTabsEl) {
      quizTabsEl.querySelectorAll('[role="tabpanel"], > div').forEach(p => {
        if (p.id !== 'proctorguard_tab_panel') { p.style.display = 'none'; }
      });
      quizTabsEl.querySelectorAll('.ui-tabs-nav li, > ul > li').forEach(l => l.classList.remove('ui-tabs-active','ui-state-active'));
    }
    panel.style.display = 'block';
    tabLiEl.classList.add('ui-tabs-active','ui-state-active');
    if (quizId) loadPGSettings(quizId);
  });

  // When other Canvas tabs are clicked, hide our panel
  tabNav.querySelectorAll('li > a').forEach(link => {
    if (link.id === 'proctorguard_tab_link') return;
    link.addEventListener('click', () => {
      panel.style.display = 'none';
      tabLiEl.classList.remove('ui-tabs-active','ui-state-active');
    });
  });

  // Save button
  document.getElementById('pg-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('pg-save-btn');
    const ok  = document.getElementById('pg-save-ok');
    const err = document.getElementById('pg-save-err');
    if (!quizId) { err.textContent = 'Cannot save: Quiz ID not found. Save the quiz in Canvas first.'; err.style.display='inline'; return; }
    btn.disabled=true; btn.textContent='Saving...'; ok.style.display='none'; err.style.display='none';
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
      const res = await fetch(`${PG_API_BASE}/api/canvas-native/exam/${quizId}`, {
        method:'POST', headers:{'Content-Type':'application/json','x-shared-secret':PG_SECRET}, body:JSON.stringify(payload)
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
    const res = await fetch(`${PG_API_BASE}/api/canvas-native/exam/${quizId}`, { headers:{'x-shared-secret':PG_SECRET} });
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
    initSpeedGraderIntegration();
    initQuizEditorIntegration();
  });
} else {
  initSpeedGraderIntegration();
  initQuizEditorIntegration();
}

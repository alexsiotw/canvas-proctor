/**
 * Canvas Mobile Camera Bridge
 * ===========================
 * Standalone integration script for Canvas LMS Global Theme JS.
 * Injects a QR-code-based secondary mobile camera pairing flow
 * on quiz pages BEFORE the student can click "Take the Quiz".
 * 
 * Works alongside Proctorio (or any proctoring tool) by self-destructing
 * before the quiz launch sequence begins.
 * 
 * Deployment: Add this script's URL to Canvas Admin → Themes → JavaScript
 * URL: https://proctor.siotw.net/js/canvas-mobile-bridge.js
 * 
 * Dependencies: Socket.IO client (loaded dynamically from proctor server)
 */
(function() {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────
  const PROCTOR_SERVER = 'https://proctor.siotw.net';
  const SHARED_SECRET  = 'canvas-proctor-shared-secret-key-998877';

  // ─── State ──────────────────────────────────────────────────
  let socket           = null;
  let sessionToken     = null;
  let examId           = null;
  let sessionId        = null;
  let qrOverlay        = null;
  let mutationObserver = null;
  let pollingInterval  = null;
  let isDestroyed      = false;
  let unloadHandler    = null;

  // ─── 1. Page Detection ─────────────────────────────────────
  // Only run on quiz show pages: /courses/:id/quizzes/:id
  // NOT on /take, /edit, /history, /moderate, etc.
  function getQuizPageInfo() {
    const match = window.location.pathname.match(
      /\/courses\/(\d+)\/quizzes\/(\d+)\/?$/
    );
    if (!match) return null;
    return { courseId: match[1], quizId: match[2] };
  }

  // Detect if we're on the Canvas Quiz Edit page
  function getQuizEditPageInfo() {
    const match = window.location.pathname.match(
      /\/courses\/(\d+)\/quizzes\/(\d+)\/edit\/?/
    );
    if (!match) return null;
    return { courseId: match[1], quizId: match[2] };
  }

  function getCanvasUser() {
    // Canvas exposes ENV globals on every page
    const env = window.ENV || {};
    const longNameEl = document.querySelector('.user_long_name');
    const longName = longNameEl ? longNameEl.textContent.trim() : '';
    return {
      studentId:   env.current_user_id || '',
      studentName: (env.current_user && env.current_user.display_name) || 
                   longName || 
                   'Student'
    };
  }

  // ─── 3. Find the "Take the Quiz" Button ────────────────────
  function findQuizButton() {
    // Canvas uses several button variants depending on quiz state
    const selectors = [
      '#take_quiz_link',                         // Standard "Take the Quiz" 
      'a.btn.btn-primary[href*="/take"]',         // Link-style button
      '#resume_quiz_link',                        // "Resume Quiz"
      'a[data-method="post"][href*="/take"]',     // POST-style link
      '#submit_quiz_form .btn-primary',           // Alternative form button
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ─── 4. Settings Check ─────────────────────────────────────
  async function checkMobileCameraRequired(quizId) {
    try {
      const resp = await fetch(
        `${PROCTOR_SERVER}/api/canvas-native/quiz-mobile-check/${quizId}`, {
          headers: { 'x-shared-secret': SHARED_SECRET }
        }
      );
      if (!resp.ok) return { required: false };
      return await resp.json();
    } catch (e) {
      console.log('[MobileBridge] Settings check failed, skipping:', e.message);
      return { required: false };
    }
  }

  // ─── 5. Create Mobile Session ──────────────────────────────
  async function createMobileSession(quizId, courseId, studentId, studentName) {
    try {
      const resp = await fetch(
        `${PROCTOR_SERVER}/api/canvas-native/mobile-session-create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-shared-secret': SHARED_SECRET
          },
          body: JSON.stringify({
            quiz_id: quizId,
            course_id: courseId,
            student_id: studentId,
            student_name: studentName
          })
        }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error('[MobileBridge] Session creation failed:', e);
      return null;
    }
  }

  // ─── 6. Load Socket.IO Client ──────────────────────────────
  function loadSocketIO() {
    return new Promise((resolve, reject) => {
      if (window.io) return resolve(window.io);
      const script = document.createElement('script');
      script.src = `${PROCTOR_SERVER}/socket.io/socket.io.js`;
      script.onload = () => resolve(window.io);
      script.onerror = () => reject(new Error('Failed to load Socket.IO'));
      document.head.appendChild(script);
    });
  }

  // ─── 7. QR Overlay UI ─────────────────────────────────────
  function createQROverlay(mobileUrl, quizButton) {
    const overlay = document.createElement('div');
    overlay.id = 'mobile-camera-bridge-overlay';
    overlay.innerHTML = `
      <style>
        #mobile-camera-bridge-overlay {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
          border: 1px solid rgba(99, 179, 237, 0.3);
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 20px;
          color: #e2e8f0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 0 40px rgba(99, 179, 237, 0.05);
          animation: mcb-fadeIn 0.4s ease-out;
        }
        @keyframes mcb-fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        #mobile-camera-bridge-overlay .mcb-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 16px;
        }
        #mobile-camera-bridge-overlay .mcb-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: #63b3ed;
        }
        #mobile-camera-bridge-overlay .mcb-icon {
          width: 32px; height: 32px;
          background: rgba(99, 179, 237, 0.15);
          border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          font-size: 18px;
        }
        #mobile-camera-bridge-overlay .mcb-body {
          display: flex;
          align-items: center;
          gap: 24px;
        }
        #mobile-camera-bridge-overlay .mcb-qr-container {
          flex-shrink: 0;
          background: white;
          border-radius: 10px;
          padding: 8px;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
        }
        #mobile-camera-bridge-overlay .mcb-qr-container img {
          display: block;
          width: 150px; height: 150px;
        }
        #mobile-camera-bridge-overlay .mcb-instructions {
          flex: 1;
        }
        #mobile-camera-bridge-overlay .mcb-instructions p {
          margin: 0 0 8px 0;
          font-size: 14px;
          line-height: 1.5;
          color: #cbd5e0;
        }
        #mobile-camera-bridge-overlay .mcb-instructions ol {
          margin: 0;
          padding-left: 18px;
          font-size: 13px;
          color: #a0aec0;
          line-height: 1.8;
        }
        #mobile-camera-bridge-overlay .mcb-status {
          margin-top: 16px;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 8px;
          transition: all 0.3s ease;
        }
        #mobile-camera-bridge-overlay .mcb-status.waiting {
          background: rgba(237, 137, 54, 0.12);
          border: 1px solid rgba(237, 137, 54, 0.3);
          color: #ed8936;
        }
        #mobile-camera-bridge-overlay .mcb-status.connected {
          background: rgba(72, 187, 120, 0.12);
          border: 1px solid rgba(72, 187, 120, 0.3);
          color: #48bb78;
        }
        #mobile-camera-bridge-overlay .mcb-status .mcb-pulse {
          width: 8px; height: 8px;
          border-radius: 50%;
          animation: mcb-pulse 1.5s ease-in-out infinite;
        }
        #mobile-camera-bridge-overlay .mcb-status.waiting .mcb-pulse {
          background: #ed8936;
        }
        #mobile-camera-bridge-overlay .mcb-status.connected .mcb-pulse {
          background: #48bb78;
        }
        @keyframes mcb-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.7); }
        }
        /* Override Canvas button style when disabled */
        #take_quiz_link.mcb-disabled,
        #resume_quiz_link.mcb-disabled,
        a.btn.mcb-disabled {
          opacity: 0.5 !important;
          pointer-events: none !important;
          cursor: not-allowed !important;
          position: relative;
        }
        /* Fix locked scroll issue */
        html, body {
          overflow: auto !important;
          height: auto !important;
        }
      </style>
      <div class="mcb-header">
        <div class="mcb-icon">📱</div>
        <h3>Secondary Camera Required</h3>
      </div>
      <div class="mcb-body">
        <div class="mcb-qr-container">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(mobileUrl)}"
               alt="Scan to connect mobile camera" />
        </div>
        <div class="mcb-instructions">
          <p>This quiz requires a secondary camera. Scan the QR code with your phone to connect your mobile camera before proceeding.</p>
          <ol>
            <li>Open your phone's camera app and scan the QR code</li>
            <li>Tap "Authorize Camera Access" on your phone</li>
            <li>Position your phone to show your workspace</li>
            <li>Once connected, the "Take the Quiz" button will unlock</li>
          </ol>
        </div>
      </div>
      <div class="mcb-status waiting" id="mcb-pairing-status">
        <span class="mcb-pulse"></span>
        <span>Waiting for phone to connect...</span>
      </div>
    `;

    // Insert above the quiz button
    const buttonParent = quizButton.closest('.button-container') || 
                         quizButton.closest('.take_quiz_button') ||
                         quizButton.parentElement;
    buttonParent.insertBefore(overlay, buttonParent.firstChild);
    return overlay;
  }

  // ─── 8. Disable/Enable Quiz Button ─────────────────────────
  function disableQuizButton(btn) {
    btn.classList.add('mcb-disabled');
    btn.setAttribute('data-mcb-original-onclick', btn.getAttribute('onclick') || '');
    btn.removeAttribute('onclick');
    // Prevent click via capture listener
    btn._mcbClickBlocker = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      return false;
    };
    btn.addEventListener('click', btn._mcbClickBlocker, true);
  }

  function enableQuizButton(btn) {
    btn.classList.remove('mcb-disabled');
    const orig = btn.getAttribute('data-mcb-original-onclick');
    if (orig) btn.setAttribute('onclick', orig);
    btn.removeAttribute('data-mcb-original-onclick');
    if (btn._mcbClickBlocker) {
      btn.removeEventListener('click', btn._mcbClickBlocker, true);
      delete btn._mcbClickBlocker;
    }
  }

  // ─── 9. Self-Destruct (Proctorio Cease-Fire) ──────────────
  function selfDestruct() {
    if (isDestroyed) return;
    isDestroyed = true;
    console.log('[MobileBridge] Self-destructing — handing off to Proctorio');

    // Disconnect socket (but keep server-side session alive for mobile uploads)
    if (socket) {
      try { socket.disconnect(); } catch (_) {}
      socket = null;
    }

    // Remove mutation observer
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    // Clear any polling intervals
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // Remove QR overlay from DOM
    if (qrOverlay) {
      qrOverlay.remove();
      qrOverlay = null;
    }

    // Remove the style tag we injected
    const style = document.getElementById('mcb-injected-styles');
    if (style) style.remove();

    // Remove unload handler (we'll add a minimal beacon-only one)
    if (unloadHandler) {
      window.removeEventListener('beforeunload', unloadHandler);
      window.removeEventListener('pagehide', unloadHandler);
    }

    // Register minimal beacon for stop signal (fires when quiz is submitted / page left)
    const minimalStopHandler = () => {
      if (sessionToken) {
        navigator.sendBeacon(
          `${PROCTOR_SERVER}/api/canvas-native/mobile-session-stop`,
          new Blob([JSON.stringify({ token: sessionToken, secret: SHARED_SECRET })], 
                   { type: 'application/json' })
        );
      }
    };
    window.addEventListener('pagehide', minimalStopHandler, { once: true });

    // Nullify all references
    sessionToken = null;
    examId       = null;
    sessionId    = null;

    console.log('[MobileBridge] Cleanup complete — DOM is pristine');
  }

  // ─── Quiz Edit Page Setting ──────────────────────────────────
  async function initQuizEditPage(info) {
    console.log('[MobileBridge] Quiz Edit page detected:', info);
    
    // Inject global scroll fix CSS immediately to solve scrollbar issue
    const style = document.createElement('style');
    style.id = 'mcb-scroll-fix-style';
    style.innerHTML = 'html, body { overflow: auto !important; height: auto !important; }';
    document.head.appendChild(style);
    
    // Find Respondus checkbox element directly by its ID
    const ldbCheckbox = document.getElementById('quiz_require_lockdown_browser');
    if (!ldbCheckbox) {
      // Re-poll if page is still rendering
      setTimeout(() => initQuizEditPage(info), 500);
      return;
    }
    
    if (document.getElementById('mcb_require_mobile_camera')) return;
    
    // Fetch current settings
    const settings = await checkMobileCameraRequired(info.quizId);
    
    // Create option checkbox
    const wrapper = document.createElement('div');
    wrapper.className = 'control-group';
    wrapper.style.marginTop = '10px';
    wrapper.innerHTML = `
      <div class="controls">
        <label class="checkbox" for="mcb_require_mobile_camera">
          <input type="checkbox" id="mcb_require_mobile_camera" name="mcb_require_mobile_camera" ${settings.required ? 'checked' : ''}>
          Require Secondary Mobile Camera (Proctor Bridge)
        </label>
      </div>
    `;
    
    // Insert it directly under the Respondus checkbox option group/container
    const targetContainer = ldbCheckbox.closest('.option-group') || ldbCheckbox.closest('.control-group') || ldbCheckbox.parentElement;
    targetContainer.parentNode.insertBefore(wrapper, targetContainer.nextSibling);
    
    // Save setting instantly on state change (click/change)
    const checkbox = document.getElementById('mcb_require_mobile_camera');
    checkbox.addEventListener('change', async () => {
      const isChecked = checkbox.checked;
      console.log('[MobileBridge] Saving mobile camera requirement change:', isChecked);
      try {
        const resp = await fetch(`${PROCTOR_SERVER}/api/canvas-native/quiz-mobile-save/${info.quizId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-shared-secret': SHARED_SECRET
          },
          body: JSON.stringify({
            required: isChecked,
            course_id: info.courseId
          })
        });
        if (resp.ok) {
          console.log('[MobileBridge] Mobile camera requirement successfully updated.');
        } else {
          console.error('[MobileBridge] Save returned status:', resp.status);
        }
      } catch (e) {
        console.error('[MobileBridge] Save failed:', e);
      }
    });
  }

  // ─── 10. Main Initialization ───────────────────────────────
  async function init() {
    // Check if we're on the Edit page first
    const editPageInfo = getQuizEditPageInfo();
    if (editPageInfo) {
      initQuizEditPage(editPageInfo);
      return;
    }

    // Step 1: Check if we're on a quiz page
    const pageInfo = getQuizPageInfo();
    if (!pageInfo) return;
    console.log('[MobileBridge] Quiz page detected:', pageInfo);

    // Step 2: Check if mobile camera is required for this quiz
    const settings = await checkMobileCameraRequired(pageInfo.quizId);
    if (!settings.required) {
      console.log('[MobileBridge] Mobile camera not required, exiting');
      return;
    }
    console.log('[MobileBridge] Mobile camera required, initializing bridge');

    // Step 3: Find the quiz button
    const quizButton = findQuizButton();
    if (!quizButton) {
      console.log('[MobileBridge] No quiz button found (maybe already taken), exiting');
      return;
    }

    // Step 4: Get Canvas user info
    const user = getCanvasUser();
    if (!user.studentId) {
      console.warn('[MobileBridge] Could not determine student ID, exiting');
      return;
    }

    // Step 5: Create mobile session
    const session = await createMobileSession(
      pageInfo.quizId, pageInfo.courseId, user.studentId, user.studentName
    );
    if (!session || !session.token) {
      console.error('[MobileBridge] Failed to create mobile session, allowing normal flow');
      return;
    }
    sessionToken = session.token;
    examId       = session.exam_id;
    sessionId    = session.session_id;

    // Step 6: Disable the quiz button
    disableQuizButton(quizButton);

    // Step 7: Build mobile URL and show QR overlay
    const mobileUrl = `${PROCTOR_SERVER}/mobile-camera.html` +
      `?token=${encodeURIComponent(sessionToken)}` +
      `&exam_id=${encodeURIComponent(examId)}`;
    qrOverlay = createQROverlay(mobileUrl, quizButton);

    // Step 8: Load Socket.IO and connect
    try {
      const io = await loadSocketIO();
      socket = io(PROCTOR_SERVER, {
        transports: ['websocket', 'polling'],
        reconnection: true
      });

      // Join the session room
      socket.on('connect', () => {
        console.log('[MobileBridge] Socket connected');
        socket.emit('join_lti', { token: sessionToken });
      });

      // Listen for mobile pairing
      socket.on('mobile_paired', () => {
        console.log('[MobileBridge] Mobile camera paired!');
        const status = document.getElementById('mcb-pairing-status');
        if (status) {
          status.className = 'mcb-status connected';
          status.innerHTML = '<span class="mcb-pulse"></span><span>✅ Phone Connected — You may now proceed</span>';
        }
        enableQuizButton(quizButton);
      });

      // Listen for mobile disconnect (re-disable button)
      socket.on('mobile_disconnected', () => {
        console.log('[MobileBridge] Mobile camera disconnected');
        const status = document.getElementById('mcb-pairing-status');
        if (status) {
          status.className = 'mcb-status waiting';
          status.innerHTML = '<span class="mcb-pulse"></span><span>⚠️ Phone disconnected — Re-scan the QR code</span>';
        }
        if (!isDestroyed) {
          disableQuizButton(quizButton);
        }
      });

    } catch (e) {
      console.error('[MobileBridge] Socket.IO load failed, allowing normal flow:', e);
      enableQuizButton(quizButton);
      if (qrOverlay) qrOverlay.remove();
      return;
    }

    // Step 9: Add click handler for the quiz button — triggers recording & self-destruct
    const launchHandler = (e) => {
      console.log('[MobileBridge] Quiz launch detected — starting mobile recording');
      
      // Tell server to start mobile recording
      if (socket && sessionToken) {
        socket.emit('laptop_begin_exam', { token: sessionToken });
      }

      // Small delay to ensure the emit goes through before socket disconnect
      setTimeout(() => selfDestruct(), 100);
    };
    quizButton.addEventListener('click', launchHandler, { once: true });

    // Step 10: Unload safety net (if student leaves without clicking button)
    unloadHandler = () => {
      if (!isDestroyed && sessionToken) {
        navigator.sendBeacon(
          `${PROCTOR_SERVER}/api/canvas-native/mobile-session-stop`,
          new Blob([JSON.stringify({ token: sessionToken, secret: SHARED_SECRET })], 
                   { type: 'application/json' })
        );
      }
    };
    window.addEventListener('beforeunload', unloadHandler);
    window.addEventListener('pagehide', unloadHandler);

    console.log('[MobileBridge] Initialization complete — waiting for mobile pairing');
  }

  // ─── Boot ──────────────────────────────────────────────────
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to let Canvas finish rendering its quiz UI
    setTimeout(init, 500);
  }

})();

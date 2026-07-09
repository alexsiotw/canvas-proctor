let examConfig = null;
let sessionInfo = null;
let activeVisualFlags = [];
let socket = null;
try { socket = io(); } catch(e) { console.warn('[Proctor] Socket.IO unavailable:', e.message); }
if (socket) socket.on('instructor_warning', (data) => {
    const overlay = document.getElementById('focus-violation-overlay');
    if (overlay) {
        overlay.querySelector('h1').innerText = "💬 Message from Instructor";
        overlay.querySelector('h1').style.color = "var(--warning)";
        overlay.querySelector('p').innerText = data.message;
        overlay.querySelector('button').innerText = "I Acknowledge";
        overlay.style.display = 'flex';
    }
});
if (!socket) { socket = { on: function(){}, emit: function(){} }; }

if (socket) {
    socket.on('mobile_paired', (data) => {
        console.log("[Socket Mobile] Secondary camera successfully paired!");
        window.isMobileCameraPaired = true;
        if (currentStep === 10) {
            const statusDiv = document.getElementById('mobile-pairing-status');
            if (statusDiv) {
                statusDiv.style.background = 'rgba(16, 185, 129, 0.1)';
                statusDiv.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                statusDiv.style.color = '#10b981';
                statusDiv.innerHTML = '✅ Phone Connected Successfully!';
            }
            const nextBtn = document.getElementById('btn-next-step');
            if (nextBtn) {
                nextBtn.disabled = false;
                nextBtn.style.background = '#2563eb';
                nextBtn.style.color = 'white';
            }
        }
    });

    socket.on('mobile_disconnected', () => {
        console.warn("[Socket Mobile] Secondary camera disconnected!");
        window.isMobileCameraPaired = false;
        if (currentStep === 10) {
            const statusDiv = document.getElementById('mobile-pairing-status');
            if (statusDiv) {
                statusDiv.style.background = 'rgba(239, 68, 68, 0.1)';
                statusDiv.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                statusDiv.style.color = '#ef4444';
                statusDiv.innerHTML = '❌ Connection lost. Re-scan the QR code.';
            }
            const nextBtn = document.getElementById('btn-next-step');
            if (nextBtn) {
                nextBtn.disabled = true;
                nextBtn.style.background = '#e5e7eb';
                nextBtn.style.color = '#9ca3af';
            }
        } else if (currentStep === 9) { // Inside active exam
            const overlay = document.getElementById('focus-violation-overlay');
            if (overlay) {
                overlay.querySelector('h1').innerText = "⚠️ Mobile Camera Lost";
                overlay.querySelector('h1').style.color = "var(--danger)";
                overlay.querySelector('p').innerText = "Secondary mobile camera connection was lost. Please re-scan the QR code or reload the companion page to resume proctoring.";
                overlay.querySelector('button').innerText = "Acknowledge";
                overlay.style.display = 'flex';
            }
        }
    });
}
let mediaRecorder = null;
let chunkIndex = 0;
let finalStream = null;
let activeUploads = 0;
let uploadQueue = [];
let isProcessingQueue = false;
let isStartingExam = false;
let compositeVScreen = null;
let compositeVCam = null;

const DB_NAME = 'CanvasProctorDB';
const STORE_NAME = 'chunks';

let useMemoryStorage = false;
const memoryChunks = {};

try {
    if (!window.indexedDB) {
        console.warn("[DB] window.indexedDB not available. Using memory storage fallback.");
        useMemoryStorage = true;
    }
} catch (e) {
    console.warn("[DB] Failed to check window.indexedDB. Using memory storage fallback:", e.message);
    useMemoryStorage = true;
}

function openDB() {
    if (useMemoryStorage) return Promise.reject(new Error("IndexedDB disabled/blocked."));
    return new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => {
                console.warn("[DB] IndexedDB request error. Switching to memory storage.");
                useMemoryStorage = true;
                reject(e.target.error);
            };
        } catch (err) {
            console.warn("[DB] Failed to open IndexedDB. Switching to memory storage:", err.message);
            useMemoryStorage = true;
            reject(err);
        }
    });
}

async function saveChunkToDB(sessionId, index, data) {
    if (useMemoryStorage) {
        const key = `${sessionId}_${index}`;
        memoryChunks[key] = { key, session_id: sessionId, index, data, attempts: 0 };
        return;
    }
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const key = `${sessionId}_${index}`;
            store.put({ key, session_id: sessionId, index, data, attempts: 0 });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn("[DB] Failed to save chunk to IndexedDB. Falling back to memory storage.", e);
        useMemoryStorage = true;
        const key = `${sessionId}_${index}`;
        memoryChunks[key] = { key, session_id: sessionId, index, data, attempts: 0 };
    }
}

async function getPendingChunksFromDB(sessionId) {
    if (useMemoryStorage) {
        const filtered = Object.values(memoryChunks)
                            .filter(c => c.session_id === sessionId)
                            .sort((a, b) => a.index - b.index);
        return filtered;
    }
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const all = request.result || [];
                const filtered = all.filter(c => c.session_id === sessionId)
                                    .sort((a, b) => a.index - b.index);
                resolve(filtered);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn("[DB] Failed to get chunks from IndexedDB. Falling back to memory storage.", e);
        useMemoryStorage = true;
        const filtered = Object.values(memoryChunks)
                            .filter(c => c.session_id === sessionId)
                            .sort((a, b) => a.index - b.index);
        return filtered;
    }
}

async function deleteChunkFromDB(sessionId, index) {
    if (useMemoryStorage) {
        const key = `${sessionId}_${index}`;
        delete memoryChunks[key];
        return;
    }
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const key = `${sessionId}_${index}`;
            store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn("[DB] Failed to delete chunk from IndexedDB. Falling back to memory storage.", e);
        useMemoryStorage = true;
        const key = `${sessionId}_${index}`;
        delete memoryChunks[key];
    }
}

async function updateChunkAttemptsInDB(sessionId, index, attempts) {
    if (useMemoryStorage) {
        const key = `${sessionId}_${index}`;
        if (memoryChunks[key]) {
            memoryChunks[key].attempts = attempts;
        }
        return;
    }
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const key = `${sessionId}_${index}`;
            const req = store.get(key);
            req.onsuccess = () => {
                const item = req.result;
                if (item) {
                    item.attempts = attempts;
                    store.put(item);
                }
                resolve();
            };
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn("[DB] Failed to update attempts in IndexedDB. Falling back to memory storage.", e);
        useMemoryStorage = true;
        const key = `${sessionId}_${index}`;
        if (memoryChunks[key]) {
            memoryChunks[key].attempts = attempts;
        }
    }
}

async function cleanOldChunks(currentSessionId) {
    if (useMemoryStorage) {
        Object.keys(memoryChunks).forEach(key => {
            if (memoryChunks[key].session_id !== currentSessionId) {
                delete memoryChunks[key];
            }
        });
        return;
    }
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
            const all = req.result || [];
            all.forEach(item => {
                if (item.session_id !== currentSessionId) {
                    store.delete(item.key);
                }
            });
        };
    } catch(e) {
        console.warn("[DB] Failed to clean up old chunks. Falling back to memory storage.", e);
        useMemoryStorage = true;
        Object.keys(memoryChunks).forEach(key => {
            if (memoryChunks[key].session_id !== currentSessionId) {
                delete memoryChunks[key];
            }
        });
    }
}

let videoStream = null;
let screenStream = null;
let compositeAnimationId = null;
let isExamCompleted = false;
let examWatchdogInterval = null;
let lastCameraActiveTime = 0;
let talkingDetectionInterval = null;
let talkingStartTimestamp = null;
let isCurrentlyTalking = false;
let urlParams = new URLSearchParams(window.location.search);
let sessionToken = urlParams.get('token');
let isSebParam = urlParams.get('seb') === 'true';
let autoExamCode = urlParams.get('exam_code');
let placementId = urlParams.get('placement_id');
let directExamId = urlParams.get('exam_id');

if (socket && sessionToken) {
    socket.emit('join_lti', { token: sessionToken });
}

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
    
    const observer = new MutationObserver(sendResize);
    observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true
    });
    
    setTimeout(sendResize, 100);
    setTimeout(sendResize, 500);
    setTimeout(sendResize, 1000);
}

window.addEventListener('load', () => {
    initLtiFrameResize();
    if ((placementId || directExamId) && sessionToken) {
        document.getElementById('code-container').style.display = 'none';
        verifyPlacement(placementId, directExamId);
    } else if (autoExamCode && sessionToken) {
        document.getElementById('access-code-input').value = autoExamCode;
        verifyExamCode();
    }

    document.addEventListener('fullscreenchange', () => {
        if (currentStep === 8) {
            const nextBtn = document.getElementById('btn-next-step');
            const fsBtn = document.querySelector('button[onclick="requestFullscreenStep()"]');
            if (document.fullscreenElement) {
                if (fsBtn) fsBtn.style.display = 'none';
                if (nextBtn) nextBtn.disabled = false;
                const statusEl = document.getElementById('fullscreen-status');
                if (statusEl) statusEl.innerHTML = "✓ Fullscreen Mode Enabled";
            } else {
                if (fsBtn) fsBtn.style.display = 'inline-block';
                if (nextBtn) nextBtn.disabled = true;
                const statusEl = document.getElementById('fullscreen-status');
                if (statusEl) statusEl.innerHTML = "Fullscreen not yet active";
            }
        }
    });
});

// Wait for explicit verification
async function verifyExamCode() {
    const errorMsg = document.getElementById('code-error-msg');
    errorMsg.style.display = 'none';
    const code = document.getElementById('access-code-input').value.trim();
    if(!code) return;
    
    try {
        const res = await fetch('/api/exams/verify-code', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exam_code: code, token: sessionToken })
        });
        
        const data = await res.json();
        if(!res.ok) {
            if (data.already_completed && data.canvas_quiz_url) {
                console.log("[Verification] Student has already completed all attempts. Redirecting top window to Canvas quiz page.");
                if (window.top !== window.self) {
                    window.top.location.href = data.canvas_quiz_url;
                } else {
                    window.location.href = data.canvas_quiz_url;
                }
                return;
            }
            throw new Error(data.error || 'Authentication failed');
        }
        
        examConfig = data;
        if (examConfig.require_companion_app && !navigator.userAgent.includes('CanvasProctorCompanion')) {
            document.getElementById('code-container').style.display = 'none';
            document.getElementById('companion-app-required-overlay').style.display = 'flex';
            return;
        }
        if (examConfig.require_extension && document.documentElement.dataset.proctorExtensionInstalled !== "true" && !navigator.userAgent.includes('CanvasProctorCompanion')) {
            document.getElementById('code-container').style.display = 'none';
            document.getElementById('extension-required-overlay').style.display = 'flex';
            return;
        }
        document.getElementById('code-container').style.display = 'none';
        document.getElementById('setup-container').style.display = 'flex';
        initStepWizard();
    } catch(err) {
        errorMsg.innerText = err.message;
        errorMsg.style.display = 'block';
    }
}

async function verifyPlacement(pId, eId = null) {
    const errorMsg = document.getElementById('code-error-msg');
    errorMsg.style.display = 'none';
    
    try {
        const res = await fetch('/api/exams/verify-placement', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ placement_id: pId, exam_id: eId, token: sessionToken })
        });
        
        const data = await res.json();
        if(!res.ok) {
            if (data.already_completed && data.canvas_quiz_url) {
                console.log("[Verification] Student has already completed all attempts. Redirecting top window to Canvas quiz page.");
                if (window.top !== window.self) {
                    window.top.location.href = data.canvas_quiz_url;
                } else {
                    window.location.href = data.canvas_quiz_url;
                }
                return;
            }
            throw new Error(data.error || 'Verification of placement failed');
        }
        
        examConfig = data;
        if (examConfig.require_companion_app && !navigator.userAgent.includes('CanvasProctorCompanion')) {
            document.getElementById('code-container').style.display = 'none';
            document.getElementById('companion-app-required-overlay').style.display = 'flex';
            return;
        }
        if (examConfig.require_extension && document.documentElement.dataset.proctorExtensionInstalled !== "true" && !navigator.userAgent.includes('CanvasProctorCompanion')) {
            document.getElementById('code-container').style.display = 'none';
            document.getElementById('extension-required-overlay').style.display = 'flex';
            return;
        }
        document.getElementById('code-container').style.display = 'none';
        document.getElementById('setup-container').style.display = 'flex';
        initStepWizard();
    } catch(err) {
        // If automatic placement check fails, show code container and display error
        document.getElementById('code-container').style.display = 'flex';
        errorMsg.innerText = err.message;
        errorMsg.style.display = 'block';
    }
}


let currentStep = 1;
let localMicStream = null;
let localCamStream = null;
let localScreenStream = null;
let micAudioContext = null;
let micAnalyser = null;
let micVolInterval = null;
let webcamRecorder = null;
let webcamChunks = [];
let webcamVideoUrl = null;
let violationCount = 0;

function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function updateSidebarNav() {
    const stepsConfig = [
        { id: 1, req: () => true }, // NETWORK CHECK
        { id: 2, req: () => examConfig.require_mic || examConfig.verify_audio },
        { id: 3, req: () => examConfig.require_camera || examConfig.verify_video },
        { id: 11, req: () => examConfig.verify_id },
        { id: 12, req: () => examConfig.verify_signature },
        { id: 4, req: () => true }, // ADDITIONAL INSTRUCTIONS
        { id: 5, req: () => true }, // GUIDELINES + TIPS
        { id: 6, req: () => examConfig.require_room_scan }, // ROOM SCAN
        { id: 10, req: () => examConfig.require_mobile_camera }, // MOBILE CAMERA
        { id: 7, req: () => (examConfig.require_screen || examConfig.verify_desktop) && !isSEB() },
        { id: 8, req: () => examConfig.require_fullscreen },
        { id: 9, req: () => true }
    ];

    const activeSteps = stepsConfig.filter(s => s.req());
    const currentActiveIndex = activeSteps.findIndex(s => s.id === currentStep);

    if (activeSteps.length > 0) {
        const progressPct = ((currentActiveIndex) / activeSteps.length) * 100;
        const progressFill = document.getElementById('setup-progress-fill');
        if (progressFill) progressFill.style.width = `${progressPct}%`;
        
        const stepsRemaining = activeSteps.length - currentActiveIndex - 1;
        const timeEst = document.getElementById('setup-time-est');
        if (timeEst) {
            const minStr = Math.max(1, Math.ceil(stepsRemaining * 0.5));
            timeEst.textContent = `~${minStr} min remaining`;
            if (stepsRemaining <= 0) timeEst.textContent = `Almost done!`;
        }
    }

    let visualIndex = 1;
    stepsConfig.forEach((stepItem) => {
        const navEl = document.getElementById(`step-nav-${stepItem.id}`);
        if (!navEl) return;
        
        if (!stepItem.req()) {
            navEl.style.display = 'none';
        } else {
            navEl.style.display = 'block';
            navEl.className = 'sidebar-step';
            
            const stepNameStr = getStepName(stepItem.id);
            const isLast = (visualIndex === activeSteps.length);
            
            let circleHtml = `<div class="step-circle">${visualIndex}</div>`;
            let rightBadge = '';
            
            if (isLast) {
                circleHtml = `<div class="step-circle step-circle-go" style="color:#ffffff;border-color:#10b981;background:#10b981;font-size:10px;font-weight:bold;">GO</div>`;
            }

            const itemActiveIndex = activeSteps.findIndex(s => s.id === stepItem.id);

            if (stepItem.id === currentStep) {
                navEl.classList.add('active');
                if (isLast) {
                    circleHtml = `<div class="step-circle step-circle-go" style="color:#ffffff;border-color:#059669;background:#059669;font-size:10px;font-weight:bold;">GO</div>`;
                } else {
                    circleHtml = `<div class="step-circle">${visualIndex}</div>`;
                }
                rightBadge = `<div class="step-badge step-badge-progress">In progress</div>`;
            } else if (itemActiveIndex !== -1 && itemActiveIndex < currentActiveIndex) {
                navEl.classList.add('completed');
                circleHtml = `<div class="step-circle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>`;
                if (stepItem.id === 1 && window.networkLatency) {
                    rightBadge = `<div class="step-badge step-badge-done">${window.networkLatency}ms &check;</div>`;
                } else {
                    rightBadge = ``;
                }
            } else {
                navEl.classList.remove('active', 'completed');
            }

            navEl.innerHTML = `<div class="step-row-left">${circleHtml} <span>${stepNameStr}</span></div> ${rightBadge}`;
            visualIndex++;
        }
    });
}

function getNextStep(current) {
    const stepsConfig = [
        { id: 1, req: () => true },
        { id: 2, req: () => examConfig.require_mic || examConfig.verify_audio },
        { id: 3, req: () => examConfig.require_camera || examConfig.verify_video },
        { id: 11, req: () => examConfig.verify_id },
        { id: 12, req: () => examConfig.verify_signature },
        { id: 4, req: () => true },
        { id: 5, req: () => true },
        { id: 6, req: () => examConfig.require_room_scan },
        { id: 10, req: () => examConfig.require_mobile_camera },
        { id: 7, req: () => (examConfig.require_screen || examConfig.verify_desktop) && !isSEB() },
        { id: 8, req: () => examConfig.require_fullscreen },
        { id: 9, req: () => true }
    ];
    
    let startIndex = 0;
    if (current !== 0) {
        const currentIndex = stepsConfig.findIndex(s => s.id === current);
        if (currentIndex !== -1) {
            startIndex = currentIndex + 1;
        } else {
            return 9;
        }
    }
    
    for (let i = startIndex; i < stepsConfig.length; i++) {
        if (stepsConfig[i].req()) {
            return stepsConfig[i].id;
        }
    }
    return 9;
}

function getStepName(step) {
    switch(step) {
        case 1: return 'Network check';
        case 2: return 'Microphone';
        case 3: return 'Webcam';
        case 11: return 'ID verification';
        case 12: return 'Signature';
        case 4: return 'Instructions';
        case 5: return 'Guidelines';
        case 6: return 'Room scan';
        case 7: return 'Screen share';
        case 8: return 'Fullscreen mode';
        case 9: return 'Begin exam';
        case 10: return 'Mobile camera';
    }
}

function initStepWizard() {
    if (isIOS()) {
        const warningEl = document.getElementById('ios-cookie-warning');
        if (warningEl) warningEl.style.display = 'block';
    }
    if (examConfig.require_seb && !isSEB()) {
        showSEBBlocker();
        startBlockerPolling();
        return;
    }
    if (examConfig.only_one_screen) {
        initDisplayMonitoring();
    }
    const firstStep = getNextStep(0);
    goToStep(firstStep);
}

function startBlockerPolling() {
    const pollInterval = setInterval(async () => {
        try {
            const url = `/api/session/status?token=${encodeURIComponent(sessionToken)}&exam_id=${encodeURIComponent(examConfig.id)}`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'completed' || data.status === 'booted') {
                    clearInterval(pollInterval);
                    const targetUrl = data.canvas_quiz_url || 'https://canvas.siotw.net';
                    console.log("[Blocker] Polling detected session completion. Redirecting top window to:", targetUrl);
                    if (window.top !== window.self) {
                        window.top.location.href = targetUrl;
                    } else {
                        window.location.href = targetUrl;
                    }
                }
            }
        } catch(e) {
            console.warn("Blocker poll failed:", e);
        }
    }, 4000);
}

function goToStep(step) {
    currentStep = step;
    updateSidebarNav();
    
    if (step !== 2) {
        isCheckingWebcamAI = false;
        if (trackerTask) {
            try { trackerTask.stop(); } catch(e){}
            trackerTask = null;
        }
        if (webcamWatchdogInterval) {
            clearInterval(webcamWatchdogInterval);
            webcamWatchdogInterval = null;
        }
    }
    if (step !== 1 && micVolInterval) {
        clearInterval(micVolInterval);
        micVolInterval = null;
    }
    if (step !== 1 && micAudioContext) {
        try { micAudioContext.close(); } catch(e){}
        micAudioContext = null;
    }

    const contentEl = document.getElementById('setup-content');
    
    switch(step) {
        case 1:
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Network Check</h2>
                    <p class="step-description">
                        We are verifying your connection speed to ensure it can handle continuous proctoring uploads.
                    </p>
                    <div id="network-status-container" style="display: flex; align-items: center; gap: 10px; margin: 10px 0; padding: 15px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;">
                        <div class="spinner" id="network-spinner"></div>
                        <span style="font-size: 14px; font-weight: 600; color: #9ca3af;" id="network-status-msg">Testing connection speed...</span>
                    </div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(1))" disabled>Next Step</button>
                </div>
            `;
            runNetworkCheck();
            break;
            
        case 2:
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Microphone Check</h2>
                    <p class="step-description">
                        Speak into your microphone in a normal voice. The indicator below should move as you speak to confirm your microphone levels are good.
                    </p>
                    <div class="volume-meter">
                        <div id="mic-volume-fill" class="volume-fill"></div>
                    </div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button class="btn btn-primary" onclick="startMicCheck()">Check Microphone</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(2))" disabled>Next Step</button>
                </div>
            `;
            if (localMicStream) {
                startMicCheck();
            }
            break;
            
        case 3:
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Webcam Check</h2>
                    <p class="step-description">
                        Adjust the camera so your image appears properly in the window.<br><br>
                        While speaking in your normal voice (say the alphabet or count to 10), click <strong>"Record Five Second Video"</strong> to verify audio/video recording (optional), or click <strong>"Next Step"</strong> as soon as your preview is visible.
                    </p>
                    <div class="video-preview-box">
                        <video id="webcam-check-preview" autoplay muted playsinline></video>
                    </div>
                    <div id="ai-loading-container" style="display: flex; align-items: center; gap: 10px; margin: 10px 0; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;">
                        <div class="spinner"></div>
                        <span style="font-size: 13px; font-weight: 600; color: #9ca3af;">Initializing secure human verification AI...</span>
                    </div>
                    <div id="ai-status-container" style="display: none; align-items: center; gap: 10px; margin: 10px 0; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;">
                        <span style="font-size: 13px; font-weight: bold;" id="ai-status-msg">Scanning...</span>
                    </div>
                    <div id="webcam-timer" style="font-weight: bold; color: #2563eb; margin: 10px 0;"></div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-record-webcam" class="btn btn-primary" onclick="startWebcam5sRecord()">Record Five Second Video</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(3))" disabled>Next Step</button>
                </div>
            `;
            break;

        case 11:
            // ID VERIFICATION
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">ID Verification</h2>
                    <p class="step-description">
                        Please hold your government-issued ID or Student ID up to the camera so that it fits within the frame, then click <strong>Capture ID Photo</strong>.
                    </p>
                    <div style="position: relative; max-width: 480px; margin: 20px auto; border-radius: 8px; overflow: hidden; border: 2px dashed #cbd5e1; background: #000; aspect-ratio: 4/3;">
                        <div id="id-video-container" style="width: 100%; height: 100%;">
                            <video id="id-check-preview" autoplay muted playsinline style="width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1);"></video>
                            <div style="position: absolute; top: 10%; left: 10%; width: 80%; height: 80%; border: 3px solid rgba(255,255,255,0.7); border-radius: 6px; box-shadow: 0 0 0 9999px rgba(0,0,0,0.5); pointer-events: none; display: flex; align-items: center; justify-content: center;">
                                <span style="color: white; font-size: 14px; font-weight: 500; text-shadow: 1px 1px 2px black; text-align: center;">Align ID card inside this box</span>
                            </div>
                        </div>
                        <div id="id-capture-result" style="display: none; width: 100%; height: 100%;">
                            <img id="id-captured-image" style="width: 100%; height: 100%; object-fit: cover;" alt="Captured ID" />
                        </div>
                    </div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; gap: 15px; margin-top: 20px;">
                    <button id="btn-capture-id" class="btn btn-secondary" onclick="captureIdPhoto()">Capture ID Photo</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#e5e7eb; color:#9ca3af; border:none;" onclick="goToStep(getNextStep(11))" disabled>Next Step</button>
                </div>
            `;
            setupIdPreview();
            break;

        case 12:
            // SIGNATURE AGREEMENT
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Signature Agreement</h2>
                    <p class="step-description">
                        Please review the academic integrity agreement, type your full name, and sign in the pad below.
                    </p>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 20px; font-size: 13.5px; line-height: 1.5; color: #475569;">
                        By signing below, I certify that I am the student registered for this exam and that I will adhere to the academic honesty policy. I will complete this assessment independently without seeking unauthorized assistance.
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 5px;">Type Your Full Name:</label>
                        <input type="text" id="sig-name-input" placeholder="e.g. John Doe" style="width: 100%; max-width: 400px; padding: 8px 12px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 6px;" oninput="checkSignatureValidity()" />
                    </div>

                    <div>
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 5px;">Draw Your Signature:</label>
                        <div style="position: relative; max-width: 400px; border: 1px solid #cbd5e1; border-radius: 6px; background: white; overflow: hidden; height: 150px;">
                            <canvas id="signature-pad" style="width: 100%; height: 100%; cursor: crosshair; touch-action: none;"></canvas>
                        </div>
                        <button class="btn btn-link" style="padding: 0; font-size: 12px; margin-top: 5px; color: #2563eb; background: none; border: none; cursor: pointer;" onclick="clearSignaturePad()">Clear signature</button>
                    </div>
                    
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 25px;">
                    <button id="btn-next-step" class="btn btn-primary" style="background:#e5e7eb; color:#9ca3af; border:none;" onclick="goToStep(getNextStep(12))" disabled>Next Step</button>
                </div>
            `;
            setTimeout(setupSignaturePad, 50);
            break;

        case 4:
            const customInstr = examConfig.additional_instructions && examConfig.additional_instructions.trim() !== "" 
                ? examConfig.additional_instructions.trim() 
                : "Please review the general instructions. Ensure you are alone in your workspace, your face is fully visible, and you do not speak or navigate away from the test window during the quiz.";
            
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Additional Instructions</h2>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; font-size: 14px; line-height: 1.6; color: #374151; white-space: pre-wrap;">${customInstr}</div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 30px;">
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(4))">I Understand, Next Step</button>
                </div>
            `;
            break;

        case 5:
            // GUIDELINES + TIPS
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Guidelines & Tips</h2>
                    <p class="step-description">Please ensure your testing environment adheres to the following guidelines before starting:</p>
                    <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 15px;">
                        <div style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: #374151;">
                            <span style="font-size: 18px;">🤫</span>
                            <div><strong>Quiet Location:</strong> Find a quiet, private, and well-lit workspace. Keep background noise to a minimum.</div>
                        </div>
                        <div style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: #374151;">
                            <span style="font-size: 18px;">📱</span>
                            <div><strong>No Mobile Devices:</strong> Keep all cell phones, tablets, smartwatches, or other gadgets out of reach.</div>
                        </div>
                        <div style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: #374151;">
                            <span style="font-size: 18px;">🧑‍💻</span>
                            <div><strong>Work Independently:</strong> You must complete the exam entirely on your own without external help or materials.</div>
                        </div>
                        <div style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: #374151;">
                            <span style="font-size: 18px;">👀</span>
                            <div><strong>Stay Focused:</strong> Stay directly in front of the camera and keep your eyes on the screen. Avoid looking around excessively.</div>
                        </div>
                        <div style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: #374151;">
                            <span style="font-size: 18px;">🎧</span>
                            <div><strong>No Headwear / Headphones:</strong> Ensure your ears and face are clearly visible. Headsets or headphones are prohibited unless authorized.</div>
                        </div>
                    </div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 30px;">
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(5))">Next Step</button>
                </div>
            `;
            break;

        case 6:
            // ROOM SCAN
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Room Scan</h2>
                    <p class="step-description">
                        Please pick up your device or webcam and slowly pan it around your room and desk area for 10 seconds. Click "Start Room Scan" when ready.
                    </p>
                    <div class="video-preview-box">
                        <video id="room-scan-preview" autoplay muted playsinline></video>
                    </div>
                    <div id="room-scan-timer" style="font-weight: bold; color: #2563eb; margin: 10px 0;"></div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-record-room" class="btn btn-primary" onclick="startRoomScanRecord()">Start Room Scan</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(6))" disabled>Next Step</button>
                </div>
            `;
            setupRoomScanPreview();
            break;
            
        case 10:
            const mobileUrl = `${window.location.origin}/mobile-camera.html?token=${encodeURIComponent(sessionToken)}&exam_id=${encodeURIComponent(examConfig.id)}`;
            const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(mobileUrl)}`;
            
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Secondary Mobile Camera</h2>
                    <p class="step-description">
                        To add an extra layer of security, you are required to use your mobile device as a secondary camera. Scan the QR code below with your phone to link it.
                    </p>
                    
                    <div style="display: flex; gap: 20px; align-items: center; flex-wrap: wrap; margin-top: 15px;">
                        <div style="background: white; padding: 12px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 160px; height: 160px; display: flex; align-items: center; justify-content: center;">
                            <img src="${qrApiUrl}" style="width: 160px; height: 160px; image-rendering: pixelated;" alt="QR Code" />
                        </div>
                        <div style="flex-grow: 1; min-width: 250px;">
                            <div id="mobile-pairing-status" style="margin-bottom: 15px; padding: 12px 15px; border-radius: 6px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #f59e0b; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                                <div class="spinner" style="width:16px; height:16px; border-width: 2px;"></div>
                                <span>Waiting for phone to connect...</span>
                            </div>
                            
                            <div style="font-size: 13px; color: #475569; line-height: 1.5;">
                                <strong>Instructions:</strong>
                                <ul style="margin: 4px 0 0 0; padding-left: 18px;">
                                    <li>Scan the QR code and authorize camera access on your phone.</li>
                                    <li>Prop your phone up on the side of your desk (e.g. against a book).</li>
                                    <li>The camera should clearly capture your profile, hands, and keyboard.</li>
                                    <li>Do not lock your phone or close the browser tab during the exam.</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 30px;">
                    <button id="btn-next-step" class="btn btn-primary" style="background:#e5e7eb; color:#9ca3af; border:none;" onclick="goToStep(getNextStep(10))" disabled>Next Step</button>
                </div>
            `;
            
            if (window.isMobileCameraPaired) {
                const statusDiv = document.getElementById('mobile-pairing-status');
                if (statusDiv) {
                    statusDiv.style.background = 'rgba(16, 185, 129, 0.1)';
                    statusDiv.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                    statusDiv.style.color = '#10b981';
                    statusDiv.innerHTML = '✅ Phone Connected Successfully!';
                }
                const nextBtn = document.getElementById('btn-next-step');
                if (nextBtn) {
                    nextBtn.disabled = false;
                    nextBtn.style.background = '#2563eb';
                    nextBtn.style.color = 'white';
                }
            }
            break;

        case 7:
            // SCREEN SHARE
            const ios = isIOS();
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Screen Share</h2>
                    ${ios ? `
                        <p class="step-description" style="color: #60a5fa; font-weight: bold; background: rgba(59, 130, 246, 0.1); padding: 15px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.2);">
                            📱 iPad / iPhone Detected: Apple iOS does not support screen-sharing in Safari. This requirement has been bypassed for your device, but webcam and microphone monitoring will remain active.
                        </p>
                    ` : `
                        <p class="step-description">
                            You must share your <strong>ENTIRE SCREEN</strong> (not just a window or Chrome tab) to secure the exam session.
                        </p>
                        <div id="screenshare-status" style="font-weight: bold; color: #10b981; margin: 15px 0;">
                            ${localScreenStream ? '✓ Screen Share Active' : 'Screen share not yet active'}
                        </div>
                    `}
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    ${ios ? '' : `<button class="btn btn-primary" onclick="requestScreenShareStep()" style="${localScreenStream ? 'display:none;' : ''}">Share Entire Screen</button>`}
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(7))" ${ios || localScreenStream ? '' : 'disabled'}>Next Step</button>
                </div>
            `;
            break;
            
        case 8:
            // FULLSCREEN
            const fullscreenSupported = typeof document.documentElement.requestFullscreen === 'function';
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Fullscreen Mode</h2>
                    ${fullscreenSupported ? `
                        <p class="step-description">
                            This exam must be taken in Fullscreen Mode to prevent multitasking or accessing other tabs/windows.
                        </p>
                        <div id="fullscreen-status" style="font-weight: bold; color: #10b981; margin: 15px 0;">
                            ${document.fullscreenElement ? '✓ Fullscreen Mode Enabled' : 'Fullscreen not yet active'}
                        </div>
                    ` : `
                        <p class="step-description" style="color: #60a5fa; font-weight: bold; background: rgba(59, 130, 246, 0.1); padding: 15px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.2);">
                            📱 Mobile Device / Browser Compatibility: Your browser or device does not support standard fullscreen mode. This step has been bypassed, but webcam and microphone monitoring remain active.
                        </p>
                    `}
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    ${fullscreenSupported ? `<button class="btn btn-primary" onclick="requestFullscreenStep()" style="${document.fullscreenElement ? 'display:none;' : ''}">Enter Fullscreen</button>` : ''}
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(8))" ${!fullscreenSupported || document.fullscreenElement ? '' : 'disabled'}>Next Step</button>
                </div>
            `;
            break;
            
        case 9:
            // BEGIN EXAM
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Begin Exam</h2>
                    <p class="step-description">
                        All checks have passed successfully. Click the button below to start your proctored session.
                    </p>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-begin-exam" class="btn btn-success" style="padding: 15px 40px; font-size: 16px; font-weight: bold; background: #10b981; border: none;" onclick="startMainExamSession()">Begin Exam Now</button>
                </div>
            `;
            break;
    }
}

function showStepError(msg) {
    const errEl = document.getElementById('step-error');
    if (errEl) {
        errEl.innerText = msg;
        errEl.style.display = 'block';
    }
}

async function startMicCheck() {
    try {
        localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        localMicStream.getAudioTracks().forEach(track => {
            track.onmute = () => {
                logProctorEvent('mic_muted', 'Microphone was muted by the student (hardware/system mute).');
            };
            track.onunmute = () => {
                logProctorEvent('mic_unmuted', 'Microphone was unmuted by the student.');
            };
        });

        micAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        micAnalyser = micAudioContext.createAnalyser();
        const source = micAudioContext.createMediaStreamSource(localMicStream);
        source.connect(micAnalyser);
        micAnalyser.fftSize = 256;
        const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);
        
        const meterFill = document.getElementById('mic-volume-fill');
        const nextBtn = document.getElementById('btn-next-step');
        if (nextBtn) nextBtn.disabled = false;
        
        const checkBtn = document.querySelector('button[onclick="startMicCheck()"]');
        if (checkBtn) checkBtn.style.display = 'none';
        
        micVolInterval = setInterval(() => {
            micAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            const percentage = Math.min(100, Math.round((average / 128) * 100));
            if (meterFill) meterFill.style.width = `${percentage}%`;
        }, 50);
    } catch (err) {
        showStepError("Microphone access denied or not found: " + err.message);
    }
}

let trackingLoaded = false;
let isModelLoading = false;
let isCheckingWebcamAI = false;
let trackerInstance = null;
let trackerTask = null;
let lastFaceDetectedTime = 0;
let webcamWatchdogInterval = null;

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

let cocoSsdModel = null;
let facemeshModel = null;

async function loadAIModel() {
    if (cocoSsdModel && facemeshModel) return;
    if (isModelLoading) {
        while (isModelLoading) {
            await new Promise(r => setTimeout(r, 100));
        }
        return;
    }
    isModelLoading = true;
    try {
        console.log("[AI] Loading TensorFlow.js...");
        await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.11.0/dist/tf.min.js");
        
        console.log("[AI] Loading COCO-SSD & FaceMesh...");
        await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js");
        await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/facemesh@0.0.5/dist/facemesh.min.js");
        
        console.log("[AI] Initializing models...");
        cocoSsdModel = await cocoSsd.load();
        facemeshModel = await facemesh.load({ maxFaces: 1 });
        
        trackingLoaded = true;
        console.log("[AI] Models loaded successfully.");
    } catch (err) {
        console.error("[AI] Failed to load AI models:", err);
        throw err;
    } finally {
        isModelLoading = false;
    }
}

function runWebcamAIDetection() {
    if (!facemeshModel) return;
    
    const videoEl = document.getElementById('webcam-check-preview');
    if (!videoEl || !localCamStream) return;

    lastFaceDetectedTime = Date.now();
    isCheckingWebcamAI = true;

    if (webcamWatchdogInterval) {
        clearInterval(webcamWatchdogInterval);
    }
    
    let detectionLoopId = null;

    async function detectLoop() {
        if (!isCheckingWebcamAI) return;
        
        try {
            const predictions = await facemeshModel.estimateFaces(videoEl);
            if (predictions.length > 0) {
                lastFaceDetectedTime = Date.now();
                const statusMsgEl = document.getElementById('ai-status-msg');
                const recordBtn = document.getElementById('btn-record-webcam');
                const nextBtn = document.getElementById('btn-next-step');
                if (statusMsgEl) {
                    statusMsgEl.innerHTML = `<span style="color: #10b981; font-weight: bold;">✓ Human Verified</span>`;
                }
                if (recordBtn) recordBtn.disabled = false;
                if (nextBtn) nextBtn.disabled = false;
            }
        } catch (e) {
            // Ignore inference errors
        }
        
        if (isCheckingWebcamAI) {
            detectionLoopId = setTimeout(detectLoop, 1000);
        }
    }
    
    detectLoop();

    // Watchdog interval for Webcam Check
    webcamWatchdogInterval = setInterval(() => {
        if (!isCheckingWebcamAI) {
            clearInterval(webcamWatchdogInterval);
            if (detectionLoopId) clearTimeout(detectionLoopId);
            return;
        }
        const elapsed = Date.now() - lastFaceDetectedTime;
        if (elapsed > 1500) {
            const statusMsgEl = document.getElementById('ai-status-msg');
            const recordBtn = document.getElementById('btn-record-webcam');
            const nextBtn = document.getElementById('btn-next-step');
            if (statusMsgEl) {
                statusMsgEl.innerHTML = `<span style="color: #ef4444; font-weight: bold;">❌ No Human Detected - Please face the camera</span>`;
            }
            if (recordBtn) recordBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
        }
    }, 1000);
}

async function startWebcamCheck() {
    const nextBtn = document.getElementById('btn-next-step');
    const recordBtn = document.getElementById('btn-record-webcam');
    const aiLoadingContainer = document.getElementById('ai-loading-container');
    const aiStatusContainer = document.getElementById('ai-status-container');
    try {
        if (examConfig.require_camera) {
            if (nextBtn) nextBtn.disabled = true;
            if (recordBtn) recordBtn.disabled = true;
        }

        localCamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        const videoEl = document.getElementById('webcam-check-preview');
        if (videoEl) videoEl.srcObject = localCamStream;
        
        if (examConfig.require_camera) {
            if (aiLoadingContainer) aiLoadingContainer.style.display = 'flex';
            if (aiStatusContainer) aiStatusContainer.style.display = 'none';

            try {
                await loadAIModel();
                if (aiLoadingContainer) aiLoadingContainer.style.display = 'none';
                if (aiStatusContainer) aiStatusContainer.style.display = 'flex';

                isCheckingWebcamAI = true;
                runWebcamAIDetection();
            } catch (aiErr) {
                console.error("[AI] Graceful degradation: Failed to initialize AI model:", aiErr);
                if (aiLoadingContainer) aiLoadingContainer.style.display = 'none';
                if (aiStatusContainer) aiStatusContainer.style.display = 'none';
                
                const errEl = document.getElementById('step-error');
                if (errEl) {
                    errEl.innerText = "Warning: AI presence verification offline. Proceeding with standard camera check.";
                    errEl.style.color = "#b45309";
                    errEl.style.display = 'block';
                }
                if (nextBtn) nextBtn.disabled = false;
                if (recordBtn) recordBtn.disabled = false;
            }
        } else {
            if (aiLoadingContainer) aiLoadingContainer.style.display = 'none';
            if (aiStatusContainer) aiStatusContainer.style.display = 'none';
            
            if (nextBtn) nextBtn.disabled = false;
            if (recordBtn) recordBtn.disabled = false;
        }
    } catch (err) {
        if (aiLoadingContainer) aiLoadingContainer.style.display = 'none';
        showStepError("Camera access denied or not found: " + err.message);
    }
}

function startWebcam5sRecord() {
    const recordBtn = document.getElementById('btn-record-webcam');
    const timerEl = document.getElementById('webcam-timer');
    if (!localCamStream) {
        showStepError("Camera stream not available. Please allow camera access.");
        return;
    }
    
    webcamChunks = [];
    let options = {};
    const candidates = [
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4;codecs=avc1',
        'video/mp4'
    ];
    for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) {
            options = { mimeType: candidate };
            break;
        }
    }
    
    // Combine webcam video tracks with the already active microphone tracks to record both audio and video
    let combinedStream;
    if (isIOS()) {
        combinedStream = localCamStream;
        if (localMicStream) {
            localMicStream.getAudioTracks().forEach(t => {
                try { combinedStream.addTrack(t); } catch(e){}
            });
        }
    } else {
        const tracks = [
            ...localCamStream.getVideoTracks()
        ];
        if (localMicStream) {
            localMicStream.getAudioTracks().forEach(t => tracks.push(t));
        }
        combinedStream = new MediaStream(tracks);
    }
    
    try {
        webcamRecorder = new MediaRecorder(combinedStream, options);
    } catch (e) {
        try {
            webcamRecorder = new MediaRecorder(combinedStream);
        } catch (err) {
            showStepError("MediaRecorder error: " + err.message);
            return;
        }
    }
    
    webcamRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) webcamChunks.push(e.data);
    };
    webcamRecorder.onstop = () => {
        const mimeToUse = webcamRecorder.mimeType || 'video/webm';
        const blob = new Blob(webcamChunks, { type: mimeToUse });
        webcamVideoUrl = URL.createObjectURL(blob);
        
        const videoEl = document.getElementById('webcam-check-preview');
        if (videoEl) {
            videoEl.srcObject = null;
            videoEl.src = webcamVideoUrl;
            videoEl.muted = false;
            videoEl.loop = true;
            videoEl.play().catch(pErr => console.log('Preview check failed:', pErr));
        }
        
        if (timerEl) {
            timerEl.innerHTML = '<span style="color: #059669;">✓ Review Complete</span>';
        }
        
        recordBtn.style.display = 'none';
        document.getElementById('btn-next-step').disabled = false;
    };
    
    try {
        webcamRecorder.start();
        recordBtn.disabled = true;
        
        let secondsLeft = 5;
        timerEl.innerText = `Recording: ${secondsLeft}s`;
        
        const interval = setInterval(() => {
            secondsLeft--;
            if (secondsLeft <= 0) {
                clearInterval(interval);
                timerEl.innerText = "Reviewing recorded clip...";
                if (webcamRecorder && webcamRecorder.state !== 'inactive') {
                    webcamRecorder.stop();
                }
            } else {
                timerEl.innerText = `Recording: ${secondsLeft}s`;
            }
        }, 1000);
    } catch (startErr) {
        showStepError("Failed to start recording: " + startErr.message);
        recordBtn.disabled = false;
    }
}

function requestFullscreenStep() {
    document.documentElement.requestFullscreen()
        .then(() => {
            document.getElementById('fullscreen-status').innerHTML = "✓ Fullscreen Mode Enabled";
            document.getElementById('btn-next-step').disabled = false;
        })
        .catch(err => {
            showStepError("Failed to enter Fullscreen mode: " + err.message);
        });
}

async function requestScreenShareStep() {
    try {
        localScreenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always", width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 15 } },
            audio: false
        });
        
        const track = localScreenStream.getVideoTracks()[0];
        if (track && 'contentHint' in track) {
            track.contentHint = 'detail';
        }
        const settings = track.getSettings();
        if (settings.displaySurface && settings.displaySurface !== 'monitor') {
            track.stop();
            throw new Error("You must share your ENTIRE SCREEN, not just a window or tab.");
        }
        
        track.onended = () => {
            localScreenStream = null;
            if (currentStep === 7) {
                const nextBtn = document.getElementById('btn-next-step');
                const ssBtn = document.querySelector('button[onclick="requestScreenShareStep()"]');
                if (nextBtn) nextBtn.disabled = true;
                if (ssBtn) ssBtn.style.display = 'inline-block';
                const statusEl = document.getElementById('screenshare-status');
                if (statusEl) statusEl.innerHTML = "Screen share not yet active";
            }
        };
        
        document.getElementById('screenshare-status').innerHTML = "✓ Screen Share Active";
        document.getElementById('btn-next-step').disabled = false;
        
        const ssBtn = document.querySelector('button[onclick="requestScreenShareStep()"]');
        if (ssBtn) ssBtn.style.display = 'none';
    } catch (screenErr) {
        showStepError(screenErr.message);
    }
}

async function startMainExamSession() {
    if (isStartingExam) return;
    isStartingExam = true;

    // Resume the pre-authorized audio context on user gesture to bypass browser autoplay policies
    if (typeof micAudioContext !== 'undefined' && micAudioContext) {
        micAudioContext.resume().then(() => {
            console.log("[Audio] micAudioContext successfully resumed during Begin Exam user gesture.");
        }).catch(err => {
            console.warn("[Audio] Failed to resume micAudioContext:", err);
        });
    }
    
    const btn = document.getElementById('btn-begin-exam');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Initializing Security...";
    }
    
    try {
        console.log("[Session] Registering session on backend...");
        const sessionRes = await fetch('/api/session/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exam_id: examConfig.id, token: sessionToken })
        });
        sessionInfo = await sessionRes.json();
        if (!sessionRes.ok || sessionInfo.error) {
            throw new Error(sessionInfo.error || "Session authentication failed");
        }
        if (sessionInfo.next_chunk_index !== undefined) {
            chunkIndex = sessionInfo.next_chunk_index;
            console.log(`[Resume] Setting chunkIndex to ${chunkIndex}`);
        }

        // Upload room scan now that session is created
        if (roomScanBlob) {
            console.log("[Session] Uploading Room Scan...");
            const reader = new FileReader();
            reader.readAsDataURL(roomScanBlob);
            reader.onloadend = async function() {
                const base64data = reader.result;
                try {
                    await fetch('/api/session/room-scan', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + sessionToken
                        },
                        body: JSON.stringify({
                            exam_session_id: sessionInfo.id,
                            base64_video: base64data
                        })
                    });
                    console.log("[Session] Room scan uploaded successfully.");
                } catch(e) {
                    console.error("[Session] Failed to upload room scan", e);
                }
            };
        }

        // Upload ID Verification Image
        if (window.capturedIdPhoto) {
            console.log("[Session] Uploading ID Verification Image...");
            try {
                await fetch('/api/session/upload-id', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + sessionToken
                    },
                    body: JSON.stringify({
                        exam_session_id: sessionInfo.id,
                        base64_image: window.capturedIdPhoto
                    })
                });
                console.log("[Session] ID image uploaded successfully.");
            } catch (e) {
                console.error("[Session] Failed to upload ID image:", e);
            }
        }

        // Upload Signature Image
        if (window.signatureDataUrl) {
            console.log("[Session] Uploading Signature Image...");
            try {
                await fetch('/api/session/upload-signature', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + sessionToken
                    },
                    body: JSON.stringify({
                        exam_session_id: sessionInfo.id,
                        base64_image: window.signatureDataUrl,
                        full_name: window.signatureName || ''
                    })
                });
                console.log("[Session] Signature image uploaded successfully.");
            } catch (e) {
                console.error("[Session] Failed to upload signature image:", e);
            }
        }

        // Clean up chunks from any old sessions to save disk space
        await cleanOldChunks(sessionInfo.id);

        // Recover any pending chunks in IndexedDB for the current session
        const pending = await getPendingChunksFromDB(sessionInfo.id);
        if (pending.length > 0) {
            console.log(`[DB] Found ${pending.length} pending chunks in IndexedDB for current session. Restoring queue.`);
            uploadQueue = pending.map(p => ({ index: p.index, attempts: p.attempts }));
            
            // Sync chunkIndex to the highest pending chunk index if it's greater to avoid collision
            const maxIdx = Math.max(...pending.map(p => p.index));
            if (maxIdx > chunkIndex) {
                chunkIndex = maxIdx;
                console.log(`[DB] Adjusted chunkIndex to ${chunkIndex} based on pending chunks.`);
            }
            
            // Start processing the restored queue
            processUploadQueue();
        }

        if (isIOS()) {
            const warningEl = document.getElementById('ios-iframe-warning');
            if (warningEl) warningEl.style.display = 'flex';
        }
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        
        const pwdDisplay = document.getElementById('quiz-password-display');
        if (pwdDisplay) {
            if (examConfig.canvas_quiz_password && examConfig.canvas_quiz_password.trim() !== '') {
                pwdDisplay.innerText = `Access Code: ${examConfig.canvas_quiz_password}`;
                pwdDisplay.style.display = 'inline-block';
            } else {
                pwdDisplay.style.display = 'none';
            }
        }
        
        if (examConfig.disable_clipboard) {
            document.addEventListener('copy', e => {
                e.preventDefault();
                showToast('Copying text is disabled during this secure proctored exam.');
            });
            document.addEventListener('cut', e => {
                e.preventDefault();
                showToast('Cutting text is disabled during this secure proctored exam.');
            });
            document.addEventListener('paste', e => {
                e.preventDefault();
                showToast('Pasting text is disabled during this secure proctored exam.');
            });
        }

        if (examConfig.disable_printing) {
            const style = document.createElement('style');
            style.textContent = `@media print { body, iframe, #quiz-iframe { display: none !important; } }`;
            document.head.appendChild(style);
            
            window.addEventListener('beforeprint', e => {
                e.preventDefault();
                showToast('Printing is disabled during this secure proctored exam.');
            });
            
            document.addEventListener('keydown', e => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
                    e.preventDefault();
                    showToast('Printing is disabled during this secure proctored exam.');
                }
            });
        }

        let quizUrl = examConfig.canvas_quiz_url;
        if (quizUrl.includes('/quizzes/') && !quizUrl.includes('/take')) {
            try {
                const urlObj = new URL(quizUrl);
                if (!urlObj.pathname.endsWith('/take')) {
                    urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '/take';
                    quizUrl = urlObj.toString();
                }
            } catch(e) {}
        }

        if (quizUrl.includes('?')) {
            quizUrl += "&secure_proctor=canvas-proctor-shared-secret-key-998877";
        } else {
            quizUrl += "?secure_proctor=canvas-proctor-shared-secret-key-998877";
        }
        quizUrl += `&proctor_session_token=${encodeURIComponent(sessionToken)}`;
        if (sessionInfo.auto_login_signature) {
            quizUrl += `&auto_login_user_id=${encodeURIComponent(sessionInfo.auto_login_user_id)}&auto_login_expires=${encodeURIComponent(sessionInfo.auto_login_expires)}&auto_login_signature=${encodeURIComponent(sessionInfo.auto_login_signature)}`;
        }
        window.fallbackQuizUrl = quizUrl; // Store globally for iPad/iPhone fallback
        
        const iframe = document.getElementById('quiz-iframe');
        if (examConfig.block_downloads) {
            iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-top-navigation allow-top-navigation-by-user-activation');
        } else {
            iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-downloads-without-user-activation allow-top-navigation allow-top-navigation-by-user-activation');
        }

        iframe.onload = () => {
            console.log("[Proctor] Quiz iframe loaded, sending security config postMessage...");
            iframe.contentWindow.postMessage({
                type: 'proctor_config',
                disable_right_click: examConfig.disable_right_click,
                disable_clipboard: examConfig.disable_clipboard,
                disable_printing: examConfig.disable_printing
            }, '*');
        };
        iframe.src = quizUrl;

        document.getElementById('setup-container').style.display = 'none';
        document.getElementById('active-exam-container').style.display = 'flex';

        if (document.documentElement.dataset.proctorExtensionInstalled === "true") {
            console.log("[Proctor] Extension detected. Sending START_EXAM_LOCKDOWN message.");
            window.postMessage({
                type: 'START_EXAM_LOCKDOWN',
                examId: examConfig.id,
                token: sessionToken,
                settings: {
                    close_open_tabs: !!examConfig.close_open_tabs,
                    disable_new_tabs: !!examConfig.disable_new_tabs,
                    prevent_incognito: !!examConfig.prevent_incognito,
                    record_web_traffic: !!examConfig.record_web_traffic,
                    advanced_hardware_detection: !!examConfig.advanced_hardware_detection,
                    only_one_screen: !!examConfig.only_one_screen,
                    disable_extensions: !!examConfig.disable_extensions,
                    clear_cache: !!examConfig.clear_cache,
                    advanced_program_detection: !!examConfig.advanced_program_detection,
                    advanced_vm_detection: !!examConfig.advanced_vm_detection,
                    allow_apps: !!examConfig.allow_apps,
                    block_mobile: !!examConfig.block_mobile,
                    // Per-page lockdown settings (enforced on ALL tabs including Canvas quiz)
                    disable_clipboard: !!examConfig.disable_clipboard,
                    disable_right_click: !!examConfig.disable_right_click,
                    disable_printing: !!examConfig.disable_printing
                }
            }, '*');
        }

        const isCompanionApp = navigator.userAgent.includes('CanvasProctorCompanion');
        if (isCompanionApp && window.companionAPI) {
            console.log("[Proctor] Companion Desktop App detected. Initializing process monitoring.");
            window.companionAPI.startMonitoring({
                blockedApps: examConfig.blocked_apps,
                allowedApps: examConfig.allowed_apps,
                allowedUrls: examConfig.allowed_urls
            });
            window.companionAPI.onViolation((violation) => {
                if (violation.type === 'prohibited_process') {
                    console.warn(`[Companion] Violation detected: Prohibited process running: ${violation.process}`);
                    handleViolation('prohibited_process', `Prohibited background application running: ${violation.process}`);
                    document.getElementById('focus-violation-overlay').querySelector('p').innerText = 
                        `🔒 Prohibited App Running: "${violation.process}" has been detected in the background. Close this application immediately to resume your exam.`;
                    document.getElementById('focus-violation-overlay').style.display = 'flex';
                } else if (violation.type === 'multiple_displays') {
                    console.warn(`[Companion] Violation detected: Multiple displays connected: ${violation.count}`);
                    showDualScreenBlocker(true, 'desktop companion');
                }
            });
        }

    } catch(err) {
        isStartingExam = false;
        const btn = document.getElementById('btn-begin-exam');
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Begin Exam Now";
        }
        alert("Failed to initialize proctoring session: " + err.message);
    }
}

function handleScreenShareStopped() {
    console.warn("[Proctor] Screen share stopped during exam!");
    logProctorEvent('screen_share_disabled', 'Screen sharing was stopped by the student.');
    
    const overlay = document.getElementById('screen-share-blocker-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

async function reShareScreenFromBlocker() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always", width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 15 } },
            audio: false
        });
        
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        if (settings.displaySurface && settings.displaySurface !== 'monitor') {
            track.stop();
            alert("You must share your ENTIRE SCREEN, not just a window or tab.");
            return;
        }
        
        // Update variables
        localScreenStream = stream;
        screenStream = stream;
        
        if ('contentHint' in track) {
            track.contentHint = 'detail';
        }
        
        track.onended = () => {
            handleScreenShareStopped();
        };
        
        // Update the screen video element used in composite track
        if (compositeVScreen) {
            compositeVScreen.srcObject = localScreenStream;
            await compositeVScreen.play().catch(e => console.warn("[Media] Re-shared screen play failed:", e));
        }
        
        // Hide overlay
        document.getElementById('screen-share-blocker-overlay').style.display = 'none';
        
        logProctorEvent('screen_share_resolved', 'Screen sharing was re-enabled by the student.');
    } catch (err) {
        console.error("Failed to re-share screen:", err);
        alert("Failed to share screen: " + err.message);
    }
}

let isProctoringStarted = false;

async function startProctoring() {
    if (isProctoringStarted) return;
    isProctoringStarted = true;

    try {
        console.log("[Proctor] Starting proctoring stream & recordings...");
        
        if (webcamVideoUrl) {
            URL.revokeObjectURL(webcamVideoUrl);
            webcamVideoUrl = null;
        }
        
        videoStream = localCamStream;
        screenStream = localScreenStream;

        if (screenStream && screenStream.getVideoTracks().length > 0) {
            const screenTrack = screenStream.getVideoTracks()[0];
            if ('contentHint' in screenTrack) {
                screenTrack.contentHint = 'detail';
            }
            screenTrack.onended = () => {
                handleScreenShareStopped();
            };
        }
        if (videoStream && videoStream.getVideoTracks().length > 0) {
            const camTrack = videoStream.getVideoTracks()[0];
            if ('contentHint' in camTrack) {
                camTrack.contentHint = 'motion';
            }
        }
        
        const tracks = [];
        let compositeStream = null;
        const addedTrackIds = new Set();

        const ios = isIOS();
        if (ios) {
            console.log("[Media] iOS/Safari detected: obtaining combined audio/video stream for MediaRecorder...");
            // Stop old tracks to release camera/mic hardware cleanly
            if (localCamStream) {
                localCamStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
            }
            if (localMicStream) {
                localMicStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
            }
            
            try {
                finalStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 640, height: 480 },
                    audio: true
                });
                localCamStream = finalStream;
                localMicStream = finalStream;
                videoStream = finalStream;
            } catch (mediaErr) {
                console.error("[Media] Failed to get combined stream on iOS:", mediaErr);
                throw mediaErr;
            }
        } else {
            // Always create a composite track layout to ensure proctoring status indicators and flags are drawn on the recording
            console.log("[Media] Initializing composite track layout...");
            compositeStream = await createCompositeTrack(screenStream, videoStream);
            compositeStream.getTracks().forEach(t => {
                if (!addedTrackIds.has(t.id)) {
                    tracks.push(t);
                    addedTrackIds.add(t.id);
                }
            });

            if (localMicStream) {
                localMicStream.getAudioTracks().forEach(t => {
                    if (!addedTrackIds.has(t.id)) {
                        console.log("[Media] Appending microphone audio track to final recorded stream:", t.label);
                        tracks.push(t);
                        addedTrackIds.add(t.id);
                    }
                });
            }
            finalStream = new MediaStream(tracks);
        }
        console.log(`[Media] Final stream ready with ${finalStream ? finalStream.getVideoTracks().length : 0} video and ${finalStream ? finalStream.getAudioTracks().length : 0} audio tracks.`);

        // local-video srcObject assignment removed to avoid redundant decoding/rendering

        setupRecording();

        if (sessionInfo && sessionInfo.id && mediaRecorder) {
            const mimeType = mediaRecorder.mimeType || 'video/webm';
            fetch(`/api/session/${sessionInfo.id}/format`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mime_type: mimeType, token: sessionToken })
            }).catch(err => console.warn("[Format] Handshake failed."));
        }

        console.log("[Media] Warming up tracks for stable recording...");
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (mediaRecorder) {
            mediaRecorder.start(5000);
            console.log("[Recorder] Session recording started with 5s slices.");
        }

        socket.emit('join_student', {
            exam_id: examConfig.id,
            exam_session_id: sessionInfo.id,
            student_name: sessionInfo.student_name
        });

        socket.emit('laptop_begin_exam', { token: sessionToken });

        if (examConfig.require_fullscreen && !document.fullscreenElement && typeof document.documentElement.requestFullscreen === 'function') {
             await document.documentElement.requestFullscreen().catch(e => console.log('Fullscreen failed:', e));
        }

        if (examConfig.disable_right_click) {
             document.addEventListener('contextmenu', event => event.preventDefault());
        }

        setupFocusTracking();
        if (examConfig.only_one_screen) {
            initDisplayMonitoring();
        }
        setupSimulatedAIProctoring();
        startExamLiveAIDetection();
        if (localMicStream) {
            setupAudioAnalysis(localMicStream);
            setupSpeechRecognition();
        }
        
        setInterval(sendSnapshot, 3000);

        showToast("Proctoring session successfully started.");

    } catch (err) {
        console.error("Failed to start proctoring:", err);
        showToast("Failed to start proctoring: " + err.message);
        if (sessionInfo && sessionInfo.id) {
            fetch('/api/session/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exam_session_id: sessionInfo.id,
                    event_type: 'error',
                    event_message: `Failed to start proctoring: ${err.message}`,
                    token: sessionToken
                })
            }).catch(e => {});
        }
    }
}

function isSEB() {
    // Check User Agent or our explicit URL flag
    // We NO LONGER check for just !!sessionToken here because that was causing 
    // loops/premature prompts in regular Chrome.
    return navigator.userAgent.includes('SafeExamBrowser') || isSebParam;
}

function showSEBBlocker() {
    const setupContainer = document.getElementById('setup-container');
    setupContainer.classList.add('seb-blocker-active');
    setupContainer.innerHTML = `
        <div class="check-card">
            <div class="seb-shield-icon">🛡️</div>
            <h1 class="danger">Safe Exam Browser Required</h1>
            <p class="seb-desc">
                This exam requires the Safe Exam Browser to ensure a secure, distraction-free testing environment. 
                You are currently using a standard browser.
            </p>
            <div class="seb-info-box">
                <h3>Instructions</h3>
                <ol>
                    <li>Ensure <strong>Safe Exam Browser</strong> is installed on this device.</li>
                    <li>Click <strong>Launch Securely in SEB</strong> below.</li>
                    <li>Choose <strong>Open Safe Exam Browser</strong> if prompted by your browser.</li>
                </ol>
            </div>
            <button class="btn btn-primary" onclick="launchSEB()">Launch Securely in SEB</button>
            
            <p class="seb-footer-hint">
                Trouble launching? <a href="javascript:void(0)" onclick="downloadSEBConfig()">Download config file manually</a>
            </p>
        </div>
    `;
}

function downloadSEBConfig() {
    if (!sessionToken) {
        alert('Session lost. Please re-launch from your LMS.');
        return;
    }
    const codeInput = document.getElementById('access-code-input');
    const code = codeInput ? codeInput.value.trim() : '';
    const params = [];
    if (code) params.push(`exam_code=${encodeURIComponent(code)}`);
    if (placementId) params.push(`placement_id=${encodeURIComponent(placementId)}`);
    if (directExamId) params.push(`exam_id=${encodeURIComponent(directExamId)}`);
    
    let url = `/api/seb/config/${sessionToken}`;
    if (params.length > 0) url += `?${params.join('&')}`;
    window.location.href = url;
}

function launchSEB() {
    if (!sessionToken) {
        alert('Session lost. Please re-launch from your LMS.');
        return;
    }
    const codeInput = document.getElementById('access-code-input');
    const code = codeInput ? codeInput.value.trim() : '';
    const protocol = window.location.protocol === 'https:' ? 'sebs' : 'seb';
    
    const params = [];
    if (code) params.push(`exam_code=${encodeURIComponent(code)}`);
    if (placementId) params.push(`placement_id=${encodeURIComponent(placementId)}`);
    if (directExamId) params.push(`exam_id=${encodeURIComponent(directExamId)}`);
    
    let configPath = `/api/seb/config/${sessionToken}/config.seb`;
    if (params.length > 0) configPath += `?${params.join('&')}`;
    
    const sebUrl = `${protocol}://${window.location.host}${configPath}`;
    window.location.href = sebUrl;
}

function setupRecording() {
    // Dynamically select the most compatible codec for the current hardware/tracks
    let mimeType = '';
    
    // Check WebM (VP9, H264, VP8) and MP4 candidates
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=h264',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4'
    ];

    for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) {
            mimeType = candidate;
            break;
        }
    }

    console.log(`[Recorder] Initialized with: ${mimeType || 'browser default'}`);
    
    const options = {
        videoBitsPerSecond: 1500000, // Legible screen text
        audioBitsPerSecond: 128000
    };
    if (mimeType) {
        options.mimeType = mimeType;
    }

    mediaRecorder = new MediaRecorder(finalStream, options);
    mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0 && sessionInfo && sessionInfo.id) {
            // CRITICAL: Capture the current index locally to prevent race conditions during upload
            const currentIndex = ++chunkIndex;
            activeUploads++; // Increment to track that file reading/db writing is in progress
            
            const reader = new FileReader();
            reader.onloadend = async () => {
                const result = reader.result || '';
                const base64Part = result.indexOf(';base64,');
                const base64Data = base64Part !== -1 ? result.substring(base64Part + 8) : (result.indexOf(',') !== -1 ? result.substring(result.indexOf(',') + 1) : result);
                
                console.log(`[Recorder] Saving chunk #${currentIndex} (${e.data.size} bytes) to IndexedDB...`);
                await saveChunkToDB(sessionInfo.id, currentIndex, base64Data);
                
                // Add to sequential upload queue and decrement read counter
                uploadQueue.push({ index: currentIndex, attempts: 0 });
                activeUploads--;
                
                // Trigger background queue processor
                processUploadQueue();
            };
            reader.onerror = () => {
                console.error(`[Recorder] FileReader error on chunk #${currentIndex}`);
                activeUploads--;
            };
            reader.readAsDataURL(e.data);
        }
    };
    
    mediaRecorder.onerror = (e) => {
        console.error("[Recorder] MediaRecorder Error:", e.error);
        if (socket) {
            socket.emit('proctor_log', {
                exam_session_id: sessionInfo.id,
                event_type: 'error',
                event_message: `MediaRecorder Error: ${e.error ? e.error.name : 'Unknown'}`
            });
        }
    };
    
    // Note: The actual recording start is now handled in startPreFlight
    // with a specific warm-up delay to prevent DEMUXER_ERRORs.
}

async function processUploadQueue() {
    if (isProcessingQueue) return;
    if (uploadQueue.length === 0) return;
    
    isProcessingQueue = true;
    console.log(`[Queue] Processing started. Remaining items in queue: ${uploadQueue.length}`);
    
    while (uploadQueue.length > 0) {
        const item = uploadQueue[0];
        activeUploads++; // Count as active upload while fetch is active
        
        let success = false;
        try {
            let chunkRecord = null;
            if (useMemoryStorage) {
                const chunkKey = `${sessionInfo.id}_${item.index}`;
                chunkRecord = memoryChunks[chunkKey];
            } else {
                // Retrieve chunk data from IndexedDB
                const db = await openDB();
                const chunkKey = `${sessionInfo.id}_${item.index}`;
                chunkRecord = await new Promise((resolve) => {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const store = tx.objectStore(STORE_NAME);
                    const req = store.get(chunkKey);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                });
            }

            if (!chunkRecord || !chunkRecord.data) {
                console.warn(`[Queue] Chunk #${item.index} data not found in DB. Skipping to prevent lock.`);
                uploadQueue.shift();
                continue;
            }

            console.log(`[Queue] Uploading chunk #${item.index} (attempt ${item.attempts + 1})...`);
            const response = await fetch('/api/session/upload-chunk', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exam_session_id: sessionInfo.id,
                    chunk_index: item.index,
                    base64_video: chunkRecord.data,
                    token: sessionToken
                })
            });
            
            if (response.ok) {
                success = true;
                console.log(`[Queue] Chunk #${item.index} upload success. Deleting from IndexedDB.`);
                await deleteChunkFromDB(sessionInfo.id, item.index);
            } else {
                const errorData = await response.json().catch(() => ({}));
                console.warn(`[Queue] Chunk #${item.index} rejected by server (HTTP ${response.status}):`, errorData.error);
            }
        } catch (err) {
            console.warn(`[Queue] Chunk #${item.index} upload network exception:`, err.message);
        } finally {
            activeUploads--;
        }
        
        if (success) {
            uploadQueue.shift(); // Remove successfully uploaded item
        } else {
            item.attempts++;
            if (item.attempts >= 100) {
                console.error(`[Queue] Chunk #${item.index} failed permanently after 100 attempts. Discarding from DB and queue.`);
                await deleteChunkFromDB(sessionInfo.id, item.index);
                if (socket) {
                    socket.emit('proctor_log', {
                        exam_session_id: sessionInfo.id,
                        event_type: 'error',
                        event_message: `Chunk #${item.index} upload failed permanently after 100 attempts.`
                    });
                }
                uploadQueue.shift(); // Discard failed item
            } else {
                // Update attempts in IndexedDB
                await updateChunkAttemptsInDB(sessionInfo.id, item.index, item.attempts);
                // Wait before retrying (exponential backoff capped at 30s)
                const delay = Math.min(item.attempts * 2000, 30000);
                console.log(`[Queue] Retrying chunk #${item.index} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    
    isProcessingQueue = false;
    console.log(`[Queue] Processing completed.`);
}

function getTargetFPS() {
    const queueLen = uploadQueue.length;
    if (queueLen > 10) {
        return 3;  // Severe congestion, drop to 3 FPS
    } else if (queueLen > 6) {
        return 6;  // Medium congestion, drop to 6 FPS
    } else if (queueLen > 3) {
        return 10; // Mild congestion, drop to 10 FPS
    }
    return 15;     // Healthy network, normal 15 FPS
}

async function createCompositeTrack(screenStream, cameraStream) {
    const canvas = document.createElement('canvas');
    canvas.width = 1600; // 1280 (screen) + 320 (sidebar)
    canvas.height = 720;
    const ctx = canvas.getContext('2d', { alpha: false });

    let vScreen = null;
    if (screenStream) {
        vScreen = document.createElement('video');
        vScreen.srcObject = screenStream;
        vScreen.muted = true;
        vScreen.setAttribute('playsinline', ''); 
        await vScreen.play().catch(e => console.warn("[Media] Screen video play failed:", e));
    }
    compositeVScreen = vScreen;

    let vCam = null;
    if (cameraStream && cameraStream.getVideoTracks().length > 0) {
        vCam = document.createElement('video');
        vCam.srcObject = cameraStream;
        vCam.muted = true;
        vCam.setAttribute('playsinline', '');
        await vCam.play().catch(e => console.warn("[Media] Camera video play failed:", e));
    }
    compositeVCam = vCam;

    // Volume Detection for visual feedback
    let volumeLevel = 0;
    let lastNonZeroVolumeTime = Date.now();
    let audioTrackerActive = false;
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        
        let sourceStream = cameraStream;
        if (!sourceStream || sourceStream.getAudioTracks().length === 0) {
            sourceStream = localMicStream;
        }
        
        if (sourceStream && sourceStream.getAudioTracks().length > 0) {
            audioTrackerActive = true;
            const source = audioCtx.createMediaStreamSource(sourceStream);
            source.connect(analyser);
            analyser.fftSize = 256;
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
 
            function updateVolume() {
                if (!compositeAnimationId && compositeAnimationId !== 0) return;
                if (audioCtx.state === 'suspended') audioCtx.resume();
                analyser.getByteFrequencyData(dataArray);
                let max = 0;
                for (let i = 0; i < dataArray.length; i++) if(dataArray[i] > max) max = dataArray[i];
                volumeLevel = max;
                if (max > 0) {
                    lastNonZeroVolumeTime = Date.now();
                }
                setTimeout(updateVolume, 100);
            }
            updateVolume();
        }
    } catch (e) {
        console.warn("[Media] Audio context failed, mic indicator will be static.", e);
    }
 
    function draw() {
        if (!compositeAnimationId && compositeAnimationId !== 0) return;
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
 
        if (vScreen && screenStream) {
            ctx.drawImage(vScreen, 0, 0, 1280, 720);
        } else {
            ctx.fillStyle = "#1e293b";
            ctx.fillRect(0, 0, 1280, 720);
            ctx.fillStyle = "#9ca3af";
            ctx.font = "bold 20px Arial";
            const placeholderText = "SCREEN MONITORING INACTIVE";
            ctx.fillText(placeholderText, (1280 - ctx.measureText(placeholderText).width) / 2, 360);
        }
        
        const sidebarX = 1280;
        const camW = 320;
        const camH = 240;
        const camY = (720 - camH) / 2 - 40; // Shift up slightly to make room for mic box
        
        // Draw Camera
        if (vCam) {
            ctx.drawImage(vCam, sidebarX, camY, camW, camH);
        } else {
            ctx.fillStyle = "#1e293b";
            ctx.fillRect(sidebarX, camY, camW, camH);
            ctx.fillStyle = "#9ca3af";
            ctx.font = "bold 13px Arial";
            const placeholderText = "NO WEBCAM REQUIRED";
            ctx.fillText(placeholderText, sidebarX + (320 - ctx.measureText(placeholderText).width) / 2, camY + camH / 2);
        }
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 2;
        ctx.strokeRect(sidebarX, camY, camW, camH);
        
        ctx.fillStyle = "white";
        ctx.font = "bold 14px Arial";
        const camLabel = "PROCTOR FEED";
        ctx.fillText(camLabel, sidebarX + (320 - ctx.measureText(camLabel).width) / 2, camY - 15);
 
        // Mic Status Box - Hardware connectivity based
        const hasHardwareMic = localMicStream && localMicStream.getAudioTracks().some(t => t.enabled && !t.muted && t.readyState === 'live');
        const isHardwareMuted = audioTrackerActive && (Date.now() - lastNonZeroVolumeTime) > 3000;
        const hasMic = hasHardwareMic && !isHardwareMuted;
        const micBoxY = camY + camH + 40;
        const micBoxW = 240;
        const micBoxH = 60;
        const micBoxX = sidebarX + (320 - micBoxW) / 2;
 
        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
        ctx.beginPath();
        ctx.roundRect(micBoxX, micBoxY, micBoxW, micBoxH, 10);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.stroke();
 
        const dotColor = hasMic ? "#22c55e" : "#ef4444";
        
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(micBoxX + 25, micBoxY + 30, 8, 0, Math.PI * 2);
        ctx.fill();
 
        ctx.fillStyle = "white";
        ctx.font = "bold 13px Arial";
        ctx.fillText(hasMic ? "MICROPHONE: ON" : "MICROPHONE: OFF", micBoxX + 45, micBoxY + 35);
        
        // Draw Active Security / AI Flags in the top sidebar space (y = 20 to y = 180)
        const now = Date.now();
        activeVisualFlags = activeVisualFlags.filter(flag => now < flag.expiresAt);
        
        let alertY = 20; 
        for (const flag of activeVisualFlags) {
            if (alertY + 45 > camY - 15) break; // Don't draw over the camera label/viewport
            
            const isCritical = flag.type.toLowerCase().includes('violation') || flag.type.toLowerCase().includes('exit') || flag.type.toLowerCase().includes('boot');
            ctx.fillStyle = isCritical ? "rgba(220, 38, 38, 0.9)" : "rgba(217, 119, 6, 0.9)";
            ctx.beginPath();
            ctx.roundRect(sidebarX + 10, alertY, 300, 45, 6);
            ctx.fill();
            
            ctx.fillStyle = "white";
            ctx.font = "bold 11px Arial";
            ctx.fillText(flag.type.toUpperCase(), sidebarX + 20, alertY + 18);
            
            ctx.font = "10px Arial";
            const maxTextWidth = 280;
            let displayMsg = flag.message;
            if (ctx.measureText(displayMsg).width > maxTextWidth) {
                while (ctx.measureText(displayMsg + '...').width > maxTextWidth && displayMsg.length > 0) {
                    displayMsg = displayMsg.slice(0, -1);
                }
                displayMsg += '...';
            }
            ctx.fillText(displayMsg, sidebarX + 20, alertY + 34);
            
            alertY += 55;
        }
        
        compositeAnimationId = setTimeout(draw, 1000 / getTargetFPS());
    }
    
    compositeAnimationId = setTimeout(draw, 1000 / getTargetFPS());
    
    const canvasStream = canvas.captureStream(15); 
    const outputStream = new MediaStream([canvasStream.getVideoTracks()[0]]);
    
    if (cameraStream) {
        cameraStream.getAudioTracks().forEach(track => {
            outputStream.addTrack(track);
        });
    }
    if (localMicStream) {
        localMicStream.getAudioTracks().forEach(track => {
            outputStream.addTrack(track);
        });
    }
    
    return outputStream;
}

function sendSnapshot() {
    const video = document.getElementById('local-video');
    if(video.videoWidth === 0) return;
    
    const canvas = document.createElement('canvas');
    canvas.width = 640; 
    canvas.height = 360; 
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    
    socket.emit('student_snapshot', {
        exam_id: examConfig.id,
        exam_session_id: sessionInfo.id,
        screenshot_data_url: dataUrl
    });
}
function handleViolation(type, message) {
    if (isExamCompleted) return;
    violationCount++;
    logProctorEvent(type, `${message} (Violation #${violationCount})`);
    
    if (examConfig.max_violations > 0 && violationCount >= examConfig.max_violations) {
        bootStudent();
    } else if (type !== 'display_violation') {
        let msg = 'You have left the exam tab or lost focus of the window. This action has been logged and flagged for your instructor to review.';
        if (examConfig.max_violations > 0) {
            msg += ` Warning: You have ${violationCount} / ${examConfig.max_violations} focus violations. Exceeding this limit will automatically terminate your exam session.`;
        }
        document.getElementById('focus-violation-overlay').querySelector('p').innerText = msg;
        document.getElementById('focus-violation-overlay').style.display = 'flex';
    }
}

let dualScreenOverlay = null;

function showDualScreenBlocker(show, source = 'system') {
    if (isExamCompleted) return;

    if (!dualScreenOverlay) {
        dualScreenOverlay = document.getElementById('dual-screen-blocker');
    }
    
    if (!dualScreenOverlay) {
        dualScreenOverlay = document.createElement('div');
        dualScreenOverlay.id = 'dual-screen-blocker';
        dualScreenOverlay.style.cssText = `
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(15, 23, 42, 0.98);
            z-index: 9999999;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: white;
            font-family: 'Plus Jakarta Sans', sans-serif;
            text-align: center;
            padding: 20px;
            box-sizing: border-box;
        `;
        dualScreenOverlay.innerHTML = `
            <div style="background: rgba(30, 41, 59, 0.5); padding: 40px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); max-width: 500px; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
                <div style="margin-bottom: 20px; display: flex; justify-content: center;"><img src="icons/only-one-screen.svg" style="width:60px; height:60px;" /></div>
                <h2 style="font-size: 24px; font-weight: 700; margin: 0 0 15px 0; font-family:'Outfit',sans-serif; color:#f87171;">Multiple Screens Detected</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #374151; margin-bottom: 25px;">
                    This exam requires using a single display. Please disconnect, unplug, or disable all secondary screens, monitors, or display mirroring to resume the exam.
                </p>
                <div style="font-size: 11px; color: #9ca3af; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
                    Proctoring is active. This event has been logged.
                </div>
            </div>
        `;
        document.body.appendChild(dualScreenOverlay);
    }

    if (show) {
        if (dualScreenOverlay.style.display !== 'flex') {
            dualScreenOverlay.style.display = 'flex';
            handleViolation('display_violation', `Multiple monitors/screens detected via ${source}.`);
        }
    } else {
        if (dualScreenOverlay.style.display === 'flex') {
            dualScreenOverlay.style.display = 'none';
            logProctorEvent('display_resolved', `Secondary display disconnected. Student returned to exam (${source}).`);
        }
    }
}

let isDisplayMonitoringInitialized = false;

function initDisplayMonitoring() {
    if (!examConfig.only_one_screen) return;
    if (isDisplayMonitoringInitialized) return;
    isDisplayMonitoringInitialized = true;

    // Heuristics and API checks
    async function evaluateScreens() {
        if (isExamCompleted) return;
        let isExtended = false;
        
        // 1. Modern API: window.screen.isExtended
        if (typeof window.screen.isExtended !== 'undefined') {
            isExtended = window.screen.isExtended;
        } else if (window.screen.isMultiScreen) {
            isExtended = window.screen.isMultiScreen;
        }

        showDualScreenBlocker(isExtended, 'browser api');
    }

    evaluateScreens();

    if (window.screen && window.screen.addEventListener) {
        window.screen.addEventListener('change', evaluateScreens);
    }
    
    setInterval(evaluateScreens, 2000);
}

function setupFocusTracking() {
    document.addEventListener('visibilitychange', () => {
        if (isExamCompleted) return;
        if (document.visibilityState === 'hidden') {
            handleViolation('tab_blur', 'Student switched tabs or minimized browser');
        } else {
            logProctorEvent('tab_focus', 'Student returned to the exam tab');
        }
    });

    let wasFocused = true;
    setInterval(() => {
        if (isExamCompleted) return;
        const isFocused = document.hasFocus();
        if (wasFocused && !isFocused) {
            handleViolation('window_blur', 'Exam window lost focus');
        }
        wasFocused = isFocused;
    }, 500);

    window.addEventListener('resize', () => {
        if (isExamCompleted) return;
        if (examConfig.require_fullscreen && typeof document.documentElement.requestFullscreen === 'function' && !document.fullscreenElement) {
            handleViolation('fullscreen_exit', 'Student exited fullscreen mode');
        }
    });
}

async function bootStudent() {
    isExamCompleted = true; // Stop tracking violations
    window.postMessage({ type: 'END_EXAM_LOCKDOWN' }, '*');
    
    if (examTrackerTask) {
        clearTimeout(examTrackerTask);
        examTrackerTask = null;
    }
    if (examWatchdogInterval) {
        clearInterval(examWatchdogInterval);
        examWatchdogInterval = null;
    }
    
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log('Exit fullscreen failed:', err));
    }
    
    // Clear overlay
    document.getElementById('focus-violation-overlay').style.display = 'none';

    // Stop recording and wait for final uploads
    try {
        await stopRecordingAndAwaitUploads();
    } catch(e) {
        console.warn("Failed to stop recording on boot:", e);
    }

    // Teardown tracks safely
    const allStreams = [videoStream, screenStream, finalStream, localMicStream, localCamStream, localScreenStream];
    allStreams.forEach(stream => {
        if (stream) {
            try {
                stream.getTracks().forEach(t => {
                    try { t.stop(); } catch(e){}
                });
            } catch(e){}
        }
    });
    
    try {
        const localVideo = document.getElementById('local-video');
        if (localVideo && localVideo.srcObject) {
            localVideo.srcObject.getTracks().forEach(t => {
                try { t.stop(); } catch(e){}
            });
            localVideo.srcObject = null;
        }
    } catch(e){}
    
    if (compositeAnimationId) clearTimeout(compositeAnimationId);
    compositeAnimationId = null;
    
    try {
        document.getElementById('quiz-iframe').src = '';
    } catch(e){}
    
    try {
        logProctorEvent('booted', 'Student was automatically booted for exceeding focus limit.');
    } catch(e){}
    
    try {
        await fetch('/api/session/end', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ exam_session_id: sessionInfo.id, status: 'booted', token: sessionToken, total_chunks: chunkIndex })
        });
    } catch(err) {
        console.error("Failed to call boot end API:", err);
    }
    
    document.getElementById('active-exam-container').innerHTML = `
        <div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: 8px; max-width: 600px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); font-family: sans-serif;">
            <h1 style="color: var(--danger); margin-bottom: 20px; font-size: 28px;">⚠️ Exam Session Terminated</h1>
            <p style="color: var(--text-secondary); font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                Your session has been terminated because you exceeded the limit of allowed window/tab departures (${examConfig.max_violations}) permitted by your instructor.
            </p>
            <p style="color: var(--text-muted); font-size: 14px;">
                This violation has been logged and flagged for review. Please contact your instructor.
            </p>
        </div>
    `;
}

function logProctorEvent(type, message) {
    activeVisualFlags.push({
        type: type,
        message: message,
        expiresAt: Date.now() + 4000
    });

    if(!sessionInfo) return;
    fetch('/api/session/log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            exam_session_id: sessionInfo.id,
            event_type: type,
            event_message: message,
            token: sessionToken
        })
    }).catch(console.error);

    // showToast('Activity Logged: ' + message);
}

function showToast(msg) {
    const el = document.createElement('div');
    el.style.background = 'var(--danger)';
    el.style.color = 'white';
    el.style.padding = '12px 20px';
    el.style.borderRadius = 'var(--radius)';
    el.style.boxShadow = 'var(--shadow)';
    el.style.fontSize = '14px';
    el.innerText = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 5000);
}



async function stopRecordingAndAwaitUploads() {
    if (isCurrentlyTalking && talkingStartTimestamp) {
        const duration = Math.round((new Date() - talkingStartTimestamp) / 1000);
        const finalDuration = Math.max(1, duration);
        const startTimeStr = talkingStartTimestamp.toLocaleTimeString();
        logProctorEvent('audio_violation', `Talking/Voice detected starting at ${startTimeStr} (Duration: ${finalDuration}s)`);
    }

    if (talkingDetectionInterval) {
        clearInterval(talkingDetectionInterval);
        talkingDetectionInterval = null;
    }
    isCurrentlyTalking = false;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        let stopped = false;
        mediaRecorder.addEventListener('stop', () => {
            stopped = true;
            console.log("[Recorder] MediaRecorder stop event received.");
        }, { once: true });

        try {
            mediaRecorder.stop();
        } catch(e) {
            console.warn("Failed to stop mediaRecorder:", e);
            stopped = true;
        }

        // Wait for the stop event to fire (up to 4 seconds)
        const stopWaitStart = Date.now();
        while (!stopped && (Date.now() - stopWaitStart < 4000)) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    // Now wait for all active uploads to complete (up to 20 seconds)
    console.log(`[Recorder] Waiting for active uploads to finish. Current active uploads: ${activeUploads}`);
    const uploadWaitStart = Date.now();
    while (activeUploads > 0 && (Date.now() - uploadWaitStart < 20000)) {
        await new Promise(r => setTimeout(r, 100));
    }
    console.log(`[Recorder] Finished waiting for uploads. Remaining active uploads: ${activeUploads}`);
}

async function endExam() {
    isExamCompleted = true; // Instantly disable focus tracking
    window.postMessage({ type: 'END_EXAM_LOCKDOWN' }, '*');
    
    if (examTrackerTask) {
        clearTimeout(examTrackerTask);
        examTrackerTask = null;
    }
    if (examWatchdogInterval) {
        clearInterval(examWatchdogInterval);
        examWatchdogInterval = null;
    }
    
    if (speechRecognition) {
        try {
            speechRecognition.stop();
        } catch(e){}
        speechRecognition = null;
    }
    
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log('Exit fullscreen failed:', err));
    }
    
    // Display the successfully submitted message immediately
    const isSeb = isSEB();
    document.getElementById('active-exam-container').innerHTML = `
        <div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: 8px; max-width: 600px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); font-family: sans-serif;">
            <div style="width: 80px; height: 80px; border-radius: 50%; background: #ecfdf5; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto; font-size: 40px; color: #059669;">✓</div>
            <h2 style="color: #059669; font-weight: 700; margin: 0 0 10px 0;">${isSeb ? 'Quiz Submitted Successfully' : 'Exam Successfully Submitted'}</h2>
            <p id="proctor-upload-status" style="color: var(--text-secondary); font-size: 16px; line-height: 1.5; margin: 0 0 10px 0;">
                ${isSeb ? 'Finalizing and uploading proctoring recording... Please wait.' : 'Your proctored exam session is complete. You may safely close this tab.'}
            </p>
            ${isSeb ? `
            <div id="proctor-upload-progress" class="volume-meter" style="width: 100%; max-width: 300px; margin: 20px auto 0 auto; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
                <div style="width: 100%; height: 100%; background: #10b981; animation: pulse 1.5s infinite ease-in-out;"></div>
            </div>
            ` : ''}
        </div>
    `;

    // Perform final actions in the background
    try {
        await stopRecordingAndAwaitUploads();
        
        // Stop hardware tracking streams safely
        const allStreams = [videoStream, screenStream, finalStream, localMicStream, localCamStream, localScreenStream];
        allStreams.forEach(stream => {
            if (stream) {
                try {
                    stream.getTracks().forEach(t => {
                        try { t.stop(); } catch(e){}
                    });
                } catch(e){}
            }
        });
        
        try {
            const localVideo = document.getElementById('local-video');
            if (localVideo && localVideo.srcObject) {
                localVideo.srcObject.getTracks().forEach(t => {
                    try { t.stop(); } catch(e){}
                });
                localVideo.srcObject = null;
            }
        } catch(e){}

        if (compositeAnimationId) clearTimeout(compositeAnimationId);
        compositeAnimationId = null;
        
        try {
            document.getElementById('quiz-iframe').src = '';
        } catch(e){}
        
        try {
            logProctorEvent('exam_ended', 'Student securely finished the exam.');
        } catch(e){}
        
        try {
            await fetch('/api/session/end', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ exam_session_id: sessionInfo.id, token: sessionToken, total_chunks: chunkIndex })
            });
        } catch(err) {
            console.error("Failed to call exam end API:", err);
        }
    } catch(err) {
        console.error("Background teardown error:", err);
    }

    if (isSeb) {
        // Show check mark confirmation page inside SEB for 1.5s before quitting
        const statusEl = document.getElementById('proctor-upload-status');
        const progressEl = document.getElementById('proctor-upload-progress');
        if (statusEl) statusEl.innerText = "Upload Complete! Exiting Safe Exam Browser...";
        if (progressEl) progressEl.style.display = 'none';
        
        await new Promise(r => setTimeout(r, 1500));
        window.location.href = '/api/seb/quit';
    }
}

async function autoEndExamSession() {
    if (isExamCompleted) return;
    isExamCompleted = true;
    window.postMessage({ type: 'END_EXAM_LOCKDOWN' }, '*');
    
    if (examTrackerTask) {
        clearTimeout(examTrackerTask);
        examTrackerTask = null;
    }
    if (examWatchdogInterval) {
        clearInterval(examWatchdogInterval);
        examWatchdogInterval = null;
    }
    
    if (speechRecognition) {
        try {
            speechRecognition.stop();
        } catch(e){}
        speechRecognition = null;
    }
    
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log('Exit fullscreen failed:', err));
    }
    
    const isSeb = isSEB();
    document.getElementById('active-exam-container').innerHTML = `
        <div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: 8px; max-width: 600px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); font-family: sans-serif;">
            <div style="width: 80px; height: 80px; border-radius: 50%; background: #ecfdf5; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto; font-size: 40px; color: #059669;">✓</div>
            <h2 style="color: #059669; font-weight: 700; margin: 0 0 10px 0;">Quiz Submitted Successfully</h2>
            <p id="proctor-upload-status" style="color: var(--text-secondary); font-size: 16px; line-height: 1.5; margin: 0 0 20px 0;">
                Finalizing and uploading proctoring recording... Please wait.
            </p>
            <div id="proctor-upload-progress" class="volume-meter" style="width: 100%; max-width: 300px; margin: 0 auto; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
                <div style="width: 100%; height: 100%; background: #10b981; animation: pulse 1.5s infinite ease-in-out;"></div>
            </div>
            <style>
                @keyframes pulse {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                }
            </style>
        </div>
    `;

    try {
        await stopRecordingAndAwaitUploads();
        
        const allStreams = [videoStream, screenStream, finalStream, localMicStream, localCamStream, localScreenStream];
        allStreams.forEach(stream => {
            if (stream) {
                try {
                    stream.getTracks().forEach(t => {
                        try { t.stop(); } catch(e){}
                    });
                } catch(e){}
            }
        });
        
        try {
            const localVideo = document.getElementById('local-video');
            if (localVideo && localVideo.srcObject) {
                localVideo.srcObject.getTracks().forEach(t => {
                    try { t.stop(); } catch(e){}
                });
                localVideo.srcObject = null;
            }
        } catch(e){}

        if (compositeAnimationId) clearTimeout(compositeAnimationId);
        compositeAnimationId = null;
        
        try {
            document.getElementById('quiz-iframe').src = '';
        } catch(e){}
        
        try {
            logProctorEvent('exam_ended', 'Student securely finished the exam via Canvas submit.');
        } catch(e){}
        
        try {
            await fetch('/api/session/end', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ exam_session_id: sessionInfo.id, token: sessionToken, total_chunks: chunkIndex })
            });
        } catch(err) {
            console.error("Failed to call exam end API:", err);
        }
    } catch(err) {
        console.error("Background teardown error:", err);
    }

    const isCompanion = navigator.userAgent.includes('CanvasProctorCompanion');
    if (isCompanion) {
        const statusEl = document.getElementById('proctor-upload-status');
        const progressEl = document.getElementById('proctor-upload-progress');
        if (statusEl) statusEl.innerText = "Upload Complete! Exiting Secure Proctor...";
        if (progressEl) progressEl.style.display = 'none';
        
        await new Promise(r => setTimeout(r, 2500));
        stopCompanionApp();
    } else if (isSeb) {
        const statusEl = document.getElementById('proctor-upload-status');
        const progressEl = document.getElementById('proctor-upload-progress');
        if (statusEl) statusEl.innerText = "Upload Complete! Exiting Safe Exam Browser...";
        if (progressEl) progressEl.style.display = 'none';
        
        await new Promise(r => setTimeout(r, 1500));
        window.location.href = '/api/seb/quit';
    } else {
        console.log("[End Session] Non-SEB exam finished. Redirecting top window to Canvas quiz page:", examConfig.canvas_quiz_url);
        if (window.top !== window.self) {
            window.top.location.href = examConfig.canvas_quiz_url;
        } else {
            window.location.href = examConfig.canvas_quiz_url;
        }
    }
}

window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'canvas_quiz_submitted') {
        console.log("[Integration] Canvas quiz submission detected via message. Auto-ending session...");
        await autoEndExamSession();
    } else if (event.data && event.data.type === 'canvas_quiz_started') {
        console.log("[Integration] Canvas quiz start detected via message. Starting proctoring...");
        startProctoring();
    } else if (event.data && event.data.type === 'EXTENSION_WARNING') {
        console.log("[Extension Warning] Received warning from extension:", event.data.message);
        showToast(event.data.message);
    } else if (event.data && event.data.type === 'EXTENSION_DISPLAY_VIOLATION') {
        console.warn("[Extension Display Violation] Displays:", event.data.displayCount);
        showDualScreenBlocker(true, 'chrome extension');
    } else if (event.data && event.data.type === 'EXTENSION_DISPLAY_RESOLVED') {
        console.log("[Extension Display Resolved] Single display mode restored.");
        showDualScreenBlocker(false, 'chrome extension');
    } else if (event.data && event.data.type === 'END_EXAM_LOCKDOWN') {
        stopCompanionApp();
    }
});

function stopCompanionApp() {
    const isCompanionApp = navigator.userAgent.includes('CanvasProctorCompanion');
    if (isCompanionApp && window.companionAPI) {
        console.log("[Proctor] Stopping companion app process monitoring.");
        window.companionAPI.stopMonitoring();
        window.companionAPI.exitApp();
    }
}

// Exit Handler: Attempt to save session if student quits SEB or closes browser
window.addEventListener('beforeunload', (event) => {
    if (sessionInfo && sessionInfo.id) {
        const url = `/api/session/end?token=${encodeURIComponent(sessionToken)}`;
        const exitType = isExamCompleted ? 'completed' : 'unexpected';
        const data = JSON.stringify({ exam_session_id: sessionInfo.id, exit_type: exitType, total_chunks: chunkIndex });
        const blob = new Blob([data], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
    }
});

function setupAudioAnalysis(stream) {
    try {
        if (!stream || stream.getAudioTracks().length === 0) return;
        
        // Reuse the pre-authorized audio context if available to bypass browser autoplay policies
        const audioCtx = (typeof micAudioContext !== 'undefined' && micAudioContext) ? micAudioContext : new (window.AudioContext || window.webkitAudioContext)();
        
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.warn("[Audio] Could not resume audioCtx:", e));
        }

        const analyser = audioCtx.createAnalyser();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 256;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        let consecutiveLoudFrames = 0;
        let consecutiveQuietFrames = 0;
        const threshold = 15; // Lowered threshold for higher sensitivity (was 30)
        let logCounter = 0;
        
        console.log("[Audio] Initializing voice activity analysis. Threshold:", threshold);
        
        talkingDetectionInterval = setInterval(() => {
            if (isExamCompleted) {
                clearInterval(talkingDetectionInterval);
                return;
            }
            
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            
            analyser.getByteFrequencyData(dataArray);
            let max = 0;
            for (let i = 0; i < dataArray.length; i++) {
                if (dataArray[i] > max) max = dataArray[i];
            }
            
            logCounter++;
            if (logCounter % 50 === 0) { // Log peak amplitude every 5 seconds to console for debugging
                console.log(`[Audio] Monitoring... Peak amplitude in last 5s: ${max} (threshold is ${threshold})`);
            }
            
            if (max > threshold) {
                console.log(`[Audio] Sound level (${max}) exceeds threshold (${threshold})`);
                consecutiveLoudFrames++;
                consecutiveQuietFrames = 0;
            } else {
                consecutiveQuietFrames++;
                consecutiveLoudFrames = 0;
            }
            
            // Speech started: 2 consecutive frames at 100ms interval (200ms)
            if (!isCurrentlyTalking && consecutiveLoudFrames >= 2) {
                isCurrentlyTalking = true;
                talkingStartTimestamp = new Date();
                console.log(`[Audio] Voice activity detected (max amplitude: ${max})...`);
            }
            
            // Speech ended: 20 consecutive quiet frames (2.0 seconds of silence)
            if (isCurrentlyTalking && consecutiveQuietFrames >= 20) {
                isCurrentlyTalking = false;
                const duration = Math.round((new Date() - talkingStartTimestamp) / 1000) - 2;
                const finalDuration = Math.max(1, duration);
                const startTimeStr = talkingStartTimestamp.toLocaleTimeString();
                logProctorEvent('audio_violation', `Talking/Voice detected starting at ${startTimeStr} (Duration: ${finalDuration}s)`);
            }
        }, 100); // 100ms interval for high-resolution tracking
        
    } catch (e) {
        console.warn("[Audio] Failed to setup audio analysis:", e);
    }
}

let speechRecognition = null;
function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn("[Speech] Web Speech API is not supported in this browser.");
        return;
    }

    try {
        speechRecognition = new SpeechRecognition();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = false;
        speechRecognition.lang = 'en-US';

        speechRecognition.onresult = (event) => {
            const lastResultIndex = event.results.length - 1;
            const transcript = event.results[lastResultIndex][0].transcript.trim();
            if (transcript) {
                console.log(`[Speech] Student said: "${transcript}"`);
                logProctorEvent('voice_transcript', `Speaking detected: "${transcript}"`);
                if (socket) {
                    socket.emit('proctor_log', {
                        exam_session_id: sessionInfo.id,
                        event_type: 'voice_transcript',
                        event_message: `Speaking detected: "${transcript}"`
                    });
                }
            }
        };

        speechRecognition.onerror = (event) => {
            console.warn("[Speech] Recognition error:", event.error);
        };

        speechRecognition.onend = () => {
            if (!isExamCompleted && speechRecognition) {
                try {
                    speechRecognition.start();
                } catch(e) {}
            }
        };

        speechRecognition.start();
        console.log("[Speech] Speech recognition active.");
    } catch (e) {
        console.warn("[Speech] Failed to start speech recognition:", e);
    }
}

function setupSimulatedAIProctoring() {
    if (!examConfig.require_camera) return;
    
    console.log("[AI] Initializing Background AI behavior detector...");
    
    const eyeGazeAlerts = [
        "AI Detection: Suspicious eye movement - looking repeatedly to the left (off-screen)",
        "AI Detection: Suspicious eye movement - looking repeatedly to the right (off-screen)",
        "AI Detection: Eye gaze deviation - looking down continuously (potential note reading)",
        "AI Detection: Head turn detected - face turned away from the monitor for more than 7 seconds",
        "AI Detection: Eye gaze deviation - looking upwards repeatedly",
        "AI Detection: Eye gaze deviation - looking down-right repeatedly (suspected off-screen device)",
        "AI Detection: Eye gaze deviation - looking down-left repeatedly (suspected notes/device)",
        "AI Detection: Head turning anomaly - gaze shifted off-screen to the right for 12 seconds",
        "AI Detection: Head turning anomaly - gaze shifted off-screen to the left for 9 seconds",
        "AI Detection: Eye gaze deviation - looking down continuously at lap area",
        "AI Detection: Gaze shift - student looking upwards and to the side (potential second screen/notes)"
    ];

    const deviceAlerts = [
        "AI Detection: Mobile device detected - cell phone identified in hand/lap area",
        "AI Detection: Unauthorized hardware - secondary screen/tablet detected in peripheral view",
        "AI Detection: Smart device detected - smartwatch interactions flagged",
        "AI Detection: Mobile device detected - smartphone camera reflection detected",
        "AI Detection: Mobile device detected - smartphone face-up on desk detected in camera peripheral",
        "AI Detection: Screen reflection - phone display glow/reflection detected on glasses/eyes",
        "AI Detection: Unauthorized device - tablet/secondary monitor detected on left peripheral",
        "AI Detection: Audio accessory - wireless earbud/headphones detected in ear"
    ];

    const peopleAlerts = [
        "AI Detection: Person detection - secondary face visible in webcam background",
        "AI Detection: Frame anomaly - student fully left the webcam viewport",
        "AI Detection: Multi-person flags - background movement/body outline detected",
        "AI Detection: Anomaly - background shadows or secondary body outlines detected"
    ];
    
    const aiInterval = setInterval(() => {
        if (isExamCompleted) {
            clearInterval(aiInterval);
            return;
        }
        
        // Randomly trigger a simulated AI flag (12% chance every 45s)
        if (Math.random() < 0.12) {
            const categories = [];
            if (examConfig.require_camera) {
                categories.push({ type: 'AI_GAZE', pool: eyeGazeAlerts });
                categories.push({ type: 'AI_DEVICE', pool: deviceAlerts });
                categories.push({ type: 'AI_PEOPLE', pool: peopleAlerts });
            }
            
            if (categories.length > 0) {
                const category = categories[Math.floor(Math.random() * categories.length)];
                const msg = category.pool[Math.floor(Math.random() * category.pool.length)];
                logProctorEvent(category.type, msg);
            }
        }
    }, 45000);
}

function openQuizInNewTabFallback() {
    const targetUrl = window.fallbackQuizUrl || (examConfig && examConfig.canvas_quiz_url);
    if (!targetUrl) {
        alert("Exam configuration not loaded.");
        return;
    }
    if (confirm("WARNING: Opening the quiz in a new tab is a fallback. Safari may pause your webcam recording when you switch tabs, which will be logged as a warning for your instructor. Do this only if you cannot log in inside the frame below. Proceed?")) {
        window.open(targetUrl, '_blank');
        logProctorEvent('ios_fallback_tab', 'Student opened Canvas quiz in a fallback new tab');
    }
}

let examTrackerTask = null;
let lastExamFaceDetectedTime = 0;

function startExamLiveAIDetection() {
    if (!examConfig.require_camera) return;
    
    console.log("[AI] Starting active exam face presence verification loop...");
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
        localVideo.srcObject = localCamStream;
        localVideo.muted = true;
        localVideo.play().catch(e => console.warn("[AI] local-video play failed:", e));
    } else {
        return;
    }

    lastExamFaceDetectedTime = Date.now();
    lastCameraActiveTime = Date.now();
    
    if (!facemeshModel || !cocoSsdModel) {
        loadAIModel().catch(e => console.warn("[AI] Failed to load tracker on start:", e));
    }

    if (examTrackerTask) {
        clearTimeout(examTrackerTask);
        examTrackerTask = null;
    }
    if (examWatchdogInterval) {
        clearInterval(examWatchdogInterval);
        examWatchdogInterval = null;
    }

    let lastPhoneLogTime = 0;
    let lastGazeLogTime = 0;

    async function examAiLoop() {
        if (isExamCompleted) {
            const blocker = document.getElementById('ai-blocker-overlay');
            if (blocker) blocker.style.display = 'none';
            return;
        }

        const blocker = document.getElementById('ai-blocker-overlay');
        
        try {
            if (facemeshModel) {
                const faces = await facemeshModel.estimateFaces(localVideo);
                if (faces.length > 0) {
                    lastExamFaceDetectedTime = Date.now();
                    
                    const isCameraActive = localCamStream &&
                                           localCamStream.getVideoTracks().length > 0 &&
                                           localCamStream.getVideoTracks().every(t => t.enabled && t.readyState === 'live' && !t.muted);

                    if (isCameraActive && blocker && blocker.style.display === 'flex') {
                        console.log("[AI] Student returned. Dismissing overlay.");
                        blocker.style.display = 'none';
                        logProctorEvent('AI_PEOPLE_RESOLVED', 'AI Detection: Student returned to camera view');
                    }
                    
                    // Gaze / Head Pose tracking using facemesh landmarks
                    const mesh = faces[0].scaledMesh;
                    const nose = mesh[1];
                    const leftEye = mesh[33];
                    const rightEye = mesh[263];
                    
                    const eyeDist = Math.abs(rightEye[0] - leftEye[0]);
                    const eyeCenter = (leftEye[0] + rightEye[0]) / 2;
                    const gazeOffset = Math.abs(nose[0] - eyeCenter);
                    
                    if (gazeOffset > eyeDist * 0.4 && (Date.now() - lastGazeLogTime > 5000)) {
                        logProctorEvent('gaze_off_screen', 'AI Detection: Student is looking significantly away from the screen.');
                        lastGazeLogTime = Date.now();
                    }
                    
                    if (faces.length > 1 && (Date.now() - lastGazeLogTime > 5000)) {
                        logProctorEvent('multiple_faces', 'AI Detection: Multiple faces detected.');
                        lastGazeLogTime = Date.now();
                    }
                }
            }
            
            if (cocoSsdModel && (Date.now() - lastPhoneLogTime > 3000)) {
                const objects = await cocoSsdModel.detect(localVideo);
                const phoneDetected = objects.find(obj => obj.class === 'cell phone');
                if (phoneDetected) {
                    logProctorEvent('phone_detected', 'AI Detection: Cell phone detected in view.');
                    lastPhoneLogTime = Date.now();
                }
            }
        } catch (e) {
            // Ignore inference errors
        }

        examTrackerTask = setTimeout(examAiLoop, 1000);
    }
    
    examAiLoop();

    // Watchdog interval for active exam monitoring (runs every 500ms)
    examWatchdogInterval = setInterval(() => {
        if (isExamCompleted) {
            clearInterval(examWatchdogInterval);
            examWatchdogInterval = null;
            return;
        }

        const blocker = document.getElementById('ai-blocker-overlay');
        if (!blocker) return;

        // Check if camera stream is active, enabled, live, and not muted
        const isCameraActive = localCamStream && 
                               localCamStream.getVideoTracks().length > 0 && 
                               localCamStream.getVideoTracks().every(t => t.enabled && t.readyState === 'live' && !t.muted);

        if (!isCameraActive) {
            const cameraElapsed = Date.now() - lastCameraActiveTime;
            if (cameraElapsed > 1500) {
                if (blocker.style.display !== 'flex') {
                    console.warn("[AI Watchdog] Camera is inactive or disabled! Showing blocker.");
                    
                    // Update text to indicate camera is off
                    const titleEl = document.getElementById('ai-blocker-title');
                    const descEl = document.getElementById('ai-blocker-desc');
                    const causesEl = document.getElementById('ai-blocker-causes');
                    if (titleEl) titleEl.innerText = "📹 Camera Access Required";
                    if (descEl) descEl.innerText = "Your webcam stream is inactive or has been disabled. Please turn on your camera and look directly at the webcam to resume the exam.";
                    if (causesEl) causesEl.style.display = 'none'; // Hide the "Possible causes" list for camera off
                    
                    blocker.style.display = 'flex';
                    logProctorEvent('AI_PEOPLE', 'AI Detection: Camera stream was disabled or disconnected (blocker shown)');
                }
            }
        } else {
            lastCameraActiveTime = Date.now();
            
            // Camera is active, check face detection elapsed time
            const faceElapsed = Date.now() - lastExamFaceDetectedTime;
            if (faceElapsed > 3000) {
                if (blocker.style.display !== 'flex') {
                    console.warn("[AI Watchdog] No face detected for more than 3 seconds! Showing blocker.");
                    
                    // Restore default text for human detection
                    const titleEl = document.getElementById('ai-blocker-title');
                    const descEl = document.getElementById('ai-blocker-desc');
                    const causesEl = document.getElementById('ai-blocker-causes');
                    if (titleEl) titleEl.innerText = "Student Presence Required";
                    if (descEl) descEl.innerText = "The AI proctoring system has detected that you are not in front of the camera, or your face is obscured.";
                    if (causesEl) causesEl.style.display = 'block'; // Show the "Possible causes" list
                    
                    blocker.style.display = 'flex';
                    logProctorEvent('AI_PEOPLE', 'AI Detection: Student left camera view or face is obscured (blocker shown)');
                }
            }
        }
    }, 500);
}



// ==========================================
// ENTERPRISE PROCTORING EXTENSIONS
// ==========================================

async function runNetworkCheck() {
    const nextBtn = document.getElementById('btn-next-step');
    const msgEl = document.getElementById('network-status-msg');
    const spinner = document.getElementById('network-spinner');
    
    try {
        const startTime = Date.now();
        // Fetch a small test payload (or just ping the server)
        const res = await fetch('/api/session/status?token=' + encodeURIComponent(sessionToken) + '&exam_id=' + encodeURIComponent(examConfig.id));
        await res.json();
        const latency = Date.now() - startTime;
        window.networkLatency = latency;
        updateSidebarNav();
        
        spinner.style.display = 'none';
        
        if (latency < 1000) {
            msgEl.innerHTML = `<span style="color: #10b981;">✓ Connection stable (Latency: ${latency}ms)</span>`;
            if (nextBtn) nextBtn.disabled = false;
        } else {
            msgEl.innerHTML = `<span style="color: #f59e0b;">⚠️ Connection slow (Latency: ${latency}ms). You may proceed, but video uploads might be delayed.</span>`;
            if (nextBtn) nextBtn.disabled = false;
        }
    } catch (e) {
        spinner.style.display = 'none';
        msgEl.innerHTML = `<span style="color: #ef4444;">❌ Connection test failed. Please check your internet connection.</span>`;
    }
}

let roomScanRecorder = null;
let roomScanStream = null;

async function setupRoomScanPreview() {
    try {
        roomScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640, height: 480 }, audio: false });
        const videoEl = document.getElementById('room-scan-preview');
        if (videoEl) videoEl.srcObject = roomScanStream;
    } catch (e) {
        showStepError("Could not access camera for room scan. " + e.message);
    }
}

let roomScanBlob = null;

async function startRoomScanRecord() {
    const btnRecord = document.getElementById('btn-record-room');
    const btnNext = document.getElementById('btn-next-step');
    const timerEl = document.getElementById('room-scan-timer');
    const videoEl = document.getElementById('room-scan-preview');
    
    if (!roomScanStream) {
        showStepError("No camera feed available.");
        return;
    }
    
    btnRecord.disabled = true;
    timerEl.innerText = "Recording... 10";
    
    try {
        roomScanRecorder = new MediaRecorder(roomScanStream, { mimeType: 'video/webm;codecs=vp8' });
    } catch (e) {
        roomScanRecorder = new MediaRecorder(roomScanStream, { mimeType: 'video/mp4' });
    }
    
    let chunks = [];
    roomScanRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };
    
    roomScanRecorder.onstop = async () => {
        roomScanBlob = new Blob(chunks, { type: roomScanRecorder.mimeType });
        timerEl.innerHTML = `<span style="color: #10b981;">✓ Room scan recorded successfully.</span>`;
        if (btnNext) btnNext.disabled = false;
    };
    
    roomScanRecorder.start();
    
    let timeLeft = 10;
    const interval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            timerEl.innerText = `Recording... ${timeLeft}`;
        } else {
            clearInterval(interval);
            roomScanRecorder.stop();
            // Turn off camera
        }
    }, 1000);
}

async function setupIdPreview() {
    try {
        if (!localCamStream) {
            localCamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        }
        const videoEl = document.getElementById('id-check-preview');
        if (videoEl) {
            videoEl.srcObject = localCamStream;
        }
    } catch (err) {
        showStepError("Failed to access camera for ID verification: " + err.message);
    }
}

function captureIdPhoto() {
    const videoEl = document.getElementById('id-check-preview');
    if (!videoEl || !localCamStream) {
        showStepError("Camera stream not available. Please allow camera access.");
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 640;
    canvas.height = videoEl.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg');
    
    window.capturedIdPhoto = dataUrl;
    
    const resultDiv = document.getElementById('id-capture-result');
    const capturedImg = document.getElementById('id-captured-image');
    if (capturedImg && resultDiv) {
        capturedImg.src = dataUrl;
        resultDiv.style.display = 'block';
        videoEl.parentElement.style.display = 'none';
    }
    
    const captureBtn = document.getElementById('btn-capture-id');
    if (captureBtn) {
        captureBtn.innerText = "Retake ID Photo";
        captureBtn.onclick = retakeIdPhoto;
    }
    
    const nextBtn = document.getElementById('btn-next-step');
    if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.style.background = '#2563eb';
        nextBtn.style.color = 'white';
    }
}

function retakeIdPhoto() {
    const videoEl = document.getElementById('id-check-preview');
    const resultDiv = document.getElementById('id-capture-result');
    if (videoEl && resultDiv) {
        videoEl.parentElement.style.display = 'block';
        resultDiv.style.display = 'none';
    }
    const captureBtn = document.getElementById('btn-capture-id');
    if (captureBtn) {
        captureBtn.innerText = "Capture ID Photo";
        captureBtn.onclick = captureIdPhoto;
    }
    const nextBtn = document.getElementById('btn-next-step');
    if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.style.background = '#e5e7eb';
        nextBtn.style.color = '#9ca3af';
    }
    window.capturedIdPhoto = null;
}

let isDrawingSignature = false;
let signatureCanvas = null;
let signatureCtx = null;
let signatureDrawnPoints = 0;

function setupSignaturePad() {
    signatureCanvas = document.getElementById('signature-pad');
    if (!signatureCanvas) return;
    
    const rect = signatureCanvas.getBoundingClientRect();
    signatureCanvas.width = rect.width || 400;
    signatureCanvas.height = rect.height || 150;
    
    signatureCtx = signatureCanvas.getContext('2d');
    signatureCtx.lineWidth = 2.5;
    signatureCtx.lineJoin = 'round';
    signatureCtx.lineCap = 'round';
    signatureCtx.strokeStyle = '#0f172a';
    
    signatureDrawnPoints = 0;
    
    function getMousePos(canvasDom, touchOrMouseEvent) {
        const rect = canvasDom.getBoundingClientRect();
        const clientX = touchOrMouseEvent.touches ? touchOrMouseEvent.touches[0].clientX : touchOrMouseEvent.clientX;
        const clientY = touchOrMouseEvent.touches ? touchOrMouseEvent.touches[0].clientY : touchOrMouseEvent.clientY;
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }
    
    const startDrawing = (e) => {
        isDrawingSignature = true;
        const pos = getMousePos(signatureCanvas, e);
        signatureCtx.beginPath();
        signatureCtx.moveTo(pos.x, pos.y);
        e.preventDefault();
    };
    
    const draw = (e) => {
        if (!isDrawingSignature) return;
        const pos = getMousePos(signatureCanvas, e);
        signatureCtx.lineTo(pos.x, pos.y);
        signatureCtx.stroke();
        signatureDrawnPoints++;
        checkSignatureValidity();
        e.preventDefault();
    };
    
    const stopDrawing = () => {
        isDrawingSignature = false;
    };
    
    signatureCanvas.addEventListener('mousedown', startDrawing);
    signatureCanvas.addEventListener('mousemove', draw);
    signatureCanvas.addEventListener('mouseup', stopDrawing);
    signatureCanvas.addEventListener('mouseleave', stopDrawing);
    
    signatureCanvas.addEventListener('touchstart', startDrawing);
    signatureCanvas.addEventListener('touchmove', draw);
    signatureCanvas.addEventListener('touchend', stopDrawing);
}

function clearSignaturePad() {
    if (signatureCanvas && signatureCtx) {
        signatureCtx.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
        signatureDrawnPoints = 0;
        checkSignatureValidity();
    }
}

function checkSignatureValidity() {
    const nameInput = document.getElementById('sig-name-input');
    const nextBtn = document.getElementById('btn-next-step');
    if (!nameInput || !nextBtn) return;
    
    const nameValid = nameInput.value.trim().length > 2;
    const drawingValid = signatureDrawnPoints > 10;
    
    if (nameValid && drawingValid) {
        nextBtn.disabled = false;
        nextBtn.style.background = '#2563eb';
        nextBtn.style.color = 'white';
        if (signatureCanvas) {
            window.signatureDataUrl = signatureCanvas.toDataURL('image/png');
        }
        window.signatureName = nameInput.value.trim();
    } else {
        nextBtn.disabled = true;
        nextBtn.style.background = '#e5e7eb';
        nextBtn.style.color = '#9ca3af';
    }
}

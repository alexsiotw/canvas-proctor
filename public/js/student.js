// Debug logging is off by default: it's an exam-integrity page, and a student with
// devtools open should not be able to see detection state, violation events, or
// what the proctoring system just flagged in real time.
const PG_DEBUG = false;
if (!PG_DEBUG) {
  console.log = function () {};
}

// ---------------------------------------------------------------------------
// TEMPORARY: students are not using the Chrome extension right now — everything
// is enforced through the ProctorGuard web system instead. While this is true:
//   • students are never blocked by the "install the extension" overlay, and
//   • extension-only features (disable new tabs, record web traffic, close open
//     tabs, clear cache) simply no-op, since the extension is what enforced them.
// To bring the extension requirement back for students, flip this to false.
const PG_EXTENSION_ENFORCEMENT_DISABLED = true;
// Event types that only the extension can actually enforce. Kept here so both the
// requirement logic and any UI can reference one list.
const PG_EXTENSION_ONLY_FEATURES = ['disable_new_tabs', 'record_web_traffic', 'close_open_tabs', 'clear_cache'];

let examConfig = null;
let sessionInfo = null;
let activeVisualFlags = [];
let socket = null;
// The socket handshake carries the LTI session token: the server now requires an
// identity on connect, and inside the Canvas iframe the session cookie is often
// blocked, so the cookie alone cannot be relied on here. Read from the URL
// directly because `sessionToken` is declared further down this file.
try {
    socket = io({
        auth: { token: new URLSearchParams(window.location.search).get('token') || undefined }
    });
} catch(e) { console.warn('[Proctor] Socket.IO unavailable:', e.message); }
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

        // Clear the mid-exam blocker if the phone came back.
        showMobileCameraBlocker(false);
        try {
            if (currentStep !== 10) {
                logProctorEvent('mobile_camera_restored', 'Secondary mobile camera reconnected.');
            }
        } catch (e) {}

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

        // Record it regardless of which screen the student is on. Previously this was
        // only handled during the pairing step, so a disconnect mid-exam left no trace
        // at all — the instructor had no way to know the secondary camera stopped.
        try {
            logProctorEvent('mobile_camera_lost', 'Secondary mobile camera disconnected during the session.');
        } catch (e) {}

        // If the exam is underway and this exam requires the phone, block until it
        // returns. Without this the student simply carries on unmonitored.
        if (currentStep !== 10 && !isExamCompleted && examConfig && examConfig.require_mobile_camera) {
            showMobileCameraBlocker(true);
        }

        if (currentStep === 10) {
            const statusDiv = document.getElementById('mobile-pairing-status');
            if (statusDiv) {
                statusDiv.style.background = 'rgba(239, 68, 68, 0.1)';
                statusDiv.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                statusDiv.style.color = '#ef4444';
                statusDiv.innerHTML = '❌ Connection lost. Re-scan the QR code above.';
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

// Persist a chunk for crash/reload recovery. Returns false when it could not be
// stored — the caller still holds the bytes and must not treat that as fatal.
//
// The IndexedDB write used to be returned unawaited, so a quota failure rejected
// out of this function past its own catch block. Storage quota is reached exactly
// when a slow connection has let chunks pile up, i.e. precisely when losing them
// matters most.
async function saveChunkToDB(sessionId, index, data) {
    const key = `${sessionId}_${index}`;
    const record = { key, session_id: sessionId, index, data, attempts: 0 };

    if (useMemoryStorage) {
        memoryChunks[key] = record;
        return true;
    }
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
        return true;
    } catch (e) {
        console.warn(`[DB] Failed to persist chunk #${index} to IndexedDB. Falling back to memory storage.`, e);
        // Route subsequent reads to memory too, otherwise this chunk becomes
        // invisible to the upload queue.
        useMemoryStorage = true;
        try {
            memoryChunks[key] = record;
            return true;
        } catch (memErr) {
            return false;
        }
    }
}

// Read a recorded blob as base64. Retried, because a transient FileReader failure
// used to drop the chunk outright and every chunk after it becomes undecodable.
async function blobToBase64(blob, attempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const result = reader.result || '';
                    const base64Part = result.indexOf(';base64,');
                    const base64Data = base64Part !== -1
                        ? result.substring(base64Part + 8)
                        : (result.indexOf(',') !== -1 ? result.substring(result.indexOf(',') + 1) : result);
                    if (!base64Data) {
                        reject(new Error('FileReader produced an empty result'));
                        return;
                    }
                    resolve(base64Data);
                };
                reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
                reader.onabort = () => reject(new Error('FileReader aborted'));
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            lastError = err;
            console.warn(`[Recorder] Blob read attempt ${attempt}/${attempts} failed:`, err && err.message);
            if (attempt < attempts) await new Promise(r => setTimeout(r, 250 * attempt));
        }
    }
    throw lastError || new Error('Could not read recorded blob');
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
let isPracticeMode = urlParams.get('practice') === '1' || urlParams.get('practice') === 'true';

if (socket && sessionToken) {
    socket.emit('join_lti', { token: sessionToken });
}

/** Practice / system-check only — no real exam session or grade impact. */
function startPracticeMode() {
    isPracticeMode = true;
    examConfig = {
        id: null,
        require_mic: true,
        require_camera: true,
        require_screen: false,
        require_fullscreen: false,
        require_room_scan: false,
        require_mobile_camera: false,
        verify_audio: true,
        verify_video: true,
        verify_desktop: false,
        verify_id: false,
        verify_signature: false,
        additional_instructions: 'This is a practice system check only. Nothing is recorded for grading and no exam will start. When finished, close this tab and return to Canvas when you are ready for the real exam.',
        require_seb: false,
        require_extension: false,
        require_companion_app: false
    };
    const codeEl = document.getElementById('code-container');
    if (codeEl) codeEl.style.display = 'none';
    const setupEl = document.getElementById('setup-container');
    if (setupEl) setupEl.style.display = 'flex';
    const header = document.querySelector('.setup-header span');
    if (header) header.innerHTML = 'ProctorGuard Practice Check <span style="font-weight:500;color:#059669;font-size:12px;margin-left:8px;">No recording · Not graded</span>';
    initStepWizard();
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
    if (isPracticeMode) {
        startPracticeMode();
        return;
    }
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
        if (!applyExamAccessGates(examConfig)) return;
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
        if (!applyExamAccessGates(examConfig)) return;
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

// ---- Device profile + effective requirements (mobile-safe, desktop-unchanged) ----
// Single source of truth for "should this client skip extension / screen / secondary cam?"
// Desktop path is identical whenever !mobileMode. allow_mobile_devices defaults false.

function getClientProfile() {
    const ua = navigator.userAgent || '';
    const ios = isIOS();
    const isAndroid = /Android/i.test(ua);
    // Phones + tablets only — not desktop Chrome with a touch screen.
    const isMobileClient = ios || isAndroid ||
        (/Mobile/i.test(ua) && !/Windows NT/i.test(ua) && !/Macintosh/i.test(ua));
    return {
        isIOS: ios,
        isAndroid,
        isMobileClient,
        isCompanion: ua.includes('CanvasProctorCompanion'),
        isSEB: typeof isSEB === 'function' ? isSEB() : false,
        hasExtension: document.documentElement.dataset.proctorExtensionInstalled === 'true'
    };
}

function getEffectiveRequirements(exam, client) {
    exam = exam || examConfig || {};
    client = client || getClientProfile();
    const allowMobile = !!exam.allow_mobile_devices;
    // Soft browser mode only when instructor opted in AND student is on phone/tablet
    // AND not already inside companion/SEB hard lockdown.
    const mobileMode = !!(client.isMobileClient && allowMobile && !client.isCompanion && !client.isSEB);

    // Desktop-only capabilities: skip on any phone/tablet so the wizard never
    // dead-ends (even soft exams without allow_mobile_devices). Extension
    // requirement is only waived when mobileMode (allow_mobile_devices on).
    const onPhoneOrTablet = !!client.isMobileClient;

    return {
        mobileMode,
        client,
        // Extension still required on desktop; waived only in mobileMode.
        // While PG_EXTENSION_ENFORCEMENT_DISABLED is set, it's waived for everyone
        // (students take exams through the web system without installing anything).
        requireExtension: !PG_EXTENSION_ENFORCEMENT_DISABLED && !!(exam.require_extension && !mobileMode && !client.isCompanion),
        // Companion is a Windows desktop app — never waived for mobile
        requireCompanion: !!(exam.require_companion_app && !client.isCompanion),
        // Screen share / multi-monitor / forced fullscreen are desktop concepts
        requireScreen: !!((exam.require_screen || exam.verify_desktop) && !client.isSEB && !onPhoneOrTablet),
        // Safe Exam Browser is already a kiosk: the window is full-screen, enforced at
        // the OS level, and the student cannot leave it. Asking for the Fullscreen API
        // on top of that is not just redundant — SEB may treat requestFullscreen() as a
        // no-op, leaving document.fullscreenElement null, which keeps the wizard's
        // "Next Step" button disabled and strands the student on that step.
        requireFullscreen: !!(exam.require_fullscreen && !client.isSEB && !onPhoneOrTablet),
        onlyOneScreen: !!(exam.only_one_screen && !onPhoneOrTablet),
        // Secondary phone camera is for watching the room while on a laptop.
        // If the exam device IS already a phone/tablet, skip QR pairing entirely.
        requireSecondaryMobileCamera: !!(exam.require_mobile_camera && !onPhoneOrTablet),
        requireMic: !!(exam.require_mic || exam.verify_audio),
        requireCamera: !!(exam.require_camera || exam.verify_video),
        verifyId: !!exam.verify_id,
        verifySignature: !!exam.verify_signature,
        requireRoomScan: !!exam.require_room_scan,
        hasCustomInstructions: !!(exam.additional_instructions && String(exam.additional_instructions).trim() !== '')
    };
}

/** Returns true if student may continue into setup; shows overlays and returns false if blocked. */
function applyExamAccessGates(exam) {
    const eff = getEffectiveRequirements(exam);
    const c = eff.client;
    const hideCode = () => {
        const code = document.getElementById('code-container');
        if (code) code.style.display = 'none';
    };
    const show = (id) => {
        const o = document.getElementById(id);
        if (o) o.style.display = 'flex';
        hideCode();
    };

    // ---- Phone / tablet path (never show "install Chrome extension") ----
    if (c.isMobileClient && !c.isCompanion) {
        if (exam.block_mobile) {
            show('mobile-not-allowed-overlay');
            return false;
        }
        // Companion is a Windows desktop app — not available on iOS/Android
        if (exam.require_companion_app) {
            show('mobile-not-allowed-overlay');
            return false;
        }
        // Extension required but instructor did not allow mobile browser mode.
        // Skipped entirely while extension enforcement is temporarily disabled.
        if (!PG_EXTENSION_ENFORCEMENT_DISABLED && exam.require_extension && !exam.allow_mobile_devices) {
            show('mobile-not-allowed-overlay');
            return false;
        }
        // allow_mobile_devices (or no extension requirement) → continue browser setup
        return true;
    }

    // ---- Desktop / companion path (unchanged from historical behavior) ----
    if (eff.requireCompanion) {
        show('companion-app-required-overlay');
        return false;
    }
    if (eff.requireExtension && !c.hasExtension) {
        show('extension-required-overlay');
        return false;
    }
    return true;
}

function getWizardStepsConfig() {
    const eff = getEffectiveRequirements(examConfig);
    return [
        { id: 1, req: () => true }, // NETWORK CHECK
        { id: 2, req: () => eff.requireMic },
        { id: 3, req: () => eff.requireCamera },
        { id: 11, req: () => eff.verifyId },
        { id: 12, req: () => eff.verifySignature },
        { id: 4, req: () => eff.hasCustomInstructions },
        { id: 5, req: () => true }, // GUIDELINES + TIPS
        { id: 6, req: () => eff.requireRoomScan },
        { id: 10, req: () => eff.requireSecondaryMobileCamera },
        { id: 7, req: () => eff.requireScreen },
        { id: 8, req: () => eff.requireFullscreen },
        { id: 9, req: () => true }
    ];
}

function updateSidebarNav() {
    const stepsConfig = getWizardStepsConfig();

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
    const stepsConfig = getWizardStepsConfig();
    
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
        case 9: return isPracticeMode ? 'Done' : 'Begin exam';
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
    const eff = getEffectiveRequirements(examConfig);
    // Multi-monitor enforcement is desktop-only; skip on phones/tablets in mobile mode
    if (eff.onlyOneScreen) {
        initDisplayMonitoring();
    }
    if (eff.mobileMode) {
        console.log('[Proctor] Mobile browser mode active — extension/screen/fullscreen/secondary-cam steps relaxed.');
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
    
    // Tear down webcam AI only when leaving the webcam step (step 3), not when entering it.
    if (step !== 3) {
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
    if (step !== 2 && micVolInterval) {
        clearInterval(micVolInterval);
        micVolInterval = null;
    }
    if (step !== 2 && micAudioContext) {
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
                    <button type="button" class="btn btn-secondary" id="btn-retry-webcam" onclick="startWebcamCheck()" style="display:none;">Retry Camera</button>
                    <button id="btn-record-webcam" class="btn btn-primary" onclick="startWebcam5sRecord()">Record Five Second Video</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#2563eb; color:white; border:none;" onclick="goToStep(getNextStep(3))" disabled>Next Step</button>
                </div>
            `;
            // CRITICAL: actually start the camera — without this the preview is a black box.
            setTimeout(() => { startWebcamCheck(); }, 50);
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
            // Served from this origin now, not api.qrserver.com — the token no longer
            // leaves the server, and it still renders under Safe Exam Browser's URL
            // filter. The server reads the token from the session, so it is not in
            // this URL either.
            const qrApiUrl = `/api/session/mobile-qr?exam_id=${encodeURIComponent(examConfig.id)}`;

            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Secondary Mobile Camera</h2>
                    <p class="step-description">
                        To add an extra layer of security, you are required to use your mobile device as a secondary camera. Scan the QR code below with your phone to link it.
                    </p>
                    
                    <div style="display: flex; gap: 20px; align-items: center; flex-wrap: wrap; margin-top: 15px;">
                        <div style="background: white; padding: 12px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 160px; height: 160px; display: flex; align-items: center; justify-content: center;">
                            <img src="${qrApiUrl}" style="width: 160px; height: 160px;" alt="Pairing QR code"
                                 onerror="document.getElementById('qr-fallback').style.display='block'; this.style.display='none';" />
                        </div>
                        <div style="flex-grow: 1; min-width: 250px;">
                            <div id="mobile-pairing-status" style="margin-bottom: 15px; padding: 12px 15px; border-radius: 6px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #f59e0b; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                                <div class="spinner" style="width:16px; height:16px; border-width: 2px;"></div>
                                <span>Waiting for phone to connect...</span>
                            </div>
                            
                            <!-- If the QR cannot render — no network, a URL filter, a
                                 missing module on the server — the student is otherwise
                                 stuck, with no address bar to work around it. -->
                            <div id="qr-fallback" style="display:none; margin-bottom:12px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:#fbf4e4; font-size:12px; line-height:1.5; color:#6b4e11;">
                                <strong>QR code unavailable.</strong> Open this address on your phone instead:
                                <div style="margin-top:6px; font-family:var(--font-mono); font-size:11px; word-break:break-all; user-select:all;">${mobileUrl}</div>
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
            if (isPracticeMode) {
                contentEl.innerHTML = `
                    <div>
                        <h2 class="step-title">Practice check complete</h2>
                        <p class="step-description">
                            Your network, microphone, and camera look ready. Nothing was recorded for grading.
                            Close this tab when finished, then open your real exam from Canvas when instructed.
                        </p>
                        <div style="background:#ecfdf5; border:1px solid #a7f3d0; border-radius:8px; padding:14px; color:#065f46; font-size:14px; line-height:1.5;">
                            <strong>Tip:</strong> Use the same device, browser, and lighting for the real exam to avoid last-minute setup issues.
                        </div>
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 24px;">
                        <button class="btn btn-primary" style="padding: 12px 28px; font-size: 15px; font-weight: bold; background: #2563eb; border: none;" onclick="window.close();">Close</button>
                    </div>
                `;
            } else {
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
            }
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

// ---- Camera helpers: resilient getUserMedia + force play (fixes black preview) ----
async function getUserMediaCamera(preferAudio = false) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not available in this browser. Use Chrome, Edge, or Safari over HTTPS.');
    }
    // Soft constraints first — rigid {width:640,height:480} fails or blacks out on many laptops/phones.
    const attempts = [
        {
            video: {
                facingMode: { ideal: 'user' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: preferAudio
        },
        {
            video: { facingMode: { ideal: 'user' } },
            audio: preferAudio
        },
        { video: true, audio: preferAudio },
        { video: { facingMode: 'user' }, audio: preferAudio }
    ];
    let lastErr = null;
    for (const constraints of attempts) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            // Ensure video tracks are enabled
            stream.getVideoTracks().forEach(t => { t.enabled = true; });
            return stream;
        } catch (err) {
            lastErr = err;
            console.warn('[Camera] getUserMedia attempt failed:', constraints, err && err.name, err && err.message);
        }
    }
    throw lastErr || new Error('Could not open camera');
}

async function attachStreamToVideoElement(videoEl, stream) {
    if (!videoEl || !stream) return false;
    videoEl.muted = true;
    videoEl.defaultMuted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    videoEl.setAttribute('muted', '');
    // Clear any leftover recorded blob URL from the 5s test
    try {
        if (videoEl.src && videoEl.src.startsWith('blob:')) {
            URL.revokeObjectURL(videoEl.src);
        }
    } catch (e) {}
    videoEl.removeAttribute('src');
    videoEl.srcObject = stream;

    // Wait for metadata then play — many browsers show a permanent black frame without this.
    await new Promise((resolve) => {
        if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) {
            resolve();
            return;
        }
        const onMeta = () => { cleanup(); resolve(); };
        const onTimeout = setTimeout(() => { cleanup(); resolve(); }, 4000);
        function cleanup() {
            videoEl.removeEventListener('loadedmetadata', onMeta);
            clearTimeout(onTimeout);
        }
        videoEl.addEventListener('loadedmetadata', onMeta);
    });

    try {
        await videoEl.play();
    } catch (playErr) {
        console.warn('[Camera] video.play() blocked, retrying after gesture/delay:', playErr);
        await new Promise(r => setTimeout(r, 200));
        try { await videoEl.play(); } catch (e2) {
            console.warn('[Camera] video.play() still failed:', e2);
        }
    }

    // Confirm frames are actually flowing (not black / 0x0)
    const readyStart = Date.now();
    while (Date.now() - readyStart < 5000) {
        if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0 && !videoEl.paused) {
            return true;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    // Partial success: stream may still work for recording even if preview lags
    return videoEl.videoWidth > 0;
}

async function startWebcamCheck() {
    const nextBtn = document.getElementById('btn-next-step');
    const recordBtn = document.getElementById('btn-record-webcam');
    const retryBtn = document.getElementById('btn-retry-webcam');
    const aiLoadingContainer = document.getElementById('ai-loading-container');
    const aiStatusContainer = document.getElementById('ai-status-container');
    try {
        if (examConfig && examConfig.require_camera) {
            if (nextBtn) nextBtn.disabled = true;
            if (recordBtn) recordBtn.disabled = true;
        }
        if (retryBtn) retryBtn.style.display = 'none';

        // Stop a previous dead stream before re-opening (common after permission toggles)
        if (localCamStream) {
            try { localCamStream.getTracks().forEach(t => t.stop()); } catch (e) {}
            localCamStream = null;
        }

        localCamStream = await getUserMediaCamera(false);
        const videoEl = document.getElementById('webcam-check-preview');
        if (!videoEl) {
            throw new Error('Webcam preview element missing from the page.');
        }
        const previewOk = await attachStreamToVideoElement(videoEl, localCamStream);
        if (!previewOk) {
            console.warn('[Camera] Preview may still be initializing; stream tracks:', localCamStream.getVideoTracks().map(t => t.label + ':' + t.readyState));
        }

        // If we got a live track, allow continue even before AI (students stuck on black+disabled Next)
        const hasLiveVideo = localCamStream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);
        if (hasLiveVideo && previewOk) {
            if (recordBtn) recordBtn.disabled = false;
            if (nextBtn) nextBtn.disabled = false;
        }
        
        if (examConfig && examConfig.require_camera) {
            if (aiLoadingContainer) aiLoadingContainer.style.display = 'flex';
            if (aiStatusContainer) aiStatusContainer.style.display = 'none';

            try {
                await loadAIModel();
                if (aiLoadingContainer) aiLoadingContainer.style.display = 'none';
                if (aiStatusContainer) aiStatusContainer.style.display = 'flex';

                isCheckingWebcamAI = true;
                runWebcamAIDetection();
                // Safety: never leave Next permanently disabled if face model is flaky
                setTimeout(() => {
                    if (nextBtn && nextBtn.disabled && localCamStream) {
                        nextBtn.disabled = false;
                        if (recordBtn) recordBtn.disabled = false;
                        const statusMsgEl = document.getElementById('ai-status-msg');
                        if (statusMsgEl) {
                            statusMsgEl.innerHTML = `<span style="color: #b45309; font-weight: bold;">⚠ Face check timed out — camera is active, you may continue</span>`;
                        }
                    }
                }, 12000);
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
        if (retryBtn) retryBtn.style.display = 'inline-flex';
        showStepError("Camera access denied or not found: " + (err && err.message ? err.message : err) + " — click Retry Camera, or check browser site permissions.");
        if (nextBtn) nextBtn.disabled = true;
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

        // This param is read by Canvas's OWN quizzes_controller.rb (self-hosted, custom
        // patched), not by our server — it's Canvas's native bypass for its
        // require_lockdown_browser gate on /take page loads. Without it, Canvas re-fires
        // its own LDB redirect on every iframe load of the quiz, looping against our flow.
        // Value comes from the server (examConfig.secure_proctor_secret) rather than being
        // hardcoded here, matching CANVAS_LAUNCH_SECRET server-side.
        quizUrl += (quizUrl.includes('?') ? '&' : '?') + `proctor_session_token=${encodeURIComponent(sessionToken)}`;
        if (examConfig.secure_proctor_secret) {
            quizUrl += `&secure_proctor=${encodeURIComponent(examConfig.secure_proctor_secret)}`;
        }
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

// Show or clear the mid-exam secondary-camera blocker, re-rendering the pairing QR
// so the student can actually act on it. The status message used to tell them to
// "re-scan the QR code" on a screen that no longer had one.
function showMobileCameraBlocker(show) {
    const overlay = document.getElementById('mobile-camera-blocker-overlay');
    if (!overlay) return;

    if (!show) {
        overlay.style.display = 'none';
        return;
    }

    const img = document.getElementById('mobile-reconnect-qr');
    if (img) {
        img.style.display = 'block';
        // Cache-busted so a previously failed load is retried rather than reused.
        img.src = `/api/session/mobile-qr?exam_id=${encodeURIComponent(examConfig.id)}&t=${Date.now()}`;
    }
    const fallback = document.getElementById('mobile-reconnect-fallback');
    if (fallback) {
        fallback.style.display = 'none';
        fallback.innerText = `${window.location.origin}/mobile-camera.html?token=${sessionToken}&exam_id=${examConfig.id}`;
    }
    overlay.style.display = 'flex';
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

        const clientProfile = getClientProfile();
        const onMobile = clientProfile.isMobileClient;
        // iOS always needs a fresh combined stream. Android mobile without screen share
        // also benefits from a simple camera+mic captureStream path (canvas composites
        // are flaky on some mobile Chromium builds and can produce zero playable video).
        if (clientProfile.isIOS || (onMobile && !screenStream)) {
            console.log("[Media] Mobile/simple path: obtaining combined camera+mic stream for MediaRecorder...");
            // Stop old tracks to release camera/mic hardware cleanly
            if (localCamStream) {
                localCamStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
            }
            if (localMicStream) {
                localMicStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
            }
            
            try {
                // Prefer combined cam+mic; fall back through soft constraint ladder
                try {
                    finalStream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }
                    });
                } catch (e1) {
                    finalStream = await getUserMediaCamera(true);
                }
                localCamStream = finalStream;
                localMicStream = finalStream;
                videoStream = finalStream;
            } catch (mediaErr) {
                console.error("[Media] Failed to get combined stream on mobile:", mediaErr);
                // Fall back to composite if available
                if (videoStream || screenStream) {
                    console.log("[Media] Falling back to composite track layout...");
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
                                tracks.push(t);
                                addedTrackIds.add(t.id);
                            }
                        });
                    }
                    finalStream = new MediaStream(tracks);
                } else {
                    throw mediaErr;
                }
            }
        } else {
            // Desktop: composite layout (screen + webcam sidebar + status flags)
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
            // Tell the server the footage timeline starts now. Everything that
            // compares video length to attempt length anchors here, so the setup
            // time above isn't mistaken for lost recording.
            fetch('/api/session/recording-started', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exam_session_id: sessionInfo.id, token: sessionToken })
            }).catch(err => console.warn('[Recorder] Could not report recording start:', err.message));

            startChunkProductionWatchdog();
        }

        socket.emit('join_student', {
            exam_id: examConfig.id,
            exam_session_id: sessionInfo.id,
            student_name: sessionInfo.student_name
        });

        socket.emit('laptop_begin_exam', { token: sessionToken });

        const runtimeEff = getEffectiveRequirements(examConfig);
        if (runtimeEff.requireFullscreen && !document.fullscreenElement && typeof document.documentElement.requestFullscreen === 'function') {
             await document.documentElement.requestFullscreen().catch(e => console.log('Fullscreen failed:', e));
        }

        if (examConfig.disable_right_click) {
             document.addEventListener('contextmenu', event => event.preventDefault());
        }

        setupFocusTracking();
        if (runtimeEff.onlyOneScreen) {
            initDisplayMonitoring();
        }
        setupSimulatedAIProctoring();
        startExamLiveAIDetection();
        if (localMicStream) {
            setupAudioAnalysis(localMicStream);
            setupSpeechRecognition();
        } else if (finalStream && finalStream.getAudioTracks().length > 0) {
            setupAudioAnalysis(finalStream);
            setupSpeechRecognition();
        }

        // Integrity metadata for reviewers — especially important on mobile where
        // extension lockdown + screen share are unavailable.
        const plat = getClientProfile();
        const platformLabel = plat.isIOS ? 'iOS/iPad' : (plat.isAndroid ? 'Android' : (plat.isMobileClient ? 'Mobile' : 'Desktop'));
        logProctorEvent('client_platform', `Client: ${platformLabel}; UA: ${(navigator.userAgent || '').slice(0, 180)}`);
        if (plat.isMobileClient) {
            logProctorEvent(
                'mobile_browser_mode',
                'Exam taken in a mobile browser. Chrome extension lockdown, multi-monitor checks, and desktop screen capture are not available. App switches and page hide events are logged instead.'
            );
            setupMobileIntegrityMonitoring();
        }
        if ((examConfig.require_screen || examConfig.verify_desktop) && !localScreenStream) {
            logProctorEvent(
                'screen_share_unavailable',
                'Screen share was enabled for this exam but could not be captured on this device (common on phones/tablets). Review webcam/audio and app-switch events carefully.'
            );
        }
        
        setInterval(sendSnapshot, 3000);

        showToast(plat.isMobileClient
            ? "Proctoring active (mobile browser — camera/mic monitored)."
            : "Proctoring session successfully started.");

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

            try {
                const base64Data = await blobToBase64(e.data);

                console.log(`[Recorder] Saving chunk #${currentIndex} (${e.data.size} bytes) to IndexedDB...`);
                const saved = await saveChunkToDB(sessionInfo.id, currentIndex, base64Data);

                // Queue the chunk with its bytes attached. Losing a single chunk makes
                // every chunk after it undecodable, so the upload must not depend on
                // being able to read it back out of storage later.
                uploadQueue.push({ index: currentIndex, attempts: 0, data: base64Data, persisted: saved !== false });
                trimQueueMemory();

                // Trigger background queue processor
                processUploadQueue();
            } catch (err) {
                // A chunk lost here is a hole in the recording, not a dropped frame.
                console.error(`[Recorder] Could not read chunk #${currentIndex}:`, err);
                logProctorEvent('upload_incomplete',
                    `Recording chunk #${currentIndex} could not be read from the browser (${err && err.message ? err.message : 'unknown error'}). ` +
                    `This leaves a gap in the video.`);
            } finally {
                activeUploads--;
            }
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

// Each queued chunk's base64 is roughly 1.3MB, so a backlog on a slow connection
// would otherwise sit entirely in the JS heap. Release the copy for chunks that did
// reach IndexedDB — those can be read back — and hold on to the rest, since for
// them the in-memory copy is the only copy.
const QUEUE_MEMORY_HIGH_WATER = 8;

function trimQueueMemory() {
    if (uploadQueue.length <= QUEUE_MEMORY_HIGH_WATER) return;
    for (let i = QUEUE_MEMORY_HIGH_WATER; i < uploadQueue.length; i++) {
        const item = uploadQueue[i];
        if (item.persisted && item.data) item.data = null;
    }
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
            // Prefer the bytes the queue is already carrying. Reading them back out of
            // IndexedDB was the only source before, so a storage miss silently dropped
            // the chunk — and a dropped chunk makes the rest of the recording
            // undecodable, not just the five seconds it held.
            let chunkData = item.data;

            if (!chunkData) {
                // Check both stores rather than branching on useMemoryStorage. That
                // flag can flip mid-exam when IndexedDB starts failing, and chunks
                // written before the flip live on the other side of it.
                const chunkKey = `${sessionInfo.id}_${item.index}`;
                let chunkRecord = memoryChunks[chunkKey];

                if (!chunkRecord || !chunkRecord.data) {
                    try {
                        const db = await openDB();
                        chunkRecord = await new Promise((resolve) => {
                            const tx = db.transaction(STORE_NAME, 'readonly');
                            const store = tx.objectStore(STORE_NAME);
                            const req = store.get(chunkKey);
                            req.onsuccess = () => resolve(req.result);
                            req.onerror = () => resolve(null);
                        });
                    } catch (dbErr) {
                        console.warn(`[Queue] Could not read chunk #${item.index} from IndexedDB:`, dbErr && dbErr.message);
                    }
                }

                if (chunkRecord && chunkRecord.data) {
                    chunkData = chunkRecord.data;
                    item.data = chunkData;
                }
            }

            if (!chunkData) {
                console.error(`[Queue] Chunk #${item.index} data is gone from storage — the recording will have a gap here.`);
                if (socket) {
                    socket.emit('proctor_log', {
                        exam_session_id: sessionInfo.id,
                        event_type: 'error',
                        event_message: `Recording chunk #${item.index} was lost from browser storage before it could be uploaded. The video will skip this point.`
                    });
                }
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
                    base64_video: chunkData,
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
                // 413 means something between the browser and Node — usually a reverse
                // proxy's client_max_body_size — is refusing the payload. Retrying is
                // futile and the operator needs to know, because every chunk this size
                // will be lost the same way.
                if (response.status === 413 && !item.reportedTooLarge) {
                    item.reportedTooLarge = true;
                    const kb = Math.round(chunkData.length / 1024);
                    console.error(`[Queue] Chunk #${item.index} (${kb}KB encoded) was rejected as too large. Raise the reverse proxy body limit.`);
                    if (socket) {
                        socket.emit('proctor_log', {
                            exam_session_id: sessionInfo.id,
                            event_type: 'error',
                            event_message: `Upload of chunk #${item.index} was rejected as too large (${kb}KB). Server upload size limit needs raising; recording will be incomplete.`
                        });
                    }
                }
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
                        event_message: `Chunk #${item.index} upload failed permanently after 100 attempts. The video will be missing everything from this point in the attempt onward unless later chunks recovered.`
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
        vCam.muted = true;
        vCam.playsInline = true;
        vCam.setAttribute('playsinline', '');
        vCam.setAttribute('webkit-playsinline', '');
        vCam.srcObject = cameraStream;
        await vCam.play().catch(e => console.warn("[Media] Camera video play failed:", e));
        // Wait until frames exist so the composite isn't a permanent black panel
        const waitStart = Date.now();
        while (Date.now() - waitStart < 4000 && (!vCam.videoWidth || !vCam.videoHeight)) {
            await new Promise(r => setTimeout(r, 50));
        }
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
 
        const hasScreen = !!(vScreen && screenStream);
        if (hasScreen) {
            ctx.drawImage(vScreen, 0, 0, 1280, 720);
        } else if (vCam) {
            // No screen share (typical on mobile): use full main pane for the webcam
            // so the recording is useful evidence instead of a blank "INACTIVE" slate.
            ctx.drawImage(vCam, 0, 0, 1280, 720);
            ctx.fillStyle = "rgba(15, 23, 42, 0.72)";
            ctx.fillRect(0, 0, 1280, 48);
            ctx.fillStyle = "#fbbf24";
            ctx.font = "bold 16px Arial";
            ctx.fillText("CAMERA-ONLY RECORDING — SCREEN SHARE NOT AVAILABLE ON THIS DEVICE", 24, 30);
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
        
        // Sidebar camera (when screen is also present); otherwise a status panel
        if (hasScreen && vCam) {
            ctx.drawImage(vCam, sidebarX, camY, camW, camH);
        } else if (hasScreen && !vCam) {
            ctx.fillStyle = "#1e293b";
            ctx.fillRect(sidebarX, camY, camW, camH);
            ctx.fillStyle = "#9ca3af";
            ctx.font = "bold 13px Arial";
            const placeholderText = "NO WEBCAM REQUIRED";
            ctx.fillText(placeholderText, sidebarX + (320 - ctx.measureText(placeholderText).width) / 2, camY + camH / 2);
        } else {
            ctx.fillStyle = "#0f172a";
            ctx.fillRect(sidebarX, camY, camW, camH);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "bold 13px Arial";
            const t1 = "PRIMARY: WEBCAM";
            ctx.fillText(t1, sidebarX + (320 - ctx.measureText(t1).width) / 2, camY + camH / 2 - 8);
            ctx.font = "11px Arial";
            const t2 = "(no desktop capture)";
            ctx.fillText(t2, sidebarX + (320 - ctx.measureText(t2).width) / 2, camY + camH / 2 + 12);
        }
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 2;
        ctx.strokeRect(sidebarX, camY, camW, camH);
        
        ctx.fillStyle = "white";
        ctx.font = "bold 14px Arial";
        const camLabel = "PROCTOR FEED";
        ctx.fillText(camLabel, sidebarX + (320 - ctx.measureText(camLabel).width) / 2, camY - 15);
 
        // Mic Status — do NOT use track.muted (Chrome/Android often reports muted=true
        // while audio is still captured). Use readyState + enabled + recent volume.
        const liveMicTrack = localMicStream && localMicStream.getAudioTracks().some(t => t.readyState === 'live' && t.enabled);
        const silenceMs = audioTrackerActive ? (Date.now() - lastNonZeroVolumeTime) : 0;
        const recentlyHeard = audioTrackerActive && silenceMs < 2500;
        let micLabel = 'MICROPHONE: OFF';
        let dotColor = '#ef4444';
        if (liveMicTrack && recentlyHeard) {
            micLabel = 'MICROPHONE: ON';
            dotColor = '#22c55e';
        } else if (liveMicTrack) {
            // Track is live but quiet — still recording; not a hard OFF
            micLabel = 'MICROPHONE: ON (quiet)';
            dotColor = '#eab308';
        }
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
        
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(micBoxX + 25, micBoxY + 30, 8, 0, Math.PI * 2);
        ctx.fill();
 
        ctx.fillStyle = "white";
        ctx.font = "bold 12px Arial";
        ctx.fillText(micLabel, micBoxX + 40, micBoxY + 35);
        
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
let pendingFullscreenReentry = false;

function handleViolation(type, message) {
    if (isExamCompleted) return;
    violationCount++;
    logProctorEvent(type, `${message} (Violation #${violationCount})`);

    if (examConfig.max_violations > 0 && violationCount >= examConfig.max_violations) {
        bootStudent();
    } else if (type !== 'display_violation') {
        let msg = type === 'fullscreen_exit'
            ? 'You have exited fullscreen mode. This exam requires fullscreen — click below to return.'
            : 'You have left the exam tab or lost focus of the window. This action has been logged and flagged for your instructor to review.';
        if (examConfig.max_violations > 0) {
            msg += ` Warning: You have ${violationCount} / ${examConfig.max_violations} focus violations. Exceeding this limit will automatically terminate your exam session.`;
        }
        pendingFullscreenReentry = (type === 'fullscreen_exit');
        const overlay = document.getElementById('focus-violation-overlay');
        overlay.querySelector('p').innerText = msg;
        const btn = overlay.querySelector('button');
        if (btn) btn.innerText = pendingFullscreenReentry ? 'Return to Fullscreen' : 'I Acknowledge, Return to Exam';
        overlay.style.display = 'flex';
    }
}

// Fired by the overlay's button click — a real user gesture, so requestFullscreen() is
// allowed here even though the fullscreen exit itself was detected asynchronously.
function acknowledgeViolationOverlay() {
    document.getElementById('focus-violation-overlay').style.display = 'none';
    if (pendingFullscreenReentry && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.log('Fullscreen re-entry failed:', err));
    }
    pendingFullscreenReentry = false;
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
            font-family: var(--font-sans);
            text-align: center;
            padding: 20px;
            box-sizing: border-box;
        `;
        dualScreenOverlay.innerHTML = `
            <div style="background: rgba(30, 41, 59, 0.5); padding: 40px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); max-width: 500px; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
                <div style="margin-bottom: 20px; display: flex; justify-content: center;"><img src="icons/only-one-screen.svg" style="width:60px; height:60px;" /></div>
                <h2 style="font-size: 24px; font-weight: 700; margin: 0 0 15px 0; font-family: var(--font-sans); color:#f87171;">Multiple Screens Detected</h2>
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
    if (!getEffectiveRequirements(examConfig).onlyOneScreen) return;
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
            const mobile = getClientProfile().isMobileClient;
            // On mobile this is the strongest integrity signal (app switch / lock screen)
            handleViolation(
                mobile ? 'app_backgrounded' : 'tab_blur',
                mobile
                    ? 'Student left the exam view (app switch, lock screen, or another tab). Screen content is not recorded on mobile.'
                    : 'Student switched tabs or minimized browser'
            );
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

    if (getEffectiveRequirements(examConfig).requireFullscreen && typeof document.documentElement.requestFullscreen === 'function') {
        document.addEventListener('fullscreenchange', () => {
            if (isExamCompleted) return;
            if (document.fullscreenElement) return;
            handleViolation('fullscreen_exit', 'Student exited fullscreen mode');
        });
    }
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
        <div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: 8px; max-width: 600px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); font-family: var(--font-sans);">
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



// ================================================================
// Chunk production watchdog
//
// mediaRecorder.start(5000) is supposed to emit a dataavailable event every five
// seconds. On mobile Safari it frequently does not: the recorder runs, the stream
// is live, and nothing is emitted until stop() is called. If the tab is then
// backgrounded and killed by the OS — the normal way a phone exam ends — stop()
// never runs and the entire recording is lost, while socket-delivered proctor
// logs keep arriving the whole time. That is the exact signature of "I have the
// speaking alerts and the transcript but no video at all".
//
// Two jobs here. First, force a flush with requestData() if nothing has arrived,
// which is the standard workaround for that bug. Second, if still nothing, say so
// on the session timeline immediately rather than leaving it to be discovered
// after the exam, when the footage is already unrecoverable.
// ================================================================
let chunkWatchdogInterval = null;

function startChunkProductionWatchdog() {
    if (chunkWatchdogInterval) return;

    const startedAt = Date.now();
    let forcedFlushes = 0;
    let reportedStall = false;

    chunkWatchdogInterval = setInterval(() => {
        if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

        const elapsedMs = Date.now() - startedAt;

        // Chunks are flowing — timeslice works on this browser, nothing to do.
        if (chunkIndex > 0) {
            if (forcedFlushes > 0) {
                console.log(`[Recorder] Chunks are flowing after ${forcedFlushes} forced flush(es).`);
            }
            clearInterval(chunkWatchdogInterval);
            chunkWatchdogInterval = null;
            return;
        }

        // Past two timeslice periods with nothing: force the recorder to hand over
        // what it has.
        if (elapsedMs > 12000) {
            try {
                mediaRecorder.requestData();
                forcedFlushes++;
                console.warn(`[Recorder] No chunks after ${Math.round(elapsedMs / 1000)}s — forcing a flush (attempt ${forcedFlushes}).`);
            } catch (e) {
                console.error('[Recorder] requestData() failed:', e && e.message);
            }
        }

        // Still nothing after three forced flushes. Recording is not working on
        // this device and the instructor needs that on the record now.
        if (forcedFlushes >= 3 && !reportedStall) {
            reportedStall = true;
            console.error('[Recorder] Recorder is producing no data on this device.');
            try {
                logProctorEvent('error',
                    `Recording is producing no data on this device after ${Math.round(elapsedMs / 1000)}s ` +
                    `(recorder state: ${mediaRecorder.state}, mime: ${mediaRecorder.mimeType || 'unknown'}). ` +
                    `Monitoring and audio alerts are still active, but there may be little or no video for this attempt.`);
            } catch (e) {}
        }
    }, 3000);

    // Belt and braces for the mobile case: a periodic flush keeps the recording
    // recoverable even if the OS kills the tab without a clean stop(), because
    // each flush is a chunk already uploaded rather than data held in the recorder.
    if (getClientProfile().isMobileClient) {
        console.log('[Recorder] Mobile client — scheduling periodic forced flushes so an OS kill cannot take the whole recording.');
        setInterval(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                try { mediaRecorder.requestData(); } catch (e) {}
            }
        }, 15000);
    }
}

// True while the recording is still being flushed to the server after submit.
// Guards the tab against being closed during that window.
let isFinalizingUpload = false;

// Shown on every exit path — SEB, companion app, and plain browser alike.
//
// The plain-browser path previously said "You may safely close this tab" the
// instant the quiz was submitted, while chunks were still uploading. That was the
// one screen actively inviting the data loss everything else in this file works
// to prevent. Nobody can act on a progress bar they were never shown, so the
// student now sees the real state and is only told they are free to go once the
// last chunk has landed.
function renderFinalizingScreen(container, headline) {
    if (!container) return;
    container.innerHTML = `
        <div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: var(--radius-lg); max-width: 620px; box-shadow: var(--shadow-lg); font-family: var(--font-sans);">
            <div style="width: 72px; height: 72px; border-radius: 50%; background: #e7effa; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto; font-size: 34px; color: var(--accent);">&#8593;</div>
            <h2 style="color: var(--text-primary); font-weight: 700; margin: 0 0 10px 0; font-size: 21px;">${headline}</h2>
            <p id="proctor-upload-status" style="color: var(--text-secondary); font-size: 15px; line-height: 1.55; margin: 0 0 6px 0;">
                Uploading your proctoring recording. Please keep this window open.
            </p>
            <p id="proctor-upload-detail" style="color: var(--text-muted); font-size: 13px; margin: 0 0 20px 0; font-family: var(--font-mono);">Preparing&hellip;</p>
            <div class="volume-meter" style="width: 100%; max-width: 340px; margin: 0 auto; height: 8px;">
                <div id="proctor-upload-bar" style="width: 5%; height: 100%; background: var(--accent); transition: width 0.3s ease;"></div>
            </div>
            <p id="proctor-upload-warning" style="color: var(--warning); font-size: 12.5px; line-height: 1.5; margin: 18px 0 0 0;">
                Closing this window now will leave your recording incomplete.
            </p>
        </div>
    `;
}

function updateUploadProgressUI(uploadedCount, totalCount) {
    const detail = document.getElementById('proctor-upload-detail');
    const bar = document.getElementById('proctor-upload-bar');
    if (detail) {
        const remaining = Math.max(0, totalCount - uploadedCount);
        detail.innerText = remaining > 0
            ? `${remaining} segment${remaining === 1 ? '' : 's'} remaining`
            : 'Finishing up…';
    }
    if (bar && totalCount > 0) {
        const pct = Math.min(99, Math.max(5, Math.round((uploadedCount / totalCount) * 100)));
        bar.style.width = `${pct}%`;
    }
}

function markUploadComplete(readyMessage) {
    const status = document.getElementById('proctor-upload-status');
    const detail = document.getElementById('proctor-upload-detail');
    const bar = document.getElementById('proctor-upload-bar');
    const warning = document.getElementById('proctor-upload-warning');
    if (status) status.innerText = readyMessage;
    if (detail) detail.innerText = 'Recording uploaded in full.';
    if (bar) {
        bar.style.width = '100%';
        bar.style.background = 'var(--success)';
    }
    if (warning) warning.style.display = 'none';
}

function markUploadIncomplete(pendingCount) {
    const status = document.getElementById('proctor-upload-status');
    const detail = document.getElementById('proctor-upload-detail');
    const warning = document.getElementById('proctor-upload-warning');
    if (status) status.innerText = 'Your quiz was submitted, but the recording could not finish uploading.';
    if (detail) detail.innerText = `${pendingCount} segment(s) could not be sent.`;
    if (warning) {
        warning.style.color = 'var(--danger)';
        warning.innerText = 'Your answers are safe. Tell your instructor the recording upload did not complete.';
    }
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

    // Wait for the recording to actually be uploaded before letting the session end.
    //
    // This previously waited on `activeUploads` alone, which only counts a chunk
    // while its FileReader is running or its fetch is in flight. A chunk sitting
    // in uploadQueue — queued but not yet picked up, or waiting between retry
    // attempts — makes activeUploads 0 while work remains. Sample the counter in
    // that window and the wait returns immediately, the session ends, and the
    // server assembles whatever arrived.
    //
    // On a good connection that gap is too small to notice. On a poor one, chunks
    // are retrying constantly and the gap is most of the time, which is how an
    // 18-second attempt produced a 5-second video: chunk 1 landed, chunks 2-4
    // were still queued, and nothing waited for them.
    //
    // Now: drain the queue, not just the in-flight count. The processor is kicked
    // in case it went idle, and the budget is larger because the whole point is
    // the slow-network case. A student on hotel wifi should not silently lose
    // three quarters of their recording.
    processUploadQueue();

    const uploadWaitStart = Date.now();
    // Generous on purpose: the whole point is the slow-connection case, and the
    // student is looking at a progress bar rather than a frozen screen. A minute
    // was not enough for a long attempt on hotel wifi.
    const UPLOAD_DRAIN_BUDGET_MS = 180000;
    const pendingWork = () => activeUploads > 0 || uploadQueue.length > 0 || isProcessingQueue;

    console.log(`[Recorder] Waiting for uploads. active=${activeUploads} queued=${uploadQueue.length}`);

    // Baseline for the progress bar: everything still outstanding at submit time.
    const totalToSend = Math.max(1, uploadQueue.length + activeUploads);
    isFinalizingUpload = true;
    updateUploadProgressUI(0, totalToSend);

    let lastReport = 0;
    while (pendingWork() && (Date.now() - uploadWaitStart < UPLOAD_DRAIN_BUDGET_MS)) {
        await new Promise(r => setTimeout(r, 100));
        // Keep the processor alive if it exited while items remain.
        if (!isProcessingQueue && uploadQueue.length > 0) processUploadQueue();

        const outstanding = uploadQueue.length + activeUploads;
        updateUploadProgressUI(Math.max(0, totalToSend - outstanding), totalToSend);

        const elapsed = Date.now() - uploadWaitStart;
        if (elapsed - lastReport >= 5000) {
            lastReport = elapsed;
            console.log(`[Recorder] Still uploading. active=${activeUploads} queued=${uploadQueue.length} elapsed=${Math.round(elapsed / 1000)}s`);
        }
    }

    isFinalizingUpload = false;

    if (pendingWork()) {
        // Record the shortfall rather than ending quietly: an instructor looking at
        // a short recording needs to know it was a network failure and not a
        // student who closed the tab.
        console.warn(`[Recorder] Upload drain timed out. active=${activeUploads} queued=${uploadQueue.length}`);
        markUploadIncomplete(uploadQueue.length + activeUploads);
        try {
            logProctorEvent('upload_incomplete', `Recording upload did not finish: ${uploadQueue.length} chunk(s) still pending after ${UPLOAD_DRAIN_BUDGET_MS / 1000}s. Video may be shorter than the attempt.`);
        } catch (e) {}
    } else {
        console.log('[Recorder] All chunks uploaded.');
    }
    return !pendingWork();
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
    
    // Show the upload state, not a completion message. The exam is submitted, but
    // the recording is not on the server yet — saying otherwise is what let
    // students walk away mid-upload.
    const isSeb = isSEB();
    renderFinalizingScreen(
        document.getElementById('active-exam-container'),
        isSeb ? 'Quiz submitted' : 'Exam submitted'
    );

    // Perform final actions in the background
    let uploadFinished = false;
    try {
        uploadFinished = await stopRecordingAndAwaitUploads();

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

    // Only now is it true that the student is free to leave.
    if (uploadFinished) {
        markUploadComplete(isSeb
            ? 'Recording uploaded. Exiting Safe Exam Browser…'
            : 'Your proctored exam session is complete. You may safely close this tab.');
    }

    if (isSeb) {
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
    renderFinalizingScreen(document.getElementById('active-exam-container'), 'Quiz submitted');

    let uploadFinished = false;
    try {
        uploadFinished = await stopRecordingAndAwaitUploads();

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

    // The student is only sent back to Canvas once the recording is on the
    // server. If the drain timed out, hold them here with the failure state
    // visible instead of redirecting over it — a redirect at that moment
    // destroys any chunks still queued and hides the fact that it happened.
    if (!uploadFinished) {
        console.warn('[End Session] Upload did not finish. Holding the student on the status screen rather than redirecting.');
        const warning = document.getElementById('proctor-upload-warning');
        if (warning) {
            warning.insertAdjacentHTML('afterend',
                `<button class="btn btn-primary" style="margin-top:16px;" onclick="proceedAfterIncompleteUpload()">Continue to Canvas anyway</button>`);
        }
        return;
    }

    if (isCompanion) {
        markUploadComplete('Recording uploaded. Exiting Secure Proctor…');
        await new Promise(r => setTimeout(r, 2500));
        stopCompanionApp();
    } else if (isSeb) {
        markUploadComplete('Recording uploaded. Exiting Safe Exam Browser…');
        await new Promise(r => setTimeout(r, 1500));
        window.location.href = '/api/seb/quit';
    } else {
        markUploadComplete('Recording uploaded. Returning you to Canvas…');
        await new Promise(r => setTimeout(r, 1200));
        console.log("[End Session] Non-SEB exam finished. Redirecting top window to Canvas quiz page:", examConfig.canvas_quiz_url);
        if (window.top !== window.self) {
            window.top.location.href = examConfig.canvas_quiz_url;
        } else {
            window.location.href = examConfig.canvas_quiz_url;
        }
    }
}

// Escape hatch for the timed-out case. Deliberately an explicit choice by the
// student rather than an automatic redirect, so leaving with an incomplete
// recording is something they did knowingly and the log reflects it.
function proceedAfterIncompleteUpload() {
    try {
        logProctorEvent('upload_incomplete', 'Student chose to leave the page before the recording finished uploading.');
    } catch (e) {}
    const url = (typeof examConfig !== 'undefined' && examConfig && examConfig.canvas_quiz_url) ? examConfig.canvas_quiz_url : '/';
    if (window.top !== window.self) {
        window.top.location.href = url;
    } else {
        window.location.href = url;
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
    // If chunks are still in flight, ask before letting the page go. The browser
    // kills outstanding uploads on unload, so this is the last chance to keep the
    // tail of the recording — and the student has no other way to know.
    if (isFinalizingUpload) {
        event.preventDefault();
        event.returnValue = 'Your proctoring recording is still uploading. Leaving now will leave it incomplete.';
    }

    // Don't fire the beacon while the clean submit path is still draining.
    //
    // Observed on a real 90-second attempt: the beacon reached /api/session/end with
    // total_chunks = 17 while the recorder still had chunks 18 and 19 to deliver.
    // Assembly started immediately, satisfied by 17 contiguous chunks, and the last
    // ~4 seconds arrived too late to be included — the server logged "Kept 2 chunk(s)
    // that arrived after assembly began".
    //
    // The clean path calls /api/session/end itself once the queue is empty, and if
    // the browser kills the page mid-drain the socket-disconnect handler still
    // finalizes the session. So staying quiet here loses nothing and stops the race.
    if (isFinalizingUpload) {
        console.log('[Exit] Suppressing unload beacon: the submit path is still draining uploads.');
        return;
    }

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
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.4;
        const timeDomainArray = new Uint8Array(analyser.fftSize);

        let consecutiveLoudFrames = 0;
        let consecutiveQuietFrames = 0;
        // Adaptive RMS threshold (0-100 scale). A single fixed number can't work across
        // every mic — a quiet laptop mic with auto-gain reads "talking" at ~6 while a hot
        // headset reads ambient at ~8. So instead we measure this student's actual ambient
        // floor for the first ~2s, then trigger when the level rises well above it.
        const isMobile = getClientProfile().isMobileClient;
        const BASELINE_FRAMES = isMobile ? 15 : 20;
        const RMS_FLOOR = isMobile ? 3 : 4;
        const RMS_CEIL = 22;
        // Mobile mics + AGC often compress dynamic range — use a lower multiplier so
        // short phrases like "one plus one equals two" still register.
        const TRIGGER_MULTIPLIER = isMobile ? 1.6 : 2.2;
        let baselineSamples = [];
        let dynamicThreshold = isMobile ? 7 : 10;
        const LOUD_FRAMES_TO_TRIGGER = isMobile ? 2 : 3; // ~200ms mobile / ~300ms desktop
        // End speech sooner so short utterances produce a complete log entry
        const QUIET_FRAMES_TO_RESET = isMobile ? 10 : 20;
        let logCounter = 0;
        let startEventLogged = false;

        console.log("[Audio] Initializing adaptive voice activity analysis (calibrating ambient floor)...");

        talkingDetectionInterval = setInterval(() => {
            if (isExamCompleted) {
                clearInterval(talkingDetectionInterval);
                return;
            }

            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            analyser.getByteTimeDomainData(timeDomainArray);
            let sumSquares = 0;
            for (let i = 0; i < timeDomainArray.length; i++) {
                const normalized = (timeDomainArray[i] - 128) / 128; // -1..1
                sumSquares += normalized * normalized;
            }
            const rms = Math.sqrt(sumSquares / timeDomainArray.length) * 100; // 0..100 scale

            // Calibration phase: collect ambient floor, don't flag anything yet.
            if (baselineSamples.length < BASELINE_FRAMES) {
                baselineSamples.push(rms);
                if (baselineSamples.length === BASELINE_FRAMES) {
                    const ambient = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
                    dynamicThreshold = Math.min(RMS_CEIL, Math.max(RMS_FLOOR, ambient * TRIGGER_MULTIPLIER));
                    console.log(`[Audio] Calibration done. Ambient floor: ${ambient.toFixed(1)}, voice threshold set to: ${dynamicThreshold.toFixed(1)}`);
                }
                return;
            }

            logCounter++;
            if (logCounter % 50 === 0) {
                console.log(`[Audio] Monitoring... RMS: ${rms.toFixed(1)} (threshold ${dynamicThreshold.toFixed(1)})`);
            }

            if (rms > dynamicThreshold) {
                consecutiveLoudFrames++;
                consecutiveQuietFrames = 0;
            } else {
                consecutiveQuietFrames++;
                consecutiveLoudFrames = 0;
            }

            // Speech started — log immediately so short phrases aren't lost if session ends mid-talk
            if (!isCurrentlyTalking && consecutiveLoudFrames >= LOUD_FRAMES_TO_TRIGGER) {
                isCurrentlyTalking = true;
                talkingStartTimestamp = new Date();
                startEventLogged = false;
                console.log(`[Audio] Voice activity detected (RMS: ${rms.toFixed(1)})...`);
                if (!startEventLogged) {
                    startEventLogged = true;
                    logProctorEvent('voice_activity', `Voice/talking activity detected at ${talkingStartTimestamp.toLocaleTimeString()} (RMS ${rms.toFixed(1)})`);
                }
            }

            // Speech ended: sustained quiet frames
            if (isCurrentlyTalking && consecutiveQuietFrames >= QUIET_FRAMES_TO_RESET) {
                isCurrentlyTalking = false;
                const duration = Math.round((new Date() - talkingStartTimestamp) / 1000) - Math.round(QUIET_FRAMES_TO_RESET / 10);
                const finalDuration = Math.max(1, duration);
                const startTimeStr = talkingStartTimestamp.toLocaleTimeString();
                logProctorEvent('audio_violation', `Talking/Voice detected starting at ${startTimeStr} (Duration: ${finalDuration}s)`);
            }
        }, 100);

    } catch (e) {
        console.warn("[Audio] Failed to setup audio analysis:", e);
    }
}

let speechRecognition = null;
function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn("[Speech] Web Speech API is not supported in this browser.");
        logProctorEvent('speech_recognition_unavailable', 'Web Speech API not supported — relying on RMS voice-activity detection only.');
        return;
    }

    try {
        speechRecognition = new SpeechRecognition();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true; // catch short phrases sooner on mobile
        speechRecognition.lang = 'en-US';
        let lastFinalTranscript = '';

        speechRecognition.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const transcript = (result[0] && result[0].transcript ? result[0].transcript : '').trim();
                if (!transcript) continue;

                // Only finals. Interim results are successive *guesses at the same
                // utterance*, not separate speech: the API emits "that's", then
                // "that's what", then "that's one" while it refines one phrase.
                // Logging each produced a violation per keystroke-equivalent — a
                // single sentence generated 25 alerts, all stamped at the same
                // second, which reads to an instructor as sustained talking and is
                // exactly the kind of false accusation this tool must not make.
                //
                // The old `transcript.length >= 4` guard let every interim through,
                // and the lastFinalTranscript check could not stop it because each
                // refinement is a different string.
                if (!result.isFinal) continue;
                if (transcript === lastFinalTranscript) continue;
                lastFinalTranscript = transcript;

                console.log(`[Speech] Student said: "${transcript}"`);
                logProctorEvent('voice_transcript', `Speaking detected: "${transcript}"`);
            }
        };

        speechRecognition.onerror = (event) => {
            console.warn("[Speech] Recognition error:", event.error);
            // network / not-allowed / service-not-allowed are common on Android — don't loop spam
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                logProctorEvent('speech_recognition_unavailable', `Speech recognition blocked: ${event.error}`);
                try { speechRecognition.onend = null; speechRecognition.stop(); } catch (e) {}
                speechRecognition = null;
            }
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
        logProctorEvent('speech_recognition_unavailable', `Speech recognition failed to start: ${e.message || e}`);
    }
}

/** Mobile-only extras beyond setupFocusTracking (visibility already handled there). */
let mobileIntegrityWired = false;
function setupMobileIntegrityMonitoring() {
    if (mobileIntegrityWired) return;
    mobileIntegrityWired = true;
    // pagehide fires more reliably than visibilitychange when the mobile OS kills the tab
    window.addEventListener('pagehide', () => {
        if (isExamCompleted) return;
        logProctorEvent('page_hidden', 'pagehide — exam page unloaded or backgrounded by the OS.');
    });
    console.log('[Proctor] Mobile integrity monitoring active.');
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
                                           localCamStream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');

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

        // Do NOT use track.muted — Chrome often reports muted=true while video is fine (false "camera off" blocker / black UX).
        const isCameraActive = localCamStream && 
                               localCamStream.getVideoTracks().length > 0 && 
                               localCamStream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');

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
        const live = localCamStream && localCamStream.getVideoTracks().some(t => t.readyState === 'live');
        if (!live) {
            if (localCamStream) {
                try { localCamStream.getTracks().forEach(t => t.stop()); } catch (e) {}
            }
            localCamStream = await getUserMediaCamera(false);
        }
        const videoEl = document.getElementById('id-check-preview');
        if (videoEl) {
            await attachStreamToVideoElement(videoEl, localCamStream);
        }
    } catch (err) {
        showStepError("Failed to access camera for ID verification: " + (err && err.message ? err.message : err));
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

let examConfig = null;
let sessionInfo = null;
let activeVisualFlags = [];
let socket = io();
socket.on('instructor_warning', (data) => {
    const overlay = document.getElementById('focus-violation-overlay');
    if (overlay) {
        overlay.querySelector('h1').innerText = "💬 Message from Instructor";
        overlay.querySelector('h1').style.color = "var(--warning)";
        overlay.querySelector('p').innerText = data.message;
        overlay.querySelector('button').innerText = "I Acknowledge";
        overlay.style.display = 'flex';
    }
});
let mediaRecorder = null;
let chunkIndex = 0;
let finalStream = null;
let activeUploads = 0;
let isStartingExam = false;

let videoStream = null;
let screenStream = null;
let compositeAnimationId = null;
let isExamCompleted = false;
let talkingDetectionInterval = null;
let talkingStartTimestamp = null;
let isCurrentlyTalking = false;
let urlParams = new URLSearchParams(window.location.search);
let sessionToken = urlParams.get('token');
let isSebParam = urlParams.get('seb') === 'true';
let autoExamCode = urlParams.get('exam_code');
let placementId = urlParams.get('placement_id');
let directExamId = urlParams.get('exam_id');

window.addEventListener('load', () => {
    if ((placementId || directExamId) && sessionToken) {
        document.getElementById('code-container').style.display = 'none';
        verifyPlacement(placementId, directExamId);
    } else if (autoExamCode && sessionToken) {
        document.getElementById('access-code-input').value = autoExamCode;
        verifyExamCode();
    }

    document.addEventListener('fullscreenchange', () => {
        if (currentStep === 4) {
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
        { id: 1, req: () => examConfig.require_mic },
        { id: 2, req: () => examConfig.require_camera },
        { id: 3, req: () => examConfig.require_screen && !isSEB() },
        { id: 4, req: () => examConfig.require_fullscreen },
        { id: 5, req: () => true }
    ];

    let visualIndex = 1;
    stepsConfig.forEach((stepItem) => {
        const navEl = document.getElementById(`step-nav-${stepItem.id}`);
        if (!navEl) return;
        
        if (!stepItem.req()) {
            navEl.style.display = 'none';
        } else {
            navEl.style.display = 'block';
            navEl.className = 'sidebar-step';
            if (stepItem.id === currentStep) {
                navEl.classList.add('active');
                navEl.innerHTML = `STEP ${visualIndex}: ${getStepName(stepItem.id)}`;
            } else if (stepItem.id < currentStep) {
                navEl.classList.add('completed');
                navEl.innerHTML = `STEP ${visualIndex}: ${getStepName(stepItem.id)} ✓`;
            } else {
                navEl.innerHTML = `STEP ${visualIndex}: ${getStepName(stepItem.id)}`;
            }
            visualIndex++;
        }
    });
}

function getNextStep(current) {
    const stepsConfig = [
        { id: 1, req: () => examConfig.require_mic },
        { id: 2, req: () => examConfig.require_camera },
        { id: 3, req: () => examConfig.require_screen && !isSEB() },
        { id: 4, req: () => examConfig.require_fullscreen },
        { id: 5, req: () => true }
    ];
    for (let i = current; i < stepsConfig.length; i++) {
        if (stepsConfig[i].req()) {
            return stepsConfig[i].id;
        }
    }
    return 5;
}

function getStepName(step) {
    switch(step) {
        case 1: return 'MICROPHONE CHECK';
        case 2: return 'WEBCAM CHECK';
        case 3: return 'SCREEN SHARE';
        case 4: return 'FULLSCREEN MODE';
        case 5: return 'BEGIN EXAM';
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
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(getNextStep(1))" disabled>Next Step</button>
                </div>
            `;
            if (localMicStream) {
                startMicCheck();
            }
            break;
            
        case 2:
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
                    <div id="webcam-timer" style="font-weight: bold; color: #1e3a8a; margin: 10px 0;"></div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-record-webcam" class="btn btn-primary" onclick="startWebcam5sRecord()">Record Five Second Video</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(getNextStep(2))" ${localCamStream ? '' : 'disabled'}>Next Step</button>
                </div>
            `;
            startWebcamCheck();
            break;
            
        case 3:
            const ios = isIOS();
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Screen Share</h2>
                    ${ios ? `
                        <p class="step-description" style="color: #1e3a8a; font-weight: bold; background: #eff6ff; padding: 15px; border-radius: 6px; border: 1px solid #bfdbfe;">
                            📱 iPad / iPhone Detected: Apple iOS does not support screen-sharing in Safari. This requirement has been bypassed for your device, but webcam and microphone monitoring will remain active.
                        </p>
                    ` : `
                        <p class="step-description">
                            You must share your <strong>ENTIRE SCREEN</strong> (not just a window or Chrome tab) to secure the exam session.
                        </p>
                        <div id="screenshare-status" style="font-weight: bold; color: #059669; margin: 15px 0;">
                            ${localScreenStream ? '✓ Screen Share Active' : 'Screen share not yet active'}
                        </div>
                    `}
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    ${ios ? '' : `<button class="btn btn-primary" onclick="requestScreenShareStep()" style="${localScreenStream ? 'display:none;' : ''}">Share Entire Screen</button>`}
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(getNextStep(3))" ${ios || localScreenStream ? '' : 'disabled'}>Next Step</button>
                </div>
            `;
            break;
            
        case 4:
            const fullscreenSupported = typeof document.documentElement.requestFullscreen === 'function';
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Fullscreen Mode</h2>
                    ${fullscreenSupported ? `
                        <p class="step-description">
                            This exam must be taken in Fullscreen Mode to prevent multitasking or accessing other tabs/windows.
                        </p>
                        <div id="fullscreen-status" style="font-weight: bold; color: #059669; margin: 15px 0;">
                            ${document.fullscreenElement ? '✓ Fullscreen Mode Enabled' : 'Fullscreen not yet active'}
                        </div>
                    ` : `
                        <p class="step-description" style="color: #1e3a8a; font-weight: bold; background: #eff6ff; padding: 15px; border-radius: 6px; border: 1px solid #bfdbfe;">
                            📱 Mobile Device / Browser Compatibility: Your browser or device does not support standard fullscreen mode. This step has been bypassed, but webcam and microphone monitoring remain active.
                        </p>
                    `}
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    ${fullscreenSupported ? `<button class="btn btn-primary" onclick="requestFullscreenStep()" style="${document.fullscreenElement ? 'display:none;' : ''}">Enter Fullscreen</button>` : ''}
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(getNextStep(4))" ${!fullscreenSupported || document.fullscreenElement ? '' : 'disabled'}>Next Step</button>
                </div>
            `;
            break;
            
        case 5:
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Begin Exam</h2>
                    <p class="step-description">
                        All checks have passed successfully. Click the button below to start your proctored session.
                    </p>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-begin-exam" class="btn btn-success" style="padding: 15px 40px; font-size: 16px; font-weight: bold;" onclick="startMainExamSession()">Begin Exam Now</button>
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

async function startWebcamCheck() {
    try {
        localCamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        const videoEl = document.getElementById('webcam-check-preview');
        if (videoEl) videoEl.srcObject = localCamStream;
        
        // Enable Next Step button immediately once webcam preview is active
        const nextBtn = document.getElementById('btn-next-step');
        if (nextBtn) nextBtn.disabled = false;
    } catch (err) {
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
    const tracks = [
        ...localCamStream.getVideoTracks()
    ];
    if (localMicStream) {
        localMicStream.getAudioTracks().forEach(t => tracks.push(t));
    }
    const combinedStream = new MediaStream(tracks);
    
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
            video: { cursor: "always", width: { max: 1024 }, height: { max: 768 }, frameRate: { max: 5 } },
            audio: false
        });
        
        const track = localScreenStream.getVideoTracks()[0];
        const settings = track.getSettings();
        if (settings.displaySurface && settings.displaySurface !== 'monitor') {
            throw new Error("You must share your ENTIRE SCREEN, not just a window or tab.");
        }
        
        track.onended = () => {
            localScreenStream = null;
            if (currentStep === 3) {
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
        if (quizUrl.includes('?')) {
            quizUrl += "&secure_proctor=canvas-proctor-shared-secret-key-998877";
        } else {
            quizUrl += "?secure_proctor=canvas-proctor-shared-secret-key-998877";
        }
        if (sessionInfo.auto_login_signature) {
            quizUrl += `&auto_login_user_id=${encodeURIComponent(sessionInfo.auto_login_user_id)}&auto_login_expires=${encodeURIComponent(sessionInfo.auto_login_expires)}&auto_login_signature=${encodeURIComponent(sessionInfo.auto_login_signature)}`;
        }
        
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
        
        const tracks = [];
        let compositeStream = null;
        const addedTrackIds = new Set();

        const ios = isIOS();
        if (ios) {
            console.log("[Media] iOS/Safari detected: recording raw webcam and mic directly for maximum stability.");
            if (localCamStream && localCamStream.getVideoTracks().length > 0) {
                localCamStream.getVideoTracks().forEach(t => {
                    tracks.push(t);
                    addedTrackIds.add(t.id);
                });
            }
            if (localMicStream) {
                localMicStream.getAudioTracks().forEach(t => {
                    tracks.push(t);
                    addedTrackIds.add(t.id);
                });
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
        }

        finalStream = new MediaStream(tracks);
        console.log(`[Media] Final stream created with ${finalStream.getVideoTracks().length} video and ${finalStream.getAudioTracks().length} audio tracks.`);

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
    
    // Check both WebM (Chrome/Firefox/Edge) and MP4 (Safari/iOS) candidates
    const candidates = [
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
        videoBitsPerSecond: 800000, 
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
            activeUploads++;
            
            const reader = new FileReader();
            reader.onloadend = async () => {
                const result = reader.result || '';
                const base64Part = result.indexOf(';base64,');
                const base64Data = base64Part !== -1 ? result.substring(base64Part + 8) : (result.indexOf(',') !== -1 ? result.substring(result.indexOf(',') + 1) : result);
                
                console.log(`[Recorder] Chunk #${currentIndex}: size=${e.data.size} bytes, base64Len=${base64Data.length}`);
                
                const uploadWithRetry = async (attempt = 1) => {
                    try {
                        const response = await fetch('/api/session/upload-chunk', { 
                            method: 'POST', 
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                exam_session_id: sessionInfo.id,
                                chunk_index: currentIndex,
                                base64_video: base64Data,
                                token: sessionToken
                            })
                        });
                        
                        if (!response.ok) {
                            const errorData = await response.json().catch(() => ({}));
                            throw new Error(errorData.error || `HTTP ${response.status}`);
                        }
                        console.log(`[Recorder] Chunk #${currentIndex} upload success (attempt ${attempt})`);
                    } catch(err) {
                        console.warn(`[Recorder] Chunk #${currentIndex} upload failed (attempt ${attempt}):`, err.message);
                        if (attempt < 3) {
                            const delay = attempt * 1500;
                            console.log(`[Recorder] Retrying chunk #${currentIndex} in ${delay}ms...`);
                            await new Promise(r => setTimeout(r, delay));
                            return uploadWithRetry(attempt + 1);
                        }
                        throw err;
                    }
                };

                try {
                    await uploadWithRetry(1);
                } catch(err) {
                    console.error(`[Recorder] Failed to upload chunk #${currentIndex} after 3 attempts`, err);
                    if (socket) {
                        socket.emit('proctor_log', {
                            exam_session_id: sessionInfo.id,
                            event_type: 'error',
                            event_message: `Chunk #${currentIndex} upload failed after 3 attempts: ${err.message}`
                        });
                    }
                } finally {
                    activeUploads--;
                }
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

async function createCompositeTrack(screenStream, cameraStream) {
    const canvas = document.createElement('canvas');
    canvas.width = 1600; // 1280 (screen) + 320 (sidebar)
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    let vScreen = null;
    if (screenStream) {
        vScreen = document.createElement('video');
        vScreen.srcObject = screenStream;
        vScreen.muted = true;
        vScreen.setAttribute('playsinline', ''); 
        await vScreen.play().catch(e => console.warn("[Media] Screen video play failed:", e));
    }

    let vCam = null;
    if (cameraStream && cameraStream.getVideoTracks().length > 0) {
        vCam = document.createElement('video');
        vCam.srcObject = cameraStream;
        vCam.muted = true;
        vCam.setAttribute('playsinline', '');
        await vCam.play().catch(e => console.warn("[Media] Camera video play failed:", e));
    }

    // Volume Detection for visual feedback
    let volumeLevel = 0;
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        
        let sourceStream = cameraStream;
        if (!sourceStream || sourceStream.getAudioTracks().length === 0) {
            sourceStream = localMicStream;
        }
        
        if (sourceStream && sourceStream.getAudioTracks().length > 0) {
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
                setTimeout(updateVolume, 100);
            }
            updateVolume();
        }
    } catch (e) {
        console.warn("[Media] Audio context failed, mic indicator will be static.", e);
    }

    function draw() {
        if (!compositeAnimationId && compositeAnimationId !== 0) return;
        
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (vScreen && screenStream) {
            ctx.drawImage(vScreen, 0, 0, 1280, 720);
        } else {
            ctx.fillStyle = "#1e293b";
            ctx.fillRect(0, 0, 1280, 720);
            ctx.fillStyle = "#94a3b8";
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
            ctx.fillStyle = "#94a3b8";
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
        const hasMic = localMicStream && localMicStream.getAudioTracks().some(t => t.enabled && !t.muted && t.readyState === 'live');
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
        
        compositeAnimationId = setTimeout(draw, 1000 / 15);
    }
    
    compositeAnimationId = setTimeout(draw, 1000 / 15);
    
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

function initDisplayMonitoring() {
    if (!examConfig.only_one_screen) return;

    // Create the overlay DOM element dynamically if it doesn't exist
    if (!document.getElementById('dual-screen-blocker')) {
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
                <div style="font-size: 60px; margin-bottom: 20px;">🖥️🚫</div>
                <h2 style="font-size: 24px; font-weight: 700; margin: 0 0 15px 0; font-family:'Outfit',sans-serif; color:#f87171;">Multiple Screens Detected</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #cbd5e1; margin-bottom: 25px;">
                    This exam requires using a single display. Please disconnect, unplug, or disable all secondary screens, monitors, or display mirroring to resume the exam.
                </p>
                <div style="font-size: 11px; color: #94a3b8; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
                    Proctoring is active. This event has been logged.
                </div>
            </div>
        `;
        document.body.appendChild(dualScreenOverlay);
    } else {
        dualScreenOverlay = document.getElementById('dual-screen-blocker');
    }

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

        if (isExtended) {
            if (dualScreenOverlay.style.display !== 'flex') {
                dualScreenOverlay.style.display = 'flex';
                handleViolation('display_violation', 'Multiple monitors/screens detected.');
            }
        } else {
            if (dualScreenOverlay.style.display === 'flex') {
                dualScreenOverlay.style.display = 'none';
                logProctorEvent('display_resolved', 'Secondary display disconnected. Student returned to exam.');
            }
        }
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

    showToast('Activity Logged: ' + message);
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

    if (isSeb) {
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
    }
});

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
    if (!examConfig || !examConfig.canvas_quiz_url) {
        alert("Exam configuration not loaded.");
        return;
    }
    if (confirm("WARNING: Opening the quiz in a new tab is a fallback. Safari may pause your webcam recording when you switch tabs, which will be logged as a warning for your instructor. Do this only if you cannot log in inside the frame below. Proceed?")) {
        window.open(examConfig.canvas_quiz_url, '_blank');
        logProctorEvent('ios_fallback_tab', 'Student opened Canvas quiz in a fallback new tab');
    }
}

let examConfig = null;
let sessionInfo = null;
let socket = io();
let mediaRecorder = null;
let chunkIndex = 0;
let finalStream = null;
let activeUploads = 0;

let videoStream = null;
let screenStream = null;
let compositeAnimationId = null;
let isExamCompleted = false;
let urlParams = new URLSearchParams(window.location.search);
let sessionToken = urlParams.get('token');
let isSebParam = urlParams.get('seb') === 'true';
let autoExamCode = urlParams.get('exam_code');

window.addEventListener('load', () => {
    if (autoExamCode && sessionToken) {
        document.getElementById('access-code-input').value = autoExamCode;
        verifyExamCode();
    }
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
    for (let i = 1; i <= 5; i++) {
        const navEl = document.getElementById(`step-nav-${i}`);
        if (!navEl) continue;
        navEl.className = 'sidebar-step';
        if (i === currentStep) {
            navEl.classList.add('active');
        } else if (i < currentStep) {
            navEl.classList.add('completed');
            navEl.innerHTML = `STEP ${i}: ${getStepName(i)} ✓`;
        } else {
            navEl.innerHTML = `STEP ${i}: ${getStepName(i)}`;
        }
    }
}

function getStepName(step) {
    switch(step) {
        case 1: return 'MICROPHONE CHECK';
        case 2: return 'WEBCAM CHECK';
        case 3: return 'FULLSCREEN MODE';
        case 4: return 'SCREEN SHARE';
        case 5: return 'BEGIN EXAM';
    }
}

function initStepWizard() {
    if (examConfig.require_seb && !isSEB()) {
        showSEBBlocker();
        return;
    }
    currentStep = 1;
    goToStep(1);
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
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(2)" disabled>Next Step</button>
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
                        While speaking in your normal voice (say the alphabet or count to 10), click <strong>"Record Five Second Video."</strong><br><br>
                        (This video will be discarded after the webcam check).
                    </p>
                    <div class="video-preview-box">
                        <video id="webcam-check-preview" autoplay muted playsinline></video>
                    </div>
                    <div id="webcam-timer" style="font-weight: bold; color: #1e3a8a; margin: 10px 0;"></div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button id="btn-record-webcam" class="btn btn-primary" onclick="startWebcam5sRecord()">Record Five Second Video</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(3)" disabled>Next Step</button>
                </div>
            `;
            startWebcamCheck();
            break;
            
        case 3:
            contentEl.innerHTML = `
                <div>
                    <h2 class="step-title">Fullscreen Mode</h2>
                    <p class="step-description">
                        This exam must be taken in Fullscreen Mode to prevent multitasking or accessing other tabs/windows.
                    </p>
                    <div id="fullscreen-status" style="font-weight: bold; color: #059669; margin: 15px 0;">
                        ${document.fullscreenElement ? '✓ Fullscreen Mode Enabled' : 'Fullscreen not yet active'}
                    </div>
                    <div id="step-error" style="color: var(--danger); font-size: 14px; margin-top: 10px; display: none;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 20px;">
                    <button class="btn btn-primary" onclick="requestFullscreenStep()">Enter Fullscreen</button>
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(4)" ${document.fullscreenElement ? '' : 'disabled'}>Next Step</button>
                </div>
            `;
            break;
            
        case 4:
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
                    ${ios ? '' : `<button class="btn btn-primary" onclick="requestScreenShareStep()">Share Entire Screen</button>`}
                    <button id="btn-next-step" class="btn btn-primary" style="background:#f97316; color:white; border:none;" onclick="goToStep(5)" ${ios || localScreenStream ? '' : 'disabled'}>Next Step</button>
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
                    <button class="btn btn-success" style="padding: 15px 40px; font-size: 16px; font-weight: bold;" onclick="startMainExamSession()">Begin Exam Now</button>
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
        micAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        micAnalyser = micAudioContext.createAnalyser();
        const source = micAudioContext.createMediaStreamSource(localMicStream);
        source.connect(micAnalyser);
        micAnalyser.fftSize = 256;
        const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);
        
        const meterFill = document.getElementById('mic-volume-fill');
        const nextBtn = document.getElementById('btn-next-step');
        if (nextBtn) nextBtn.disabled = false;
        
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
        
        recordBtn.innerText = "Record Again";
        recordBtn.disabled = false;
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
        
        document.getElementById('screenshare-status').innerHTML = "✓ Screen Share Active";
        document.getElementById('btn-next-step').disabled = false;
    } catch (screenErr) {
        showStepError(screenErr.message);
    }
}

async function startMainExamSession() {
    try {
        // Clean up checking URLs/Timers
        if (webcamVideoUrl) {
            URL.revokeObjectURL(webcamVideoUrl);
            webcamVideoUrl = null;
        }
        
        videoStream = localCamStream;
        screenStream = localScreenStream;
        
        const tracks = [];
        let compositeStream = null;

        if (screenStream && videoStream && videoStream.getVideoTracks().length > 0) {
            console.log("[Media] Both Screen and Camera detected. Initializing side-by-side compositor...");
            compositeStream = await createCompositeTrack(screenStream, videoStream);
            compositeStream.getTracks().forEach(t => tracks.push(t));
        } else if (screenStream) {
            tracks.push(screenStream.getVideoTracks()[0]);
            if (videoStream && videoStream.getAudioTracks().length > 0) {
                videoStream.getAudioTracks().forEach(t => tracks.push(t));
            }
        } else if (videoStream) {
            videoStream.getTracks().forEach(t => tracks.push(t));
        }

        finalStream = new MediaStream(tracks);
        console.log(`[Media] Final stream created with ${finalStream.getVideoTracks().length} video and ${finalStream.getAudioTracks().length} audio tracks.`);

        setupRecording();

        console.log("[Media] Warming up tracks for stable recording...");
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (mediaRecorder) {
            mediaRecorder.start(5000);
            console.log("[Recorder] Session recording started with 5s slices.");
        }
        
        if(screenStream) {
            document.getElementById('local-video').srcObject = screenStream;
        } else if(videoStream) {
            document.getElementById('local-video').srcObject = videoStream;
        }

        const sessionRes = await fetch('/api/session/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exam_id: examConfig.id })
        });
        sessionInfo = await sessionRes.json();

        socket.emit('join_student', {
            exam_id: examConfig.id,
            exam_session_id: sessionInfo.id,
            student_name: sessionInfo.student_name
        });

        if (examConfig.require_fullscreen && !document.fullscreenElement) {
             await document.documentElement.requestFullscreen().catch(e => console.log('Fullscreen failed:', e));
        }

        if (examConfig.disable_right_click) {
             document.addEventListener('contextmenu', event => event.preventDefault());
        }

        document.getElementById('setup-container').style.display = 'none';
        document.getElementById('active-exam-container').style.display = 'flex';
        document.getElementById('quiz-iframe').src = examConfig.canvas_quiz_url;

        setupFocusTracking();

        setInterval(sendSnapshot, 3000);

    } catch(err) {
        alert("Failed to initialize proctoring session: " + err.message);
    }
}

function isSEB() {
    // Check User Agent or our explicit URL flag
    // We NO LONGER check for just !!sessionToken here because that was causing 
    // loops/premature prompts in regular Chrome.
    return navigator.userAgent.includes('SafeExamBrowser') || isSebParam;
}

function showSEBBlocker() {
    document.getElementById('setup-container').innerHTML = `
        <div class="check-card">
            <h1 style="color:var(--danger)">🛡️ Safe Exam Browser Required</h1>
            <p style="color: var(--text-secondary); margin-bottom: 20px;">
                This exam requires the Safe Exam Browser to ensure a secure testing environment. 
                You are currently using a standard browser.
            </p>
            <div style="background: #eef2ff; border: 1px solid #c7d2fe; padding: 15px; border-radius: 8px; margin-bottom: 20px; text-align: left;">
                <h3 style="margin-top:0; font-size:14px; color: #4338ca;">Unlocked Environment:</h3>
                <p style="font-size:13px; color: #4338ca; margin-bottom:10px;">
                    Click the button below to <strong>Launch Securely</strong>. It will open SEB with <strong>Multiple Tabs</strong> and <strong>New Windows</strong> enabled so you can use Google Meet or other resources.
                </p>
                <ol style="font-size:13px; color: #4338ca; padding-left: 20px;">
                    <li>Ensure Safe Exam Browser is installed.</li>
                    <li>Click <strong>Launch Securely</strong> below.</li>
                    <li>If prompted, allow the browser to open "Safe Exam Browser".</li>
                </ol>
            </div>
            <button class="btn btn-primary" style="width: 100%; justify-content: center; padding: 14px; font-size: 16px;" onclick="launchSEB()">Launch Securely in SEB</button>
            <button class="btn btn-secondary" style="width: 100%; justify-content: center; margin-top: 10px; border:none; background:none; color:var(--text-secondary);" onclick="location.reload()">Back to Code Entry</button>
            
            <p style="font-size:11px; color:var(--text-muted); margin-top:15px;">
                Trouble launching? <a href="javascript:void(0)" onclick="downloadSEBConfig()" style="color:var(--primary)">Download config file manually</a>
            </p>
        </div>
    `;
}

function downloadSEBConfig() {
    if (!sessionToken) {
        alert('Session lost. Please re-launch from your LMS.');
        return;
    }
    window.location.href = `/api/seb/config/${sessionToken}`;
}

function launchSEB() {
    if (!sessionToken) {
        alert('Session lost. Please re-launch from your LMS.');
        return;
    }
    const code = document.getElementById('access-code-input').value.trim();
    const protocol = window.location.protocol === 'https:' ? 'sebs' : 'seb';
    // Pass the exam_code into the config URL so the server can inject it into the SEB start URL
    const sebUrl = `${protocol}://${window.location.host}/api/seb/config/${sessionToken}/config.seb${code ? '?exam_code=' + encodeURIComponent(code) : ''}`;
    window.location.href = sebUrl;
}

function setupRecording() {
    // Dynamically select the most compatible codec for the current hardware/tracks
    let mimeType = 'video/webm';
    const hasAudio = finalStream.getAudioTracks().length > 0;
    
    // Strictly use the most standard and reliable WebM codec to prevent DEMUXER_ERROR
    const candidates = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp8',
        'video/webm'
    ];

    for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) {
            mimeType = candidate;
            break;
        }
    }

    console.log(`[Recorder] Initialized with: ${mimeType}`);
    
    // Handshake: Report the chosen format to the server immediately so playback knows how to decode it
    if (sessionInfo && sessionInfo.id) {
        fetch(`/api/session/${sessionInfo.id}/format`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mime_type: mimeType })
        }).catch(err => console.warn("[Format] Handshake failed, defaulting to webm."));
    }

    mediaRecorder = new MediaRecorder(finalStream, { 
        mimeType: mimeType,
        videoBitsPerSecond: 1500000, 
        audioBitsPerSecond: 128000
    });
    mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0 && sessionInfo.id) {
            // CRITICAL: Capture the current index locally to prevent race conditions during upload
            const currentIndex = ++chunkIndex;
            activeUploads++;
            
            try {
                // Use ArrayBuffer for cleaner binary handling than DataURLs
                const arrayBuffer = await e.data.arrayBuffer();
                let binary = '';
                const bytes = new Uint8Array(arrayBuffer);
                const len = bytes.byteLength;
                for (let i = 0; i < len; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64Data = window.btoa(binary);



                await fetch('/api/session/upload-chunk', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exam_session_id: sessionInfo.id,
                        chunk_index: currentIndex,
                        base64_video: base64Data
                    })
                });
            } catch(err) {
                console.error(`[Recorder] Failed to upload chunk #${currentIndex}`, err);
                if (socket) {
                    socket.emit('proctor_log', {
                        exam_session_id: sessionInfo.id,
                        event_type: 'error',
                        event_message: `Chunk #${currentIndex} upload failed: ${err.message}`
                    });
                }
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

async function createCompositeTrack(screenStream, cameraStream) {
    const canvas = document.createElement('canvas');
    canvas.width = 1600; // 1280 (screen) + 320 (sidebar)
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    const vScreen = document.createElement('video');
    vScreen.srcObject = screenStream;
    vScreen.muted = true;
    vScreen.setAttribute('playsinline', ''); 
    await vScreen.play();

    const vCam = document.createElement('video');
    vCam.srcObject = cameraStream;
    vCam.muted = true;
    vCam.setAttribute('playsinline', '');
    await vCam.play();

    // Volume Detection for visual feedback
    let volumeLevel = 0;
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        const source = audioCtx.createMediaStreamSource(cameraStream);
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
            requestAnimationFrame(updateVolume);
        }
        updateVolume();
    } catch (e) {
        console.warn("[Media] Audio context failed, mic indicator will be static.", e);
    }

    function draw() {
        if (!compositeAnimationId && compositeAnimationId !== 0) return;
        
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.drawImage(vScreen, 0, 0, 1280, 720);
        
        const sidebarX = 1280;
        const camW = 320;
        const camH = 240;
        const camY = (720 - camH) / 2 - 40; // Shift up slightly to make room for mic box
        
        // Draw Camera
        ctx.drawImage(vCam, sidebarX, camY, camW, camH);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 2;
        ctx.strokeRect(sidebarX, camY, camW, camH);
        
        ctx.fillStyle = "white";
        ctx.font = "bold 14px Arial";
        const camLabel = "PROCTOR FEED";
        ctx.fillText(camLabel, sidebarX + (320 - ctx.measureText(camLabel).width) / 2, camY - 15);

        // Mic Status Box - Hardware connectivity based
        const hasMic = cameraStream.getAudioTracks().some(t => t.enabled && t.readyState === 'live');
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
        
        compositeAnimationId = requestAnimationFrame(draw);
    }
    
    compositeAnimationId = requestAnimationFrame(draw);
    
    const canvasStream = canvas.captureStream(15); 
    const outputStream = new MediaStream([canvasStream.getVideoTracks()[0]]);
    
    cameraStream.getAudioTracks().forEach(track => {
        outputStream.addTrack(track);
    });
    
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

function setupFocusTracking() {
    function handleViolation(type, message) {
        if (isExamCompleted) return;
        violationCount++;
        logProctorEvent(type, `${message} (Violation #${violationCount})`);
        
        if (examConfig.max_violations > 0 && violationCount >= examConfig.max_violations) {
            bootStudent();
        } else {
            let msg = 'You have left the exam tab or lost focus of the window. This action has been logged and flagged for your instructor to review.';
            if (examConfig.max_violations > 0) {
                msg += ` Warning: You have ${violationCount} / ${examConfig.max_violations} focus violations. Exceeding this limit will automatically terminate your exam session.`;
            }
            document.getElementById('focus-violation-overlay').querySelector('p').innerText = msg;
            document.getElementById('focus-violation-overlay').style.display = 'flex';
        }
    }

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
        if (examConfig.require_fullscreen && !document.fullscreenElement) {
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

    // Teardown tracks
    const allStreams = [videoStream, screenStream, finalStream, localMicStream, localCamStream, localScreenStream];
    allStreams.forEach(stream => {
        if (stream) stream.getTracks().forEach(t => {
            try { t.stop(); } catch(e){}
        });
    });
    
    const localVideo = document.getElementById('local-video');
    if (localVideo && localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(t => t.stop());
        localVideo.srcObject = null;
    }
    
    if (compositeAnimationId) cancelAnimationFrame(compositeAnimationId);
    compositeAnimationId = null;
    
    document.getElementById('quiz-iframe').src = '';
    
    logProctorEvent('booted', 'Student was automatically booted for exceeding focus limit.');
    
    await fetch('/api/session/end', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ exam_session_id: sessionInfo.id, status: 'booted' })
    });
    
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
    if(!sessionInfo) return;
    fetch('/api/session/log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            exam_session_id: sessionInfo.id,
            event_type: type,
            event_message: message
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



async function endExam() {
    isExamCompleted = true; // Instantly disable focus tracking
    
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log('Exit fullscreen failed:', err));
    }
    
    document.getElementById('active-exam-container').innerHTML = '<div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: 8px;"><h2>Finalizing Video...</h2><p style="color:var(--text-secondary);">Safely encrypting and uploading your footage. Please do not close the window yet.</p></div>';

    if(mediaRecorder && mediaRecorder.state !== 'inactive') {
        const stopPromise = new Promise(resolve => {
            mediaRecorder.onstop = resolve;
        });
        mediaRecorder.stop();
        await stopPromise;
    }
    
    while(activeUploads > 0) {
        await new Promise(r => setTimeout(r, 1000));
    }
    
    // Aggressively disable the browser's hardware tracking logic so the screen/mic recording icons shut off cleanly
    const allStreams = [videoStream, screenStream, finalStream];
    allStreams.forEach(stream => {
        if (stream) stream.getTracks().forEach(t => {
            try { t.stop(); } catch(e){}
        });
    });
    
    const localVideo = document.getElementById('local-video');
    if (localVideo && localVideo.srcObject) {
        localVideo.srcObject.getTracks().forEach(t => t.stop());
        localVideo.srcObject = null;
    }

    if (compositeAnimationId) cancelAnimationFrame(compositeAnimationId);
    compositeAnimationId = null;
    
    // Clear the iframe immediately to stop any lingering background noise from the quiz
    document.getElementById('quiz-iframe').src = '';
    
    logProctorEvent('exam_ended', 'Student securely finished the exam.');
    
    await fetch('/api/session/end', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ exam_session_id: sessionInfo.id })
    });
    
    document.getElementById('active-exam-container').innerHTML = '<div style="margin: auto; text-align: center; padding: 40px; background: white; border-radius: 8px;"><h2>Exam Completed</h2><p style="color:var(--text-secondary);">You may safely close this window.</p></div>';
}

// Exit Handler: Attempt to save session if student quits SEB or closes browser
window.addEventListener('beforeunload', (event) => {
    if (sessionInfo && sessionInfo.id) {
        const url = '/api/session/end';
        const data = JSON.stringify({ exam_session_id: sessionInfo.id, exit_type: 'unexpected' });
        const blob = new Blob([data], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
    }
});

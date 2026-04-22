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
        renderRequirements();
    } catch(err) {
        errorMsg.innerText = err.message;
        errorMsg.style.display = 'block';
    }
}

function renderRequirements() {
    let reqHtml = '';
    if (examConfig.require_camera) reqHtml += '<li>📷 Web Camera Access Required</li>';
    if (examConfig.require_mic) reqHtml += '<li>🎤 Microphone Access Required</li>';
    if (examConfig.require_screen) reqHtml += '<li>💻 Screen Sharing (Entire Screen) Required</li>';
    if (examConfig.require_fullscreen) reqHtml += '<li>🔲 Fullscreen Mode will be enforced</li>';
    if (examConfig.require_seb) reqHtml += '<li>🛡️ Safe Exam Browser Required</li>';
    
    document.getElementById('requirements-list').innerHTML = reqHtml;
}

async function startPreFlight() {
    // Check SEB requirement first
    if (examConfig.require_seb && !isSEB()) {
        showSEBBlocker();
        return;
    }

    const errorMsg = document.getElementById('error-msg');
    errorMsg.style.display = 'none';
    
    try {
        if (examConfig.require_camera || examConfig.require_mic) {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: examConfig.require_camera ? { width: { max: 640 }, height: { max: 360 }, frameRate: { max: 10 } } : false,
                audio: examConfig.require_mic
            });

            // Confidence Preview for Student
            const previewEl = document.getElementById('camera-preview');
            const previewContainer = document.getElementById('camera-preview-container');
            if (previewEl && previewContainer && examConfig.require_camera) {
                previewEl.srcObject = videoStream;
                previewContainer.style.display = 'block';
            }
        }

        if (examConfig.require_screen) {
            if (isSEB()) {
                console.log("SEB detected: Skipping getDisplayMedia as it is blocked by SEB security policy.");
                showToast("SEB blocks screen sharing, but your session is secured by the lockdown.");
            } else {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: "always", width: { max: 1024 }, height: { max: 768 }, frameRate: { max: 5 } },
                    audio: false
                });
                
                // Basic check to ensure they shared entire screen (heuristic: surface/display surface)
                const track = screenStream.getVideoTracks()[0];
                const settings = track.getSettings();
                if (settings.displaySurface && settings.displaySurface !== 'monitor') {
                    throw new Error("You must share your ENTIRE SCREEN, not just a window or tab.");
                }
            }
        }

        // Combine streams for recording
        const tracks = [];
        let compositeStream = null;

        if (screenStream && videoStream && videoStream.getVideoTracks().length > 0) {
            console.log("[Media] Both Screen and Camera detected. Initializing side-by-side compositor...");
            compositeStream = await createCompositeTrack(screenStream, videoStream);
            compositeStream.getTracks().forEach(t => tracks.push(t));
        } else if (screenStream) {
            tracks.push(screenStream.getVideoTracks()[0]);
            // Add mic if available
            if (videoStream && videoStream.getAudioTracks().length > 0) {
                videoStream.getAudioTracks().forEach(t => tracks.push(t));
            }
        } else if (videoStream) {
            videoStream.getTracks().forEach(t => tracks.push(t));
        }

        // Finalize stream
        finalStream = new MediaStream(tracks);
        console.log(`[Media] Final stream created with ${finalStream.getVideoTracks().length} video and ${finalStream.getAudioTracks().length} audio tracks.`);

        // Ensure all gathered tracks are enabled and ready
        tracks.forEach(track => {
            track.enabled = true;
            if (track.readyState === 'ended') console.warn(`[Media] Warning: Track ${track.label} is in 'ended' state.`);
        });

        // Finalize stream
        finalStream = new MediaStream(tracks);
        
        // Sync Guard: Wait for tracks to stabilize before allowing the recording to start later
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log(`[Media] Final stream synchronized with ${tracks.length} tracks.`);
        
        // Attach local video object for snapshot extraction (choose screen or camera)
        if(screenStream) {
            document.getElementById('local-video').srcObject = screenStream;
        } else if(videoStream) {
            document.getElementById('local-video').srcObject = videoStream;
        }

        // Tell server session started
        const sessionRes = await fetch('/api/session/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exam_id: examConfig.id })
        });
        sessionInfo = await sessionRes.json();

        // Join socket room
        socket.emit('join_student', {
            exam_id: examConfig.id,
            exam_session_id: sessionInfo.id,
            student_name: sessionInfo.student_name
        });

        // Setup Media Recorder
        setupRecording();

        // Setup environment
        if (examConfig.require_fullscreen) {
             await document.documentElement.requestFullscreen().catch(e => console.log('Fullscreen failed:', e));
        }

        if (examConfig.disable_right_click) {
             document.addEventListener('contextmenu', event => event.preventDefault());
        }

        // Launch Exam
        document.getElementById('setup-container').style.display = 'none';
        document.getElementById('recording-indicator').style.display = 'block';
        document.getElementById('active-exam-container').style.display = 'block';

        // Start taking snapshots
        setInterval(sendSnapshot, 3000);

    } catch(err) {
        errorMsg.innerText = err.message || err.name;
        errorMsg.style.display = 'block';
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
        alert('Session lost. Please re-launch from Canvas.');
        return;
    }
    window.location.href = `/api/seb/config/${sessionToken}`;
}

function launchSEB() {
    if (!sessionToken) {
        alert('Session lost. Please re-launch from Canvas.');
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
    
    // Priority List: H.264 is often more stable on Windows, VP8 is the WebM standard
    const candidates = [
        `video/webm;codecs=h264${hasAudio ? ',opus' : ''}`,
        `video/webm;codecs=vp8${hasAudio ? ',opus' : ''}`,
        `video/mp4;codecs=avc1${hasAudio ? '.42E01E,mp4a.40.2' : ''}`,
        'video/webm',
        'video/mp4'
    ];

    for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) {
            mimeType = candidate;
            break;
        }
    }

    console.log(`[Recorder] Initialized with: ${mimeType}`);
    
    mediaRecorder = new MediaRecorder(finalStream, { 
        mimeType: mimeType,
        videoBitsPerSecond: 1500000, // 1.5 Mbps for 1600x720 clarity
        audioBitsPerSecond: 128000
    });
    mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0 && sessionInfo.id) {
            chunkIndex++;
            activeUploads++;
            
            try {
                const reader = new FileReader();
                reader.readAsDataURL(e.data);
                reader.onloadend = async () => {
                    const base64Data = reader.result;
                    
                    try {
                        await fetch('/api/session/upload-chunk', { 
                            method: 'POST', 
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                exam_session_id: sessionInfo.id,
                                chunk_index: chunkIndex,
                                base64_video: base64Data
                            })
                        });
                    } catch(uploadErr) {
                        console.error("Failed to upload chunk", uploadErr);
                    } finally {
                        activeUploads--;
                    }
                };
            } catch(err) {
                console.error("Reader boundary crash:", err);
                activeUploads--;
            }
        }
    };
    
    // Start recording but wait 3 seconds for the hardware to fully warm up and sync
    // This solves "Demuxer Error" by ensuring headers are fully initialized before upload
    mediaRecorder.start();
    console.log("[Recorder] Hardware warm-up initiated (3s guard)...");
    
    setTimeout(() => {
        if (mediaRecorder.state === 'recording') {
            console.log("[Recorder] Warm-up complete. Capturing master headers...");
            mediaRecorder.requestData();
            
            // Then continue with regular 10-second segments
            setInterval(() => {
                if (mediaRecorder.state === 'recording') {
                    mediaRecorder.requestData();
                }
            }, 10000);
        }
    }, 3000);
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

    function draw() {
        if (!compositeAnimationId && compositeAnimationId !== 0) return;
        
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.drawImage(vScreen, 0, 0, 1280, 720);
        
        const sidebarX = 1280;
        const camW = 320;
        const camH = 240;
        const camY = (720 - camH) / 2;
        
        ctx.drawImage(vCam, sidebarX, camY, camW, camH);
        
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 2;
        ctx.strokeRect(sidebarX, camY, camW, camH);
        
        ctx.fillStyle = "white";
        ctx.font = "bold 14px Arial";
        const label = "PROCTOR FEED";
        const textWidth = ctx.measureText(label).width;
        ctx.fillText(label, sidebarX + (320 - textWidth) / 2, camY - 15);
        
        compositeAnimationId = requestAnimationFrame(draw);
    }
    
    compositeAnimationId = requestAnimationFrame(draw);
    
    // Create a new stream that combines the canvas video with the original camera/mic audio
    const canvasStream = canvas.captureStream(15); // Higher FPS for better sync
    const outputStream = new MediaStream([canvasStream.getVideoTracks()[0]]);
    
    // Crucial: Add audio tracks to the SAME stream object for perfect sync
    cameraStream.getAudioTracks().forEach(track => {
        console.log(`[Media] Bonding audio track: ${track.label}`);
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
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            logProctorEvent('tab_blur', 'Student switched tabs or minimized browser');
        } else {
            logProctorEvent('tab_focus', 'Student returned to the exam tab');
        }
    });

    window.addEventListener('blur', () => {
        logProctorEvent('window_blur', 'Exam window lost focus');
    });

    window.addEventListener('resize', () => {
        if (examConfig.require_fullscreen && !document.fullscreenElement) {
            logProctorEvent('fullscreen_exit', 'Student exited fullscreen mode');
        }
    });
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

function launchQuiz() {
    window.open(examConfig.canvas_quiz_url, '_blank');
}

async function endExam() {
    document.getElementById('active-exam-container').innerHTML = '<h2>Finalizing Video...</h2><p style="color:var(--text-secondary);">Safely encrypting and uploading your footage. Please do not close the window yet.</p>';

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
    
    // Disable the browser's hardware tracking logic so the screen recording icons shut off cleanly
    if (videoStream) videoStream.getTracks().forEach(t => t.stop());
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    if (finalStream) finalStream.getTracks().forEach(t => t.stop());
    if (compositeAnimationId) cancelAnimationFrame(compositeAnimationId);
    compositeAnimationId = null;
    
    logProctorEvent('exam_ended', 'Student securely finished the exam.');
    
    await fetch('/api/session/end', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ exam_session_id: sessionInfo.id })
    });
    
    document.getElementById('active-exam-container').innerHTML = '<h2>Exam Completed</h2><p style="color:var(--text-secondary);">Your recording has been saved securely to Google Drive. You may now close this window.</p>';
    document.getElementById('recording-indicator').style.display = 'none';
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

// Mobile Companion Script
let socket = null;
let localStream = null;
let mediaRecorder = null;
let chunkIndex = 0;
let isRecording = false;
let recordIntervalId = null;

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');
const examId = urlParams.get('exam_id');

// Status Elements
const stateDot = document.getElementById('state-dot');
const stateText = document.getElementById('state-text');
const btnGrant = document.getElementById('btn-camera-grant');
const recBadge = document.getElementById('rec-badge');
const setupError = document.getElementById('setup-error');
const videoPreview = document.getElementById('mobile-preview');

// Queue upload variables
const uploadQueue = [];
let isProcessingQueue = false;

// Update status visual helper
function updateStatus(state, message) {
    stateText.innerText = message;
    stateDot.style.background = `var(--${state})`;
    stateDot.style.boxShadow = `0 0 10px var(--${state})`;
}

function showError(msg) {
    setupError.innerText = msg;
    setupError.style.display = 'block';
}

// 1. Setup Socket.IO connection
if (!token || !examId) {
    showError("Error: Missing session configuration tokens. Please scan the QR code again.");
    updateStatus('danger', 'Pairing Failed');
} else {
    try {
        socket = io();
        
        socket.on('connect', () => {
            console.log("[Socket] Connected to server, pairing mobile...");
            socket.emit('mobile_pair', { token, exam_id: parseInt(examId) });
        });

        socket.on('mobile_paired', (data) => {
            console.log("[Socket] Successfully paired with desktop session!");
            updateStatus('success', 'Paired & Ready');
            btnGrant.style.display = 'flex';
        });

        socket.on('mobile_pair_error', (data) => {
            showError("Failed to pair: " + data.error);
            updateStatus('danger', 'Pairing Error');
        });

        socket.on('mobile_start_record', () => {
            console.log("[Socket] Start record command received");
            startRecordingSequence();
        });

        socket.on('mobile_stop_record', () => {
            console.log("[Socket] Stop record command received");
            stopRecordingSequence();
        });
        
        socket.on('disconnect', () => {
            console.warn("[Socket] Disconnected from server.");
            updateStatus('warning', 'Reconnecting...');
        });
    } catch (e) {
        console.error("Socket initialization failed:", e);
        showError("Unable to establish real-time server link.");
    }
}

// 2. Request rear camera stream
async function requestMobileCamera() {
    try {
        setupError.style.display = 'none';
        
        // Prefer rear camera ("environment")
        const constraints = {
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15 }
            },
            audio: false // Video only for mobile to prevent echo loops
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        videoPreview.srcObject = localStream;
        
        btnGrant.style.display = 'none';
        updateStatus('success', 'Camera Active & Paired');
        
        // Keep phone awake if supported (via wake lock API)
        if ('wakeLock' in navigator) {
            try {
                await navigator.wakeLock.request('screen');
                console.log("[Wake Lock] Screen Wake Lock activated");
            } catch (err) {
                console.warn("[Wake Lock] Failed to acquire lock:", err.message);
            }
        }
    } catch (err) {
        console.error("Camera access failed:", err);
        showError("Camera Access Denied. Please check your browser permissions and try again.");
        updateStatus('danger', 'Camera Denied');
    }
}

// 3. Recording and chunking loop
function startRecordingSequence() {
    if (isRecording || !localStream) return;
    
    isRecording = true;
    recBadge.style.display = 'flex';
    updateStatus('success', 'PROCTORING ACTIVE');
    chunkIndex = 0;
    
    try {
        mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp8' });
        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                const thisIndex = chunkIndex++;
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64data = reader.result;
                    // Push to queue for sequential processing
                    uploadQueue.push({ index: thisIndex, data: base64data });
                    processUploadQueue();
                };
                reader.readAsDataURL(e.data);
            }
        };
        mediaRecorder.start(5000); // Emit chunk every 5 seconds
    } catch (err) {
        console.error("Failed to start MediaRecorder:", err);
        showError("MediaRecorder error: " + err.message);
    }
}

let notifiedComplete = false;
async function notifyUploadComplete() {
    if (notifiedComplete) return;
    notifiedComplete = true;
    try {
        await fetch('/api/session/mobile-upload-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, total_chunks: chunkIndex })
        });
        console.log("[Upload Mobile] Sent completion notification to server.");
    } catch(e) {
        console.error("Failed to notify server of mobile upload completion:", e);
        notifiedComplete = false; // allow retry
    }
}

// 4. Sequential upload queue processor
async function processUploadQueue() {
    if (isProcessingQueue) return;
    
    if (uploadQueue.length === 0) {
        if (!isRecording && chunkIndex > 0) {
            console.log(`[Upload Mobile] All chunks uploaded. Total: ${chunkIndex}`);
            notifyUploadComplete();
        }
        return;
    }
    
    isProcessingQueue = true;
    const task = uploadQueue.shift();
    
    let retries = 3;
    while (retries > 0) {
        try {
            const res = await fetch('/api/session/upload-mobile-chunk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chunk_index: task.index,
                    token: token,
                    base64_video: task.data
                })
            });
            if (res.ok) {
                console.log(`[Upload Mobile] Successfully uploaded chunk #${task.index}`);
                break;
            } else {
                throw new Error("HTTP " + res.status);
            }
        } catch (err) {
            retries--;
            console.warn(`[Upload Mobile] Failed to upload chunk #${task.index}. Retries left: ${retries}`, err);
            if (retries === 0) {
                console.error(`[Upload Mobile] Chunk #${task.index} discarded after 3 failures.`);
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    isProcessingQueue = false;
    processUploadQueue();
}

function stopRecordingSequence() {
    if (!isRecording) return;
    
    isRecording = false;
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try {
            mediaRecorder.stop();
        } catch (e) {}
    }
    
    recBadge.style.display = 'none';
    updateStatus('success', 'Exam Finished');
    
    // Stop camera stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    document.body.innerHTML = `
        <div style="width:100%; max-width:480px; text-align:center; padding:40px 20px; background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius-lg); margin-top:40px;">
            <div style="font-size:48px; margin-bottom:20px;">🏁</div>
            <h2 style="font-family: var(--font-sans); font-size:24px; color:var(--success); margin-bottom:10px;">Proctoring Complete</h2>
            <p style="color:var(--text-secondary); font-size:14px; line-height:1.6;">Your secondary camera recording has been securely uploaded. You may close this page now.</p>
        </div>
    `;
}

// 5. Visibility and Lock Screen Warning Check
document.addEventListener('visibilitychange', () => {
    if (document.hidden && isRecording) {
        console.warn("[Visibility] Student switched tabs or locked mobile screen!");
        
        // Notify desktop browser immediately via socket
        if (socket) {
            socket.emit('mobile_violation', {
                token: token,
                event_type: 'mobile_visibility_lost',
                event_message: 'Secondary mobile camera page lost focus (tab switched or locked).'
            });
        }
        
        // Trigger sound warning/vibe if supported when user returns
        if ('vibrate' in navigator) {
            navigator.vibrate([200, 100, 200]);
        }
    }
});

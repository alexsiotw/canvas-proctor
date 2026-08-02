// Mobile Companion Script
let socket = null;
let localStream = null;
let mediaRecorder = null;
let chunkIndex = 0;
let isRecording = false;
let recordIntervalId = null;
let wakeLockSentinel = null;

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
        // Handshake identity — the server rejects unauthenticated sockets.
        socket = io({ auth: { token } });
        
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

        // Tell the laptop the camera is genuinely live.
        //
        // `mobile_paired` only means this page loaded and joined the room — it says
        // nothing about camera permission. The laptop used to unlock "Next Step" on
        // pairing alone, so a student could open the link, decline or ignore the camera
        // prompt, and still be waved through the check with no secondary camera at all.
        if (socket) {
            socket.emit('mobile_camera_ready', { token: token });
        }
        
        // Keep phone awake if supported (via wake lock API).
        //
        // The sentinel has to be retained: dropping the return value lets it be
        // garbage-collected, releasing the lock, after which the screen sleeps and
        // the camera track stops mid-exam. Re-acquire when the page becomes visible
        // again, since the OS releases the lock on backgrounding.
        if ('wakeLock' in navigator) {
            const acquireWakeLock = async () => {
                try {
                    wakeLockSentinel = await navigator.wakeLock.request('screen');
                    wakeLockSentinel.addEventListener('release', () => {
                        console.warn('[Wake Lock] Released by the system.');
                    });
                    console.log("[Wake Lock] Screen Wake Lock activated");
                } catch (err) {
                    console.warn("[Wake Lock] Failed to acquire lock:", err.message);
                }
            };
            await acquireWakeLock();
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && isRecording && (!wakeLockSentinel || wakeLockSentinel.released)) {
                    acquireWakeLock();
                }
            });
        }
    } catch (err) {
        console.error("Camera access failed:", err);
        showError("Camera Access Denied. Please check your browser permissions and try again.");
        updateStatus('danger', 'Camera Denied');
    }
}

// Pick a container this device can actually record.
//
// This used to hardcode 'video/webm;codecs=vp8'. iOS Safari's MediaRecorder does
// not support WebM at all, so on an iPhone the constructor threw
// NotSupportedError, the catch below surfaced "MediaRecorder error", and nothing
// was ever recorded — while the page still said PROCTORING ACTIVE. Since the
// secondary camera is almost always a phone, that meant the feature silently did
// not work for most of the devices it exists for.
//
// Same ladder as the desktop recorder in student.js: prefer WebM where available,
// fall through to MP4 for Safari.
function pickMobileMimeType() {
    const candidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4'
    ];
    for (const candidate of candidates) {
        try {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) return candidate;
        } catch (e) { /* isTypeSupported can throw on old engines */ }
    }
    return '';
}

// 3. Recording and chunking loop
function startRecordingSequence() {
    if (isRecording || !localStream) return;

    if (!window.MediaRecorder) {
        showError("This device's browser cannot record video. Please use a different phone or browser.");
        updateStatus('danger', 'Recording unsupported');
        return;
    }

    isRecording = true;
    recBadge.style.display = 'flex';
    updateStatus('success', 'PROCTORING ACTIVE');
    chunkIndex = 0;

    try {
        const mimeType = pickMobileMimeType();
        console.log(`[Recorder] Mobile recorder using: ${mimeType || 'browser default'}`);
        mediaRecorder = mimeType
            ? new MediaRecorder(localStream, { mimeType })
            : new MediaRecorder(localStream);

        // Tell the server which container it will be reassembling. Without this the
        // assembly step assumes WebM and mislabels an MP4 recording.
        fetch('/api/session/mobile-format', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, mime_type: mediaRecorder.mimeType || mimeType || 'video/webm' })
        }).catch(() => {});

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                const thisIndex = chunkIndex++;
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64data = reader.result;
                    // Push to queue for sequential processing
                    uploadQueue.push({ index: thisIndex, data: base64data, attempts: 0 });
                    processUploadQueue();
                };
                reader.onerror = () => {
                    console.error(`[Recorder] Could not read mobile chunk #${thisIndex}`);
                };
                reader.readAsDataURL(e.data);
            }
        };

        mediaRecorder.onerror = (e) => {
            console.error('[Recorder] Mobile MediaRecorder error:', e.error);
            showError('Recording error: ' + ((e.error && e.error.name) || 'unknown'));
        };

        mediaRecorder.start(5000); // Emit chunk every 5 seconds

        // Tell the session timeline what this device actually chose. Without it there
        // is no way to know after the fact whether a phone recorded as WebM or MP4, or
        // which hardware produced a given result — so nobody learns anything from a
        // failure in the field.
        if (socket) {
            socket.emit('mobile_violation', {
                token: token,
                event_type: 'info',
                event_message: `Secondary camera started. Container: ${mediaRecorder.mimeType || mimeType || 'browser default'}. Device: ${navigator.userAgent}`
            });
        }

        // Mobile browsers are unreliable about honouring the timeslice — Safari in
        // particular can withhold every chunk until stop(), which an OS kill then
        // destroys. A periodic forced flush keeps each five seconds recoverable.
        if (recordIntervalId) clearInterval(recordIntervalId);
        recordIntervalId = setInterval(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                try { mediaRecorder.requestData(); } catch (e) {}
            }
        }, 15000);

        startMobileChunkWatchdog();
    } catch (err) {
        console.error("Failed to start MediaRecorder:", err);
        showError("MediaRecorder error: " + err.message);
        isRecording = false;
        updateStatus('danger', 'Recording failed');
    }
}

// Watchdog: prove the recorder is actually producing data on this device.
//
// The codec ladder above picks a container this browser claims to support, but
// "isTypeSupported returned true" is not the same as "frames are being emitted".
// Mobile Safari in particular can run a recorder that withholds everything until
// stop(). Combined with a phone that gets backgrounded and killed, that yields the
// worst outcome available: the page says PROCTORING ACTIVE for the whole exam and
// the server receives nothing.
//
// So rather than trusting the ladder, verify it — and if no data appears, say so on
// the phone, where the student can still do something about it, and on the session
// timeline, where the instructor will see it afterwards.
let mobileWatchdogInterval = null;

function startMobileChunkWatchdog() {
    if (mobileWatchdogInterval) return;

    const startedAt = Date.now();
    let forcedFlushes = 0;
    let reported = false;

    mobileWatchdogInterval = setInterval(() => {
        if (!isRecording || !mediaRecorder) return;

        // Data is flowing — nothing more to check for the rest of the exam.
        if (chunkIndex > 0) {
            clearInterval(mobileWatchdogInterval);
            mobileWatchdogInterval = null;
            return;
        }

        const elapsedMs = Date.now() - startedAt;

        if (elapsedMs > 12000 && mediaRecorder.state === 'recording') {
            try {
                mediaRecorder.requestData();
                forcedFlushes++;
                console.warn(`[Recorder] No mobile chunks after ${Math.round(elapsedMs / 1000)}s — forcing flush ${forcedFlushes}.`);
            } catch (e) {
                console.error('[Recorder] requestData() failed on mobile:', e && e.message);
            }
        }

        if (elapsedMs > 25000 && !reported) {
            reported = true;
            console.error('[Recorder] Secondary camera is producing no data on this device.');

            updateStatus('danger', 'RECORDING NOT WORKING');
            showError(
                'This phone is not able to record video for proctoring. Your camera is on, but no ' +
                'footage is being saved. Please tell your instructor now, or try a different phone ' +
                'or browser — do not rely on this device for your exam.'
            );

            if (socket) {
                socket.emit('mobile_violation', {
                    token: token,
                    event_type: 'system_error',
                    event_message: `Secondary camera produced no data after ${Math.round(elapsedMs / 1000)}s ` +
                        `(state: ${mediaRecorder.state}, container: ${mediaRecorder.mimeType || 'unknown'}). ` +
                        `Device: ${navigator.userAgent}. There is likely no secondary footage for this attempt.`
                });
            }
        }
    }, 3000);
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
    // Peek rather than shift: the chunk stays in the queue until it is actually
    // delivered, so a failure cannot silently drop it.
    const task = uploadQueue[0];

    // Retry policy matches the desktop recorder. It was 3 attempts over roughly two
    // seconds, after which the chunk was discarded — and because these are
    // MediaRecorder timeslices, losing one corrupts the stream from that point on.
    // A brief mobile-data blip therefore truncated the rest of the recording.
    const MAX_ATTEMPTS = 60;
    let delivered = false;

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
            delivered = true;
        } else {
            throw new Error("HTTP " + res.status);
        }
    } catch (err) {
        task.attempts = (task.attempts || 0) + 1;
        console.warn(`[Upload Mobile] Chunk #${task.index} failed (attempt ${task.attempts}/${MAX_ATTEMPTS}):`, err.message);
    }

    if (delivered) {
        uploadQueue.shift();
    } else if (task.attempts >= MAX_ATTEMPTS) {
        console.error(`[Upload Mobile] Chunk #${task.index} discarded after ${MAX_ATTEMPTS} attempts.`);
        if (socket) {
            socket.emit('mobile_violation', {
                token: token,
                event_type: 'system_error',
                event_message: `Secondary camera chunk #${task.index} could not be uploaded after ${MAX_ATTEMPTS} attempts. The secondary recording will be incomplete from this point.`
            });
        }
        uploadQueue.shift();
    } else {
        // Exponential backoff capped at 15s — long enough to ride out a tunnel or a
        // lift, short enough to catch up afterwards.
        const delay = Math.min(task.attempts * 1500, 15000);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    isProcessingQueue = false;
    processUploadQueue();
}

async function stopRecordingSequence() {
    if (!isRecording) return;

    isRecording = false;
    if (recordIntervalId) {
        clearInterval(recordIntervalId);
        recordIntervalId = null;
    }
    if (mobileWatchdogInterval) {
        clearInterval(mobileWatchdogInterval);
        mobileWatchdogInterval = null;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try {
            mediaRecorder.stop();
        } catch (e) {}
    }

    recBadge.style.display = 'none';

    // Stop camera stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    // Show the upload state, then wait for it.
    //
    // This screen used to be written immediately and said the recording "has been
    // securely uploaded. You may close this page now" — while mediaRecorder.stop()
    // was still delivering its final chunk asynchronously and the queue was still
    // draining. It told the student it was safe to close at the one moment it was not.
    document.body.innerHTML = `
        <div id="mobile-finalize" style="width:100%; max-width:480px; text-align:center; padding:40px 20px; background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius-lg); margin-top:40px;">
            <div style="font-size:40px; margin-bottom:16px;">&#8593;</div>
            <h2 style="font-family: var(--font-sans); font-size:21px; color:var(--text-primary); margin-bottom:10px;">Finishing upload</h2>
            <p id="mobile-finalize-detail" style="color:var(--text-secondary); font-size:14px; line-height:1.6;">Keep this page open until it finishes.</p>
        </div>
    `;
    const detail = document.getElementById('mobile-finalize-detail');

    const started = Date.now();
    const BUDGET_MS = 120000;
    while ((uploadQueue.length > 0 || isProcessingQueue) && (Date.now() - started < BUDGET_MS)) {
        if (detail) {
            detail.innerText = `${uploadQueue.length} segment(s) remaining. Keep this page open.`;
        }
        await new Promise(r => setTimeout(r, 400));
    }

    const heading = document.querySelector('#mobile-finalize h2');
    if (uploadQueue.length === 0) {
        if (heading) {
            heading.innerText = 'Secondary camera complete';
            heading.style.color = 'var(--success)';
        }
        if (detail) detail.innerText = 'Your secondary camera recording was uploaded in full. You may close this page.';
        notifyUploadComplete();
    } else {
        if (heading) {
            heading.innerText = 'Upload did not finish';
            heading.style.color = 'var(--danger)';
        }
        if (detail) {
            detail.innerText = `${uploadQueue.length} segment(s) could not be sent. Tell your instructor the secondary camera upload did not complete.`;
        }
    }
}

// Warn before the page is closed while chunks are still outstanding. The browser
// kills in-flight uploads on unload, so this is the last chance to keep them.
window.addEventListener('beforeunload', (event) => {
    if (uploadQueue.length > 0 || isProcessingQueue) {
        event.preventDefault();
        event.returnValue = 'Your secondary camera recording is still uploading.';
    }
});

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

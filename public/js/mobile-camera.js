// Mobile Companion Script
let socket = null;
let localStream = null;
let mediaRecorder = null;
let chunkIndex = 0;
let isRecording = false;
let recordIntervalId = null;
let wakeLockSentinel = null;
// chunkIndex is a session-wide high-water mark that survives reloads, so it can
// start above zero. The watchdog needs to know whether *this* recorder run has
// produced anything, which is a different question.
let chunksProducedThisRun = 0;

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
// Set once the server (or a proxy in front of it) refuses a chunk for being too
// large, so the cause is reported one time instead of once per doomed chunk.
let uploadTooLargeReported = false;

// ---------------------------------------------------------------------------
// Chunk persistence
//
// The queue used to live only in the array above. A phone that lost signal piled
// chunks up in memory, and anything still unsent when the tab was reloaded,
// backgrounded and evicted, or killed by the OS was gone for good — while the
// desktop recorder had survived exactly that through IndexedDB from the start.
// Every chunk is now written to storage *before* it is queued, so losing the
// network — or the page — costs time rather than footage.
// ---------------------------------------------------------------------------
const MOBILE_DB_NAME = 'ProctorGuardMobileDB';
const MOBILE_STORE = 'mobile_chunks';
// Keyed on the session token so a reload recovers this attempt's chunks and
// never picks up a previous student's.
const RESUME_KEY = `pg_mobile_next_index_${token || 'unknown'}`;

let useMobileMemoryStorage = false;
const mobileMemoryChunks = {};
try {
    if (!window.indexedDB) useMobileMemoryStorage = true;
} catch (e) {
    useMobileMemoryStorage = true;
}

function openMobileDB() {
    if (useMobileMemoryStorage) return Promise.reject(new Error('IndexedDB unavailable'));
    return new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open(MOBILE_DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(MOBILE_STORE)) {
                    db.createObjectStore(MOBILE_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => {
                useMobileMemoryStorage = true;
                reject(e.target.error);
            };
        } catch (err) {
            useMobileMemoryStorage = true;
            reject(err);
        }
    });
}

// Returns true when the chunk is safely stored somewhere the caller can get it
// back from. Never throws: the caller still holds the bytes in memory and a
// storage failure must not stop the upload attempt.
async function saveMobileChunk(index, data) {
    const key = `${token}_${index}`;
    const record = { key, session_token: token, index, data };
    if (useMobileMemoryStorage) {
        mobileMemoryChunks[key] = record;
        return true;
    }
    try {
        const db = await openMobileDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MOBILE_STORE, 'readwrite');
            tx.objectStore(MOBILE_STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
        });
        return true;
    } catch (e) {
        // Quota is reached exactly when a slow connection has let chunks pile up,
        // which is precisely when losing them matters most. Keep them in memory
        // and route later reads there too, or the chunk becomes invisible.
        console.warn(`[DB Mobile] Could not persist chunk #${index}, holding in memory:`, e && e.message);
        useMobileMemoryStorage = true;
        try {
            mobileMemoryChunks[key] = record;
            return true;
        } catch (memErr) {
            return false;
        }
    }
}

async function readMobileChunk(index) {
    const key = `${token}_${index}`;
    if (useMobileMemoryStorage) return mobileMemoryChunks[key] || null;
    try {
        const db = await openMobileDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(MOBILE_STORE, 'readonly');
            const req = tx.objectStore(MOBILE_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        return mobileMemoryChunks[key] || null;
    }
}

async function deleteMobileChunk(index) {
    const key = `${token}_${index}`;
    if (useMobileMemoryStorage) {
        delete mobileMemoryChunks[key];
        return;
    }
    try {
        const db = await openMobileDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MOBILE_STORE, 'readwrite');
            tx.objectStore(MOBILE_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        delete mobileMemoryChunks[key];
    }
}

async function getPersistedMobileChunks() {
    if (useMobileMemoryStorage) {
        return Object.values(mobileMemoryChunks)
            .filter(c => c.session_token === token)
            .sort((a, b) => a.index - b.index);
    }
    try {
        const db = await openMobileDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(MOBILE_STORE, 'readonly');
            const req = tx.objectStore(MOBILE_STORE).getAll();
            req.onsuccess = () => resolve((req.result || [])
                .filter(c => c.session_token === token)
                .sort((a, b) => a.index - b.index));
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        return [];
    }
}

// The recorder restarts from index 0 on every page load. Without a high-water
// mark a reload mid-exam would re-emit #0, #1, #2… and overwrite the chunks
// already on the server, destroying the footage it had successfully saved.
// Assembly treats the post-reload run as a new segment, which is exactly what it
// is, so continuing the numbering is both safe and necessary.
function readResumeIndex() {
    try {
        const n = parseInt(localStorage.getItem(RESUME_KEY) || '0', 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
        return 0;
    }
}

function writeResumeIndex(nextIndex) {
    try { localStorage.setItem(RESUME_KEY, String(nextIndex)); } catch (e) {}
}

// Base64 chunks are large, and holding every one of a long backlog in memory as
// well as in storage is how a phone runs itself out of RAM. Past the first few,
// drop the in-memory copy and re-read it from storage at upload time.
const MOBILE_QUEUE_MEMORY_LIMIT = 6;
function trimMobileQueueMemory() {
    if (useMobileMemoryStorage) return; // memory is the only copy — nothing to drop
    for (let i = MOBILE_QUEUE_MEMORY_LIMIT; i < uploadQueue.length; i++) {
        if (uploadQueue[i] && uploadQueue[i].data) uploadQueue[i].data = null;
    }
}

// Chunks from earlier sessions would otherwise accumulate on a shared phone
// forever. Keys carry the token, so identifying them needs no data reads.
async function purgeForeignMobileChunks() {
    if (useMobileMemoryStorage || !token) return;
    try {
        const db = await openMobileDB();
        const keys = await new Promise((resolve, reject) => {
            const tx = db.transaction(MOBILE_STORE, 'readonly');
            const req = tx.objectStore(MOBILE_STORE).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        const foreign = keys.filter(k => typeof k === 'string' && k.indexOf(`${token}_`) !== 0);
        if (!foreign.length) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MOBILE_STORE, 'readwrite');
            const store = tx.objectStore(MOBILE_STORE);
            foreign.forEach(k => store.delete(k));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        console.log(`[DB Mobile] Cleared ${foreign.length} leftover chunk(s) from earlier sessions.`);
    } catch (e) { /* best effort — never block recording on housekeeping */ }
}

// Re-queue anything a previous load of this page recorded but never delivered.
let recoveryAttempted = false;
async function recoverPersistedChunks() {
    if (!token || recoveryAttempted) return;
    recoveryAttempted = true;
    await purgeForeignMobileChunks();
    let pending = [];
    try {
        pending = await getPersistedMobileChunks();
    } catch (e) {
        return;
    }
    if (!pending.length) return;

    const queued = new Set(uploadQueue.map(t => t.index));
    let recovered = 0;
    pending.forEach(rec => {
        if (queued.has(rec.index)) return;
        uploadQueue.push({ index: rec.index, data: rec.data, attempts: 0, recovered: true });
        recovered++;
    });
    if (!recovered) return;

    uploadQueue.sort((a, b) => a.index - b.index);
    trimMobileQueueMemory();
    console.log(`[Upload Mobile] Recovered ${recovered} chunk(s) left over from an earlier load — resuming upload.`);
    if (socket && socket.connected) {
        socket.emit('mobile_violation', {
            token: token,
            event_type: 'info',
            event_message: `Secondary camera page reloaded; ${recovered} previously recorded segment(s) recovered from device storage and re-queued.`
        });
    }
    processUploadQueue();
}

// Update status visual helper
// Both of these tolerate a missing element on purpose. The finalize screen replaces
// document.body, destroying these nodes, and the socket 'disconnect' handler calls
// updateStatus — so a network drop during upload used to throw on every reconnect
// attempt, in precisely the situation the upload queue is trying to survive.
function updateStatus(state, message) {
    if (stateText) stateText.innerText = message;
    if (stateDot) {
        stateDot.style.background = `var(--${state})`;
        stateDot.style.boxShadow = `0 0 10px var(--${state})`;
    }
}

function showError(msg) {
    if (!setupError) {
        console.error('[Mobile]', msg);
        return;
    }
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
            // Anything an earlier load of this page recorded but never managed to send
            // is still on the device. Send it now, before this run adds more.
            recoverPersistedChunks();
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
    // Resume the numbering rather than restarting it, so a reload mid-exam cannot
    // overwrite chunks the server already holds.
    chunkIndex = readResumeIndex();
    chunksProducedThisRun = 0;
    if (chunkIndex > 0) {
        console.log(`[Recorder] Resuming secondary camera numbering at chunk #${chunkIndex}.`);
    }

    try {
        const mimeType = pickMobileMimeType();
        console.log(`[Recorder] Mobile recorder using: ${mimeType || 'browser default'}`);
        // Without an explicit bitrate the handset picks its own, and modern phones
        // choose 2-4 Mbps for 720p. Five-second timeslices then base64-encode to
        // several megabytes and are rejected with a 413 by any reverse proxy left on
        // nginx's default 1m body limit — invisibly, because the refusal happens
        // before Node logs anything, so the phone just retries the same bytes into
        // the same wall. The secondary view only has to show the room and the
        // student's hands, so a modest bitrate costs nothing that matters here.
        const recorderOptions = {
            videoBitsPerSecond: 600000,
            audioBitsPerSecond: 64000
        };
        if (mimeType) recorderOptions.mimeType = mimeType;
        try {
            mediaRecorder = new MediaRecorder(localStream, recorderOptions);
        } catch (optErr) {
            console.warn('[Recorder] Bitrate hints refused, using browser defaults:', optErr.message);
            mediaRecorder = mimeType
                ? new MediaRecorder(localStream, { mimeType })
                : new MediaRecorder(localStream);
        }

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
                chunksProducedThisRun++;
                writeResumeIndex(chunkIndex);
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64data = reader.result;
                    // Persist before queueing. If this page dies between now and a
                    // successful upload — signal loss then an OS tab eviction is the
                    // usual way — the next load recovers this chunk instead of the
                    // footage simply ending here.
                    await saveMobileChunk(thisIndex, base64data);
                    uploadQueue.push({ index: thisIndex, data: base64data, attempts: 0 });
                    trimMobileQueueMemory();
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
        if (chunksProducedThisRun > 0) {
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

    // The in-memory copy is trimmed once a backlog builds, so storage is the source
    // of truth from here on.
    if (!task.data) {
        const record = await readMobileChunk(task.index);
        if (record && record.data) task.data = record.data;
    }
    if (!task.data) {
        console.error(`[Upload Mobile] Chunk #${task.index} is missing from device storage — the secondary recording will have a gap here.`);
        if (socket) {
            socket.emit('mobile_violation', {
                token: token,
                event_type: 'system_error',
                event_message: `Secondary camera chunk #${task.index} was lost from device storage before it could be uploaded. The secondary recording will skip this point.`
            });
        }
        uploadQueue.shift();
        isProcessingQueue = false;
        processUploadQueue();
        return;
    }

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
        } else if (res.status === 413) {
            // A 413 is usually the reverse proxy, not Node — it refuses the body before
            // the request is ever logged server-side, which is why chunks could vanish
            // with no matching error line. Retrying sends identical bytes into an
            // identical refusal, so name the real cause once and stop.
            const kb = Math.round((task.data || '').length / 1024);
            console.error(`[Upload Mobile] Chunk #${task.index} (${kb}KB encoded) rejected as too large. Raise client_max_body_size on the reverse proxy.`);
            if (!uploadTooLargeReported) {
                uploadTooLargeReported = true;
                if (socket) {
                    socket.emit('mobile_violation', {
                        token: token,
                        event_type: 'system_error',
                        event_message: `Secondary camera upload rejected as too large (chunk #${task.index}, ${kb}KB encoded). The server's upload size limit is smaller than the recording's chunks, so no secondary footage can be saved until it is raised.`
                    });
                }
            }
            task.discard = true;
        } else {
            throw new Error("HTTP " + res.status);
        }
    } catch (err) {
        task.attempts = (task.attempts || 0) + 1;
        console.warn(`[Upload Mobile] Chunk #${task.index} failed (attempt ${task.attempts}/${MAX_ATTEMPTS}):`, err.message);
    }

    if (delivered) {
        await deleteMobileChunk(task.index);
        uploadQueue.shift();
    } else if (task.discard) {
        // Already reported with its actual cause. It will never be accepted at this
        // size, so free the storage too rather than leaving it to be retried forever.
        await deleteMobileChunk(task.index);
        uploadQueue.shift();
    } else if (task.attempts >= MAX_ATTEMPTS) {
        // Out of the live queue, but deliberately left in device storage. If the
        // network was down for the whole retry window, reopening this page recovers
        // and re-sends it — so a long outage delays the footage rather than losing it.
        console.error(`[Upload Mobile] Chunk #${task.index} undelivered after ${MAX_ATTEMPTS} attempts — retained in device storage for recovery.`);
        if (socket) {
            socket.emit('mobile_violation', {
                token: token,
                event_type: 'system_error',
                event_message: `Secondary camera chunk #${task.index} could not be uploaded after ${MAX_ATTEMPTS} attempts (likely a network outage). It is still stored on the phone — reopening the secondary camera link on that device will finish sending it.`
            });
        }
        uploadQueue.shift();
    } else if (task.attempts % 3 === 0 && uploadQueue.length > 1) {
        // Rotate a persistently failing chunk to the back instead of letting it block
        // everything behind it.
        //
        // The queue was strictly FIFO, so one chunk the server kept rejecting stalled
        // every later chunk — which is how a single bad upload turns into "14 segments
        // could not be sent" even when thirteen of them would have gone through fine.
        // Out-of-order delivery is safe: the server writes each chunk to a filename
        // derived from its index, and assembly sorts numerically and handles gaps.
        console.warn(`[Upload Mobile] Chunk #${task.index} still failing after ${task.attempts} attempts — moving it behind the others.`);
        uploadQueue.push(uploadQueue.shift());
        await new Promise(resolve => setTimeout(resolve, 1000));
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
        try { localStorage.removeItem(RESUME_KEY); } catch (e) {}
        notifyUploadComplete();
    } else {
        if (heading) {
            heading.innerText = 'Upload still finishing';
            heading.style.color = 'var(--warning)';
        }
        if (detail) {
            // The footage is on the device, not lost, so the instruction that actually
            // helps is "keep this page reachable" rather than "tell your instructor it
            // failed" — reopening this link resumes the upload from storage.
            detail.innerText = `${uploadQueue.length} segment(s) have not been sent yet — they are saved on this phone, not lost. ` +
                `Reconnect to Wi-Fi and leave this page open, or open the same camera link again, and they will finish uploading. ` +
                `Let your instructor know if this message does not clear.`;
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

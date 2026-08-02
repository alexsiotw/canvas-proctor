# Root cause: reverse-proxy 413 destroyed camera-only recordings

Found 2026-08-02. One cause, three symptoms that had been investigated separately.

## Evidence

An iPad attempt logged, in order:

```
[0:18]  ERROR             Upload of chunk #1 was rejected as too large (1205KB).
[15:00] UPLOAD INCOMPLETE Recording upload did not finish: 165 chunk(s) still pending after 60s.
[16:02] ERROR             No recording chunks were found on the server for this attempt.
```

**1205KB encoded vs nginx's default `client_max_body_size` of 1m (1024KB).**

Express is set to `50mb` ([server.js:242](../server.js#L242)), so the refusal happened
*upstream of Node*. That is why no server-side error line ever appeared for these
uploads — the request never reached the application.

## Why only some devices

`setupRecording()` used `videoBitsPerSecond: 1500000` on every path.

- **Desktop composite** records a mostly-static screen canvas. The encoder undershoots
  that target badly, so chunks land at a few hundred KB and always fit.
- **Camera-only** (iOS always; Android without screen share) records a 720p full-motion
  camera and genuinely *reaches* 1.5 Mbps. A 5-second slice is ~993KB raw, which
  base64-encodes to ~1.3MB — over the limit on **every single chunk**.
- **`mobile-camera.js` set no bitrate at all**, so handsets chose their own 2–4 Mbps.
  Worse again.

So the bug was invisible on desktop and total on tablets and phones.

## This also explains the sessions 111/112/113 mobile-chunk gaps

Those chunks vanished with **no matching server error** because nginx rejected them
before Node could log anything. The chunks that arrived were low-motion (small) slices;
the missing ones (#1, #8) were high-motion (large) ones. The earlier queue-rotation fix
appeared to help, but the rotated chunks were already doomed — retrying a 413 re-sends
identical bytes into an identical refusal.

The working hypothesis at the time was flaky mobile wifi. It was not.

## Fixes applied (client side)

- **`public/js/student.js`** — bitrate is now keyed on whether the recording actually
  contains a screen: 1.5 Mbps / 128k with, 800k / 96k without. Camera chunks now encode
  to roughly 750KB, inside even the 1m default.
- **`public/js/mobile-camera.js`** — explicit 600k / 64k, with a fallback if the handset
  refuses the bitrate hints.
- **Both** — a 413 is now treated as deterministic: reported once with its real cause,
  then the chunk is dropped rather than burning 100 (desktop) or 60 (mobile) identical
  retries. Those wasted retries are what let the backlog reach 165 pending.

## Required server-side change — the actual unblocker

The client caps only add margin. Raise the limit on the proxy:

```bash
sudo nginx -T 2>/dev/null | grep -i client_max_body_size
```

No output means the default 1m is in force. To fix (inherited by every server block, and
reversible by deleting the one file):

```bash
echo 'client_max_body_size 64M;' | sudo tee /etc/nginx/conf.d/upload-size.conf
sudo nginx -t && sudo systemctl reload nginx
```

If the grep shows a *smaller* value set inside a `server` or `location` block, that one
wins over the `http`-level setting and must be edited directly.

## Follow-up hardening (second pass)

Fixing the 413 closed one hole. These close the class of problem it belonged to —
recordings failing without anyone finding out, and network loss costing footage.

### 1. Boot-time upload probe — `services/uploadPathHealth.js`

On startup the server POSTs a 2MB payload to **its own public origin**, so the request
traverses the reverse proxy. A 413 is reported as a loud startup banner and surfaced on
the instructor dashboard.

It deliberately refuses to probe `localhost` / `127.0.0.1` / `::1` and reports
"not verified" instead: a pass that bypassed the proxy would be worse than no check at
all. Missing `BASE_URL`, an unparseable one, or an unreachable origin are likewise
reported as *undetermined* (`ok: null`) rather than as failures, so the dashboard banner
only appears for a confirmed break.

Verified with 19 unit assertions plus an end-to-end run against two real servers: a
50mb limit passes, a 1mb limit (nginx's exact default) is correctly reported as broken
with the fix named in the message.

### 2. The phone now survives losing the network — `public/js/mobile-camera.js`

The secondary camera's queue lived only in a memory array, so anything unsent when the
tab was reloaded, evicted or killed was gone. The desktop recorder had survived this via
IndexedDB from the start; the phone now does too.

- Every chunk is written to IndexedDB **before** it is queued, with a memory fallback if
  storage is unavailable or full.
- On load, undelivered chunks from a previous load are recovered and re-queued.
- `chunkIndex` resumes from a `localStorage` high-water mark. Without this a reload would
  restart at #0 and overwrite chunks already on the server — assembly treats the
  post-reload run as a new segment, which is exactly what it is.
- Chunks that exhaust their 60 retries are removed from the live queue but **kept on the
  device**, so reopening the camera link finishes sending them. A long outage now delays
  footage instead of destroying it.
- Past the first six queued chunks the in-memory copy is dropped and re-read from storage
  at upload time, so a backlog cannot exhaust the phone's RAM.
- Chunks from earlier sessions are purged by key prefix (no data reads).
- `updateStatus` / `showError` tolerate a missing element. The finalize screen replaces
  `document.body`, and the socket `disconnect` handler calls `updateStatus` — so a network
  drop during upload used to throw on every reconnect, in exactly the situation the queue
  is trying to survive.
- The "upload did not finish" screen now says the footage is saved on the phone and
  explains how to finish sending it, instead of telling the student it failed.

Verified in a real browser against the actual file: 16 assertions on the storage
primitives, 7 on recovery across a genuine page reload (5 undelivered chunks survived,
were re-queued in order, and numbering resumed at #5 rather than overwriting), and 7 on
the failure paths — a 413 drains in ~53ms with one attempt per chunk while a 500 is
correctly retried and retained.

### Known limitation

If a phone is offline long enough that the desktop finalizes and assembles the video
first, chunks recovered afterwards arrive too late to be included. The footage is on the
device and reaches the server, but that session's assembled video won't contain it. A
server-side re-assembly sweep for sessions that gain chunks after finalizing would close
this; it is not built.

## Not recoverable

The affected attempt's footage is gone. The chunks were refused before reaching the
server and the client discarded them from IndexedDB after exhausting retries. There is
nothing on disk to reassemble.

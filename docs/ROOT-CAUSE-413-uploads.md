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

## Not recoverable

The affected attempt's footage is gone. The chunks were refused before reaching the
server and the client discarded them from IndexedDB after exhausting retries. There is
nothing on disk to reassemble.

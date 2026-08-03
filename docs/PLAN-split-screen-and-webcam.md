# Plan: record screen and webcam as separate videos

Requested 2026-08-03. Not yet implemented — this is the build spec.

Today one recorder captures a composited canvas (screen + webcam inset) as a single
video. The goal is three independent recordings per attempt:

1. **Screen** — display capture plus any system/tab audio
2. **Webcam** — camera plus microphone
3. **Secondary phone camera** — already exists, unchanged

## Why this is worth doing beyond the request

- **Failure isolation.** Everything currently funnels through
  `createCompositeTrack()`. If the canvas composite fails, *both* views are lost —
  and there is already a comment in `student.js` noting composites "are flaky on some
  mobile Chromium builds and can produce zero playable video." Separate recorders mean
  a screen-capture failure still leaves the webcam.
- **Lower CPU on the student's machine.** A 1600x720 canvas drawn in JS at up to 15fps
  and then encoded is more expensive than two directly-encoded streams, both of which
  can use hardware encoding.

## Cost

Upload volume rises roughly 40%: screen stays at 1.5 Mbps (screen text legibility),
webcam adds ~600 kbps. Acceptable now that `client_max_body_size` is 64M and the
retry/persistence work is in, but it is more data per exam.

## The architecture already has the template

The phone's secondary camera is a complete second pipeline. Mirror it, do not invent:

| Concern | Main | Mobile | New webcam |
| --- | --- | --- | --- |
| chunk dir | `chunks-<id>/` | `chunks-mobile-<id>/` | `chunks-<id>-webcam/` |
| mime column | `mime_type` | `mobile_mime_type` | `webcam_mime_type` |
| Drive column | `drive_file_id` | `mobile_drive_file_id` | `webcam_drive_file_id` |

## Step 1 — extract the per-stream assembly first

`assembleAndUploadSessionVideo` (`server.js:2278`, ~470 lines) contains the segment
pipeline twice: the main stream around `server.js:2395-2610` and a condensed copy for
mobile at `server.js:2613-2740`. **Do not add a third copy.** Extract into
`services/videoAssembly.js`, which already holds the primitives
(`readOrderedChunks`, `groupChunksIntoSegments`, `extractInitSegment`,
`writeSegmentFile`, `transcodeSegmentToMp4`, `concatMp4Segments`):

```js
// Returns null when the directory holds nothing decodable.
async function assembleStreamToFile({
    chunkDir,          // absolute path
    outputBasePath,    // e.g. os.tmpdir()/session-123-webcam
    declaredMimeType,  // from the per-stream mime column
    label,             // 'Screen' | 'Webcam' | 'Mobile' — log prefix only
    forceTranscode     // honour TRANSCODE_TO_MP4 as today
}) // -> { path, mimeType, ext, durationSec, diagnostics: [{level, message}] }
```

Return diagnostics rather than calling `logSessionEvent` inside, so the caller owns
DB writes and the function stays unit-testable. Migrate main and mobile to it in the
same commit — the win is three call sites and one implementation.

Verify with the existing approach: build real WebM fixtures, drop chunk #1 and a
middle chunk, assert the output duration and frame count match the no-gap case minus
the dropped span. The earlier Case B regression (everything after a gap discarded) was
caught exactly this way.

## Step 2 — schema

`db.js`, alongside the existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` lines:

```sql
ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS webcam_drive_file_id VARCHAR(255);
ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS webcam_mime_type VARCHAR(255);
```

**`db.js` and `server.js` must ship in the same commit.** Shipping `server.js`
alone while it queried `es.mobile_mime_type` made every assembly fail with `column
does not exist`. That is the single most expensive mistake made on this project.

## Step 3 — server

- `/api/session/upload-chunk` (`server.js:3080`): accept `stream` (`'main'` |
  `'webcam'`, default `'main'`). Suffix the chunk dir. Reject anything else rather
  than string-concatenating client input into a path.
- `/api/session/:id/format`: accept `stream`, write to the matching mime column.
- Assembly: third `assembleStreamToFile` call; add `webcam_drive_file_id` and
  `webcam_mime_type` to the final `UPDATE` at `server.js:2743`.
- Extend the boot probe's sibling checks if a zero-chunk webcam stream should alert.

## Step 4 — client (`public/js/student.js`)

- Stop calling `createCompositeTrack()` for the recorded output. Keep the function:
  the mobile fallback path still uses it, and the live proctor thumbnail may too.
- Main recorder: screen video + screen audio, staying at 1.5 Mbps.
- New recorder: camera + mic at 800k/96k — the values already chosen for the
  camera-only path, which land ~750KB per 5s chunk.
- Upload queue items carry `stream`. IndexedDB keys become
  `${sessionId}_${stream}_${index}` — without the stream in the key the two recorders'
  index sequences collide and overwrite each other.
- Two `chunkIndex` counters. `startChunkProductionWatchdog` and
  `startMediaIntegrityMonitor` should treat a dead webcam recorder as a media loss
  even while the screen recorder is healthy.
- iOS/iPad has no screen capture at all, so there the webcam recorder is the only one.
  Do not let a missing screen stream block recording.

## Step 5 — report UI

`public/js/app.js` and `extension/review-center.js`: a third player. Sessions
recorded before this change have `webcam_drive_file_id = NULL` and must render exactly
as they do today — one video, no empty second player. No migration or backfill.

The flag strip currently seeks one `<video>`; decide whether it drives the screen
recording only (simplest, probably right) or both in sync.

## Ordering

1. Step 1 alone, with its tests — behaviour-neutral, independently shippable
2. Steps 2+3 together in one commit
3. Step 4
4. Step 5 in the same push as Step 4, so instructors never have two recordings with a
   UI that shows one

Stage explicit paths. `git add -A` is what swept unfinished LTI enforcement into a
deploy and took the tool offline.

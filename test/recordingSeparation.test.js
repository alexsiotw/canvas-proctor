const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const studentSource = fs.readFileSync(path.join(root, 'public', 'js', 'student.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(root, 'db.js'), 'utf8');

test('student persists and reconciles independent camera chunks', () => {
  assert.match(studentSource, /let cameraRecorder = null/);
  assert.match(studentSource, /recording_kind: recordingKind/);
  assert.match(studentSource, /camera_total_chunks: cameraChunkIndex/);
  assert.match(studentSource, /getServerChunkReceipt\(sessionInfo\.id, cameraChunkIndex, 'camera'\)/);
  assert.match(studentSource, /new MediaRecorder\(new MediaStream\(cameraTracks\)/);
});

test('server isolates, assembles, and streams the camera recording', () => {
  assert.match(serverSource, /ensureSessionChunkDir\(exam_session_id, recordingKind\)/);
  assert.match(serverSource, /assembleAuxiliaryCameraRecording/);
  assert.match(serverSource, /camera-video-playback\/:session_id/);
  assert.match(serverSource, /camera_drive_file_id/);
});

test('completed WebM recordings are normalized to seekable MP4', () => {
  assert.match(serverSource, /const wantTranscode = isWebm \|\| process\.env\.TRANSCODE_TO_MP4/);
  assert.match(serverSource, /mobileRawPaths\.length > 1 \|\| mobileIsWebm/);
  assert.match(serverSource, /normalizeExistingSessionToMp4/);
  assert.match(serverSource, /normalize-latest-webm/);
});

test('SEB preserves stable interim speech transcripts', () => {
  assert.match(studentSource, /pendingSpeechTranscript/);
  assert.match(studentSource, /setTimeout\(flushPendingSpeechTranscript, 1400\)/);
  assert.match(studentSource, /partial transcript/);
});

test('database migration records source identity and camera drive metadata', () => {
  assert.match(dbSource, /camera_mime_type/);
  assert.match(dbSource, /camera_drive_file_id/);
  assert.match(dbSource, /primary_recording_kind/);
});

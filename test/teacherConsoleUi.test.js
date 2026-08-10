const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('attempt status is initialized before the approval label is derived', () => {
  const statusDeclaration = appSource.indexOf("const statusLabel = s.status === 'completed'");
  const displayDeclaration = appSource.indexOf('const displayStatusLabel = s.resume_approval_required');
  assert.ok(statusDeclaration >= 0);
  assert.ok(displayDeclaration > statusDeclaration);
});

test('teacher workspace separates live monitoring from attempts', () => {
  assert.match(appSource, /id="workspace-tab-live"/);
  assert.match(appSource, /id="workspace-tab-attempts"/);
  assert.match(appSource, /id="workspace-live-panel"/);
  assert.match(appSource, /id="workspace-attempts-panel"/);
  assert.match(appSource, /function setWorkspaceView\(view\)/);
});

test('opening an exam workspace resets the preserved page scroll position', () => {
  assert.doesNotMatch(appSource, /report-content'\);\s*if \(reports\) reports\.scrollIntoView/);
  assert.match(appSource, /function scrollWorkspaceToTop\(\)/);
  assert.match(appSource, /window\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)/);
  assert.match(appSource, /id="workspace-heading" tabindex="-1"/);
});

test('attempt review keeps events bounded underneath the recording', () => {
  assert.match(appSource, /class="pg-review-event-row/);
  assert.match(appSource, /class="pg-review-summary"/);
  assert.match(appSource, /id="report-flag-duration"/);
  assert.match(appSource, /class="pg-review-playhead"/);
  assert.match(cssSource, /\.pg-review-event-list[\s\S]*overflow-y: auto/);
  assert.match(cssSource, /\.pg-report-body[\s\S]*overflow: hidden/);
  assert.match(cssSource, /grid-template-rows: minmax\(330px, 3fr\) minmax\(190px, 2fr\)/);
  assert.match(cssSource, /\.pg-review-event-row\.is-selected/);
  assert.match(appSource, /activeLogFilterSeverity = 'all'/);
  assert.match(appSource, /effectiveReportDuration/);
  assert.match(appSource, /modalOverlay\.addEventListener\('wheel',[\s\S]*capture: true/);
  assert.match(appSource, /event\.deltaMode === WheelEvent\.DOM_DELTA_LINE/);
  assert.match(appSource, /removeEventListener\('wheel', window\.activeReviewWheelHandler, true\)/);
});

test('reviewer uses synchronized camera and screen panes with a bounded investigation rail', () => {
  assert.match(appSource, /pg-review-workstation/);
  assert.match(appSource, /pg-review-split-stage/);
  assert.match(appSource, /pg-review-camera-column/);
  assert.match(appSource, /is-legacy-camera-crop/);
  assert.match(appSource, /is-legacy-screen-crop/);
  assert.match(appSource, /activeReviewCropObserver/);
  assert.match(appSource, /camera-video-playback/);
  assert.match(appSource, /primary_recording_kind/);
  assert.match(appSource, /getReviewEventPriority/);
  assert.match(appSource, /priority-\$\{priority\}/);
  assert.match(appSource, /id="tab-evidence-btn"/);
  assert.match(appSource, /id="report-evidence-container"/);
  assert.match(cssSource, /\.pg-review-split-stage/);
  assert.match(cssSource, /aspect-ratio: 16 \/ 9/);
  assert.match(cssSource, /aspect-ratio: 4 \/ 3/);
  assert.match(cssSource, /\.pg-review-priority-badge/);
  assert.match(cssSource, /overflow-y: scroll !important/);
  assert.match(cssSource, /body\.pg-review-lock/);
});

test('attention filter retains approval and interruption states', () => {
  assert.match(appSource, /liveViewFilter === 'attention'/);
  assert.match(appSource, /'approval_required', 'unexpected', 'interrupted'/);
  assert.doesNotMatch(appSource, /liveViewFilter === 'flagged'/);
});

test('live cards expose explicit textual status instead of a color-only dot', () => {
  assert.match(appSource, /Awaiting approval/);
  assert.match(appSource, /pg-live-status-/);
  assert.match(cssSource, /\.pg-live-status-attention/);
});

test('settings modal keeps actions visible and cards keyboard accessible', () => {
  assert.match(appSource, /class="pg-settings-footer"/);
  assert.match(appSource, /function enhanceSettingsAccessibility\(root\)/);
  assert.match(appSource, /card\.addEventListener\('keydown'/);
  assert.match(cssSource, /\.pg-settings-modal/);
  assert.match(cssSource, /\.proctorio-card:focus-visible/);
});

test('teacher asset versions invalidate cached pre-facelift files', () => {
  assert.match(indexSource, /styles\.css\?v=4\.7\.1/);
  assert.match(indexSource, /app\.js\?v=4\.7\.1/);
});

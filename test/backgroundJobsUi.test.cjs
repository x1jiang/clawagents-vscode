const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("background jobs can be stopped and finished rows can be dismissed", () => {
  const jobs = section(app, "const BackgroundJobs = memo", "type TranscriptItemProps");
  assert.match(jobs, /Stopping…/);
  assert.match(jobs, /JOB_STOP_RETRY_MS/);
  assert.match(jobs, /force-killed if it ignores the stop signal/);
  assert.match(jobs, /onDismissFinished/);
  assert.match(jobs, />\s*Clear finished\s*</);
  assert.match(jobs, />\s*Dismiss\s*</);

  const stopHandler = section(provider, 'case "stop_job":', 'case "report_job":');
  assert.match(stopHandler, /if \(!res\.ok\)/);
  assert.match(stopHandler, /if \(res\.job\?\.running\)/);
  assert.match(stopHandler, /Background job stopped/);
});

test("dismissed job ids survive a webview reload without replacing other state", () => {
  assert.match(app, /const DISMISSED_JOB_IDS_STATE_KEY = "dismissedBackgroundJobIds"/);
  assert.match(app, /persistedDismissedJobIds/);
  assert.match(app, /\.\.\.\(previous && typeof previous === "object" \? previous : \{\}\)/);
  assert.match(app, /\[DISMISSED_JOB_IDS_STATE_KEY\]: \[\.\.\.dismissedJobIds\]/);
  assert.match(app, /jobs\.filter\(\(job\) => !dismissedJobIds\.has\(job\.job_id\)\)/);
});

test("job logs refresh while open and remain manually controllable", () => {
  const jobs = section(app, "const BackgroundJobs = memo", "type TranscriptItemProps");
  assert.match(jobs, /JOB_DETAIL_REFRESH_MS/);
  assert.match(jobs, /window\.setInterval/);
  assert.match(jobs, />\s*Refresh\s*</);
  assert.match(jobs, />\s*Copy\s*</);
  assert.match(jobs, /aria-label="Close logs"/);
  assert.match(jobs, /jobs-log-label">stdout/);
  assert.match(jobs, /jobs-log-label">stderr/);
  assert.match(styles, /\.jobs-detail-meta/);
  assert.match(styles, /\.jobs-log-stream/);
  assert.match(styles, /@media \(max-width: 440px\)[\s\S]*\.jobs-row-actions[\s\S]*width:\s*100%/);
});

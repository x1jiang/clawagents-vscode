const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const { text } = buildSync({
  entryPoints: [path.join(__dirname, "../src/humanTiming.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
}).outputFiles[0];
const timingModule = { exports: {} };
new Function("module", "exports", text)(timingModule, timingModule.exports);
const { HumanTiming, defaultHumanTimingPolicy } = timingModule.exports;

test("clips each idle gap while counting continued input and file browsing", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("chat-a", "input");
  now = 50_000;
  timer.pulse("chat-a", "input");
  now = 400_000;
  timer.pulse("chat-a", "file");
  now += 170_000;
  timer.pulse("chat-a", "file");
  now += 250_000;
  assert.deepEqual(timer.snapshot("chat-a"), { inputMs: 170_000, fileMs: 350_000, readingMs: 0 });
  assert.equal(timer.checkpoint().active, false);
});

test("switching sources or chats counts each instant once and saves only elapsed time", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("chat-a", "input");
  now = 20_000;
  timer.pulse("chat-a", "file");
  now = 30_000;
  timer.pulse("chat-b", "input");
  now = 35_000;
  const { state } = timer.checkpoint();
  now = 900_000;
  const restored = new HumanTiming(state, defaultHumanTimingPolicy, () => now);
  assert.deepEqual(restored.snapshot("chat-a"), { inputMs: 20_000, fileMs: 10_000, readingMs: 0 });
  assert.deepEqual(restored.snapshot("chat-b"), { inputMs: 5_000, fileMs: 0, readingMs: 0 });
});

test("allows replacement policies and uses the selected chat for shared files", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, {
    ...defaultHumanTimingPolicy,
    idleLimitMs: () => 10,
  }, () => now);
  timer.rememberFile("chat-a", "/report.md");
  assert.equal(timer.fileOwner("/report.md", "chat-b"), "chat-a");
  timer.rememberFile("chat-b", "/report.md");
  assert.equal(timer.fileOwner("/report.md"), undefined);
  assert.equal(timer.fileOwner("/report.md", "chat-b"), "chat-b");
  timer.pulse("chat-b", "file");
  now = 100;
  assert.equal(timer.snapshot("chat-b").fileMs, 10);
  timer.forgetChat("chat-b");
  assert.equal(timer.fileOwner("/report.md"), "chat-a");
  assert.equal(timer.snapshot("chat-b").fileMs, 0);
});

test("attributes preparation before the first send once the conversation exists", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("", "input");
  now = 5000;
  assert.deepEqual(timer.checkpoint().state.totals, []);
  timer.addInput("chat-new", timer.takeUnassignedInput());
  assert.equal(timer.snapshot("chat-new").inputMs, 5000);
  assert.equal(timer.takeUnassignedInput(), 0);
});

test("resuming the same file within one minute fills only time not already counted", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.resumeFile("chat-a", "/report.md");
  now = 60_000;
  timer.suspendFile("/report.md");
  now = 70_000;
  timer.pulse("chat-b", "input");
  now = 90_000;
  timer.checkpoint(); // The covered time can already have been saved.
  now = 100_000;
  timer.stop("input");
  now = 120_000;
  timer.resumeFile("chat-a", "/report.md");
  assert.deepEqual(timer.snapshot("chat-a"), { inputMs: 0, fileMs: 90_000, readingMs: 0 });
  assert.deepEqual(timer.snapshot("chat-b"), { inputMs: 30_000, fileMs: 0, readingMs: 0 });
});

test("a pause is only filled for the same file and owner within grace and idle limits", () => {
  for (const [chat, file, pauseAt, resumeAt] of [
    ["chat-a", "/report.md", 60_000, 120_001],
    ["chat-a", "/report.md", 170_000, 181_000],
    ["chat-a", "/other.md", 60_000, 90_000],
    ["chat-b", "/report.md", 60_000, 90_000],
  ]) {
    let now = 0;
    const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
    timer.resumeFile("chat-a", "/report.md");
    now = pauseAt;
    timer.suspendFile("/report.md");
    now = resumeAt;
    timer.resumeFile(chat, file);
    assert.equal(timer.snapshot("chat-a").fileMs, pauseAt);
    assert.equal(timer.snapshot("chat-b").fileMs, 0);
  }
});

test("resuming a draft and a file can fill intersecting gaps without double credit", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("chat-a", "input");
  now = 40_000;
  timer.suspendInput();
  now = 50_000;
  timer.resumeFile("chat-a", "/report.md");
  now = 70_000;
  timer.suspendFile("/report.md");
  now = 80_000;
  timer.pulse("chat-a", "input");
  now = 90_000;
  timer.suspendInput();
  now = 100_000;
  timer.resumeFile("chat-a", "/report.md");
  now = 110_000;
  timer.suspendFile("/report.md");
  timer.pulse("chat-a", "input");
  assert.deepEqual(timer.snapshot("chat-a"), { inputMs: 70_000, fileMs: 40_000, readingMs: 0 });
});

test("a sent or cleared draft, a different chat, and an expired pause do not fill a draft gap", () => {
  for (const [chatId, resumeAt, ended] of [
    ["chat-a", 100_001, false],
    ["chat-b", 65_000, false],
    ["chat-a", 65_000, true],
  ]) {
    let now = 0;
    const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
    timer.pulse("chat-a", "input");
    now = 40_000;
    timer.suspendInput();
    now = resumeAt;
    if (ended) timer.stop("input");
    timer.pulse(chatId, "input");
    assert.equal(timer.snapshot("chat-a").inputMs, 40_000);
    assert.equal(timer.snapshot("chat-b").inputMs, 0);
  }
});

test("thread reading clips at 90 seconds and new signals restart the reading window", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("a", "reading");
  now = 200_000;
  assert.equal(timer.snapshot("a").readingMs, 90_000);
  timer.pulse("a", "reading");
  now = 260_000;
  timer.pulse("a", "reading");
  now = 400_000;
  assert.equal(timer.snapshot("a").readingMs, 240_000);
});

test("reading, input, and file resume gaps share a single credited interval union", () => {
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("a", "reading");
  now = 10_000;
  timer.suspendReading();
  now = 20_000;
  timer.pulse("a", "input");
  now = 30_000;
  timer.suspendInput();
  now = 40_000;
  timer.resumeFile("b", "/file");
  now = 50_000;
  timer.suspendFile("/file");
  now = 60_000;
  timer.pulse("a", "reading");
  now = 70_000;
  timer.suspendReading();
  timer.pulse("a", "input");
  now = 80_000;
  timer.suspendInput();
  timer.resumeFile("b", "/file");
  now = 90_000;
  timer.suspendFile("/file");
  timer.pulse("a", "reading");
  assert.deepEqual(timer.snapshot("a"), { inputMs: 20_000, fileMs: 0, readingMs: 50_000 });
  assert.deepEqual(timer.snapshot("b"), { inputMs: 0, fileMs: 20_000, readingMs: 0 });
});

test("reading resumes only the same thread within both grace and the previous idle deadline", () => {
  for (const [resumeAt, chat, expected] of [
    [70_000, "a", 70_000], // Inclusive 60-second grace boundary.
    [70_001, "a", 10_000],
    [50_000, "b", 10_000],
  ]) {
    let now = 0;
    const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
    timer.pulse("a", "reading");
    now = 10_000;
    timer.suspendReading();
    now = resumeAt;
    timer.pulse(chat, "reading");
    assert.equal(timer.snapshot("a").readingMs, expected);
  }
  let now = 0;
  const timer = new HumanTiming(undefined, defaultHumanTimingPolicy, () => now);
  timer.pulse("a", "reading");
  now = 80_000;
  timer.suspendReading();
  now = 95_000;
  timer.pulse("a", "reading");
  assert.equal(timer.snapshot("a").readingMs, 80_000);
});

test("legacy totals load with zero reading; checkpoints never restore live or paused sessions", () => {
  let now = 0;
  const timer = new HumanTiming({ totals: [["a", { inputMs: 12, fileMs: 34 }]], files: [] },
    defaultHumanTimingPolicy, () => now);
  assert.deepEqual(timer.snapshot("a"), { inputMs: 12, fileMs: 34, readingMs: 0 });
  timer.pulse("a", "reading");
  now = 1000;
  timer.suspendReading();
  const saved = timer.checkpoint().state;
  now = 2000;
  const restored = new HumanTiming(saved, defaultHumanTimingPolicy, () => now);
  restored.pulse("a", "reading");
  assert.equal(restored.snapshot("a").readingMs, 1000);
  restored.stop();
  now = 3000;
  restored.pulse("a", "reading");
  assert.equal(restored.snapshot("a").readingMs, 1000);
});

test("background scrolling and returning from file browsing resume their timers", () => {
  let now = 0;
  const events = {};
  const listen = (name) => (callback) => {
    events[name] = callback;
    return { dispose() {} };
  };
  const editor = {};
  const window = {
    state: { focused: true },
    activeTextEditor: editor,
    tabGroups: {
      activeTabGroup: { activeTab: { input: { uri: { scheme: "file", fsPath: "/report.md" } } } },
      onDidChangeTabs: listen("tabs"),
      onDidChangeTabGroups: listen("groups"),
    },
    onDidChangeWindowState: listen("focus"),
    onDidChangeActiveTextEditor: listen("editor"),
    onDidChangeTextEditorSelection: listen("selection"),
    onDidChangeTextEditorVisibleRanges: listen("scroll"),
  };
  const { text } = buildSync({
    entryPoints: [path.join(__dirname, "../src/humanTimingMonitor.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    write: false,
  }).outputFiles[0];
  const module = { exports: {} };
  const load = (id) => id === "vscode" ? { window } : require(id);
  new Function("module", "exports", "require", "performance", text)(
    module, module.exports, load, { now: () => now },
  );
  const monitor = new module.exports.HumanTimingMonitor({ get() {}, async update() {} }, () => "chat-a", assert.fail);
  try {
    monitor.listen();
    monitor.rememberFile("chat-a", "/report.md");
    monitor.refreshFile();
    now = 60_000;
    window.state.focused = false;
    events.focus();
    now = 90_000;
    assert.equal(monitor.timer.snapshot("chat-a").fileMs, 60_000);
    events.scroll({ textEditor: editor });
    now = 150_000;
    assert.equal(monitor.timer.snapshot("chat-a").fileMs, 150_000);

    window.state.focused = true;
    events.focus();
    now = 160_000;
    monitor.input("chat-a");
    now = 200_000;
    monitor.setViewFocused(false);
    now = 220_000;
    monitor.input("chat-a");
    assert.deepEqual(monitor.timer.snapshot("chat-a"), { inputMs: 40_000, fileMs: 180_000, readingMs: 0 });
    now = 230_000;
    monitor.reading("chat-a");
    now = 240_000;
    window.state.focused = false;
    events.focus();
    now = 250_000;
    monitor.reading("chat-a"); // A foreground-only signal cannot resume in the background.
    assert.equal(monitor.timer.snapshot("chat-a").readingMs, 10_000);
    monitor.reading("chat-a", true); // An actual wheel/drag can.
    now = 260_000;
    assert.equal(monitor.timer.snapshot("chat-a").readingMs, 30_000);
    monitor.setEnabled(false);
    now = 300_000;
    monitor.reading("chat-a", true);
    assert.equal(monitor.timer.snapshot("chat-a").readingMs, 30_000);
    monitor.setEnabled(true);
    now = 310_000;
    monitor.reading("chat-a", true);
    assert.equal(monitor.timer.snapshot("chat-a").readingMs, 30_000);
  } finally {
    monitor.dispose();
  }
});

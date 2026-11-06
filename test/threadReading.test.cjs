const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { buildSync } = require("esbuild");
const { text } = buildSync({
  entryPoints: [path.join(__dirname, "../webview/src/threadReading.ts")],
  bundle: true, platform: "node", format: "cjs", write: false,
}).outputFiles[0];
const loaded = { exports: {} };
new Function("module", "exports", text)(loaded, loaded.exports);
const { installThreadReading } = loaded.exports;

function surface() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    emit(type, event = {}) { listeners.get(type)?.({ type, isTrusted: true, ...event }); },
  };
}

function fixture() {
  let now = 0;
  const view = surface();
  const doc = { ...surface(), hidden: false, focused: true, defaultView: view,
    hasFocus() { return this.focused; } };
  const root = { ...surface(), ownerDocument: doc, contains: (node) => node?.inside };
  const content = { inside: true, closest: () => null };
  const editable = { inside: true, closest: () => ({}) };
  const context = { chatId: "a", enabled: true, hasContent: true };
  const reports = [];
  const tracker = installThreadReading(root, () => context, (...args) => reports.push(args), () => now);
  return { view, doc, root, context, content, editable, reports, tracker, tick: (ms) => { now += ms; },
    emit: (type, event = {}) => root.emit(type, { target: content, ...event }) };
}

test("mount, auto-scroll, focus, passive hover, and synthetic events cannot start reading", () => {
  const f = fixture();
  f.emit("scroll");
  f.emit("pointermove", { buttons: 0 });
  f.emit("click", { isTrusted: false });
  f.emit("keydown", { key: "Shift" });
  f.view.emit("focus");
  assert.deepEqual(f.reports, []);
  f.tracker.open();
  assert.deepEqual(f.reports, [["a", true, false]]);
  f.tracker.dispose();
  assert.equal(f.root.listeners.size + f.doc.listeners.size + f.view.listeners.size, 0);
});

test("wheel, drag, keyboard navigation, text selection, and tool clicks refresh at most once a second", () => {
  const f = fixture();
  f.emit("wheel");
  f.tick(500);
  f.emit("wheel");
  assert.equal(f.reports.length, 1);
  for (const [type, event] of [["pointermove", { buttons: 1 }], ["keydown", { key: "PageDown" }],
    ["pointerup", {}], ["click", {}], ["touchmove", {}]]) {
    f.tick(1000);
    f.emit(type, event);
  }
  assert.equal(f.reports.length, 6);
});

test("typing and clicking outside the transcript pause reading; a return can pulse immediately", () => {
  const f = fixture();
  f.emit("click");
  f.doc.emit("focusin", { target: f.editable });
  f.emit("keydown", { target: f.editable, key: "Enter" });
  assert.deepEqual(f.reports.map((r) => r[1]), [true, false]);
  f.emit("pointerup");
  f.doc.emit("pointerdown", { target: { inside: false } });
  assert.deepEqual(f.reports.map((r) => r[1]), [true, false, true, false]);
});

test("blur pauses, focus alone does not resume, but visible background scrolling can", () => {
  const f = fixture();
  f.tracker.open();
  f.doc.focused = false;
  f.view.emit("blur");
  f.view.emit("focus");
  f.tracker.open();
  assert.equal(f.reports.length, 2);
  f.emit("wheel");
  assert.deepEqual(f.reports[2], ["a", true, true]);
  f.doc.hidden = true;
  f.doc.emit("visibilitychange");
  f.tick(1000);
  f.emit("wheel");
  assert.deepEqual(f.reports.map((r) => r[1]), [true, false, true, false]);
});

test("disabled, empty, and not-yet-loaded conversations produce no reading signal", () => {
  for (const patch of [{ enabled: false }, { hasContent: false }, { chatId: undefined }]) {
    const f = fixture();
    Object.assign(f.context, patch);
    f.tracker.open();
    f.emit("click");
    assert.deepEqual(f.reports, []);
  }
});

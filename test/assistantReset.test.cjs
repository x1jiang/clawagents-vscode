const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const provider = read("src", "webviewProvider.ts");
const protocol = read("src", "protocol.ts");
const app = read("webview", "src", "App.tsx");
const chats = read("python", "chats.py");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("the sidecar forwards assistant_reset from the agent stream", () => {
  assert.match(chats, /elif kind == "assistant_reset":\s+#[^\n]*\n\s+#[^\n]*\n\s+on_event\("assistant_reset", \{\}\)/);
});

test("assistant_reset is part of the host-to-webview protocol", () => {
  assert.match(protocol, /\{ type: "assistant_reset"; chatId\?: string \}/);
});

test("a reset drops the coalesced partial answer from the live replay buffer", () => {
  const remember = section(provider, "const last = events[events.length - 1];", "private parentChatIdForSideChat");
  assert.match(remember, /if \(event\.type === "assistant_reset"\) \{[\s\S]*?events\.pop\(\);[\s\S]*?return;/);
});

test("both webview reducers discard the streamed partial answer on reset", () => {
  assert.equal((app.match(/case "assistant_reset":/g) || []).length, 2);
  const live = section(app, 'case "assistant_reset":\n          if (isStaleEvent(msg)) break;', 'case "assistant_message": {');
  assert.match(live, /streamingRef\.current = false/);
  assert.match(live, /prev\.slice\(0, -1\)/);
  // Scoped to its run like the deltas it cancels.
  const scoped = section(app, "const RUN_SCOPED_EVENT_TYPES", "]);");
  assert.match(scoped, /"assistant_reset"/);
});

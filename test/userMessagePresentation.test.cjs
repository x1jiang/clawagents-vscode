const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

test("long sent Markdown collapses by rendered height and can be expanded", () => {
  assert.match(app, /const CollapsibleUserMessage/);
  assert.match(app, /content\.scrollHeight > content\.clientHeight \+ 1/);
  assert.match(app, /Show full message/);
  assert.match(app, /Collapse message/);
  assert.match(app, /<CollapsibleUserMessage text=\{item\.text\} \/>/);
});

test("sent Markdown remains constrained to the conversation width", () => {
  assert.match(styles, /\.user-text \{[\s\S]*?max-width: 100%;/);
  assert.match(styles, /\.user-message \{[\s\S]*?max-width: min\(94%, 1,080px\);/);
  assert.match(styles, /\.user-text\.is-preview/);
  assert.match(styles, /\.user-message-expander/);
});

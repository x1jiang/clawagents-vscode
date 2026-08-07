const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");
const gateway = fs.readFileSync(path.join(root, "src", "gatewayClient.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "python", "app.py"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("ordinary refreshes do not live-probe providers or kill an active chat", () => {
  const ready = section(provider, "private async pushReady()", "private async postSettingsWithKeyFlags");
  const loadSettings = section(provider, 'case "load_settings":', 'case "load_skills":');
  const saveSettings = section(provider, 'case "save_settings":', 'case "pick_skill_dir":');

  for (const source of [ready, loadSettings, saveSettings]) {
    assert.doesNotMatch(source, /getProviders\(\{ probe: true \}\)/);
  }
  assert.match(loadSettings, /getProviders\(\{ probe: false \}\)/);
  assert.match(loadSettings, /isSidecarTransportError\(err\) && !this\.busy/);
  assert.match(saveSettings, /isSidecarTransportError\(err\) && !this\.busy/);
});

test("skill previews leave the sidecar event loop available to chat streams", () => {
  assert.match(gateway, /GET", "\/skills", undefined, 30_000/);
  assert.match(app, /return await asyncio\.to_thread\(preview_skills\)/);
});

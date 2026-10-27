const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-clipboard-'));
const out = path.join(dir, 'clipboard.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../webview/src/clipboard.ts')], outfile: out,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const source = fs.readFileSync(out, 'utf8');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function client({ host = true, postMessage = () => {}, browserWrite = () => Promise.reject(new Error('denied')) } = {}) {
  const listeners = new Set();
  const timers = new Map();
  let timerId = 0;
  const context = { exports: {}, navigator: { clipboard: { writeText: browserWrite } },
    window: {
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: id => timers.delete(id),
    },
  };
  context.module = { exports: context.exports };
  if (host) context.acquireVsCodeApi = () => ({ postMessage });
  vm.runInNewContext(source, context);
  return { copy: context.module.exports.copyText, listeners, timers,
    emit: data => [...listeners].forEach(fn => fn({ data })),
  };
}

test('host clipboard bypasses denied browser API and waits for its own acknowledgement', async () => {
  const requests = [];
  const c = client({ postMessage: msg => requests.push(msg), browserWrite: () => assert.fail('browser clipboard used') });
  const first = c.copy('你好\n```ts\nconst x = 1;\n```');
  const second = c.copy('second');
  assert.equal(requests[0].text, '你好\n```ts\nconst x = 1;\n```');
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  c.emit({ type: 'clipboard_result', requestId: requests[1].requestId, ok: false });
  assert.equal(await second, false);
  assert.equal(c.listeners.size, 1);
  c.emit({ type: 'clipboard_result', requestId: requests[0].requestId, ok: true });
  assert.equal(await first, true);
  assert.equal(c.listeners.size, 0);
  assert.equal(c.timers.size, 0);
});

test('missing host acknowledgement and bridge failure release listeners and report failure', async () => {
  const c = client();
  const pending = c.copy('text');
  [...c.timers.values()][0]();
  assert.equal(await pending, false);
  assert.equal(c.listeners.size, 0);
  assert.equal(c.timers.size, 0);
  const broken = client({ postMessage: () => { throw new Error('disposed'); } });
  assert.equal(await broken.copy('text'), false);
  assert.equal(broken.listeners.size, 0);
});

test('browser preview reports both success and denied permission', async () => {
  let value;
  const c = client({ host: false, browserWrite: async text => { value = text; } });
  assert.equal(await c.copy('preview'), true);
  assert.equal(value, 'preview');
  assert.equal(await client({ host: false }).copy('denied'), false);
});

// Exercise the production host branch with a mocked VS Code clipboard.
const hostSource = fs.readFileSync(path.join(__dirname, '../src/webviewProvider.ts'), 'utf8');
const ast = ts.createSourceFile('host.ts', hostSource, ts.ScriptTarget.Latest, true);
let copyCase;
function visit(node) {
  if (ts.isCaseClause(node) && node.expression.getText(ast) === '"copy_text"') copyCase = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert(copyCase);
const compiled = ts.transpileModule(`async function handle(msg) { switch (msg.type) { ${copyCase} } }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

test('host acknowledges only after write succeeds and reports write rejection without a chat error', async () => {
  const responses = [];
  let complete;
  const pendingWrite = new Promise(resolve => { complete = resolve; });
  const vscode = { env: { clipboard: { writeText: text => { assert.equal(text, 'actual text'); return pendingWrite; } } } };
  const handle = new Function('vscode', `${compiled}; return handle;`)(vscode);
  const host = { post: msg => responses.push(msg) };
  const pending = handle.call(host, { type: 'copy_text', requestId: 'copy-1', text: 'actual text' });
  assert.equal(responses.length, 0);
  complete();
  await pending;
  assert.deepEqual(responses, [{ type: 'clipboard_result', requestId: 'copy-1', ok: true }]);
  vscode.env.clipboard.writeText = async () => { throw new Error('unavailable'); };
  await handle.call(host, { type: 'copy_text', requestId: 'copy-2', text: 'text' });
  assert.deepEqual(responses[1], { type: 'clipboard_result', requestId: 'copy-2', ok: false });
});

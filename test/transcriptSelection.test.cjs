const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-selection-'));
const out = path.join(dir, 'selection.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../webview/src/transcriptSelection.ts')], outfile: out,
 bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const source = fs.readFileSync(out, 'utf8');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
function fixture() {
 const requests = [];
 const listeners = new Map();
 const attributes = new Map();
 const root = { setAttribute: (key, value) => attributes.set(key, value) };
 const node = (container = root, editable = false) => ({ nodeType: 1,
  closest: selector => selector.startsWith('input') ? (editable ? {} : null) : container });
 const start = node();
 const end = node();
 const selection = { anchorNode: start, focusNode: end, isCollapsed: false, rangeCount: 1,
  toString: () => '某段回复\n第二行' };
 let focused = true;
 const doc = { getSelection: () => selection, hasFocus: () => focused,
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: type => listeners.delete(type),
 };
 const context = { exports: {}, acquireVsCodeApi: () => ({ postMessage: msg => requests.push(msg) }),
  window: { setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
 };
 context.module = { exports: context.exports };
 vm.runInNewContext(source, context);
 const api = context.module.exports;
 const cleanup = api.installTranscriptSelection(doc);
 return { requests, attributes, root, node, start, selection, doc, api, cleanup, listeners,
  blur: () => { focused = false; },
  emit: (type, event = {}) => listeners.get(type)?.(event),
 };
}

test('copy only actual rendered selection; exclude composer, collapsed and cross-panel selections', () => {
 const f = fixture();
 assert.equal(f.api.selectedTranscriptText(f.doc), '某段回复\n第二行');
 f.selection.focusNode = f.node({});
 assert.equal(f.api.selectedTranscriptText(f.doc), '');
 f.selection.focusNode = f.node(f.root, true);
 assert.equal(f.api.selectedTranscriptText(f.doc), '');
 f.selection.focusNode = f.start;
 f.selection.isCollapsed = true;
 assert.equal(f.api.selectedTranscriptText(f.doc), '');
 f.cleanup();
 assert.equal(f.listeners.size, 0);
});

test('right-click snapshots selected text before the native menu blurs the webview', () => {
 const f = fixture();
 f.emit('selectionchange');
 assert.equal(f.requests.at(-1).text, '某段回复\n第二行');
 f.emit('contextmenu', { target: f.start });
 const menu = JSON.parse(f.attributes.get('data-vscode-context'));
 assert.equal(menu.webviewSection, 'transcript-selection');
 assert.equal(menu.preventDefaultContextMenuItems, true);
 assert.equal(menu.clawagentsSelectionText, '某段回复\n第二行');
 f.blur();
 f.selection.isCollapsed = true;
 f.emit('selectionchange');
 assert.equal(f.requests.at(-1).text, '某段回复\n第二行');
 // The command's captured argument remains valid even if selection later clears.
 assert.equal(menu.clawagentsSelectionText, '某段回复\n第二行');
 f.emit('focusin', { target: f.node(null, true) });
 assert.equal(f.requests.at(-1).text, '');
 f.cleanup();
});

test('Ctrl/Cmd+C and native copy events copy the selected substring via host, leaving editor keys alone', () => {
 const f = fixture();
 for (const chord of [{ ctrlKey: true }, { metaKey: true }]) {
  let prevented = false;
  f.emit('keydown', { ...chord, key: 'c', preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
  assert(prevented);
  assert.equal(f.requests.at(-1).type, 'copy_text');
  assert.equal(f.requests.at(-1).text, '某段回复\n第二行');
 }
 let nativeText;
 f.emit('copy', { clipboardData: { setData: (kind, text) => { assert.equal(kind, 'text/plain'); nativeText = text; } }, preventDefault: () => {} });
 assert.equal(nativeText, '某段回复\n第二行');
 f.selection.anchorNode = f.node(null, true);
 f.emit('keydown', { ctrlKey: true, key: 'c', preventDefault: () => assert.fail('editor copy intercepted') });
 f.cleanup();
});

// Exercise the actual command handler independently of webview/native menu focus.
const host = fs.readFileSync(path.join(__dirname, '../src/webviewProvider.ts'), 'utf8');
const ast = ts.createSourceFile('host.ts', host, ts.ScriptTarget.Latest, true);
let method;
function visit(n) {
 if (ts.isMethodDeclaration(n) && n.name.getText(ast) === 'copyTranscriptSelection') method = n.getText(ast);
 ts.forEachChild(n, visit);
}
visit(ast);
assert(method);
const compiled = ts.transpileModule(`class Host { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
test('context-menu command uses the snapshot when iframe no longer has focus; keyboard uses latest selection', async () => {
 const writes = [];
 const vscode = { env: { clipboard: { writeText: async text => writes.push(text) } }, window: { showErrorMessage: () => {} } };
 const Host = new Function('vscode', compiled + '; return Host;')(vscode);
 const instance = new Host();
 instance.transcriptSelection = '';
 await instance.copyTranscriptSelection({ clawagentsSelectionText: 'right-click snapshot' });
 instance.transcriptSelection = 'keyboard selection';
 await instance.copyTranscriptSelection();
 assert.deepEqual(writes, ['right-click snapshot', 'keyboard selection']);
});

test('shortcut and context menu are scoped to the chat selection', () => {
 const manifest = require('../package.json').contributes;
 const key = manifest.keybindings.find(k => k.command === 'clawagents.copySelection');
 assert.equal(key.key, 'ctrl+c');
 assert.equal(key.mac, 'cmd+c');
 assert.match(key.when, /clawagents:hasTranscriptSelection/);
 const menu = manifest.menus['webview/context'].find(m => m.command === key.command);
 assert.match(menu.when, /clawagents\.sidebar/);
 assert.match(menu.when, /transcript-selection/);
});

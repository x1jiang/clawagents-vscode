const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-markdown-links-'));
const out = path.join(dir, 'links.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../webview/src/markdownLinks.ts')],
  outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { markdownFileReference: parse, markdownUrlTransform: transform } = require(out);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('report links resolve explicit relative, absolute and encoded file destinations', () => {
  assert.deepEqual(parse('reports/english.md'), { path: 'reports/english.md' });
  assert.deepEqual(parse('report.md'), { path: 'report.md' });
  assert.deepEqual(parse('./reports/英文%20报告.md#L12'), { path: './reports/英文 报告.md', line: 12 });
  assert.deepEqual(parse('/workspace/report.md:42'), { path: '/workspace/report.md', line: 42 });
  assert.deepEqual(parse('file:///workspace/English%20report.md#L9C2'), { path: '/workspace/English report.md', line: 9 });
  assert.deepEqual(parse('file://localhost/workspace/report.md'), { path: '/workspace/report.md' });
  assert.deepEqual(parse('C:\\reports\\english.md:7:3'), { path: 'C:\\reports\\english.md', line: 7 });
});

test('web URLs and fragment links keep their browser behavior; unsafe schemes remain blocked', () => {
  for (const href of ['https://example.com/report', 'mailto:a@example.com', '#section', '//example.com/report']) {
    assert.equal(parse(href), undefined);
    assert.equal(transform(href, 'href'), href);
  }
  for (const href of ['javascript:alert(1)', 'data:text/html,test', 'command:workbench.action.files.openFile']) {
    assert.equal(parse(href), undefined);
    assert.equal(transform(href, 'href'), '');
  }
  for (const href of ['file://server/share/report.md', '%zz.md', 'report%00.md', 'report.md#L0']) {
    assert.equal(parse(href), undefined);
  }
});

test('file links survive URL sanitization without enabling file image sources', () => {
  const href = 'file:///workspace/report.md';
  assert.equal(transform(href, 'href'), href);
  assert.equal(transform(href, 'src'), '');
});

test('Windows file URLs retain drive-qualified paths through workspace resolution', () => {
  for (const [href, expected] of [
    ['file:///C:/work/report.md', { path: 'C:/work/report.md' }],
    ['file://localhost/C:/work/English%20report.md#L9C2', { path: 'C:/work/English report.md', line: 9 }],
    ['file:///c:/work/report.md:42:3', { path: 'c:/work/report.md', line: 42 }],
    ['file:///%43%3A/work/report.md', { path: 'C:/work/report.md' }],
  ]) {
    const reference = parse(href);
    assert.deepEqual(reference, expected);
    assert.equal(path.win32.isAbsolute(reference.path), true);
    assert.equal(path.win32.resolve('C:\\work', reference.path),
      path.win32.normalize(expected.path));
    assert.equal(transform(href, 'href'), href);
    assert.equal(transform(href, 'src'), '');
  }
  // Only file URLs need drive-prefix conversion; plain POSIX paths stay intact.
  assert.deepEqual(parse('/C:/work/report.md'), { path: '/C:/work/report.md' });
  assert.equal(parse('file://server/C:/work/report.md'), undefined);
});

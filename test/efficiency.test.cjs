const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-efficiency-'));
const out = path.join(dir, 'efficiency.cjs');
buildSync({entryPoints: [path.join(__dirname, '../src/efficiency.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs'});
const { normalizeEfficiency, efficiencyLabel } = require(out);
test.after(() => fs.rmSync(dir, {recursive: true, force: true}));
test('older sidecar omits efficiency rather than claiming measurements', () => {
  assert.equal(normalizeEfficiency(undefined), undefined);
  assert.equal(efficiencyLabel(undefined), '');
});
test('snapshot keeps only valid nonnegative counters and reason maps', () => {
  const result = normalizeEfficiency({round_trips_avoided: 2, tokens_avoided_by_handles: 123, reducer_bytes_saved: -7, compactions: {micro: 2, invalid: -1}, reducer_fallbacks: {unverified: 1}, cache_debt_tokens: Infinity});
  assert.equal(result.round_trips_avoided, 2);
  assert.equal(result.reducer_bytes_saved, 0);
  assert.deepEqual(result.compactions, {micro: 2});
  assert.equal(result.cache_debt_tokens, 0);
  assert.match(efficiencyLabel(result), /2 fused follow-ups/);
  assert.match(efficiencyLabel(result), /123 estimated context tokens/);
});

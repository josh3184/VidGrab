import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load the vendored mux.js bundle exactly the way the extension does: as a
// classic script that sets globalThis.muxjs. This exercises the real runtime
// dependency rather than a separate npm copy.
globalThis.window = globalThis.window || {};
vm.runInThisContext(fs.readFileSync(path.join(here, '../lib/vendor/muxjs-mp4.min.js'), 'utf8'));

const { tsToMp4, tsToFragmentedMp4 } = await import('../lib/transmux.js');

const fixture = () => new Uint8Array(fs.readFileSync(path.join(here, 'fixtures/muxed.ts')));
const boxType = (b, o) => String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
const latin1 = (b) => Buffer.from(b).toString('latin1');

test('turns a muxed TS into a progressive MP4', () => {
  const out = tsToMp4(fixture());
  assert.equal(boxType(out, 0), 'ftyp', 'starts with an ftyp box');
  const s = latin1(out);
  assert.ok(s.includes('moov'), 'has moov');
  assert.ok(s.includes('mdat'), 'has media data');
  // Fragments are an implementation detail of mux.js, never of what we save.
  // test/progressive.test.mjs covers the resulting sample tables in detail.
  assert.ok(!s.includes('moof'), 'must not still be fragmented');
});

test('mux.js still gives us fragments to work from', () => {
  const s = latin1(tsToFragmentedMp4(fixture()));
  assert.ok(s.includes('moof'), 'has moof (fragment)');
  assert.ok(s.includes('mdat'), 'has media data');
});

test('accepts segments pushed as an array (the HLS case)', () => {
  const buf = fs.readFileSync(path.join(here, 'fixtures/muxed.ts'));
  const pkt = 188;
  const third = Math.floor(buf.length / pkt / 3) * pkt; // split on TS packet boundaries
  const parts = [
    new Uint8Array(buf.subarray(0, third)),
    new Uint8Array(buf.subarray(third, 2 * third)),
    new Uint8Array(buf.subarray(2 * third)),
  ];
  const out = tsToMp4(parts);
  assert.equal(boxType(out, 0), 'ftyp');
  const s = latin1(out);
  assert.ok(s.includes('moov') && s.includes('mdat'));
  assert.ok(!s.includes('moof'));
});

test('throws on non-TS input so the caller can fall back to .ts', () => {
  const junk = new Uint8Array(4096).fill(0x11);
  assert.throws(() => tsToMp4(junk));
});

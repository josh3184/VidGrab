// The file VidGrab saves must be a plain progressive MP4, not the fragmented
// MSE stream mux.js emits. Fragmented output has no real duration in its
// header and no sample table, which is why saved videos showed a nonsense
// length and a seek bar that didn't work.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mp4 from './helpers/mp4-inspect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

globalThis.window = globalThis.window || {};
vm.runInThisContext(fs.readFileSync(path.join(here, '../lib/vendor/muxjs-mp4.min.js'), 'utf8'));

const { tsToMp4, tsToFragmentedMp4 } = await import('../lib/transmux.js');

const TS = path.join(here, 'fixtures/muxed.ts');
// The fixture is one second of 25fps video (25 frames, a single keyframe).
// mux.js emits 43 AAC frames for it, two fewer than the TS carries, because it
// drops the frames that precede the first video sample.
const VIDEO_SAMPLES = 25;
const AUDIO_SAMPLES = 43;
const INDEFINITE = 0xffffffff;

const source = new Uint8Array(fs.readFileSync(TS));
const out = tsToMp4(source);

const trackOf = (kind) =>
  mp4.traks(out).find((t) => mp4.handlerOf(out, t) === kind);

test('output is not fragmented', () => {
  const top = mp4.topLevelTypes(out);
  assert.ok(!top.includes('moof'), `expected no moof, got top-level ${top.join(',')}`);
  assert.equal(mp4.find(out, 'moov/mvex'), null, 'mvex describes fragments and must be gone');
});

test('moov is written before mdat so the file opens without a full scan', () => {
  const top = mp4.topLevelTypes(out);
  assert.ok(top.indexOf('moov') < top.indexOf('mdat'), `got ${top.join(',')}`);
});

test('movie header declares a real duration', () => {
  const mvhd = mp4.readMvhd(out);
  assert.notEqual(mvhd.duration, INDEFINITE, 'mvhd still has the mux.js placeholder duration');
  const seconds = mvhd.duration / mvhd.timescale;
  assert.ok(seconds > 0.8 && seconds < 1.3, `expected ~1s, got ${seconds.toFixed(3)}s`);
});

test('every track declares a real duration', () => {
  for (const trak of mp4.traks(out)) {
    const kind = mp4.handlerOf(out, trak);
    const tkhd = mp4.readTkhd(null, out, trak);
    const mdhd = mp4.readMdhd(out, trak);
    assert.notEqual(tkhd.duration, INDEFINITE, `${kind} tkhd duration is the placeholder`);
    assert.notEqual(mdhd.duration, INDEFINITE, `${kind} mdhd duration is the placeholder`);
    assert.ok(mdhd.duration > 0, `${kind} mdhd duration is zero`);
  }
});

test('every track has a populated sample table', () => {
  for (const trak of mp4.traks(out)) {
    const kind = mp4.handlerOf(out, trak);
    const children = mp4.stblChildren(out, trak);
    for (const required of ['stsd', 'stts', 'stsc', 'stsz', 'stco']) {
      assert.ok(children.includes(required), `${kind} stbl is missing ${required}`);
    }
    // A fragmented file has all of these boxes too, but empty — the entries are
    // what a player actually needs.
    assert.ok(mp4.readStsz(out, trak).count > 0, `${kind} stsz has no entries`);
    assert.ok(mp4.readStts(out, trak).length > 0, `${kind} stts has no entries`);
    assert.ok(mp4.readStco(out, trak).length > 0, `${kind} stco has no entries`);
    assert.ok(mp4.readStsc(out, trak).length > 0, `${kind} stsc has no entries`);
  }
});

test('video sample table has one entry per frame', () => {
  const trak = trackOf('vide');
  assert.equal(mp4.readStsz(out, trak).count, VIDEO_SAMPLES);
  const stts = mp4.readStts(out, trak).reduce((n, e) => n + e.count, 0);
  assert.equal(stts, VIDEO_SAMPLES, 'stts must account for every sample');
});

test('audio sample table has one entry per frame', () => {
  const trak = trackOf('soun');
  assert.equal(mp4.readStsz(out, trak).count, AUDIO_SAMPLES);
});

test('video track lists its sync samples', () => {
  const stss = mp4.readStss(out, trackOf('vide'));
  assert.deepEqual(stss, [1], 'the fixture opens on its only keyframe');
});

test('audio track omits stss because every frame is a sync point', () => {
  assert.equal(mp4.readStss(out, trackOf('soun')), null);
});

test('sample offsets land inside mdat and account for all of it', () => {
  const mdat = mp4.boxes(out).find((b) => b.type === 'mdat');
  let total = 0;
  for (const trak of mp4.traks(out)) {
    const { sizes } = mp4.readStsz(out, trak);
    const offsets = mp4.sampleOffsets(out, trak);
    assert.equal(offsets.length, sizes.length, 'every sample needs an offset');
    for (let i = 0; i < offsets.length; i++) {
      assert.ok(
        offsets[i] >= mdat.body && offsets[i] + sizes[i] <= mdat.end,
        `sample ${i} at ${offsets[i]}+${sizes[i]} falls outside mdat ${mdat.body}..${mdat.end}`
      );
      total += sizes[i];
    }
  }
  assert.equal(total, mdat.end - mdat.body, 'mdat should hold exactly the samples, no padding');
});

// --- End-to-end conformance -------------------------------------------------
// The structural tests above prove the file is well-formed. This one proves the
// rewrite is lossless, by decoding mux.js's fragmented output and our
// progressive one and comparing frame hashes. mux.js is the reference rather
// than the source TS because it legitimately trims leading audio frames — that
// difference is not ours to preserve or fix.

const ffmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const frameHashes = (file, stream) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', stream, '-f', 'framemd5', '-'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.trim().split(/,\s*/).pop());

test('decodes to exactly the frames mux.js produced', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgrab-'));
  try {
    const progressive = path.join(dir, 'progressive.mp4');
    const fragmented = path.join(dir, 'fragmented.mp4');
    fs.writeFileSync(progressive, Buffer.from(out));
    fs.writeFileSync(fragmented, Buffer.from(tsToFragmentedMp4(source)));

    assert.deepEqual(
      frameHashes(progressive, '0:v:0'),
      frameHashes(fragmented, '0:v:0'),
      'video frames differ from the fragmented original'
    );
    assert.deepEqual(
      frameHashes(progressive, '0:a:0'),
      frameHashes(fragmented, '0:a:0'),
      'audio frames differ from the fragmented original'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('presentation timestamps survive the rewrite', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgrab-'));
  try {
    const progressive = path.join(dir, 'progressive.mp4');
    const fragmented = path.join(dir, 'fragmented.mp4');
    fs.writeFileSync(progressive, Buffer.from(out));
    fs.writeFileSync(fragmented, Buffer.from(tsToFragmentedMp4(source)));

    const stamps = (file) =>
      execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts,dts', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();

    assert.equal(stamps(progressive), stamps(fragmented), 'video timestamps changed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

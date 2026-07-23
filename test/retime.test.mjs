// Some streams stamp their video timeline at a rounded-off frame rate — 23.98
// instead of 23.976 — while the audio stays sample-accurate. Concatenated into
// one file that shows up as video sliding ahead of the audio, a few hundred
// milliseconds by the end of a long download.
//
// The audio track is the reference clock here: AAC frames are a fixed number of
// samples, so its duration is exact. Video is only retimed when it disagrees
// with that clock AND a standard frame rate explains the disagreement.

import { test } from 'node:test';
import assert from 'node:assert';
import { correctFrameDurations } from '../lib/retime.js';

const TIMESCALE = 90000;

// Builds the duration pattern a stream stamped at `fps` would carry.
const stampedAt = (frames, fps) => {
  const tick = TIMESCALE / fps;
  return Array.from({ length: frames }, (_, i) =>
    Math.round((i + 1) * tick) - Math.round(i * tick)
  );
};

const seconds = (durations) => durations.reduce((a, b) => a + b, 0) / TIMESCALE;

test('leaves a clean 25fps track alone', () => {
  const durations = stampedAt(250, 25);
  assert.equal(correctFrameDurations(durations, TIMESCALE, seconds(durations)), null);
});

test('leaves a clean 23.976fps track alone', () => {
  const durations = stampedAt(2400, 24000 / 1001);
  assert.equal(correctFrameDurations(durations, TIMESCALE, seconds(durations)), null);
});

test('corrects a 23.98-stamped track back to 23.976', () => {
  // The real case: 24414 frames stamped at 23.98, audio says 1018.218s.
  const durations = stampedAt(24414, 23.98);
  const audioSeconds = 1018.218231;
  assert.ok(
    Math.abs(seconds(durations) - audioSeconds) > 0.1,
    'precondition: the stamped timeline should disagree with audio'
  );

  const fixed = correctFrameDurations(durations, TIMESCALE, audioSeconds);
  assert.ok(fixed, 'expected a correction');
  assert.equal(fixed.length, durations.length, 'frame count must not change');
  assert.ok(
    Math.abs(seconds(fixed) - audioSeconds) < 0.05,
    `expected to land within 50ms of the audio clock, got ${(seconds(fixed) - audioSeconds).toFixed(4)}s`
  );
});

test('spreads rounding so drift never accumulates', () => {
  const fixed = correctFrameDurations(stampedAt(24414, 23.98), TIMESCALE, 1018.218231);
  const tick = TIMESCALE / (24000 / 1001);
  let running = 0;
  let worst = 0;
  for (let i = 0; i < fixed.length; i++) {
    running += fixed[i];
    worst = Math.max(worst, Math.abs(running - (i + 1) * tick));
  }
  assert.ok(worst <= 1, `cumulative error reached ${worst.toFixed(3)} ticks, should stay within 1`);
});

test('ignores a disagreement too small to notice', () => {
  const durations = stampedAt(250, 25);
  assert.equal(correctFrameDurations(durations, TIMESCALE, seconds(durations) + 0.02), null);
});

test('leaves variable frame rate content alone', () => {
  // Real VFR: frames held for wildly different times. Snapping this to a
  // constant rate would be destructive, however much it disagrees with audio.
  const durations = Array.from({ length: 300 }, (_, i) => (i % 5 === 0 ? 9000 : 3000));
  assert.equal(correctFrameDurations(durations, TIMESCALE, 20), null);
});

test('declines when no standard rate explains the audio clock', () => {
  const durations = stampedAt(250, 25);
  assert.equal(correctFrameDurations(durations, TIMESCALE, 50), null);
});

test('declines on a track too short to judge', () => {
  assert.equal(correctFrameDurations([3600], TIMESCALE, 5), null);
});

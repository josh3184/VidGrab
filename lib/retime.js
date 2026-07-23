// Corrects a video track whose timeline was stamped at a rounded-off frame rate.
//
// Some encoders write 23.98 where they mean 24000/1001 (23.976). The error is
// only 0.017%, but it is a rate error, not an offset, so it accumulates: video
// slides ahead of the audio by roughly 170ms over a 17-minute download and more
// over a longer one. Players fight it by dropping a frame every few minutes.
//
// AAC frames hold a fixed number of samples, so the audio track's duration is
// exact and makes a good reference clock. Video is only touched when it
// disagrees with that clock and a standard frame rate accounts for the
// disagreement — otherwise the timeline is left exactly as it came.

const STANDARD_RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60];

// Below this the offset is both inaudible and not worth the risk of touching.
const TOLERANCE_SECONDS = 0.05;

// A stamped rate this far from a standard one is not a rounding artefact.
const MAX_RATE_SHIFT = 0.01;

// Fraction of frames allowed to sit outside the constant-rate pattern before we
// treat the track as genuinely variable and refuse to touch it.
const VFR_THRESHOLD = 0.01;

// Returns replacement sample durations, or null to leave the track alone.
export function correctFrameDurations(durations, timescale, referenceSeconds) {
  if (!durations || durations.length < 2) return null;
  if (!(referenceSeconds > 0) || !(timescale > 0)) return null;

  // Constant-rate check. A track stamped at a slightly wrong rate alternates
  // between two adjacent tick counts (3753/3754); real variable-rate content
  // holds frames for genuinely different lengths, and snapping that to a
  // constant rate would be destructive.
  const median = [...durations].sort((a, b) => a - b)[durations.length >> 1];
  const irregular = durations.filter((d) => Math.abs(d - median) > 1).length;
  if (irregular > durations.length * VFR_THRESHOLD) return null;

  const frames = durations.length;
  const currentSeconds = durations.reduce((a, b) => a + b, 0) / timescale;
  if (Math.abs(currentSeconds - referenceSeconds) <= TOLERANCE_SECONDS) return null;

  // Which standard rate would put this many frames on the audio clock?
  let best = null;
  for (const rate of STANDARD_RATES) {
    const error = Math.abs(frames / rate - referenceSeconds);
    if (best === null || error < best.error) best = { rate, error };
  }
  if (!best || best.error > TOLERANCE_SECONDS) return null;

  // Only accept it as a correction of what's already stamped, not a wholesale
  // reinterpretation of the track.
  const stampedRate = frames / currentSeconds;
  if (Math.abs(best.rate - stampedRate) / stampedRate > MAX_RATE_SHIFT) return null;

  // Derive each duration from the difference of rounded absolute positions, so
  // the rounding error stays within half a tick instead of accumulating.
  const tick = timescale / best.rate;
  const out = new Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.round((i + 1) * tick) - Math.round(i * tick);
  }
  return out;
}

// Converts the fragmented MP4 that mux.js produces into a plain progressive
// MP4 — the shape every player has handled correctly for twenty years.
//
// mux.js builds output for Media Source Extensions, where the player already
// knows the duration from the HLS manifest and feeds fragments in by hand. So
// it writes placeholder durations (0xFFFFFFFF) in mvhd/tkhd/mdhd, leaves the
// sample tables empty, and describes the media only through moof/trun boxes.
// Saved to disk that yields a file with a nonsense length and a seek bar that
// doesn't work.
//
// This rebuilds the real sample tables (stts/stsz/stsc/stco/stss/ctts) from the
// fragment metadata, re-interleaves the media so audio and video stay close
// together, and writes moov ahead of mdat. Sample bytes are copied verbatim —
// nothing is re-encoded and no timestamp is altered.

import { correctFrameDurations } from './retime.js';

const u32 = (b, o) => (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const i32 = (b, o) => (u32(b, o) | 0);
const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);
const typeAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// Interleave granularity. Players read a chunk at a time, so mixing audio and
// video at roughly one-second intervals keeps seeking cheap. mux.js emits one
// giant fragment per track, which would otherwise leave a 250 MB video run
// followed by all of the audio.
const CHUNK_SECONDS = 1;

const SAMPLE_IS_NON_SYNC = 0x00010000;
const MAX_OFFSET = 0xffffffff;

// --- Reading ----------------------------------------------------------------

function boxes(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(buf, pos);
    const type = typeAt(buf, pos + 4);
    let body = pos + 8;
    if (size === 1) {
      size = u64(buf, pos + 8);
      body = pos + 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < 8 || pos + size > end) break;
    out.push({ type, start: pos, end: pos + size, body });
    pos += size;
  }
  return out;
}

const child = (buf, box, type) =>
  boxes(buf, box.body, box.end).find((b) => b.type === type) || null;

function descend(buf, box, path) {
  let cur = box;
  for (const type of path) {
    cur = child(buf, cur, type);
    if (!cur) return null;
  }
  return cur;
}

function parseTfhd(buf, box) {
  const flags = u32(buf, box.body) & 0xffffff;
  let o = box.body + 8;
  const out = { trackId: u32(buf, box.body + 4), flags };
  if (flags & 0x000001) { out.baseDataOffset = u64(buf, o); o += 8; }
  if (flags & 0x000002) { o += 4; } // sample_description_index
  if (flags & 0x000008) { out.defaultDuration = u32(buf, o); o += 4; }
  if (flags & 0x000010) { out.defaultSize = u32(buf, o); o += 4; }
  if (flags & 0x000020) { out.defaultFlags = u32(buf, o); o += 4; }
  return out;
}

function parseTfdt(buf, box) {
  const version = buf[box.body];
  return version === 1 ? u64(buf, box.body + 4) : u32(buf, box.body + 4);
}

// Yields one entry per sample described by this trun.
function parseTrun(buf, box, defaults) {
  const version = buf[box.body];
  const flags = u32(buf, box.body) & 0xffffff;
  const count = u32(buf, box.body + 4);
  let o = box.body + 8;

  let dataOffset = 0;
  if (flags & 0x000001) { dataOffset = i32(buf, o); o += 4; }
  let firstFlags = null;
  if (flags & 0x000004) { firstFlags = u32(buf, o); o += 4; }

  const samples = [];
  for (let i = 0; i < count; i++) {
    let duration = defaults.defaultDuration || 0;
    let size = defaults.defaultSize || 0;
    let sampleFlags = defaults.defaultFlags || 0;
    let cts = 0;
    if (flags & 0x000100) { duration = u32(buf, o); o += 4; }
    if (flags & 0x000200) { size = u32(buf, o); o += 4; }
    if (flags & 0x000400) { sampleFlags = u32(buf, o); o += 4; }
    if (flags & 0x000800) {
      cts = version === 1 ? i32(buf, o) : u32(buf, o);
      o += 4;
    }
    if (i === 0 && firstFlags !== null) sampleFlags = firstFlags;
    samples.push({ duration, size, cts, sync: !(sampleFlags & SAMPLE_IS_NON_SYNC) });
  }
  return { dataOffset, samples };
}

// Walks every moof and returns the samples belonging to each track, in order,
// each carrying its absolute byte offset in `buf`.
function readFragments(buf, top) {
  const byTrack = new Map();

  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of boxes(buf, moof.body, moof.end).filter((b) => b.type === 'traf')) {
      const tfhdBox = child(buf, traf, 'tfhd');
      const trunBox = child(buf, traf, 'trun');
      if (!tfhdBox || !trunBox) continue;

      const tfhd = parseTfhd(buf, tfhdBox);
      const tfdtBox = child(buf, traf, 'tfdt');
      const { dataOffset, samples } = parseTrun(buf, trunBox, tfhd);

      // With neither base-data-offset nor default-base-is-moof set — which is
      // what mux.js emits — the base is the start of the enclosing moof.
      const base = tfhd.baseDataOffset !== undefined ? tfhd.baseDataOffset : moof.start;
      let offset = base + dataOffset;
      let dts = tfdtBox ? parseTfdt(buf, tfdtBox) : null;

      if (!byTrack.has(tfhd.trackId)) byTrack.set(tfhd.trackId, []);
      const list = byTrack.get(tfhd.trackId);
      if (dts === null) dts = list.length ? list[list.length - 1].dts + list[list.length - 1].duration : 0;

      for (const s of samples) {
        list.push({ ...s, offset, dts });
        offset += s.size;
        dts += s.duration;
      }
    }
  }
  return byTrack;
}

// --- Writing ----------------------------------------------------------------

const TYPE_BYTES = (t) => [t.charCodeAt(0), t.charCodeAt(1), t.charCodeAt(2), t.charCodeAt(3)];

function box(type, ...parts) {
  let payload = 0;
  for (const p of parts) payload += p.length;
  const out = new Uint8Array(8 + payload);
  writeU32(out, 0, out.length);
  out.set(TYPE_BYTES(type), 4);
  let at = 8;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function writeU32(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

const fullBoxHeader = (version, flags) =>
  new Uint8Array([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);

// Run-length encodes [{count, value}] pairs into an entry table.
function entryTable(pairs, fields = 2) {
  const out = new Uint8Array(4 + pairs.length * 4 * fields);
  writeU32(out, 0, pairs.length);
  let at = 4;
  for (const p of pairs) {
    for (const v of p) { writeU32(out, at, v); at += 4; }
  }
  return out;
}

function runLength(values) {
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  return runs;
}

function buildStts(samples) {
  return box('stts', fullBoxHeader(0, 0), entryTable(runLength(samples.map((s) => s.duration))));
}

function buildCtts(samples) {
  if (samples.every((s) => s.cts === 0)) return null;
  const negative = samples.some((s) => s.cts < 0);
  const runs = runLength(samples.map((s) => s.cts));
  const out = new Uint8Array(4 + runs.length * 8);
  writeU32(out, 0, runs.length);
  let at = 4;
  for (const [count, value] of runs) {
    writeU32(out, at, count);
    writeU32(out, at + 4, value < 0 ? (value >>> 0) : value);
    at += 8;
  }
  return box('ctts', fullBoxHeader(negative ? 1 : 0, 0), out);
}

function buildStss(samples) {
  const sync = [];
  for (let i = 0; i < samples.length; i++) if (samples[i].sync) sync.push(i + 1);
  // Every sample being a sync point is the normal case for audio; the spec says
  // to omit stss entirely rather than list all of them.
  if (sync.length === samples.length) return null;
  const out = new Uint8Array(4 + sync.length * 4);
  writeU32(out, 0, sync.length);
  sync.forEach((n, i) => writeU32(out, 4 + i * 4, n));
  return box('stss', fullBoxHeader(0, 0), out);
}

function buildStsz(samples) {
  const first = samples.length ? samples[0].size : 0;
  const uniform = samples.length > 0 && samples.every((s) => s.size === first);
  if (uniform) {
    const out = new Uint8Array(8);
    writeU32(out, 0, first);
    writeU32(out, 4, samples.length);
    return box('stsz', fullBoxHeader(0, 0), out);
  }
  const out = new Uint8Array(8 + samples.length * 4);
  writeU32(out, 0, 0);
  writeU32(out, 4, samples.length);
  samples.forEach((s, i) => writeU32(out, 8 + i * 4, s.size));
  return box('stsz', fullBoxHeader(0, 0), out);
}

function buildStsc(chunks) {
  const runs = [];
  chunks.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (!last || last[1] !== c.count) runs.push([i + 1, c.count, 1]);
  });
  return box('stsc', fullBoxHeader(0, 0), entryTable(runs, 3));
}

function buildStco(chunks, base) {
  const out = new Uint8Array(4 + chunks.length * 4);
  writeU32(out, 0, chunks.length);
  chunks.forEach((c, i) => writeU32(out, 4 + i * 4, base + c.offset));
  return box('stco', fullBoxHeader(0, 0), out);
}

// --- Assembly ---------------------------------------------------------------

// Splits each track's samples into chunks of roughly CHUNK_SECONDS, emitted in
// timeline order so the tracks stay interleaved.
function planChunks(tracks) {
  const cursors = tracks.map(() => 0);
  const chunks = [];
  const active = () => tracks.some((t, i) => cursors[i] < t.samples.length);

  let boundary = Infinity;
  for (const t of tracks) {
    if (t.samples.length) boundary = Math.min(boundary, t.samples[0].dts / t.timescale);
  }
  if (!isFinite(boundary)) return chunks;

  while (active()) {
    boundary += CHUNK_SECONDS;
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti];
      const first = cursors[ti];
      while (
        cursors[ti] < t.samples.length &&
        t.samples[cursors[ti]].dts / t.timescale < boundary
      ) cursors[ti]++;
      if (cursors[ti] > first) {
        chunks.push({ track: ti, first, count: cursors[ti] - first, offset: 0 });
      }
    }
  }
  return chunks;
}

// Some streams stamp video at a rounded-off frame rate (23.98 for 23.976),
// which makes video drift ahead of the audio as the file plays. Audio is
// sample-locked, so it serves as the reference clock. correctFrameDurations
// declines unless the track is constant-rate and a standard rate explains the
// disagreement, so this is a no-op for well-formed streams.
function alignVideoToAudioClock(tracks) {
  const video = tracks.find((t) => t.handler === 'vide');
  const audio = tracks.find((t) => t.handler === 'soun');
  if (!video || !audio) return;

  const audioSeconds = audio.samples.reduce((n, s) => n + s.duration, 0) / audio.timescale;
  const corrected = correctFrameDurations(
    video.samples.map((s) => s.duration),
    video.timescale,
    audioSeconds
  );
  if (!corrected) return;

  let dts = video.samples[0].dts;
  for (let i = 0; i < video.samples.length; i++) {
    video.samples[i].duration = corrected[i];
    video.samples[i].dts = dts;
    dts += corrected[i];
  }
}

// Rebuilds a trak, keeping every box we don't own (stsd, hdlr, dinf, matrix,
// language) byte-for-byte and replacing only the durations and the sample table.
function rebuildTrak(buf, trak, track, movieTimescale) {
  const trackDuration = track.samples.reduce((n, s) => n + s.duration, 0);
  const inMovie = Math.round((trackDuration / track.timescale) * movieTimescale);

  const rebuilt = boxes(buf, trak.body, trak.end).map((b) => {
    if (b.type === 'tkhd') return patchDuration(buf, b, inMovie, 20, 28);
    if (b.type === 'edts') return null; // built for fragments; meaningless here
    if (b.type !== 'mdia') return buf.subarray(b.start, b.end);

    const mdia = boxes(buf, b.body, b.end).map((m) => {
      if (m.type === 'mdhd') return patchDuration(buf, m, trackDuration, 16, 24);
      if (m.type !== 'minf') return buf.subarray(m.start, m.end);

      const minf = boxes(buf, m.body, m.end).map((n) =>
        n.type === 'stbl' ? track.stbl : buf.subarray(n.start, n.end)
      );
      return box('minf', ...minf);
    });
    return box('mdia', ...mdia);
  });

  return box('trak', ...rebuilt.filter(Boolean));
}

// tkhd and mdhd both hold a duration whose offset depends on the box version.
function patchDuration(buf, b, duration, offsetV0, offsetV1) {
  const copy = buf.slice(b.start, b.end);
  const version = copy[8];
  const at = (b.body - b.start) + (version === 1 ? offsetV1 : offsetV0);
  if (version === 1) {
    writeU32(copy, at, Math.floor(duration / 0x100000000));
    writeU32(copy, at + 4, duration >>> 0);
  } else {
    writeU32(copy, at, duration);
  }
  return copy;
}

export function fragmentedToProgressive(input) {
  const buf = input;
  const top = boxes(buf, 0, buf.length);

  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('no moov box; not an MP4');
  if (!top.some((b) => b.type === 'moof')) return buf; // already progressive

  const samplesByTrack = readFragments(buf, top);
  if (samplesByTrack.size === 0) throw new Error('no fragment samples found');

  const mvhd = child(buf, moov, 'mvhd');
  const movieTimescale = mvhd
    ? (buf[mvhd.body] === 1 ? u32(buf, mvhd.body + 20) : u32(buf, mvhd.body + 12))
    : 1000;

  // Pair each moov trak with the samples its fragments carried.
  const trakBoxes = boxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak');
  const tracks = [];
  for (const trak of trakBoxes) {
    const tkhd = child(buf, trak, 'tkhd');
    const mdhd = descend(buf, trak, ['mdia', 'mdhd']);
    if (!tkhd || !mdhd) continue;
    const version = buf[tkhd.body];
    const trackId = version === 1 ? u32(buf, tkhd.body + 20) : u32(buf, tkhd.body + 12);
    const timescale = buf[mdhd.body] === 1 ? u32(buf, mdhd.body + 20) : u32(buf, mdhd.body + 12);
    const samples = samplesByTrack.get(trackId) || [];
    if (samples.length === 0) continue;
    const hdlr = descend(buf, trak, ['mdia', 'hdlr']);
    const handler = hdlr ? typeAt(buf, hdlr.body + 8) : '';
    tracks.push({ trak, trackId, timescale, samples, handler });
  }
  if (tracks.length === 0) throw new Error('no track had any samples');

  alignVideoToAudioClock(tracks);

  const chunks = planChunks(tracks);

  // Lay out mdat, recording where each chunk lands relative to the payload.
  let payloadSize = 0;
  for (const c of chunks) {
    c.offset = payloadSize;
    const { samples } = tracks[c.track];
    for (let i = c.first; i < c.first + c.count; i++) payloadSize += samples[i].size;
  }

  const movieDuration = Math.max(
    ...tracks.map((t) => {
      const ticks = t.samples.reduce((n, s) => n + s.duration, 0);
      return Math.round((ticks / t.timescale) * movieTimescale);
    })
  );

  // Chunk offsets are absolute, but they depend on moov's size, which depends
  // on the offsets. Build it twice: the first pass only exists to measure, and
  // because offsets are fixed-width the second pass has identical length.
  const buildMoov = (base) => {
    for (const track of tracks) {
      const mine = chunks.filter((c) => tracks[c.track].trackId === track.trackId);
      const parts = [
        buf.subarray(...stsdRange(buf, track.trak)),
        buildStts(track.samples),
        buildStsc(mine),
        buildStsz(track.samples),
        buildStco(mine, base),
      ];
      const ctts = buildCtts(track.samples);
      const stss = buildStss(track.samples);
      if (stss) parts.splice(2, 0, stss);
      if (ctts) parts.splice(2, 0, ctts);
      track.stbl = box('stbl', ...parts);
    }

    const parts = boxes(buf, moov.body, moov.end)
      .map((b) => {
        if (b.type === 'mvhd') return patchDuration(buf, b, movieDuration, 16, 24);
        if (b.type === 'mvex') return null; // describes fragments; there are none now
        if (b.type !== 'trak') return buf.subarray(b.start, b.end);
        const track = tracks.find((t) => t.trak.start === b.start);
        return track ? rebuildTrak(buf, b, track, movieTimescale) : null;
      })
      .filter(Boolean);
    return box('moov', ...parts);
  };

  const ftypBytes = ftyp ? buf.subarray(ftyp.start, ftyp.end) : box('ftyp',
    new Uint8Array([...TYPE_BYTES('isom'), 0, 0, 0, 1, ...TYPE_BYTES('isom'), ...TYPE_BYTES('avc1')]));

  const payloadStart = ftypBytes.length + buildMoov(0).length + 8;
  if (payloadStart + payloadSize > MAX_OFFSET) {
    throw new Error('file too large for 32-bit chunk offsets');
  }
  const newMoov = buildMoov(payloadStart);
  const mdatStart = ftypBytes.length + newMoov.length;
  if (mdatStart + 8 !== payloadStart) {
    throw new Error('moov size changed between passes');
  }

  const out = new Uint8Array(payloadStart + payloadSize);
  out.set(ftypBytes, 0);
  out.set(newMoov, ftypBytes.length);
  writeU32(out, mdatStart, 8 + payloadSize);
  out.set(TYPE_BYTES('mdat'), mdatStart + 4);

  let at = payloadStart;
  for (const c of chunks) {
    const { samples } = tracks[c.track];
    for (let i = c.first; i < c.first + c.count; i++) {
      const s = samples[i];
      out.set(buf.subarray(s.offset, s.offset + s.size), at);
      at += s.size;
    }
  }
  return out;
}

function stsdRange(buf, trak) {
  const stsd = descend(buf, trak, ['mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) throw new Error('track has no sample description');
  return [stsd.start, stsd.end];
}

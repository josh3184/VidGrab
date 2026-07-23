// Minimal, dependency-free MP4 box reader used only by tests.
//
// Deliberately a separate implementation from lib/mp4.js: the tests should fail
// if the writer and this reader disagree about the file format, which they
// wouldn't if both sides shared the same parsing code.

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts',
  'dinf', 'moof', 'traf', 'mfra', 'udta',
]);

const type = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);

// Boxes directly inside [start, end), each as {type, start, end, body}.
// `body` is the offset of the first byte after the box header.
export function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(buf, pos);
    const t = type(buf, pos + 4);
    let body = pos + 8;
    if (size === 1) {
      size = u64(buf, pos + 8);
      body = pos + 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < 8 || pos + size > end) break;
    out.push({ type: t, start: pos, end: pos + size, body });
    pos += size;
  }
  return out;
}

// findAll(buf, 'moov/trak/mdia') -> every box matching that path.
export function findAll(buf, path) {
  const parts = path.split('/');
  let level = boxes(buf);
  for (let i = 0; i < parts.length; i++) {
    const matches = level.filter((b) => b.type === parts[i]);
    if (i === parts.length - 1) return matches;
    level = matches.flatMap((b) =>
      CONTAINERS.has(b.type) ? boxes(buf, b.body, b.end) : []
    );
  }
  return [];
}

export function find(buf, path) {
  return findAll(buf, path)[0] || null;
}

export const topLevelTypes = (buf) => boxes(buf).map((b) => b.type);

// --- Typed readers for the boxes the tests assert on -------------------------

export function readMvhd(buf) {
  const box = find(buf, 'moov/mvhd');
  if (!box) return null;
  const v = buf[box.body];
  const o = box.body + 4; // skip version+flags
  return v === 1
    ? { version: v, timescale: u32(buf, o + 16), duration: u64(buf, o + 20) }
    : { version: v, timescale: u32(buf, o + 8), duration: u32(buf, o + 12) };
}

export function readTkhd(trakBuf, buf, trak) {
  const box = boxes(buf, trak.body, trak.end).find((b) => b.type === 'tkhd');
  const v = buf[box.body];
  const o = box.body + 4;
  return v === 1
    ? { trackId: u32(buf, o + 16), duration: u64(buf, o + 24) }
    : { trackId: u32(buf, o + 8), duration: u32(buf, o + 16) };
}

export function readMdhd(buf, trak) {
  const box = findIn(buf, trak, ['mdia', 'mdhd']);
  const v = buf[box.body];
  const o = box.body + 4;
  return v === 1
    ? { timescale: u32(buf, o + 16), duration: u64(buf, o + 20) }
    : { timescale: u32(buf, o + 8), duration: u32(buf, o + 12) };
}

export function handlerOf(buf, trak) {
  const hdlr = findIn(buf, trak, ['mdia', 'hdlr']);
  return type(buf, hdlr.body + 8);
}

export function findIn(buf, box, path) {
  let cur = box;
  for (const name of path) {
    const next = boxes(buf, cur.body, cur.end).find((b) => b.type === name);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

export function stblOf(buf, trak) {
  return findIn(buf, trak, ['mdia', 'minf', 'stbl']);
}

export function stblChildren(buf, trak) {
  const stbl = stblOf(buf, trak);
  return stbl ? boxes(buf, stbl.body, stbl.end).map((b) => b.type) : [];
}

// Entry counts / contents for the sample tables.
export function readStsz(buf, trak) {
  const b = findIn(buf, stblOf(buf, trak), []) && boxes(buf, stblOf(buf, trak).body, stblOf(buf, trak).end).find((x) => x.type === 'stsz');
  const uniform = u32(buf, b.body + 4);
  const count = u32(buf, b.body + 8);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    sizes.push(uniform !== 0 ? uniform : u32(buf, b.body + 12 + i * 4));
  }
  return { count, uniform, sizes };
}

function stblBox(buf, trak, name) {
  const stbl = stblOf(buf, trak);
  return boxes(buf, stbl.body, stbl.end).find((x) => x.type === name) || null;
}

export function readStts(buf, trak) {
  const b = stblBox(buf, trak, 'stts');
  const n = u32(buf, b.body + 4);
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ count: u32(buf, b.body + 8 + i * 8), delta: u32(buf, b.body + 12 + i * 8) });
  }
  return entries;
}

export function readStss(buf, trak) {
  const b = stblBox(buf, trak, 'stss');
  if (!b) return null;
  const n = u32(buf, b.body + 4);
  const out = [];
  for (let i = 0; i < n; i++) out.push(u32(buf, b.body + 8 + i * 4));
  return out;
}

export function readStco(buf, trak) {
  const b = stblBox(buf, trak, 'stco');
  const n = u32(buf, b.body + 4);
  const out = [];
  for (let i = 0; i < n; i++) out.push(u32(buf, b.body + 8 + i * 4));
  return out;
}

export function readStsc(buf, trak) {
  const b = stblBox(buf, trak, 'stsc');
  const n = u32(buf, b.body + 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = b.body + 8 + i * 12;
    out.push({ firstChunk: u32(buf, o), samplesPerChunk: u32(buf, o + 4), descIndex: u32(buf, o + 8) });
  }
  return out;
}

export function readCtts(buf, trak) {
  const b = stblBox(buf, trak, 'ctts');
  if (!b) return null;
  const version = buf[b.body];
  const n = u32(buf, b.body + 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = b.body + 8 + i * 8;
    const raw = u32(buf, o + 4);
    out.push({ count: u32(buf, o), offset: version === 1 ? (raw | 0) : raw });
  }
  return out;
}

export const traks = (buf) => findAll(buf, 'moov/trak');

// Flattens stsc/stco/stsz into one absolute byte offset per sample, which is
// how a player locates sample data. Used to prove the rewritten offsets point
// at the right bytes.
export function sampleOffsets(buf, trak) {
  const stsc = readStsc(buf, trak);
  const stco = readStco(buf, trak);
  const { sizes } = readStsz(buf, trak);
  const offsets = [];
  let sample = 0;
  for (let chunk = 0; chunk < stco.length && sample < sizes.length; chunk++) {
    let run = stsc[0].samplesPerChunk;
    for (let i = stsc.length - 1; i >= 0; i--) {
      if (chunk + 1 >= stsc[i].firstChunk) { run = stsc[i].samplesPerChunk; break; }
    }
    let at = stco[chunk];
    for (let i = 0; i < run && sample < sizes.length; i++) {
      offsets.push(at);
      at += sizes[sample];
      sample++;
    }
  }
  return offsets;
}

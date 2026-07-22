// Transmux MPEG-TS (H.264 video + AAC audio) into fragmented MP4, in memory,
// without re-encoding. Lossless container rewrap.
//
// Relies on the vendored mux.js MP4 bundle (lib/vendor/muxjs-mp4.min.js) having
// been loaded first as a classic script, which sets `globalThis.muxjs`. The
// mp4-only bundle hoists the transmuxer to `muxjs.Transmuxer`; the full bundle
// exposes it at `muxjs.mp4.Transmuxer` — we accept either.

function getTransmuxer() {
  const muxjs = globalThis.muxjs;
  const Transmuxer = muxjs && (muxjs.Transmuxer || (muxjs.mp4 && muxjs.mp4.Transmuxer));
  if (!Transmuxer) throw new Error('mux.js transmuxer not loaded');
  return Transmuxer;
}

// Accepts a single Uint8Array or an array of Uint8Arrays (e.g. the ordered HLS
// segments). Segments are pushed in order and flushed once, so no giant
// concatenated buffer is held. Returns the fMP4 as a Uint8Array.
// Throws if the stream can't be transmuxed (e.g. HEVC or unexpected codec),
// so callers can fall back to saving the raw .ts.
export function tsToMp4(input) {
  const Transmuxer = getTransmuxer();
  const parts = input instanceof Uint8Array ? [input] : input;

  const transmuxer = new Transmuxer({ remux: true });
  const chunks = [];
  let initSegment = null;

  transmuxer.on('data', (segment) => {
    if (initSegment === null) initSegment = segment.initSegment;
    chunks.push(segment.data);
  });

  // mux.js emits its output synchronously during push()/flush().
  for (const part of parts) transmuxer.push(part);
  transmuxer.flush();

  if (initSegment === null || chunks.length === 0) {
    throw new Error('transmux produced no output (unsupported codec?)');
  }

  let total = initSegment.byteLength;
  for (const chunk of chunks) total += chunk.byteLength;

  const out = new Uint8Array(total);
  out.set(initSegment, 0);
  let offset = initSegment.byteLength;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

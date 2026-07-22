// Minimal HLS (m3u8) playlist parser. No dependencies; used by the offscreen
// document and by the Node test suite.

// Parses an attribute list like: BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
export function parseAttributes(str) {
  const attrs = {};
  let i = 0;
  while (i < str.length) {
    const eq = str.indexOf('=', i);
    if (eq === -1) break;
    const key = str.slice(i, eq).trim();
    let value;
    if (str[eq + 1] === '"') {
      const end = str.indexOf('"', eq + 2);
      value = str.slice(eq + 2, end === -1 ? str.length : end);
      i = (end === -1 ? str.length : end + 1);
      if (str[i] === ',') i++;
    } else {
      let end = str.indexOf(',', eq + 1);
      if (end === -1) end = str.length;
      value = str.slice(eq + 1, end).trim();
      i = end + 1;
    }
    attrs[key] = value;
  }
  return attrs;
}

export function resolveUrl(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

// Parses "0x1234..." into a 16-byte Uint8Array, or null.
export function parseHexIv(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^0x/i, '').padStart(32, '0');
  if (!/^[0-9a-f]{32}$/i.test(clean)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// 16-byte big-endian IV derived from a segment's media sequence number
// (the HLS default when no IV attribute is present).
export function sequenceIv(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

// Parses "<length>[@<offset>]". prevEnd is used when offset is omitted.
function parseByteRange(value, prevEnd) {
  const [len, off] = value.split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
  return { offset, length };
}

// Returns either:
//   { kind: 'master', variants: [...], audioRenditions: [...] }
//   { kind: 'media', segments: [...], map, endList, targetDuration, totalDuration }
export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines[0] !== '#EXTM3U') {
    throw new Error('Not an m3u8 playlist');
  }

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audioRenditions = [];
  let pendingStreamInf = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingStreamInf = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO') {
        audioRenditions.push({
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
        });
      }
    } else if (!line.startsWith('#') && pendingStreamInf) {
      const a = pendingStreamInf;
      let width = 0;
      let height = 0;
      if (a.RESOLUTION) {
        const m = a.RESOLUTION.match(/^(\d+)x(\d+)$/i);
        if (m) {
          width = parseInt(m[1], 10);
          height = parseInt(m[2], 10);
        }
      }
      variants.push({
        uri: resolveUrl(line, baseUrl),
        bandwidth: a.BANDWIDTH ? parseInt(a.BANDWIDTH, 10) : 0,
        width,
        height,
        codecs: a.CODECS || '',
        frameRate: a['FRAME-RATE'] ? parseFloat(a['FRAME-RATE']) : 0,
        audioGroup: a.AUDIO || null,
      });
      pendingStreamInf = null;
    }
  }

  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return { kind: 'master', variants, audioRenditions };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let map = null;
  let endList = false;
  let targetDuration = 0;
  let totalDuration = 0;
  let mediaSequence = 0;
  let currentKey = null; // { method, uri, iv }
  let pendingDuration = 0;
  let pendingByteRange = null;
  let prevRangeEnd = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (a.METHOD === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method: a.METHOD,
          uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
          iv: parseHexIv(a.IV),
        };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      map = {
        uri: resolveUrl(a.URI, baseUrl),
        byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null,
      };
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), prevRangeEnd);
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const seg = {
        uri: resolveUrl(line, baseUrl),
        duration: pendingDuration,
        key: currentKey,
        byteRange: pendingByteRange,
        mediaSequence: mediaSequence + segments.length,
      };
      if (pendingByteRange) prevRangeEnd = pendingByteRange.offset + pendingByteRange.length;
      totalDuration += pendingDuration;
      segments.push(seg);
      pendingDuration = 0;
      pendingByteRange = null;
    }
  }

  return { kind: 'media', segments, map, endList, targetDuration, totalDuration };
}

// True if the playlist uses an encryption method we cannot handle
// (SAMPLE-AES and anything DRM-based; plain AES-128 is supported).
export function hasUnsupportedEncryption(media) {
  return media.segments.some(
    (s) => s.key && s.key.method !== 'AES-128'
  );
}

// Heights CDNs commonly bake into a path/filename, most-specific first.
const KNOWN_HEIGHTS = [4320, 2160, 1440, 1080, 720, 576, 540, 480, 360, 240, 144];

// Best-effort quality guess from a bare variant-playlist URL, for when there is
// no master to read RESOLUTION/BANDWIDTH from. Returns { height, bitrateKbps },
// each 0 when nothing recognizable is present. Deliberately conservative: it
// only trusts digits in unambiguous quality positions (WxH, an "NNNp" marker,
// a known height bounded by separators, or an "NNNNk" bitrate marker) so that
// dates, ids and random tokens don't masquerade as quality.
export function qualityHintFromUrl(url) {
  let height = 0;
  let bitrateKbps = 0;
  try {
    const u = new URL(url);
    const s = decodeURIComponent(u.pathname + u.search);
    let m = s.match(/(\d{2,4})[xX](\d{2,4})/);
    if (m) height = parseInt(m[2], 10);
    if (!height) {
      m = s.match(/(?:^|[^0-9])(\d{3,4})[pP](?![0-9])/);
      if (m) height = parseInt(m[1], 10);
    }
    if (!height) {
      for (const h of KNOWN_HEIGHTS) {
        if (new RegExp(`(?:^|[/_.\\-])${h}(?:[/_.\\-p]|$)`).test(s)) {
          height = h;
          break;
        }
      }
    }
    m = s.match(/(?:^|[^0-9])(\d{3,5})k(?:bps)?(?![0-9a-z])/i);
    if (m) bitrateKbps = parseInt(m[1], 10);
  } catch {
    // Not a URL; leave the hint empty.
  }
  return { height, bitrateKbps };
}

// Pick the leading segments of a media playlist to measure for a bitrate
// estimate: enough to cover targetSeconds, capped at maxSegments. byteRangeLength
// is the segment's size when the playlist declares it (fMP4 byteranges), letting
// the caller skip a network probe for that segment.
export function sampleForBitrate(media, targetSeconds = 8, maxSegments = 3) {
  if (!media || media.kind !== 'media' || !Array.isArray(media.segments)) {
    return { segments: [], seconds: 0 };
  }
  const segments = [];
  let seconds = 0;
  for (const seg of media.segments) {
    if (!seg.duration) continue;
    segments.push({
      uri: seg.uri,
      duration: seg.duration,
      byteRangeLength: seg.byteRange ? seg.byteRange.length : 0,
    });
    seconds += seg.duration;
    if (seconds >= targetSeconds || segments.length >= maxSegments) break;
  }
  return { segments, seconds };
}

// Average bitrate in kbps for `bytes` transferred over `seconds` of media.
export function bitrateKbps(bytes, seconds) {
  if (!bytes || !seconds) return 0;
  return Math.round((bytes * 8) / seconds / 1000);
}

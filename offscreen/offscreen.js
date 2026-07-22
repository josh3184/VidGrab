// VidGrab offscreen worker: downloads HLS streams (playlist -> segments ->
// single file) off the popup's lifecycle. Talks to the service worker only.

import {
  parsePlaylist,
  sequenceIv,
  hasUnsupportedEncryption,
} from '../lib/m3u8.js';
import { tsToMp4 } from '../lib/transmux.js';

// Hard cap on assembled output; blobs live in memory.
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const SEGMENT_CONCURRENCY = 4;
const SEGMENT_RETRIES = 2;

const activeJobs = new Map(); // jobId -> AbortController

function toSW(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'sw' }).catch(() => {});
}

async function fetchWithRetry(url, { signal, byteRange, retries = SEGMENT_RETRIES }) {
  const headers = {};
  if (byteRange) {
    headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal, headers, credentials: 'include' });
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist`);
  return res.text();
}

// --- AES-128 (whole-segment AES-CBC, the standard HLS encryption) -----------

const keyCache = new Map();

async function getKey(uri, signal) {
  if (!keyCache.has(uri)) {
    const raw = await fetchWithRetry(uri, { signal });
    const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    keyCache.set(uri, key);
  }
  return keyCache.get(uri);
}

async function maybeDecrypt(data, seg, signal) {
  if (!seg.key) return data;
  if (seg.key.method !== 'AES-128') {
    throw new Error(`Unsupported encryption: ${seg.key.method}`);
  }
  const key = await getKey(seg.key.uri, signal);
  const iv = seg.key.iv || sequenceIv(seg.mediaSequence);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
  return new Uint8Array(plain);
}

// --- Playlist inspection (popup asks "what qualities exist?") ---------------

async function inspect(url) {
  const text = await fetchText(url);
  const playlist = parsePlaylist(text, url);
  if (playlist.kind === 'master') {
    return {
      ok: true,
      kind: 'master',
      variants: playlist.variants.map((v) => ({
        uri: v.uri,
        bandwidth: v.bandwidth,
        width: v.width,
        height: v.height,
        codecs: v.codecs,
        audioGroup: v.audioGroup,
      })),
      audioRenditions: playlist.audioRenditions,
    };
  }
  if (hasUnsupportedEncryption(playlist)) {
    return { ok: false, error: 'Stream is DRM-protected or uses unsupported encryption.' };
  }
  return {
    ok: true,
    kind: 'media',
    segmentCount: playlist.segments.length,
    duration: Math.round(playlist.totalDuration),
    live: !playlist.endList,
  };
}

// --- Download job ------------------------------------------------------------

// Picks the audio rendition URI to also download, if the chosen variant uses
// a separate (demuxed) audio group.
function pickAudioUri(variant, audioRenditions) {
  if (!variant || !variant.audioGroup) return null;
  const group = audioRenditions.filter((r) => r.groupId === variant.audioGroup && r.uri);
  if (group.length === 0) return null;
  const def = group.find((r) => r.isDefault);
  return (def || group[0]).uri;
}

async function downloadMediaPlaylist(url, jobId, signal, progressBase) {
  const text = await fetchText(url, signal);
  let playlist = parsePlaylist(text, url);

  if (playlist.kind === 'master') {
    // Caller handed us a master directly: take the best variant.
    const best = playlist.variants[0];
    if (!best) throw new Error('Master playlist has no variants');
    return downloadMediaPlaylist(best.uri, jobId, signal, progressBase);
  }
  if (playlist.segments.length === 0) throw new Error('Playlist has no segments');
  if (!playlist.endList) {
    throw new Error('This is a live stream (no end marker); saving live streams is not supported.');
  }
  if (hasUnsupportedEncryption(playlist)) {
    throw new Error('Stream is DRM-protected or uses unsupported encryption (not AES-128).');
  }

  const total = playlist.segments.length + (playlist.map ? 1 : 0);
  const parts = new Array(playlist.segments.length);
  let initPart = null;
  let loaded = 0;
  let bytes = 0;

  const reportProgress = () => {
    toSW({
      type: 'job-progress',
      jobId,
      phase: progressBase.phase,
      loadedSegments: progressBase.offsetLoaded + loaded,
      totalSegments: progressBase.offsetTotal + total,
      bytes: progressBase.offsetBytes + bytes,
    });
  };

  if (playlist.map) {
    initPart = await fetchWithRetry(playlist.map.uri, {
      signal,
      byteRange: playlist.map.byteRange,
    });
    loaded++;
    bytes += initPart.byteLength;
    reportProgress();
  }

  // Bounded-concurrency segment fetch, results kept in order.
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(SEGMENT_CONCURRENCY, playlist.segments.length) },
    async () => {
      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const i = nextIndex++;
        if (i >= playlist.segments.length) return;
        const seg = playlist.segments[i];
        let data = await fetchWithRetry(seg.uri, { signal, byteRange: seg.byteRange });
        data = await maybeDecrypt(data, seg, signal);
        parts[i] = data;
        loaded++;
        bytes += data.byteLength;
        if (progressBase.offsetBytes + bytes > MAX_BYTES) {
          throw new Error('Stream exceeds the 2 GB size limit.');
        }
        if (loaded % 5 === 0 || loaded === total) reportProgress();
      }
    }
  );
  await Promise.all(workers);

  // Container detection + output shaping:
  //   fMP4 (init segment or ftyp/styp box) -> pass through as .mp4
  //   MPEG-TS (0x47 sync byte)             -> transmux to fMP4, or fall back to
  //                                           the raw .ts if transmux fails
  //   anything else                        -> .bin
  const first = initPart || parts[0];

  if (initPart || looksLikeMp4(first)) {
    const blobParts = initPart ? [initPart, ...parts] : parts;
    return { blob: new Blob(blobParts, { type: 'video/mp4' }), ext: 'mp4', bytes, segments: total };
  }

  if (first && first[0] === 0x47) {
    try {
      const mp4 = tsToMp4(parts);
      return { blob: new Blob([mp4], { type: 'video/mp4' }), ext: 'mp4', bytes: mp4.byteLength, segments: total };
    } catch (e) {
      // Couldn't transmux (e.g. HEVC or unexpected codec) — keep the raw .ts so
      // the download is never lost; it can be converted later with ffmpeg.
      console.warn('VidGrab: TS->MP4 transmux failed, saving raw .ts:', e);
      return { blob: new Blob(parts, { type: 'video/mp2t' }), ext: 'ts', bytes, segments: total };
    }
  }

  return { blob: new Blob(parts, { type: 'application/octet-stream' }), ext: 'bin', bytes, segments: total };
}

function looksLikeMp4(data) {
  if (!data || data.length < 12) return false;
  const tag = String.fromCharCode(data[4], data[5], data[6], data[7]);
  return tag === 'ftyp' || tag === 'styp' || tag === 'moof';
}

async function runJob({ jobId, url, variant, audioUri, baseName }) {
  const controller = new AbortController();
  activeJobs.set(jobId, controller);
  const signal = controller.signal;

  try {
    let mediaUrl = url;
    let separateAudioUri = audioUri;

    // If we were given the master URL and a chosen variant, use the variant.
    if (variant && variant.uri) {
      mediaUrl = variant.uri;
    } else {
      // No variant chosen (single-quality stream or direct media playlist).
      // If it turns out to be a master, resolve best variant + audio here.
      const text = await fetchText(url, signal);
      const playlist = parsePlaylist(text, url);
      if (playlist.kind === 'master') {
        const best = playlist.variants[0];
        if (!best) throw new Error('Master playlist has no variants');
        mediaUrl = best.uri;
        separateAudioUri = pickAudioUri(best, playlist.audioRenditions);
      }
    }

    const video = await downloadMediaPlaylist(mediaUrl, jobId, signal, {
      phase: 'video',
      offsetLoaded: 0,
      offsetTotal: 0,
      offsetBytes: 0,
    });

    const videoBlobUrl = URL.createObjectURL(video.blob);
    await toSW({
      type: 'job-file-ready',
      jobId,
      blobUrl: videoBlobUrl,
      filename: `${baseName}.${video.ext}`,
    });

    let note = '';
    if (separateAudioUri) {
      const audio = await downloadMediaPlaylist(separateAudioUri, jobId, signal, {
        phase: 'audio',
        offsetLoaded: video.segments,
        offsetTotal: video.segments,
        offsetBytes: video.bytes,
      });
      const audioExt = audio.ext === 'mp4' ? 'm4a' : audio.ext === 'ts' ? 'aac.ts' : audio.ext;
      const audioBlobUrl = URL.createObjectURL(audio.blob);
      await toSW({
        type: 'job-file-ready',
        jobId,
        blobUrl: audioBlobUrl,
        filename: `${baseName}.audio.${audioExt}`,
      });
      note =
        'Video and audio are separate files (the site streams them demuxed). ' +
        'Combine with: ffmpeg -i video -i audio -c copy out.mp4';
    }

    toSW({ type: 'job-complete', jobId, note });
  } catch (e) {
    const msg = signal.aborted
      ? 'Cancelled'
      : String(e && e.message ? e.message : e);
    toSW({ type: 'job-error', jobId, error: msg });
  } finally {
    activeJobs.delete(jobId);
  }
}

// --- Message handling ----------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  if (msg.type === 'hls-inspect') {
    inspect(msg.url)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })
      );
    return true;
  }

  if (msg.type === 'hls-start') {
    runJob(msg);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'job-cancel') {
    const controller = activeJobs.get(msg.jobId);
    if (controller) controller.abort();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'revoke-blob') {
    try {
      URL.revokeObjectURL(msg.blobUrl);
    } catch {}
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

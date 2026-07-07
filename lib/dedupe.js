// Deduplication helpers: canonical identity for detected media URLs, and
// HLS playlist classification used to fold variant playlists under their
// master. Pure functions; shared by the service worker and the test suite.

import { parsePlaylist } from './m3u8.js';

const MEDIA_EXT_PATH_RE = /\.(mp4|webm|mov|mkv|avi|flv|m4v|ogv|m3u8|mpd)$/i;

// Canonical key for an item URL. Signed CDN URLs rotate query tokens while
// pointing at the same media, so:
// - playlists/manifests (hls/dash) dedupe on origin+path
// - direct files dedupe on origin+path when the path itself names a media
//   file; otherwise the query may identify the video, so keep it
// - everything drops the hash
export function canonicalKey(url, kind) {
  try {
    const u = new URL(url);
    if (kind === 'hls' || kind === 'dash') return u.origin + u.pathname;
    if ((kind === 'file' || kind === 'page') && MEDIA_EXT_PATH_RE.test(u.pathname)) {
      return u.origin + u.pathname;
    }
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

// Classify fetched m3u8 text.
// Master:  { role: 'master', childKeys, variantCount, maxHeight }
//          childKeys are canonical keys of every variant and audio-rendition
//          playlist this master references; detections matching one of them
//          are duplicates of this stream.
// Media:   { role: 'media', duration, live }
export function classifyHlsText(text, baseUrl) {
  const p = parsePlaylist(text, baseUrl);
  if (p.kind === 'master') {
    const childKeys = [];
    for (const v of p.variants) childKeys.push(canonicalKey(v.uri, 'hls'));
    for (const a of p.audioRenditions) {
      if (a.uri) childKeys.push(canonicalKey(a.uri, 'hls'));
    }
    return {
      role: 'master',
      childKeys,
      variantCount: p.variants.length,
      maxHeight: p.variants.reduce((m, v) => Math.max(m, v.height), 0),
    };
  }
  return {
    role: 'media',
    duration: Math.round(p.totalDuration),
    live: !p.endList,
  };
}

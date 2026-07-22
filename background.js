// VidGrab background service worker.
// - Sniffs network responses for media files and stream playlists (per tab)
// - Merges in <video>-element reports from the content script
// - Dedupes: canonical URL keys + folding HLS variant playlists under masters
// - Coordinates HLS download jobs running in the offscreen document

import { canonicalKey, classifyHlsText } from './lib/dedupe.js';
import { qualityHintFromUrl, bitrateKbps } from './lib/m3u8.js';

const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|avi|flv|m4v|ogv)(\?|#|$)/i;
const SEGMENT_RE = /\.(m4s|ts|aac|m4a|mp3|vtt|srt|jpg|jpeg|png|gif|webp|init)(\?|#|$)/i;
const HLS_RE = /\.m3u8(\?|#|$)/i;
const DASH_RE = /\.mpd(\?|#|$)/i;

const VIDEO_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'video/x-msvideo', 'video/x-flv', 'video/ogg', 'video/mpeg',
]);
const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'audio/mpegurl', 'audio/x-mpegurl', 'application/mpegurl',
]);
const DASH_TYPES = new Set(['application/dash+xml']);

// Direct video files smaller than this are almost always MSE segments or
// preview thumbnails rather than a whole video; skip them.
const MIN_DIRECT_BYTES = 300 * 1024;

// tabId -> { pageUrl, pageTitle, items: Map<key, item> }
const tabMedia = new Map();
// jobId -> { id, tabId, filename, phase, loadedSegments, totalSegments, bytes, error, done }
const jobs = new Map();
let jobCounter = 0;

// ---------------------------------------------------------------------------
// Per-tab media list

function getTabState(tabId) {
  let st = tabMedia.get(tabId);
  if (!st) {
    st = { pageUrl: '', pageTitle: '', items: new Map(), childKeys: new Set() };
    tabMedia.set(tabId, st);
  }
  return st;
}

function persistTab(tabId) {
  const st = tabMedia.get(tabId);
  if (!st) return;
  chrome.storage.session.set({
    ['tab_' + tabId]: {
      pageUrl: st.pageUrl,
      pageTitle: st.pageTitle,
      items: [...st.items.values()],
      childKeys: [...st.childKeys],
    },
  });
}

async function restoreTab(tabId) {
  if (tabMedia.has(tabId)) return getTabState(tabId);
  const data = await chrome.storage.session.get('tab_' + tabId);
  const saved = data['tab_' + tabId];
  const st = getTabState(tabId);
  if (saved) {
    st.pageUrl = saved.pageUrl;
    st.pageTitle = saved.pageTitle;
    for (const item of saved.items) st.items.set(item.key, item);
    for (const k of saved.childKeys || []) st.childKeys.add(k);
  }
  return st;
}

function resetTab(tabId, newUrl) {
  tabMedia.set(tabId, {
    pageUrl: newUrl || '',
    pageTitle: '',
    items: new Map(),
    childKeys: new Set(),
  });
  chrome.storage.session.remove('tab_' + tabId);
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const st = tabMedia.get(tabId);
  const count = st
    ? [...st.items.values()].filter((i) => i.kind !== 'page' && !i.hiddenBy).length
    : 0;
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
}

function addItem(tabId, item) {
  const st = getTabState(tabId);
  const key = canonicalKey(item.url, item.kind);
  const existing = st.items.get(key);
  if (existing) {
    // Merge: keep the richest metadata; keep the newest URL (fresh tokens).
    for (const f of ['size', 'width', 'height', 'duration', 'title', 'contentType']) {
      if (!existing[f] && item[f]) existing[f] = item[f];
    }
    if (item.url !== existing.url) existing.url = item.url;
  } else {
    item.key = key;
    // A playlist referenced by an already-classified master is a duplicate.
    if (st.childKeys.has(key)) item.hiddenBy = 'master';
    st.items.set(key, item);
    if (item.kind === 'hls' && !item.hiddenBy) classifyHlsItem(tabId, key);
  }
  persistTab(tabId);
  updateBadge(tabId);
  broadcast({ type: 'media-updated', tabId });
}

// Fetch and parse a detected m3u8 (small text file) so masters gain quality
// metadata and their variant/audio playlists collapse into one entry.
async function classifyHlsItem(tabId, key) {
  const st = tabMedia.get(tabId);
  const item = st && st.items.get(key);
  if (!item || item.classified || item.hiddenBy) return;
  item.classified = true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(item.url, {
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const info = classifyHlsText(await res.text(), item.url);
    item.role = info.role;
    if (info.role === 'master') {
      item.variantCount = info.variantCount;
      item.maxHeight = info.maxHeight;
      for (const childKey of info.childKeys) {
        st.childKeys.add(childKey);
        const child = st.items.get(childKey);
        if (child && child.key !== key) child.hiddenBy = key;
      }
    } else {
      if (!item.duration) item.duration = info.duration;
      item.live = info.live;
      // Bare variant playlist: no master to read RESOLUTION/BANDWIDTH from, so
      // guess quality from the URL first (free), then refine with a measured
      // bitrate from a couple of segments. Skip live streams — their segment
      // window shifts and the estimate isn't worth the churn.
      const hint = qualityHintFromUrl(item.url);
      if (hint.height) item.height = hint.height;
      if (hint.bitrateKbps) item.estBitrateKbps = hint.bitrateKbps;
      if (!item.live) {
        const measured = await estimateBitrate(info.sample);
        if (measured) item.estBitrateKbps = measured;
      }
    }
  } catch {
    // Unreachable or unparsable playlist: leave the item as-is.
  } finally {
    persistTab(tabId);
    updateBadge(tabId);
    broadcast({ type: 'media-updated', tabId });
  }
}

// Fetch the content-length of a segment without downloading its body: try HEAD,
// then fall back to a GET whose body we abort as soon as the headers land.
async function segmentBytes(uri) {
  try {
    const res = await fetchWithTimeout(uri, { method: 'HEAD' }, 5000);
    const len = parseInt(res.headers.get('content-length'), 10);
    if (len > 0) return len;
  } catch {
    // HEAD unsupported or blocked; fall through to a ranged GET.
  }
  const controller = new AbortController();
  try {
    const res = await fetch(uri, {
      credentials: 'include',
      signal: controller.signal,
    });
    const len = parseInt(res.headers.get('content-length'), 10);
    return len > 0 ? len : 0;
  } catch {
    return 0;
  } finally {
    controller.abort(); // discard the body; we only wanted the size
  }
}

function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { credentials: 'include', ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Average bitrate (kbps) of the sampled segments, or 0 if any size is unknown.
// Byterange segments carry their own length, so those need no network probe.
async function estimateBitrate(sample) {
  if (!sample || !sample.seconds || !sample.segments.length) return 0;
  let bytes = 0;
  for (const seg of sample.segments) {
    const size = seg.byteRangeLength || (await segmentBytes(seg.uri));
    if (!size) return 0; // one unknown size makes the whole estimate unreliable
    bytes += size;
  }
  return bitrateKbps(bytes, sample.seconds);
}

// ---------------------------------------------------------------------------
// Network sniffing

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return; // extension/offscreen fetches, workers
    const rawType = headerValue(details.responseHeaders, 'content-type')
      .split(';')[0].trim().toLowerCase();
    const size = parseInt(headerValue(details.responseHeaders, 'content-length'), 10) || 0;
    const url = details.url;

    let kind = null;
    if (HLS_TYPES.has(rawType) || HLS_RE.test(url)) {
      kind = 'hls';
    } else if (DASH_TYPES.has(rawType) || DASH_RE.test(url)) {
      kind = 'dash';
    } else if (
      (VIDEO_TYPES.has(rawType) || VIDEO_EXT_RE.test(url)) &&
      !SEGMENT_RE.test(url)
    ) {
      // Range responses (206) for the same URL come through repeatedly while
      // a player scrubs; they dedupe on URL. Tiny files are segments/posters.
      if (size > 0 && size < MIN_DIRECT_BYTES && details.statusCode === 200) return;
      kind = 'file';
    }
    if (!kind) return;

    addItem(details.tabId, {
      kind,
      url,
      contentType: rawType,
      size: details.statusCode === 200 ? size : 0,
      source: 'network',
      title: '',
      width: 0,
      height: 0,
      duration: 0,
      foundAt: Date.now(),
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

// ---------------------------------------------------------------------------
// Tab lifecycle

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const st = tabMedia.get(tabId);
    // Real navigation (not just a hash change / SPA pushState) clears the list.
    const oldBase = st ? st.pageUrl.split('#')[0] : null;
    if (!st || oldBase !== changeInfo.url.split('#')[0]) {
      resetTab(tabId, changeInfo.url);
    }
  }
  if (tab && tab.title) {
    const st = tabMedia.get(tabId);
    if (st) st.pageTitle = tab.title;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId);
});

// ---------------------------------------------------------------------------
// Offscreen document management

let offscreenReady = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['BLOBS'],
        justification:
          'Assemble HLS stream segments into a single video file for download',
      })
      .finally(() => {
        offscreenReady = null;
      });
  }
  await offscreenReady;
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

function broadcast(msg) {
  // Fire-and-forget to popup (it may be closed; ignore the error).
  chrome.runtime.sendMessage({ ...msg, target: 'popup' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Downloads

function sanitizeFilename(name) {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video'
  );
}

function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const base = path.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(base);
  } catch {
    return '';
  }
}

async function downloadDirect(item, tabId) {
  const st = tabMedia.get(tabId);
  let filename = filenameFromUrl(item.url);
  if (!filename || !/\.[a-z0-9]{2,4}$/i.test(filename)) {
    const ext = (item.contentType || '').includes('webm') ? 'webm' : 'mp4';
    filename = sanitizeFilename(item.title || (st && st.pageTitle) || 'video') + '.' + ext;
  } else {
    filename = sanitizeFilename(filename.replace(/\.[a-z0-9]{2,4}$/i, '')) +
      filename.match(/\.[a-z0-9]{2,4}$/i)[0];
  }
  try {
    const id = await chrome.downloads.download({
      url: item.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return { ok: true, downloadId: id, filename };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function startHlsJob({ url, variant, audioUri, title, tabId }) {
  await ensureOffscreen();
  const jobId = 'job' + ++jobCounter + '_' + Date.now();
  const st = tabMedia.get(tabId);
  const baseName = sanitizeFilename(title || (st && st.pageTitle) || 'stream');
  const job = {
    id: jobId,
    tabId,
    filename: baseName,
    phase: 'starting',
    loadedSegments: 0,
    totalSegments: 0,
    bytes: 0,
    error: null,
    done: false,
  };
  jobs.set(jobId, job);
  sendToOffscreen({
    type: 'hls-start',
    jobId,
    url,
    variant: variant || null,
    audioUri: audioUri || null,
    baseName,
  }).catch((e) => {
    job.error = String(e);
    job.done = true;
    broadcast({ type: 'job-updated', job });
  });
  broadcast({ type: 'job-updated', job });
  return jobId;
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
  });
}

// ---------------------------------------------------------------------------
// Message routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // --- from content scripts -------------------------------------------------
  if (msg.type === 'page-media' && sender.tab) {
    const tabId = sender.tab.id;
    const st = getTabState(tabId);
    if (sender.frameId === 0) {
      st.pageUrl = msg.pageUrl || st.pageUrl;
      st.pageTitle = msg.pageTitle || st.pageTitle;
    }
    for (const v of msg.items || []) {
      const isHttp = /^https?:/i.test(v.url || '');
      let kind = 'page';
      if (isHttp) {
        if (HLS_RE.test(v.url)) kind = 'hls';
        else if (DASH_RE.test(v.url)) kind = 'dash';
        else kind = 'file';
      }
      addItem(tabId, {
        kind,
        url: v.url,
        contentType: v.contentType || '',
        size: 0,
        source: 'dom',
        title: v.title || msg.pageTitle || '',
        width: v.width || 0,
        height: v.height || 0,
        duration: v.duration || 0,
        foundAt: Date.now(),
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // --- from the offscreen document ------------------------------------------
  if (msg.target === 'sw' && msg.type === 'job-progress') {
    const job = jobs.get(msg.jobId);
    if (job) {
      Object.assign(job, {
        phase: msg.phase,
        loadedSegments: msg.loadedSegments,
        totalSegments: msg.totalSegments,
        bytes: msg.bytes,
      });
      broadcast({ type: 'job-updated', job });
    }
    return false;
  }

  if (msg.target === 'sw' && msg.type === 'job-file-ready') {
    const job = jobs.get(msg.jobId);
    if (job) {
      job.files = job.files || [];
      job.files.push(msg.filename);
    }
    (async () => {
      try {
        await chrome.downloads.download({
          url: msg.blobUrl,
          filename: msg.filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        // Give the download pipeline time to open the blob before revoking.
        setTimeout(() => {
          sendToOffscreen({ type: 'revoke-blob', blobUrl: msg.blobUrl }).catch(() => {});
        }, 60000);
      } catch (e) {
        if (job) {
          job.error = 'Download failed: ' + String(e && e.message ? e.message : e);
          job.done = true;
          broadcast({ type: 'job-updated', job });
        }
      }
    })();
    return false;
  }

  if (msg.target === 'sw' && msg.type === 'job-complete') {
    const job = jobs.get(msg.jobId);
    if (job) {
      job.done = true;
      job.phase = 'done';
      job.note = msg.note || '';
      broadcast({ type: 'job-updated', job });
      notify('VidGrab: download ready', job.filename + (msg.note ? ' — ' + msg.note : ''));
    }
    return false;
  }

  if (msg.target === 'sw' && msg.type === 'job-error') {
    const job = jobs.get(msg.jobId);
    if (job) {
      job.error = msg.error;
      job.done = true;
      broadcast({ type: 'job-updated', job });
      notify('VidGrab: download failed', msg.error);
    }
    return false;
  }

  // --- from the popup ---------------------------------------------------------
  if (msg.type === 'get-media') {
    (async () => {
      const st = await restoreTab(msg.tabId);
      updateBadge(msg.tabId);
      sendResponse({
        pageUrl: st.pageUrl,
        pageTitle: st.pageTitle,
        items: [...st.items.values()].sort((a, b) => a.foundAt - b.foundAt),
        jobs: [...jobs.values()].filter((j) => j.tabId === msg.tabId),
      });
    })();
    return true;
  }

  if (msg.type === 'rescan') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'rescan' }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'download-direct') {
    downloadDirect(msg.item, msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'hls-inspect') {
    (async () => {
      try {
        await ensureOffscreen();
        const res = await sendToOffscreen({ type: 'hls-inspect', url: msg.url });
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg.type === 'hls-download') {
    startHlsJob(msg).then((jobId) => sendResponse({ ok: true, jobId }));
    return true;
  }

  if (msg.type === 'job-cancel') {
    sendToOffscreen({ type: 'job-cancel', jobId: msg.jobId }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

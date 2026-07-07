// VidGrab popup: shows detected media for the active tab, one download
// button per item. HLS items get an inline quality picker when the stream
// offers multiple variants.

let tabId = null;
let items = [];
let jobs = [];
const rowState = new Map(); // item.key -> { error, note, variants, busy }

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const jobsEl = document.getElementById('jobs');
const statusEl = document.getElementById('status');

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return n.toFixed(n >= 10 || u === 0 ? 0 : 1) + ' ' + units[u];
}

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function displayName(item) {
  if (item.title) return item.title;
  try {
    const base = decodeURIComponent(
      new URL(item.url).pathname.split('/').filter(Boolean).pop() || ''
    );
    if (base) return base;
  } catch {}
  return item.url;
}

const KIND_LABEL = {
  file: (item) => {
    const m = item.url.match(/\.(mp4|webm|mov|mkv|m4v|ogv|avi|flv)(\?|#|$)/i);
    if (m) return m[1].toUpperCase();
    if ((item.contentType || '').startsWith('video/')) {
      return item.contentType.split('/')[1].toUpperCase().slice(0, 5);
    }
    return 'VIDEO';
  },
  hls: () => 'HLS',
  dash: () => 'DASH',
  page: () => 'PLAYER',
};

// ---------------------------------------------------------------------------
// Rendering

function render() {
  // Jobs panel
  jobsEl.replaceChildren();
  const visibleJobs = jobs.filter((j) => !j.done || j.error || j.note);
  jobsEl.hidden = visibleJobs.length === 0;
  for (const job of visibleJobs) {
    const el = document.createElement('div');
    el.className = 'job';

    const row = document.createElement('div');
    row.className = 'job-row';
    const name = document.createElement('span');
    name.className = 'job-name';
    name.textContent = job.filename;
    row.appendChild(name);

    const status = document.createElement('span');
    status.className = 'job-status';
    if (job.error) {
      status.classList.add('error');
      status.textContent = job.error;
    } else if (job.done) {
      status.classList.add('done');
      status.textContent =
        'saved' + (job.files && job.files.length ? ': ' + job.files.join(', ') : '');
    } else {
      const pct = job.totalSegments
        ? Math.round((job.loadedSegments / job.totalSegments) * 100)
        : 0;
      status.textContent = `${job.phase} ${pct}% · ${fmtSize(job.bytes)}`;
    }
    row.appendChild(status);

    if (!job.done) {
      const cancel = document.createElement('button');
      cancel.className = 'job-cancel';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => send({ type: 'job-cancel', jobId: job.id });
      row.appendChild(cancel);
    }
    el.appendChild(row);

    if (!job.done && job.totalSegments) {
      const bar = document.createElement('div');
      bar.className = 'progress';
      const fill = document.createElement('div');
      fill.style.transform = `scaleX(${job.loadedSegments / job.totalSegments})`;
      bar.appendChild(fill);
      el.appendChild(bar);
    }
    if (job.note) {
      const note = document.createElement('div');
      note.className = 'item-note';
      note.textContent = job.note;
      el.appendChild(note);
    }
    jobsEl.appendChild(el);
  }

  // Item list. Hide page-player entries that duplicate a network detection,
  // and hide blob: players entirely when a stream was sniffed for this tab.
  const streams = items.filter((i) => i.kind === 'hls' || i.kind === 'dash');
  const shown = items.filter((item) => {
    if (item.kind !== 'page') return true;
    if (item.url.startsWith('blob:')) return streams.length === 0;
    return true;
  });

  listEl.querySelectorAll('.item').forEach((el) => el.remove());
  emptyEl.hidden = shown.length > 0;

  for (const item of shown) {
    listEl.appendChild(renderItem(item));
  }

  statusEl.textContent = shown.length
    ? `${shown.length} item${shown.length === 1 ? '' : 's'} detected`
    : '';
}

function renderItem(item) {
  const state = rowState.get(item.key) || {};
  const el = document.createElement('div');
  el.className = 'item';

  const row = document.createElement('div');
  row.className = 'item-row';

  const badge = document.createElement('span');
  badge.className = 'badge ' + item.kind;
  badge.textContent = KIND_LABEL[item.kind](item);
  row.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'item-info';
  const name = document.createElement('div');
  name.className = 'item-name';
  name.textContent = displayName(item);
  name.title = item.url;
  info.appendChild(name);

  const metaBits = [];
  if (item.width && item.height) metaBits.push(`${item.width}×${item.height}`);
  if (item.duration) metaBits.push(fmtDuration(item.duration));
  if (item.size) metaBits.push(fmtSize(item.size));
  metaBits.push(hostOf(item.url));
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  meta.textContent = metaBits.filter(Boolean).join(' · ');
  info.appendChild(meta);
  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'item-actions';

  if (item.kind === 'page' && item.url.startsWith('blob:')) {
    // MSE player without a sniffed stream: nothing to download directly.
    const hint = document.createElement('span');
    hint.className = 'item-note';
    hint.textContent = 'streaming player';
    actions.appendChild(hint);
  } else if (item.kind === 'dash') {
    actions.appendChild(copyButton(item.url));
  } else {
    const dl = document.createElement('button');
    dl.textContent = state.busy ? '…' : 'Download';
    dl.disabled = !!state.busy;
    dl.onclick = () => onDownload(item);
    actions.appendChild(dl);
    actions.appendChild(copyButton(item.url));
  }
  row.appendChild(actions);
  el.appendChild(row);

  // Inline quality picker (HLS master playlists)
  if (state.variants) {
    const picker = document.createElement('div');
    picker.className = 'quality-picker';
    const select = document.createElement('select');
    for (let i = 0; i < state.variants.length; i++) {
      const v = state.variants[i];
      const opt = document.createElement('option');
      opt.value = String(i);
      const parts = [];
      if (v.height) parts.push(`${v.height}p`);
      if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(1)} Mbps`);
      opt.textContent = parts.join(' · ') || `Variant ${i + 1}`;
      select.appendChild(opt);
    }
    picker.appendChild(select);

    const go = document.createElement('button');
    go.textContent = 'Get';
    go.onclick = () => {
      const v = state.variants[parseInt(select.value, 10)];
      startHls(item, v);
    };
    picker.appendChild(go);

    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Close';
    cancel.onclick = () => {
      rowState.set(item.key, {});
      render();
    };
    picker.appendChild(cancel);
    el.appendChild(picker);
  }

  if (state.error) {
    const err = document.createElement('div');
    err.className = 'item-error';
    err.textContent = state.error;
    el.appendChild(err);
  }
  if (state.note) {
    const note = document.createElement('div');
    note.className = 'item-note';
    note.textContent = state.note;
    el.appendChild(note);
  }
  if (item.kind === 'dash') {
    const note = document.createElement('div');
    note.className = 'item-note';
    note.textContent =
      'DASH manifests need external muxing. Copy the URL and use e.g. yt-dlp.';
    el.appendChild(note);
  }

  return el;
}

function copyButton(url) {
  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.textContent = 'Copy URL';
  btn.onclick = async () => {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy URL'), 1200);
  };
  return btn;
}

// ---------------------------------------------------------------------------
// Actions

async function onDownload(item) {
  if (item.kind === 'file' || item.kind === 'page') {
    rowState.set(item.key, { busy: true });
    render();
    const res = await send({ type: 'download-direct', item, tabId });
    rowState.set(
      item.key,
      res && res.ok
        ? { note: 'Saved to Downloads as ' + res.filename }
        : { error: (res && res.error) || 'Download failed' }
    );
    render();
    return;
  }

  if (item.kind === 'hls') {
    rowState.set(item.key, { busy: true });
    render();
    const res = await send({ type: 'hls-inspect', url: item.url });
    if (!res || !res.ok) {
      rowState.set(item.key, { error: (res && res.error) || 'Could not read playlist' });
    } else if (res.kind === 'master' && res.variants.length > 1) {
      rowState.set(item.key, { variants: res.variants, audioRenditions: res.audioRenditions });
    } else if (res.kind === 'media' && res.live) {
      rowState.set(item.key, { error: 'Live stream; saving is not supported.' });
    } else {
      rowState.set(item.key, {});
      startHls(item, res.variants ? res.variants[0] : null);
      return;
    }
    render();
  }
}

async function startHls(item, variant) {
  const state = rowState.get(item.key) || {};
  let audioUri = null;
  if (variant && variant.audioGroup && state.audioRenditions) {
    const group = state.audioRenditions.filter(
      (r) => r.groupId === variant.audioGroup && r.uri
    );
    const def = group.find((r) => r.isDefault);
    audioUri = def ? def.uri : group[0] ? group[0].uri : null;
  }
  rowState.set(item.key, { note: 'Downloading… progress shown above.' });
  render();
  await send({
    type: 'hls-download',
    url: item.url,
    variant,
    audioUri,
    title: variantTitle(item, variant),
    tabId,
  });
  refresh();
}

function variantTitle(item, variant) {
  const base = item.title || document.title || '';
  const res = variant && variant.height ? ` ${variant.height}p` : '';
  return (base || displayName(item).replace(/\.m3u8.*/i, '')) + res;
}

// ---------------------------------------------------------------------------
// Data loading

async function refresh() {
  const res = await send({ type: 'get-media', tabId });
  if (!res) return;
  items = res.items || [];
  jobs = res.jobs || [];
  // Use page title as fallback item title
  for (const item of items) {
    if (!item.title && res.pageTitle) item.title = res.pageTitle;
  }
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'popup') return;
  if (msg.type === 'media-updated' && msg.tabId === tabId) refresh();
  if (msg.type === 'job-updated') refresh();
});

document.getElementById('rescan').onclick = async () => {
  await send({ type: 'rescan', tabId });
  setTimeout(refresh, 500);
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  await refresh();
})();

// End-to-end smoke test: loads the unpacked extension in Chromium, serves a
// page with a direct mp4 and an AES-128 HLS stream, and verifies detection,
// quality inspection, segment download + decryption, and final file assembly.
//
// Usage: node test/e2e-smoke.mjs
// Requires a playwright install; path is resolved below.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const PLAYWRIGHT_HOME = '/home/josh/code/apex-season/package.json';
const { chromium } = createRequire(PLAYWRIGHT_HOME)('playwright');

const EXT_DIR = path.resolve(new URL('..', import.meta.url).pathname);

// --- Test fixtures -----------------------------------------------------------

const KEY = crypto.randomBytes(16);

function sequenceIv(seq) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(seq), 8);
  return iv;
}

// Plain TS-looking segments (0x47 sync byte first), then AES-128-CBC encrypted
// the way HLS does it (IV = media sequence number).
const PLAIN_SEGMENTS = [0, 1, 2].map((i) => {
  const buf = Buffer.alloc(4096 + i * 512, i + 1);
  buf[0] = 0x47;
  return buf;
});
const ENC_SEGMENTS = PLAIN_SEGMENTS.map((plain, i) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, sequenceIv(i));
  return Buffer.concat([cipher.update(plain), cipher.final()]);
});
const EXPECTED = Buffer.concat(PLAIN_SEGMENTS);

const FAKE_MP4 = Buffer.alloc(600 * 1024, 7); // big enough to pass size filter

function playlist(port) {
  return {
    master: `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
/v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
/v360.m3u8
`,
    v720: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="http://localhost:${port}/key.bin"
#EXTINF:4.0,
/seg0.ts
#EXTINF:4.0,
/seg1.ts
#EXTINF:4.0,
/seg2.ts
#EXT-X-ENDLIST
`,
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      const pl = playlist(server.address().port);
      const routes = {
        '/page.html': [
          'text/html',
          `<!DOCTYPE html><title>Smoke Test Video Page</title>
           <video src="/video.mp4" controls></video>
           <script>fetch('/master.m3u8').then(r => r.text());</script>`,
        ],
        '/video.mp4': ['video/mp4', FAKE_MP4],
        '/master.m3u8': ['application/vnd.apple.mpegurl', pl.master],
        '/v720.m3u8': ['application/vnd.apple.mpegurl', pl.v720],
        '/key.bin': ['application/octet-stream', KEY],
        '/seg0.ts': ['video/mp2t', ENC_SEGMENTS[0]],
        '/seg1.ts': ['video/mp2t', ENC_SEGMENTS[1]],
        '/seg2.ts': ['video/mp2t', ENC_SEGMENTS[2]],
      };
      const hit = routes[url];
      if (!hit) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': hit[0], 'content-length': Buffer.byteLength(hit[1]) });
      res.end(hit[1]);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- Assertions ---------------------------------------------------------------

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? '  (' + extra + ')' : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Main -----------------------------------------------------------------------

const server = await startServer();
const port = server.address().port;
const pageUrl = `http://localhost:${port}/page.html`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgrab-profile-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgrab-dl-'));
fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
fs.writeFileSync(
  path.join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloadDir, prompt_for_download: false },
  })
);

console.log('Launching Chromium with extension...');
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});

try {
  // Wait for the extension service worker.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  check('service worker registered', !!sw, 'extension failed to load');

  const page = await context.newPage();
  await page.goto(pageUrl);
  await sleep(3500); // content script delayed scan + sniffing

  // 1. Detection state (per-tab store mirrored into storage.session)
  const stored = await sw.evaluate(() => chrome.storage.session.get(null));
  const tabs = Object.values(stored);
  const allItems = tabs.flatMap((t) => t.items || []);
  check(
    'mp4 detected',
    allItems.some((i) => i.kind === 'file' && i.url.endsWith('/video.mp4')),
    JSON.stringify(allItems.map((i) => [i.kind, i.url]))
  );
  check(
    'HLS playlist sniffed from network',
    allItems.some((i) => i.kind === 'hls' && i.url.endsWith('/master.m3u8'))
  );

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost/*' });
    return tabs[0] ? tabs[0].id : null;
  });
  check('page tab found', tabId !== null);

  const badge = await sw.evaluate(
    (id) => chrome.action.getBadgeText({ tabId: id }),
    tabId
  );
  check('badge shows count', parseInt(badge, 10) >= 2, `badge="${badge}"`);

  // 2. Drive the popup flow from an extension page (same messaging path the
  //    popup uses).
  const extPage = await context.newPage();
  await extPage.goto(sw.url().replace('background.js', 'popup/popup.html'));

  const inspect = await extPage.evaluate(
    (u) => chrome.runtime.sendMessage({ type: 'hls-inspect', url: u }),
    `http://localhost:${port}/master.m3u8`
  );
  check('inspect: master recognized', inspect && inspect.ok && inspect.kind === 'master',
    JSON.stringify(inspect));
  check('inspect: 2 variants, 720p first',
    inspect.variants && inspect.variants.length === 2 && inspect.variants[0].height === 720);

  const dl = await extPage.evaluate(
    ({ u, variant, tabId }) =>
      chrome.runtime.sendMessage({
        type: 'hls-download',
        url: u,
        variant,
        audioUri: null,
        title: 'smoke-test 720p',
        tabId,
      }),
    { u: `http://localhost:${port}/master.m3u8`, variant: inspect.variants[0], tabId }
  );
  check('hls-download accepted', dl && dl.ok && dl.jobId, JSON.stringify(dl));

  // 3. Wait for the job to finish and the file to land on disk.
  let job = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const res = await extPage.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'get-media', tabId: id }),
      tabId
    );
    job = (res.jobs || []).find((j) => j.id === dl.jobId);
    if (job && (job.done || job.error)) break;
  }
  check('job completed', job && job.done && !job.error, job && job.error);

  let downloads = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    downloads = await sw.evaluate(() =>
      chrome.downloads.search({}).then((ds) =>
        ds.map((d) => ({ state: d.state, filename: d.filename, bytes: d.totalBytes }))
      )
    );
    if (downloads.some((d) => d.state === 'complete')) break;
  }
  const done = downloads.find((d) => d.state === 'complete');
  check('chrome download completed', !!done, JSON.stringify(downloads));

  // Playwright reroutes downloads to its artifacts dir, so verify the
  // requested name via the job record instead of the on-disk path.
  check('saved as .ts with title-based name',
    job && job.files && job.files[0] === 'smoke-test 720p.ts',
    job && JSON.stringify(job.files));

  if (done) {
    const data = fs.readFileSync(done.filename);
    check('decrypted bytes match original segments',
      data.equals(EXPECTED),
      `got ${data.length} bytes, expected ${EXPECTED.length}`);
  }
} finally {
  await context.close();
  server.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

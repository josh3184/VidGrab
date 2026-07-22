# VidGrab design

2026-07-07. Local-only Chrome extension (MV3, load unpacked) that lists
videos on the current page with a per-item download button, including
embedded players and streamed (HLS) video.

## Requirements

- List detected videos for the active tab; one download button each.
- Catch videos in players and streams, not just direct `<video src>`.
- Local use only; no store packaging, no build step, no dependencies.

## Architecture

Three detection layers feed one per-tab list in the service worker:

1. **Content script** (`content.js`, all frames): reports `<video>` /
   `<source>` elements with dimensions/duration. MutationObserver plus
   `loadedmetadata`/`play` listeners catch late-attaching players. `blob:`
   sources are surfaced as "streaming player" hints only, since MSE data is
   not reachable from the DOM.
2. **Network sniffer** (`background.js`): non-blocking
   `webRequest.onResponseStarted` over media/xhr/other types. Classifies by
   content-type and URL: direct video files (mp4/webm/mov/...; files under
   300 KB skipped as segments/thumbnails), HLS playlists (`.m3u8`), DASH
   manifests (`.mpd`). Per-tab state mirrored to `chrome.storage.session`
   so it survives service-worker suspension.

   Dedupe (`lib/dedupe.js`): items are keyed by canonical URL — playlists
   and media-file paths dedupe on origin+path (rotating signed-URL tokens
   collapse), extensionless URLs keep their query since it may identify the
   video. Detected `.m3u8` playlists are fetched (10 s timeout) and parsed:
   masters gain quality metadata and their variant/audio playlist URLs are
   recorded as child keys; any detection matching a child key is hidden
   behind the master. Media playlists gain duration and a live flag (live
   streams are shown but not downloadable).
3. **Popup** (`popup/`): renders the merged list. HLS items get an inline
   quality picker fed by playlist inspection.

Downloads:

- **Direct files**: `chrome.downloads.download` straight from the URL.
- **HLS**: assembled in an **offscreen document** (`offscreen/`), which
  outlives the popup. Flow: fetch playlist -> (master?) pick variant ->
  fetch segments (concurrency 4, 2 retries, ordered) -> AES-128-CBC decrypt
  via WebCrypto when keyed (IV from attribute or media-sequence) ->
  concatenate to Blob -> blob URL handed to the service worker for
  `chrome.downloads.download`. Container sniffing (fMP4: EXT-X-MAP or
  ftyp/styp/moof; MPEG-TS: 0x47 sync byte) decides output: fMP4 passes
  through as-is, MPEG-TS (H.264 + AAC) is transmuxed to MP4 in-memory via
  the vendored mux.js bundle (lossless container rewrap, no re-encode). If a
  stream can't be transmuxed (e.g. HEVC), it falls back to saving the raw
  `.ts` so the download is never lost. Demuxed audio groups are downloaded
  as a second file with an ffmpeg hint. 2 GB cap (in-memory assembly). Live
  playlists (no ENDLIST) are refused.
- **DASH**: listed with Copy URL only; correct output needs a real muxer.
- **DRM / SAMPLE-AES**: detected and refused. Out of scope permanently.

Messaging uses a `target` field (`sw` / `offscreen` / `popup`) to route
`chrome.runtime` messages between contexts. Job progress is pushed from
offscreen -> SW -> popup broadcast; jobs are tracked in the SW so the popup
can be closed and reopened mid-download.

## Decisions and trade-offs

- **Offscreen document over popup-hosted downloads**: MV3 service workers
  cannot create blob URLs and the popup dies on close; the offscreen
  document is the one extension context that can both fetch cross-origin
  (with host_permissions) and hold blobs for the SW to download.
- **mux.js transmuxer, but no re-encoder**: MPEG-TS is rewrapped to MP4
  losslessly via the vendored mux.js bundle (the one bundled dependency),
  so single-stream HLS lands as a directly-playable `.mp4`. We stop short
  of a full ffmpeg/wasm re-encoder: demuxed audio still ships as a second
  file, and DASH stays out of scope. yt-dlp is the right tool for those.
- **Sniffing over parsing site players**: works on any site without
  per-site adapters, at the cost of requiring the user to press play first.

## Testing

- `test/m3u8.test.mjs`: parser unit tests (attributes, master/media
  playlists, keys, byteranges, IV derivation).
- `test/e2e-smoke.mjs`: launches headless Chromium with the extension
  loaded against a local HTTP server serving a page with an mp4 and an
  AES-128 encrypted HLS stream; asserts detection, badge, inspection,
  download job completion, output filename, and that the decrypted bytes
  equal the original plaintext.

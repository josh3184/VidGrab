# VidGrab

Chrome extension that lists the videos found on the current page and gives
each one a download button. Detects plain `<video>` elements, direct video
file URLs, and HLS streams sniffed from network traffic. Built for local use
(load unpacked); not intended for the Web Store.

## Install

1. Clone or download this repository:

   ```
   git clone https://github.com/josh3184/VidGrab.git
   ```

2. Open `chrome://extensions` (also works in Chromium-based browsers such as
   Edge and Brave)
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick the cloned folder
5. Pin the VidGrab icon to the toolbar if you like

There is no build step; the folder loads as-is.

## Use

1. Open a page with video. If the video is streamed, **press play first**;
   streams are detected from network traffic, so the player needs to start
   loading before VidGrab can see it. The toolbar badge shows how many items
   were found.
2. Click the VidGrab icon. Each detected item has a **Download** button and a
   **Copy URL** button.
3. For HLS streams with multiple qualities, clicking Download shows a quality
   picker; pick one and hit **Get**. Progress appears at the top of the popup
   and continues even if you close it. You get a notification when the file
   is saved.

### What lands in your Downloads folder

- Direct files (mp4/webm/mov/...) download as-is.
- HLS streams are assembled into a single file: `.ts` for MPEG-TS streams
  (plays in VLC/mpv; most players handle it) or `.mp4` for fMP4 streams.
- Some sites stream video and audio separately (demuxed). VidGrab saves both
  files (`name.mp4` + `name.audio.m4a`) and tells you. Combine them with:

  ```
  ffmpeg -i "name.mp4" -i "name.audio.m4a" -c copy "combined.mp4"
  ```

## What it can and can't grab

| Source | Support |
|---|---|
| `<video>` tags with a direct src | yes |
| Direct video file requests (mp4, webm, mov, mkv, ...) | yes |
| HLS (.m3u8), including AES-128 encrypted | yes, assembled to one file |
| HLS live streams (no end marker) | no |
| DASH (.mpd) | listed with Copy URL; use yt-dlp or similar to fetch |
| DRM (Widevine/FairPlay, SAMPLE-AES) | no, and never will be |
| YouTube | effectively no (DASH + throttling; use yt-dlp) |

Other notes:

- Detections are deduplicated: repeat requests for the same file with
  rotating URL tokens collapse into one entry, and HLS quality/audio variant
  playlists are folded under their master playlist (the master row shows
  "N qualities up to 1080p"). Live streams are labeled LIVE and offer Copy
  URL only.
- Streams are capped at 2 GB because the file is assembled in memory.
- If a page's video shows a `blob:` URL, that is a streaming player (MSE);
  look for an HLS entry in the list instead, and press play if there isn't
  one yet.
- Downloads of segment-based streams reuse your browser session cookies, so
  videos behind a login generally work as long as you can play them.

## Development

```
npm test                      # unit tests (node --test), no dependencies
node test/e2e-smoke.mjs       # end-to-end test in headless Chromium
python3 tools/make_icons.py   # regenerate icons
```

The e2e test loads the extension into a real headless Chromium, serves a test
page with an mp4 and an AES-128 encrypted HLS stream, and verifies detection,
dedupe, download, and decryption. It needs playwright:

```
npm i --no-save playwright && npx playwright install chromium
```

## Layout

```
manifest.json           MV3 manifest
background.js           service worker: network sniffing, tab state, download jobs
content.js              scans frames for <video> elements
lib/m3u8.js             HLS playlist parser (shared with tests)
lib/dedupe.js           canonical URL keys + playlist classification
offscreen/              offscreen document: segment download, AES-128 decrypt, assembly
popup/                  the popup UI
test/                   unit tests + e2e smoke test
```

## Legal

MIT licensed; see [LICENSE](LICENSE). VidGrab is a personal tool for saving
videos you have legitimate access to. It does not and will not circumvent
DRM. Respect the copyright and terms of service of the sites you use it on.

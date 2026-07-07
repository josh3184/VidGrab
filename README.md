# VidGrab

Chrome extension that lists the videos found on the current page and gives
each one a download button. Detects plain `<video>` elements, direct video
file URLs, and HLS streams sniffed from network traffic. Built for local use
(load unpacked); not intended for the Web Store.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder (`vidgrab`)
4. Pin the VidGrab icon to the toolbar if you like

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

- Streams are capped at 2 GB because the file is assembled in memory.
- If a page's video shows a `blob:` URL, that is a streaming player (MSE);
  look for an HLS entry in the list instead, and press play if there isn't
  one yet.
- Downloads of segment-based streams reuse your browser session cookies, so
  videos behind a login generally work as long as you can play them.

## Development

```
npm test                  # m3u8 parser unit tests (node --test)
node test/e2e-smoke.mjs   # full end-to-end test in headless Chromium
python3 tools/make_icons.py   # regenerate icons
```

No build step and no dependencies; the folder is loaded as-is.

## Layout

```
manifest.json           MV3 manifest
background.js           service worker: network sniffing, tab state, download jobs
content.js              scans frames for <video> elements
lib/m3u8.js             HLS playlist parser (shared with tests)
offscreen/              offscreen document: segment download, AES-128 decrypt, assembly
popup/                  the popup UI
test/                   unit tests + e2e smoke test
```

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylist,
  parseAttributes,
  parseHexIv,
  sequenceIv,
  hasUnsupportedEncryption,
} from '../lib/m3u8.js';

const BASE = 'https://cdn.example.com/vod/stream/index.m3u8';

test('parseAttributes handles quoted commas and bare values', () => {
  const a = parseAttributes(
    'BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud1"'
  );
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.RESOLUTION, '640x360');
  assert.equal(a.CODECS, 'avc1.4d401e,mp4a.40.2');
  assert.equal(a.AUDIO, 'aud1');
});

test('master playlist: variants sorted by height desc, relative URLs resolved', () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=59.94
1080p/index.m3u8
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.kind, 'master');
  assert.equal(p.variants.length, 3);
  assert.equal(p.variants[0].height, 1080);
  assert.equal(p.variants[0].uri, 'https://cdn.example.com/vod/stream/1080p/index.m3u8');
  assert.equal(p.variants[0].frameRate, 59.94);
  assert.equal(p.variants[2].height, 360);
});

test('master playlist: demuxed audio renditions are captured', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="French",LANGUAGE="fr",URI="audio/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud1"
720p.m3u8
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.audioRenditions.length, 2);
  assert.equal(p.audioRenditions[0].isDefault, true);
  assert.equal(
    p.audioRenditions[0].uri,
    'https://cdn.example.com/vod/stream/audio/en.m3u8'
  );
  assert.equal(p.variants[0].audioGroup, 'aud1');
});

test('media playlist: segments, durations, endlist', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:9.009,
seg100.ts
#EXTINF:9.009,
seg101.ts
#EXTINF:3.003,
seg102.ts
#EXT-X-ENDLIST
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.kind, 'media');
  assert.equal(p.segments.length, 3);
  assert.equal(p.endList, true);
  assert.equal(p.targetDuration, 10);
  assert.equal(Math.round(p.totalDuration), 21);
  assert.equal(p.segments[0].mediaSequence, 100);
  assert.equal(p.segments[2].mediaSequence, 102);
  assert.equal(p.segments[0].uri, 'https://cdn.example.com/vod/stream/seg100.ts');
  assert.equal(p.segments[0].key, null);
});

test('media playlist: live stream has endList false', () => {
  const text = `#EXTM3U
#EXTINF:6.0,
a.ts
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.endList, false);
});

test('media playlist: AES-128 keys with and without IV', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000042
#EXTINF:6.0,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="key2.bin"
#EXTINF:6.0,
b.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:6.0,
c.ts
#EXT-X-ENDLIST
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.segments[0].key.method, 'AES-128');
  assert.equal(p.segments[0].key.uri, 'https://cdn.example.com/vod/stream/key.bin');
  assert.equal(p.segments[0].key.iv[15], 0x42);
  assert.equal(p.segments[1].key.uri, 'https://cdn.example.com/vod/stream/key2.bin');
  assert.equal(p.segments[1].key.iv, null);
  assert.equal(p.segments[2].key, null);
  assert.equal(hasUnsupportedEncryption(p), false);
});

test('media playlist: SAMPLE-AES marks unsupported', () => {
  const text = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"
#EXTINF:6.0,
a.ts
#EXT-X-ENDLIST
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(hasUnsupportedEncryption(p), true);
});

test('media playlist: fMP4 with EXT-X-MAP and byteranges', () => {
  const text = `#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@720
media.mp4
#EXTINF:4.0,
#EXT-X-BYTERANGE:2000
media.mp4
#EXT-X-ENDLIST
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.map.uri, 'https://cdn.example.com/vod/stream/init.mp4');
  assert.deepEqual(p.map.byteRange, { offset: 0, length: 720 });
  assert.deepEqual(p.segments[0].byteRange, { offset: 720, length: 1000 });
  // second byterange has no offset: continues from previous end
  assert.deepEqual(p.segments[1].byteRange, { offset: 1720, length: 2000 });
});

test('sequenceIv produces 16-byte big-endian IV', () => {
  const iv = sequenceIv(258);
  assert.equal(iv.length, 16);
  assert.equal(iv[15], 2);
  assert.equal(iv[14], 1);
  assert.equal(iv[0], 0);
});

test('parseHexIv rejects garbage', () => {
  assert.equal(parseHexIv('0xZZ'), null);
  assert.equal(parseHexIv(''), null);
  const iv = parseHexIv('0x0102030405060708090a0b0c0d0e0f10');
  assert.equal(iv[0], 1);
  assert.equal(iv[15], 16);
});

test('non-playlist input throws', () => {
  assert.throws(() => parsePlaylist('<html>not a playlist</html>', BASE));
});

test('absolute segment URLs are kept as-is', () => {
  const text = `#EXTM3U
#EXTINF:6.0,
https://other-cdn.example.net/seg1.ts
#EXT-X-ENDLIST
`;
  const p = parsePlaylist(text, BASE);
  assert.equal(p.segments[0].uri, 'https://other-cdn.example.net/seg1.ts');
});

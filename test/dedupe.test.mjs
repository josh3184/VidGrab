import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalKey, classifyHlsText } from '../lib/dedupe.js';

test('canonicalKey: rotating query tokens on media-file paths collapse', () => {
  assert.equal(
    canonicalKey('https://cdn.example.com/v/clip.mp4?token=abc&exp=1', 'file'),
    canonicalKey('https://cdn.example.com/v/clip.mp4?token=def&exp=2', 'file')
  );
});

test('canonicalKey: extensionless file URLs keep their query', () => {
  const a = canonicalKey('https://cdn.example.com/videoplayback?id=111', 'file');
  const b = canonicalKey('https://cdn.example.com/videoplayback?id=222', 'file');
  assert.notEqual(a, b);
});

test('canonicalKey: hash is always dropped', () => {
  assert.equal(
    canonicalKey('https://cdn.example.com/videoplayback?id=1#t=30', 'file'),
    canonicalKey('https://cdn.example.com/videoplayback?id=1', 'file')
  );
});

test('canonicalKey: playlists dedupe on origin+path regardless of query', () => {
  assert.equal(
    canonicalKey('https://cdn.example.com/hls/master.m3u8?sig=aaa', 'hls'),
    canonicalKey('https://cdn.example.com/hls/master.m3u8?sig=bbb', 'hls')
  );
});

test('canonicalKey: different playlist paths stay distinct', () => {
  assert.notEqual(
    canonicalKey('https://cdn.example.com/hls/v720.m3u8', 'hls'),
    canonicalKey('https://cdn.example.com/hls/v360.m3u8', 'hls')
  );
});

test('canonicalKey: unparsable URLs fall back to the raw string', () => {
  assert.equal(canonicalKey('not a url', 'file'), 'not a url');
});

test('classifyHlsText: master yields child keys for variants and audio', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio/en.m3u8?sig=x"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
v1080.m3u8?sig=x
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
v360.m3u8?sig=x
`;
  const info = classifyHlsText(text, 'https://cdn.example.com/hls/master.m3u8?sig=x');
  assert.equal(info.role, 'master');
  assert.equal(info.variantCount, 2);
  assert.equal(info.maxHeight, 1080);
  assert.deepEqual(info.childKeys.sort(), [
    'https://cdn.example.com/hls/audio/en.m3u8',
    'https://cdn.example.com/hls/v1080.m3u8',
    'https://cdn.example.com/hls/v360.m3u8',
  ]);
  // A sniffed variant with a different token still matches its child key.
  assert.ok(
    info.childKeys.includes(
      canonicalKey('https://cdn.example.com/hls/v360.m3u8?sig=zzz', 'hls')
    )
  );
});

test('classifyHlsText: media playlist yields duration and live flag', () => {
  const vod = `#EXTM3U
#EXTINF:6.0,
a.ts
#EXTINF:6.0,
b.ts
#EXT-X-ENDLIST
`;
  const info = classifyHlsText(vod, 'https://cdn.example.com/hls/v720.m3u8');
  assert.equal(info.role, 'media');
  assert.equal(info.duration, 12);
  assert.equal(info.live, false);

  const live = `#EXTM3U
#EXTINF:6.0,
a.ts
`;
  assert.equal(classifyHlsText(live, 'https://cdn.example.com/x.m3u8').live, true);
});

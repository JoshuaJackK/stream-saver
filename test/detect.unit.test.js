'use strict';
// Čista logika zaznavanja (detect.js) in razčlenjevanja HLS (hls.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/lib/detect.js');
const Hls = require('../src/lib/hls.js');

const base = { method: 'GET', status: 200 };
const c = (o) => D.classify(Object.assign({}, base, o));

test('classify: HLS/DASH po končnici ali Content-Type', () => {
  assert.equal(c({ url: 'https://a.example/v/master.m3u8?t=1' }).kind, 'hls');
  assert.equal(c({ url: 'https://a.example/playlist', contentType: 'application/vnd.apple.mpegurl; charset=utf-8' }).kind, 'hls');
  assert.equal(c({ url: 'https://a.example/v/stream.mpd' }).kind, 'dash');
  assert.equal(c({ url: 'https://a.example/manifest', contentType: 'application/dash+xml' }).kind, 'dash');
  // ključ HLS ne vsebuje poizvedbe (žetoni se spreminjajo)
  assert.equal(c({ url: 'https://a.example/v/m.m3u8?t=1' }).key, c({ url: 'https://a.example/v/m.m3u8?t=2' }).key);
});

test('classify: navadne datoteke – video/audio, velikost, ključ', () => {
  const big = c({ url: 'https://a.example/f/x.mp4?sig=1', contentType: 'video/mp4', contentLength: '50000000' });
  assert.equal(big.kind, 'mp4'); assert.equal(big.size, 50000000); assert.equal(big.audioOnly, false);
  assert.equal(big.key, c({ url: 'https://a.example/f/x.mp4?sig=2', contentType: 'video/mp4', contentLength: '50000000' }).key);
  assert.equal(c({ url: 'https://a.example/f/x.webm', contentType: 'video/webm', contentLength: '9000000' }).ext, 'webm');
  assert.equal(c({ url: 'https://a.example/f/x.mp4', contentType: 'application/octet-stream', contentLength: '9000000' }).kind, 'mp4');
  assert.equal(c({ url: 'https://a.example/f/p.mp3', contentType: 'audio/mpeg', contentLength: '9000000' }).audioOnly, true);
  // 206: velikost iz Content-Range
  assert.equal(c({ url: 'https://a.example/f/x.mp4', status: 206, contentType: 'video/mp4', contentRange: 'bytes 0-99/7000000' }).size, 7000000);
});

test('classify: ignorira segmente, drobne datoteke, oglase, YouTube, ne-GET in napake', () => {
  assert.equal(c({ url: 'https://a.example/v/seg-12.ts', contentType: 'video/mp2t' }), null);
  assert.equal(c({ url: 'https://a.example/v/s1.m4s', contentType: 'video/iso.segment' }), null);
  assert.equal(c({ url: 'https://a.example/v/init-0.mp4', contentType: 'video/mp4', contentLength: '9000000' }), null);
  assert.equal(c({ url: 'https://a.example/t.mp4', contentType: 'video/mp4', contentLength: '4000' }), null);
  assert.equal(c({ url: 'https://a.example/t.mp4', contentType: 'video/mp4', contentLength: '4000000', method: 'POST' }), null);
  assert.equal(c({ url: 'https://a.example/t.mp4', contentType: 'video/mp4', contentLength: '4000000', status: 404 }), null);
  assert.equal(c({ url: 'https://rr1---sn.googlevideo.com/videoplayback?x=1', contentType: 'video/mp4', contentLength: '4000000' }), null);
  assert.equal(c({ url: 'https://securepubads.doubleclick.net/v.mp4', contentType: 'video/mp4', contentLength: '4000000' }), null);
  assert.equal(c({ url: 'https://a.example/img.jpg', contentType: 'image/jpeg', contentLength: '4000000' }), null);
  assert.equal(c({ url: 'ftp://a.example/v.mp4', contentType: 'video/mp4' }), null);
  assert.equal(c({ url: 'https://x.svc.ms/transform/videomanifest?x=1', contentType: 'application/dash+xml' }), null, 'Stream ima svoj vmesnik');
  assert.equal(c({ url: 'https://a.example/f/ad/spot.mp4', contentType: 'video/mp4', contentLength: '4000000' }).small, true, 'oglas po imenu je le označen');
});

test('flags/score: kratki, samo zvok, DRM, živo – glavni posnetek ima najvišjo oceno', () => {
  const main = { kind: 'hls', meta: { durationSec: 3600 } };
  const ad = { kind: 'hls', meta: { durationSec: 5 } };
  const audio = { kind: 'mp4', audioOnly: true, size: 20e6 };
  const drm = { kind: 'dash', meta: { durationSec: 3600, drm: true } };
  assert.ok(D.score(main) > D.score(ad));
  assert.ok(D.score(main) > D.score(audio));
  assert.ok(D.score(main) > D.score(drm));
  assert.deepEqual(D.flags(ad), ['zelo kratek']);
  assert.ok(D.flags(audio).includes('samo zvok'));
  assert.ok(D.flags(drm).includes('DRM'));
  assert.ok(D.flags({ kind: 'hls', meta: { live: true } }).includes('v živo'));
});

test('nameFromTitle: prepovedani znaki, dolžina, rezervno ime', () => {
  assert.equal(D.nameFromTitle('Predavanje: 3/4 <test>?'), 'Predavanje 3 4 test');
  assert.equal(D.nameFromTitle('   ...   '), 'posnetek');
  assert.equal(D.nameFromTitle('', 'x'), 'x');
  assert.ok(D.nameFromTitle('a'.repeat(300)).length <= 120);
});

test('hls.parsePlaylist: master, DRM ključi, živo', () => {
  const master = Hls.parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nhigh.m3u8\n', 'https://c.example/p/master.m3u8');
  assert.equal(master.type, 'master');
  assert.equal(Hls.sortedVariants(master)[0].uri, 'https://c.example/p/high.m3u8');
  const media = (key) => Hls.parsePlaylist(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${key}\n#EXTINF:4,\ns0.ts\n#EXT-X-ENDLIST\n`, 'https://c.example/p/m.m3u8');
  assert.equal(media('#EXT-X-KEY:METHOD=NONE').live, false);
  assert.ok(!media('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"').drm);
  assert.ok(media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"').drm);
  assert.ok(media('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:;base64,AA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"').drm);
  assert.ok(media('#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.microsoft.playready"').drm);
  const live = Hls.parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns0.ts\n', 'https://c.example/p/m.m3u8');
  assert.equal(live.live, true);
});

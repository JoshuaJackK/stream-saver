'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DOMParser } = require('@xmldom/xmldom');
const M = require('../src/lib/mpd.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const MANIFEST_URL = 'https://northeurope1-mediap.svc.ms/transform/videomanifest?provider=spo&inputFormat=mp4&cs=fFNQTw&docid=https%3A%2F%2Fexample-my.sharepoint.com%2F_api%2Fv2.0%2Fdrives%2Fb!x%2Fitems%2F01AB%3Fversion%3DPublished&action=Access&part=index&format=dash&useScf=True&pretranscode=0&transcodeahead=0';

test('Stream videomanifest: tracks, best quality, timeline expansion, URLs', () => {
  const p = M.parseMpd(fx('stream-videomanifest.mpd'), MANIFEST_URL, DOMParser);
  assert.equal(p.drm, null);
  assert.ok(Math.abs(p.durationSec - 11525.4) < 1e-6);
  assert.deepEqual(p.tracks.map((t) => t.type), ['video', 'audio']); // text track skipped
  const [v, a] = p.tracks;
  assert.equal(v.id, 'vhigh');
  assert.equal(v.height, 1080);
  assert.equal(v.segments.length, 5761);
  assert.equal(a.segments.length, 5761);
  assert.equal(v.timescale, 10000000);
  assert.equal(v.segments[0].time, 0);
  assert.equal(v.segments[1].time, 2);
  assert.equal(v.segments[5760].time, 11520);
  const u = new URL(v.segments[5760].url);
  assert.equal(u.origin, 'https://example-my.sharepoint.com');
  assert.match(u.pathname, /\/_api_cached\/v2\.1\/drives\/b!AbCdEf0123456789-XyZ\/items\/01ABCDEFGHIJKLMNOPQRSTUVWXYZ\/oneDrive\.transcode$/);
  assert.equal(u.searchParams.get('segmentTime'), String(5760 * 20000000));
  assert.equal(u.searchParams.get('quality'), 'vhigh');
  assert.equal(u.searchParams.get('P4'), 'AbC+dEf=');
  assert.equal(new URL(v.initUrl).searchParams.get('part'), 'initsegment');
  assert.equal(new URL(a.initUrl).searchParams.get('track'), 'audio');
  // whole-segment AES from page key: not declared in MPD → no SEA info
  assert.equal(v.encryption, null);
  assert.deepEqual(M.selectTracks(p, 'av').map((t) => t.type), ['video', 'audio']);
  assert.deepEqual(M.selectTracks(p, 'audio').map((t) => t.type), ['audio']);
});

test('SEA AES-128-CBC + $Number%05d$ template + MPD BaseURL', () => {
  const p = M.parseMpd(fx('sea-number.mpd'), MANIFEST_URL, DOMParser);
  const [v, a] = p.tracks;
  assert.equal(v.segments.length, 16); // ceil(61/4)
  assert.equal(v.segments[0].url, 'https://northeurope1-mediap.svc.ms/transform/v/v1/seg-00001.m4s');
  assert.equal(v.segments[15].url, 'https://northeurope1-mediap.svc.ms/transform/v/v1/seg-00016.m4s');
  assert.equal(v.segments[15].time, 60);
  assert.equal(v.initUrl, 'https://northeurope1-mediap.svc.ms/transform/v/v1/init.mp4');
  assert.equal(v.encryption.type, 'sea');
  assert.equal(v.encryption.scheme, 'aes-128-cbc');
  assert.equal(v.encryption.keyUri, 'https://northeurope1-mediap.svc.ms/transform/key?kid=abc');
  assert.equal(Buffer.from(v.encryption.iv).toString('hex'), '0123456789abcdef0123456789abcdef');
  assert.equal(a.type, 'audio');
  assert.equal(a.encryption, null);
});

test('hard DRM (PlayReady) is reported', () => {
  const p = M.parseMpd(fx('drm.mpd'), 'https://x.svc.ms/m', DOMParser);
  assert.equal(p.drm, 'PlayReady');
});

test('invalid input is rejected', () => {
  assert.throws(() => M.parseMpd('<html><body>Sign in</body></html>', 'https://x/', DOMParser), /MPD/);
});

test('ISO 8601 durations and template expansion', () => {
  assert.equal(M.parseDuration('PT3H12M5.4S'), 11525.4);
  assert.equal(M.parseDuration('PT45M'), 2700);
  assert.equal(M.parseDuration('P0DT1H'), 3600);
  assert.equal(M.expandTemplate('a/$RepresentationID$/$Number%04d$-$Time$-$Bandwidth$$$.m4s', { RepresentationID: 'r', Number: 7, Time: 99, Bandwidth: 5 }), 'a/r/0007-99-5$.m4s');
});

test('S@r="-1" repeats until period end', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="audio">
    <SegmentTemplate timescale="1000" media="s$Time$" initialization="i"><SegmentTimeline><S t="0" d="3000" r="-1"/></SegmentTimeline></SegmentTemplate>
    <Representation id="a" bandwidth="1"/></AdaptationSet></Period></MPD>`;
  const p = M.parseMpd(xml, 'https://h/x/m.mpd', DOMParser);
  assert.deepEqual(p.tracks[0].segments.map((s) => s.url.split('/').pop()), ['s0', 's3000', 's6000', 's9000']);
});

test('oneDrive.transcode session reconstruction from observed requests', () => {
  const base = 'https://example-my.sharepoint.com/_api_cached/v2.1/drives/b!d/items/01X/oneDrive.transcode?version=Published&P1=1&P2=2&P3=3&P4=x&format=fmp4&enableEncryption=1&kid=k';
  const urls = [
    base + '&part=initsegment&track=video&quality=vcopy',
    base + '&part=mediasegment&track=video&quality=vcopy&segmentTime=40000000&wsd=20000000&ppd=115254000000&ppst=0',
    base + '&part=initsegment&track=audio&quality=audcopy',
    base + '&part=mediasegment&track=audio&quality=audcopy&segmentTime=0&wsd=20000000&ppd=115254000000&ppst=0',
    'https://example-my.sharepoint.com/_layouts/15/stream.aspx?id=x'
  ];
  const tr = M.buildTranscodeTracks(urls, 'av');
  assert.deepEqual(tr.map((t) => t.type), ['video', 'audio']);
  assert.equal(tr[0].segments.length, 5763); // ceil(115254000000/20000000)
  assert.equal(new URL(tr[0].segments[5762].url).searchParams.get('segmentTime'), String(5762 * 20000000));
  assert.equal(tr[0].encryption.type, 'page-key');
});

test('file names keep Slovenian letters, strip illegal chars; commands', () => {
  assert.equal(M.sanitizeFilename('Primer predmeta: 3. predavanje – Žiga/Čuk?.mp4'), 'Primer predmeta_ 3. predavanje – Žiga_Čuk_');
  assert.equal(M.sanitizeSubfolder('Razvojna psihologija\\..\\ŠTUDIJ'), 'Razvojna psihologija/ŠTUDIJ');
  assert.equal(M.titleFromTab('Predavanje 5.mp4 - Microsoft Stream'), 'Predavanje 5.mp4');
  assert.equal(M.cleanManifestUrl(MANIFEST_URL), MANIFEST_URL.slice(0, MANIFEST_URL.indexOf('&useScf')));
  assert.match(M.ytDlpCommand('https://example-my.sharepoint.com/personal/u/_layouts/15/stream.aspx?id=a&b=c', 'Pred 1', true),
    /^yt-dlp --cookies-from-browser firefox -o "Pred 1\.%\(ext\)s" "https:\/\/example-my.+&b=c"$/);
  const ff = M.ffmpegCommand(MANIFEST_URL, 'Pred 1', true, null);
  assert.ok(ff.startsWith('ffmpeg -i "https://northeurope1-mediap.svc.ms/transform/videomanifest?'));
  assert.ok(ff.endsWith('-map 0:v:0 -map 0:a:0? -c copy "Pred 1.mp4"'));
});

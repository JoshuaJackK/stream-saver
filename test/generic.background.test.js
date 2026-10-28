'use strict';
// Splošno zaznavanje (SSGen) v background kontekstu z lažnim WebExtension API-jem in sintetičnimi ffmpeg fixture-i:
// webRequest (onHeadersReceived) → seznam tokov → prenos → downloads.download → ffprobe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('@xmldom/xmldom');
const H = require('./helpers-hls.js');

const SRC = path.join(__dirname, '..', 'src');
const skip = !H.hasFfmpeg && 'ffmpeg not installed';
const PAGE = 'https://video.example.org/predavanje/3';
let dir;

function setup(o) {
  o = o || {};
  const L = {}; const state = { badges: {}, downloads: [], blobs: [], registered: [], frame: [], added: 0, perm: o.perm !== false };
  const origFetch = H.makeFetcher(dir, o);
  const ev = (name) => ({ addListener: (fn) => { L[name] = fn; }, removeListener: (fn) => { if (L[name] === fn) delete L[name]; } });
  const browser = {
    webRequest: { onBeforeSendHeaders: { addListener() {} }, onHeadersReceived: ev('hdr') },
    tabs: {
      onRemoved: ev('rm'), onUpdated: ev('up'),
      get: async (id) => ({ id, title: 'Predavanje 3 | Video portal', url: PAGE }),
      sendMessage: async (id, msg, opt) => {
        state.frame.push({ id, msg, opt });
        if (msg.type === 'ss-gfetch' && o.frameFetch) return o.frameFetch(msg);
        return null;
      }
    },
    browserAction: { setBadgeText: async (x) => { state.badges.text = x.text; }, setBadgeBackgroundColor: async () => {}, setTitle: async (x) => { state.badges.title = x.title; } },
    downloads: { download: async (x) => { state.downloads.push(x); return state.downloads.length; }, onChanged: ev('dl') },
    runtime: { onMessage: ev('msg') },
    permissions: { contains: async () => state.perm, onAdded: ev('padd'), onRemoved: ev('prem') },
    contentScripts: { register: async (x) => { state.registered.push(x); return { unregister: async () => { state.registered.pop(); } }; } }
  };
  const bytes = [];
  const ctx = {
    browser, console: { log() {} }, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, DOMParser, Blob,
    fetch: async (url, init) => {
      state.fetchLog = state.fetchLog || [];
      state.fetchLog.push({ url, headers: init.headers, credentials: init.credentials });
      if (o.bgStatus) return new Response(null, { status: o.bgStatus });
      const r = await origFetch(url, { range: init.headers && init.headers.Range ? init.headers.Range.replace('bytes=', '') : undefined });
      const h = { 'Content-Type': 'application/octet-stream' };
      if (r.contentRange) h['Content-Range'] = r.contentRange;
      return new Response(r.buffer, { status: r.status, headers: h });
    }
  };
  ctx.globalThis = ctx;
  ctx.URL = class extends URL {};
  ctx.URL.createObjectURL = (b) => { state.blobs.push(b); return 'blob:moz-extension://x/' + state.blobs.length; };
  ctx.URL.revokeObjectURL = () => {};
  vm.createContext(ctx);
  for (const f of ['lib/mpd.js', 'lib/mp4.js', 'lib/ts.js', 'lib/engine.js', 'lib/hls.js', 'lib/hlsdl.js', 'lib/detect.js', 'lib/transcript.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  ctx.SSSink = { purgeAll: async () => {}, createSink: async () => { const parts = []; return { kind: 'test', write: async (u8) => { parts.push(Buffer.from(u8)); bytes.push(u8.byteLength); }, close: async () => {}, abort: async () => {}, getBlob: async () => new Blob(parts), cleanup: async () => {} }; } };
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background-generic.js'), 'utf8'), ctx, { filename: 'background-generic.js' });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { L, state, origFetch };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 40));
const hdrReq = (url, ct, extra) => Object.assign({ url, method: 'GET', tabId: 9, frameId: 0, statusCode: 200, type: 'xmlhttprequest', documentUrl: PAGE, originUrl: PAGE, responseHeaders: ct ? [{ name: 'Content-Type', value: ct }] : [] }, extra);
const M3U8 = 'application/vnd.apple.mpegurl';
async function waitJob(t, tabId) {
  for (let i = 0; i < 400; i++) {
    const s = await t.L.msg({ type: 'ss-g-state', tabId }, {});
    if (s.job && s.job.status !== 'running') return s;
    await tick(25);
  }
  throw new Error('prenos se ni končal');
}
async function blobToFile(blob, name) { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.from(await blob.arrayBuffer())); return f; }

test('priprava fixture-ov', { skip }, () => { dir = H.buildFixtures(); });

test('brez dovoljenja <all_urls>: ne posluša zahtev in ne vstavlja skript', { skip }, async () => {
  const t = setup({ perm: false });
  await tick();
  assert.equal(t.L.hdr, undefined);
  assert.equal(t.state.registered.length, 0);
  const s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.enabled, false);
  assert.equal(s.streams.length, 0);
});

test('HLS: zaznava, skrivanje variant, stanje, prenos z imenom in podmapo, ponastavitev ob navigaciji', { skip }, async () => {
  const t = setup();
  await tick();
  assert.equal(typeof t.L.hdr, 'function', 'poslušalec onHeadersReceived');
  assert.equal(t.state.registered.length, 1);
  assert.deepEqual(Array.from(t.state.registered[0].matches), ['http://*/*', 'https://*/*']);
  const B = H.BASE;
  t.L.hdr(hdrReq(B + 'ts/master.m3u8?token=abc', M3U8));
  t.L.hdr(hdrReq(B + 'ts/high.m3u8', M3U8)); // varianta glavnega seznama
  t.L.hdr(hdrReq(B + 'ts/high0.ts', 'video/mp2t', { type: 'media' })); // segment
  t.L.hdr(hdrReq('https://cdn.example.org/thumb.mp4', 'video/mp4', { type: 'media', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1200' }] })); // drobna datoteka
  t.L.hdr(hdrReq(B + 'x.m3u8', M3U8, { tabId: -1 })); // ni zavihek
  t.L.hdr(hdrReq(B + 'y.m3u8', M3U8, { originUrl: 'moz-extension://abc/background.html' }));
  await tick(300);
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.enabled, true);
  assert.equal(s.streams.length, 1, JSON.stringify(s.streams.map((x) => x.url)));
  const st = s.streams[0];
  assert.equal(st.kind, 'hls');
  assert.ok(st.variants.length >= 2);
  assert.match(st.quality, /270p/);
  assert.ok(Math.abs(st.durationSec - 8) < 1, 'trajanje ' + st.durationSec);
  assert.equal(s.defaultName, 'Predavanje 3 Video portal'); // naslov strani, očiščen nedovoljenih znakov
  assert.equal(t.state.badges.text, '▼');

  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: st.id, filename: 'Moje ime', subfolder: 'Predmet/Teden 1', variantIndex: 1, mode: 'av', concurrency: 3 } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'done', s.job.error);
  assert.equal(t.state.downloads.length, 1);
  assert.equal(t.state.downloads[0].filename, 'Predmet/Teden 1/Moje ime.mp4');
  assert.equal(t.state.badges.text, 'OK');
  const f = await blobToFile(t.state.blobs[0], 'bg-hls.mp4');
  const p = H.probe(f);
  assert.equal(p.streams.map((x) => x.codec_type).sort().join(','), 'audio,video');
  assert.equal(p.streams.find((x) => x.codec_type === 'video').width, 320, 'izbrana nižja kakovost (indeks 1)');
  assert.equal(H.decodeErrors(f), '');
  // piškotki: prenos prek ozadja z credentials include
  assert.ok(t.state.fetchLog.length > 5 && t.state.fetchLog.every((x) => x.credentials === 'include'));

  // navigacija: stanje se ponastavi
  await t.L.msg({ type: 'ss-g-reset', tabId: 9 }, {});
  t.L.up(9, { status: 'loading', url: 'https://video.example.org/drugo' });
  s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.streams.length, 0);
});

test('403 v ozadju → prenos prek okvirja strani (ss-gfetch) v okvirju, kjer je bil tok zaznan', { skip }, async () => {
  const origin = H.makeFetcher(dir, {});
  const t = setup({
    bgStatus: 403,
    frameFetch: async (msg) => { const r = await origin(msg.url, { range: msg.headers.Range && msg.headers.Range.replace('bytes=', '') }); return r; }
  });
  await tick();
  t.L.hdr(hdrReq(H.BASE + 'fm/media.m3u8', M3U8, { frameId: 4 }));
  await tick(300);
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.streams.length, 1);
  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id, filename: 'a', mode: 'av' } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'done', s.job.error);
  const fr = t.state.frame.filter((x) => x.msg.type === 'ss-gfetch');
  assert.ok(fr.length > 3);
  assert.ok(fr.every((x) => x.opt.frameId === 4));
  const f = await blobToFile(t.state.blobs[0], 'bg-frame.mp4');
  assert.equal(H.probe(f).streams.length, 2);
});

test('DRM: tok je označen, prenos se zavrne in noben segment ni prenesen', { skip }, async () => {
  const t = setup();
  await tick();
  t.L.hdr(hdrReq(H.BASE + 'drm/sample.m3u8', M3U8));
  await tick(300);
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.ok(s.streams[0].drm, 'DRM označen');
  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id, filename: 'x' } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'error');
  assert.match(s.job.error, /DRM/);
  assert.equal(t.state.downloads.length, 0);
  assert.ok(!t.state.fetchLog.some((x) => /\.ts(\?|$)/.test(x.url)), 'nobenega segmenta ni bilo prenesenega');
});

test('živi prenos: označen in zavrnjen', { skip }, async () => {
  const t = setup();
  await tick();
  t.L.hdr(hdrReq(H.BASE + 'ts/live.m3u8', M3U8));
  await tick(300);
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.streams[0].live, true);
  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'error');
  assert.match(s.job.error, /ž[ie]v/i);
  assert.equal(t.state.downloads.length, 0);
});

test('navadna datoteka (MP4): zaznava prek Content-Length, prenos po delih (Range)', { skip }, async () => {
  const t = setup();
  await tick();
  const size = fs.statSync(path.join(dir, 'prog/video.mp4')).size;
  const url = H.BASE + 'prog/video.mp4';
  t.L.hdr(hdrReq(url, 'video/mp4', { type: 'media', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: String(Math.max(size, 600000)) }] }));
  t.L.hdr(hdrReq(url, 'video/mp4', { type: 'media', statusCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Range', value: `bytes 0-9/${Math.max(size, 600000)}` }] }));
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.streams.length, 1, 'podvojena zaznava ni dovoljena');
  assert.equal(s.streams[0].kindLabel, 'MP4');
  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id, filename: 'datoteka' } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'done', s.job.error);
  assert.equal(t.state.downloads[0].filename, 'datoteka.mp4');
  const f = await blobToFile(t.state.blobs[0], 'bg-prog.mp4');
  assert.equal(H.probe(f).streams.length, 2);
  assert.ok(fs.readFileSync(f).equals(fs.readFileSync(path.join(dir, 'prog/video.mp4'))), 'bajt-na-bajt enako izvirniku');
});

test('izklop dovoljenja odstrani poslušalca in skripto', { skip }, async () => {
  const t = setup();
  await tick();
  assert.equal(typeof t.L.hdr, 'function');
  t.state.perm = false;
  await t.L.prem({ origins: ['<all_urls>'] });
  await tick();
  assert.equal(t.L.hdr, undefined);
  assert.equal(t.state.registered.length, 0);
});

function dashFixtures() {
  const { execFileSync } = require('node:child_process');
  const d = path.join(dir, 'dash'); fs.mkdirSync(d, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', path.join(d, 'manifest.mpd')]);
  const mpd = fs.readFileSync(path.join(d, 'manifest.mpd'), 'utf8');
  fs.writeFileSync(path.join(d, 'wv.mpd'), mpd.replace(/(<AdaptationSet id="0"[^>]*>)/, '$1<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'));
  const live = mpd.replace('type="static"', 'type="dynamic"');
  fs.writeFileSync(path.join(d, 'live.mpd'), live);
}

test('DASH: zaznava, prenos (ffprobe), DRM (Widevine) in dinamični (živi) manifest se zavrneta', { skip }, async () => {
  dashFixtures();
  const t = setup();
  await tick();
  t.L.hdr(hdrReq(H.BASE + 'dash/manifest.mpd', 'application/dash+xml'));
  await tick(200);
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.equal(s.streams.length, 1);
  assert.equal(s.streams[0].kind, 'dash');
  assert.ok(Math.abs(s.streams[0].durationSec - 6) < 0.5);
  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id, filename: 'dash', mode: 'av' } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'done', s.job.error);
  const f = await blobToFile(t.state.blobs[0], 'bg-dash.mp4');
  const p = H.probe(f);
  assert.equal(p.streams.map((x) => x.codec_type).sort().join(','), 'audio,video');
  assert.ok(Math.abs(Number(p.format.duration) - 6) < 0.6);
  assert.equal(H.decodeErrors(f), '');

  const t2 = setup();
  await tick();
  t2.L.hdr(hdrReq(H.BASE + 'dash/wv.mpd', 'application/dash+xml'));
  await tick(200);
  s = await t2.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  assert.ok(s.streams[0].drm);
  await t2.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id } }, {});
  s = await waitJob(t2, 9);
  assert.equal(s.job.status, 'error'); assert.match(s.job.error, /DRM/);
  assert.ok(!t2.state.fetchLog.some((x) => /\.m4s/.test(x.url)), 'noben segment ni bil prenesen');

  const t3 = setup();
  await tick();
  t3.L.hdr(hdrReq(H.BASE + 'dash/live.mpd', 'application/dash+xml'));
  await tick(200);
  s = await t3.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  await t3.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id } }, {});
  s = await waitJob(t3, 9);
  assert.equal(s.job.status, 'error');
  assert.equal(t3.state.downloads.length, 0);
});

test('navadna datoteka brez podpore Range: celoten prenos v enem odgovoru', { skip }, async () => {
  const t = setup({ noRange: true });
  await tick();
  const url = H.BASE + 'prog/video.mp4';
  t.L.hdr(hdrReq(url, 'video/mp4', { type: 'media', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '900000' }] }));
  let s = await t.L.msg({ type: 'ss-g-state', tabId: 9 }, {});
  await t.L.msg({ type: 'ss-g-start', tabId: 9, options: { streamId: s.streams[0].id, filename: 'cela' } }, {});
  s = await waitJob(t, 9);
  assert.equal(s.job.status, 'done', s.job.error);
  const f = await blobToFile(t.state.blobs[0], 'bg-prog2.mp4');
  assert.ok(fs.readFileSync(f).equals(fs.readFileSync(path.join(dir, 'prog/video.mp4'))));
});

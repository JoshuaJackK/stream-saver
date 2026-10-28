'use strict';
// HLS end-to-end: sintetični ffmpeg fixture-i → razširitvena logika (hls.js, hlsdl.js, ts.js, engine.js, mp4.js) → ffprobe/ffmpeg preverjanje.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const Dl = require('../src/lib/hlsdl.js');
const Mp4 = require('../src/lib/mp4.js');
const H = require('./helpers-hls.js');

let dir;
async function download(url, o) {
  o = o || {};
  const fetcher = o.fetcher || H.makeFetcher(dir, o);
  const plan = await Dl.plan({ fetchBytes: fetcher, url, variantIndex: o.variantIndex, mode: o.mode });
  const raw = path.join(dir, 'out-' + Math.random().toString(36).slice(2) + '.bin');
  const msgs = [];
  const res = await Dl.run({ plan, fetchBytes: fetcher, openSink: async () => H.sinkToFile(raw), concurrency: 3, subtle: webcrypto.subtle, onProgress: (p) => msgs.push(p) });
  let out = raw + '.' + res.ext;
  if (res.needsDefrag) fs.writeFileSync(out, Mp4.defragmentToProgressive(new Uint8Array(fs.readFileSync(raw)), null, res.defragOpts));
  else fs.renameSync(raw, out);
  return { plan, res, out, fetcher, msgs };
}
function types(p) { return p.streams.map((s) => s.codec_type).sort().join(','); }
function checkAv(out, expectDur, label) {
  const p = H.probe(out);
  assert.equal(types(p), 'audio,video', label + ': sledi');
  const d = Number(p.format.duration);
  assert.ok(Math.abs(d - expectDur) < 0.6, `${label}: trajanje ${d}`);
  const st = p.streams.map((s) => Number(s.start_time || 0));
  assert.ok(Math.abs(st[0] - st[1]) < 0.25, `${label}: A/V zamik ${st}`);
  assert.equal(H.decodeErrors(out), '', label + ': napake pri dekodiranju');
  return p;
}

test('HLS e2e', { skip: !H.hasFfmpeg && 'ffmpeg ni nameščen' }, async (t) => {
  dir = H.buildFixtures();

  await t.test('MPEG-TS: master → najboljša varianta (480x270) → MP4 z videom in zvokom', async () => {
    const r = await download(H.BASE + 'ts/master.m3u8');
    assert.equal(r.plan.variants.length, 2);
    assert.equal(r.plan.selected, 0);
    assert.match(r.plan.variants[0].label, /270p/);
    assert.equal(r.res.kind, 'ts-remux');
    assert.equal(r.res.ext, 'mp4');
    const p = checkAv(r.out, 8, 'ts');
    const v = p.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'h264'); assert.equal(v.width, 480);
  });

  await t.test('MPEG-TS: zvok se začne 0,6 s po videu → zamik ostane (edit list)', async () => {
    const r = await download(H.BASE + 'tsoff/p.m3u8');
    const p = H.probe(r.out);
    const v = Number(p.streams.find((s) => s.codec_type === 'video').start_time);
    const a = Number(p.streams.find((s) => s.codec_type === 'audio').start_time);
    assert.ok(a - v > 0.4 && a - v < 0.8, 'zamik zvoka ' + (a - v));
    assert.equal(H.decodeErrors(r.out), '');
  });

  await t.test('MPEG-TS: izbira nižje kakovosti', async () => {
    const r = await download(H.BASE + 'ts/master.m3u8', { variantIndex: 1 });
    const v = H.probe(r.out).streams.find((s) => s.codec_type === 'video');
    assert.equal(v.width, 320);
  });

  await t.test('MPEG-TS: samo medijski seznam + 429 ponovni poskusi', async () => {
    const r = await download(H.BASE + 'ts/low.m3u8', { throttleEvery: 4 });
    checkAv(r.out, 8, 'ts-low-429');
  });

  await t.test('MPEG-TS: samo zvok iz muxed toka → m4a', async () => {
    const r = await download(H.BASE + 'ts/low.m3u8', { mode: 'audio' });
    assert.equal(r.res.ext, 'm4a');
    const p = H.probe(r.out);
    assert.equal(types(p), 'audio');
    assert.equal(H.decodeErrors(r.out), '');
  });

  await t.test('MPEG-TS z ločenim zvokom (EXT-X-MEDIA, zvok v .ts)', async () => {
    const r = await download(H.BASE + 'tssep/master.m3u8');
    assert.equal(r.plan.sources.length, 2);
    checkAv(r.out, 8, 'tssep');
  });

  await t.test('fMP4 muxed (ena inicializacija z dvema sledema)', async () => {
    const r = await download(H.BASE + 'fm/media.m3u8');
    assert.equal(r.res.kind, 'fmp4');
    checkAv(r.out, 8, 'fm');
  });

  await t.test('fMP4 z ločenim zvokom → združeni MP4', async () => {
    const r = await download(H.BASE + 'sep/master.m3u8');
    assert.equal(r.plan.sources.length, 2);
    assert.equal(r.res.kind, 'fmp4');
    checkAv(r.out, 8, 'sep');
  });

  await t.test('AES-128 (TS) z IV v seznamu', async () => {
    const r = await download(H.BASE + 'aes/a.m3u8');
    checkAv(r.out, 6, 'aes-iv');
    assert.ok(r.fetcher.log.some((l) => /k\.bin$/.test(l.url)));
    // ključ se prenese samo enkrat
    assert.equal(r.fetcher.log.filter((l) => /k\.bin$/.test(l.url)).length, 1);
  });

  await t.test('AES-128 (TS) z IV iz zaporedne številke (MEDIA-SEQUENCE 5)', async () => {
    const r = await download(H.BASE + 'aes/b-noiv.m3u8');
    checkAv(r.out, 6, 'aes-seq');
  });

  await t.test('AES-128 (fMP4): šifriran init, menjava ključnega zapisa, IV iz zaporedne številke', async () => {
    const r = await download(H.BASE + 'aesfm/media.m3u8');
    checkAv(r.out, 8, 'aesfm');
  });

  await t.test('DRM SAMPLE-AES / FairPlay: zavrnjeno, noben medijski segment ni prenesen', async () => {
    for (const f of ['drm/sample.m3u8', 'drm/widevine.m3u8', 'drm/master.m3u8']) {
      const fetcher = H.makeFetcher(dir);
      await assert.rejects(Dl.plan({ fetchBytes: fetcher, url: H.BASE + f }), (e) => e.code === 'DRM' && /zaščiten z DRM/.test(e.message), f);
      assert.ok(!fetcher.log.some((l) => /\.ts$/.test(l.url)), 'brez prenosa segmentov: ' + f);
    }
  });

  await t.test('Živi prenos: zavrnjen z jasnim sporočilom', async () => {
    await assert.rejects(Dl.plan({ fetchBytes: H.makeFetcher(dir), url: H.BASE + 'ts/live.m3u8' }), (e) => e.code === 'LIVE' && /živi prenos/i.test(e.message));
  });

  await t.test('CENC (Widevine/PlayReady-podobna šifra v fMP4): zavrnjeno brez izhoda', async () => {
    const fetcher = H.makeFetcher(dir);
    const plan = await Dl.plan({ fetchBytes: fetcher, url: H.BASE + 'cenc/media.m3u8' });
    const raw = path.join(dir, 'cenc-out.bin');
    await assert.rejects(Dl.run({ plan, fetchBytes: fetcher, openSink: async () => H.sinkToFile(raw), subtle: webcrypto.subtle }), (e) => e.code === 'DRM');
    assert.ok(!fetcher.log.some((l) => /seg0\.m4s$/.test(l.url)), 'segmenti niso bili preneseni');
  });

  await t.test('HEVC v TS: pretvorba ni podprta → surov .ts (ffprobe ga prebere)', async () => {
    const r = await download(H.BASE + 'hevc/h.m3u8');
    assert.equal(r.res.kind, 'ts-raw'); assert.equal(r.res.ext, 'ts');
    assert.ok(r.res.notes.join(' ').includes('ffmpeg'));
    const p = H.probe(r.out);
    assert.ok(p.streams.some((s) => s.codec_name === 'hevc'));
  });

  await t.test('napačen ključ → razumljiva napaka (ne tiho pokvarjena datoteka)', async () => {
    const f = H.makeFetcher(dir);
    const bad = async (url, o) => /k\.bin$/.test(url) ? { status: 200, buffer: new Uint8Array(16).buffer } : f(url, o);
    const plan = await Dl.plan({ fetchBytes: bad, url: H.BASE + 'aes/a.m3u8' });
    await assert.rejects(Dl.run({ plan, fetchBytes: bad, openSink: async () => H.sinkToFile(path.join(dir, 'bad.bin')), subtle: webcrypto.subtle }), /dešifriranj|ključ/i);
  });
});

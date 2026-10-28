'use strict';
// Orkestracija prepisa v background.js z lažnim WebExtension API-jem (sintetični podatki):
// zaznava zahteve format=json -> ponoven prenos ISTEGA naslova -> povzetek -> shranjevanje prek downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('@xmldom/xmldom');

const SRC = path.join(__dirname, '..', 'src');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'transcript-synthetic.json'));
const BASE = 'https://fake-my.sharepoint.com/personal/u_fake/_api/v2.1/drives/b!drive/items/ITEM/media/transcripts/TID/streamContent';
const VIEW = BASE + '?format=json&applyhighlights=false&applymediaedits=false';
const MANIFEST = 'https://northeurope1-mediap.svc.ms/transform/videomanifest?provider=spo&docid=x&part=index&format=dash';

function setup(fetchImpl, frameFetchImpl) {
  const clock = { offset: 0 };
  const listeners = {}; const badges = {}; const downloads = []; const fetchLog = []; const blobs = []; const frameLog = []; const revoked = [];
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const browser = {
    webRequest: { onBeforeSendHeaders: ev('wr') },
    tabs: {
      onRemoved: ev('rm'), onUpdated: ev('up'),
      get: async (id) => ({ id, title: 'Izmišljeno predavanje.mp4 - Microsoft Stream', url: 'https://fake-my.sharepoint.com/personal/u_fake/_layouts/15/stream.aspx?id=a' }),
      sendMessage: async (id, msg, opt) => { frameLog.push({ id, msg, opt }); return frameFetchImpl ? frameFetchImpl(msg) : null; }
    },
    browserAction: { setBadgeText: async (o) => { badges.text = o.text; badges.title = badges.title; }, setBadgeBackgroundColor: async () => {}, setTitle: async (o) => { badges.title = o.title; } },
    downloads: { download: async (o) => { downloads.push(o); return downloads.length; }, onChanged: ev('dl') },
    runtime: { onMessage: ev('msg') }
  };
  const ctx = {
    browser, console: { log() {} }, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, DOMParser, Blob,
    fetch: async (url, init) => { fetchLog.push({ url, credentials: init.credentials, headers: init.headers }); return fetchImpl(url); }
  };
  ctx.Date = class extends Date { static now() { return Date.now() + clock.offset; } };
  ctx.globalThis = ctx;
  ctx.URL = class extends URL {};
  ctx.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:moz-extension://x/' + blobs.length; };
  ctx.URL.revokeObjectURL = (u) => { revoked.push(u); };
  vm.createContext(ctx);
  for (const f of ['lib/mpd.js', 'lib/mp4.js', 'lib/engine.js', 'lib/transcript.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  ctx.SSSink = { purgeAll: async () => {}, createSink: async () => { throw new Error('ne uporabljen'); } };
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { listeners, badges, downloads, fetchLog, blobs, frameLog, revoked, clock };
}
const okResponse = () => new Response(FIXTURE, { status: 200, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 20));
const req = (o) => Object.assign({ url: VIEW, method: 'GET', tabId: 5, frameId: 2, documentUrl: 'https://fake-my.sharepoint.com/personal/u_fake/_layouts/15/embed.aspx', originUrl: 'https://fake-my.sharepoint.com/', requestHeaders: [] }, o);

test('prepis brez videa: zaznava, ponoven prenos istega naslova, povzetek', async () => {
  const t = setup(async () => okResponse());
  let st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'none');
  assert.match(st.transcript.text, /osveži stran \(F5\)/);

  t.listeners.wr(req());
  await tick();
  assert.equal(t.badges.text, 'T');
  st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.detected, false, 'video ni zaznan');
  assert.equal(st.transcript.state, 'ready');
  assert.equal(st.transcript.text, 'Prepis zaznan: 6 vrstic, 3 govorci, jezik sl-si');
  // natanko ena zahteva, na natanko isti naslov, s piškotki
  assert.equal(t.fetchLog.length, 1);
  assert.equal(t.fetchLog[0].url, VIEW);
  assert.equal(t.fetchLog[0].credentials, 'include');
});

test('nikoli ne kliče drugih oblik (vtt/docx) in ignorira tuje zahteve', async () => {
  const t = setup(async () => okResponse());
  t.listeners.wr(req({ url: BASE + '?format=vtt' }));
  t.listeners.wr(req({ url: BASE + '?format=docx' }));
  t.listeners.wr(req({ url: BASE }));
  t.listeners.wr(req({ method: 'POST' }));
  t.listeners.wr(req({ tabId: -1 }));
  t.listeners.wr(req({ originUrl: 'moz-extension://abc/background.html' })); // lastni prenos ne sproži zaznave
  await tick();
  assert.equal(t.fetchLog.length, 0);
  const st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'none');
});

test('ponovno opažena ista zahteva ne sproži novega prenosa; nova zahteva zamenja prepis', async () => {
  const t = setup(async () => okResponse());
  t.listeners.wr(req()); await tick();
  t.listeners.wr(req()); await tick();
  assert.equal(t.fetchLog.length, 1);
  const other = VIEW.replace('/TID/', '/TID2/');
  t.listeners.wr(req({ url: other })); await tick();
  assert.equal(t.fetchLog.length, 2);
  assert.equal(t.fetchLog[1].url, other);
});

test('shranjevanje .txt in .vtt: ime, podmapa, BOM, preklic URL-jev', async () => {
  const t = setup(async () => okResponse());
  t.listeners.wr(req()); await tick();
  let r = await t.listeners.msg({ type: 'ss-save-transcript', tabId: 5, options: { subfolder: 'Čebelarstvo', format: 'txt' } }, {});
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'Čebelarstvo/Izmišljeno predavanje.txt');
  assert.equal(t.downloads[0].filename, 'Čebelarstvo/Izmišljeno predavanje.txt');
  assert.equal(t.downloads[0].conflictAction, 'uniquify');
  assert.equal(t.downloads[0].saveAs, false);
  const bytes = Buffer.from(await t.blobs[0].arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(bytes.toString('utf8').includes('[0:00:07] Ana Novak: Dobrodošli'));

  r = await t.listeners.msg({ type: 'ss-save-transcript', tabId: 5, options: { filename: 'Moje ime', subfolder: '', format: 'vtt', saveAs: true } }, {});
  assert.equal(r.filename, 'Moje ime.vtt');
  assert.equal(t.downloads[1].saveAs, true);
  const vtt = await t.blobs[1].text();
  assert.ok(vtt.startsWith('WEBVTT\n\n00:00:07.117 --> 00:00:13.930\n<v Ana Novak>'));

  // URL-ji se prekličejo, ko se prenos konča
  t.listeners.dl({ id: 1, state: { current: 'complete' } });
  await new Promise((res) => setTimeout(res, 5100));
  assert.deepEqual(t.revoked, ['blob:moz-extension://x/1']);
});

test('privzeta oblika je .txt', async () => {
  const t = setup(async () => okResponse());
  t.listeners.wr(req()); await tick();
  const r = await t.listeners.msg({ type: 'ss-save-transcript', tabId: 5, options: {} }, {});
  assert.equal(r.filename, 'Izmišljeno predavanje.txt');
});

test('403 pri ozadju -> isti naslov iz okvirja predvajalnika', async () => {
  const t = setup(async () => new Response('x', { status: 403 }), (msg) => {
    assert.equal(msg.type, 'ss-fetch');
    return { status: 200, buffer: FIXTURE.buffer.slice(FIXTURE.byteOffset, FIXTURE.byteOffset + FIXTURE.byteLength) };
  });
  t.listeners.wr(req({ frameId: 3 })); await tick();
  const fl = t.frameLog.filter((x) => x.msg.type === 'ss-fetch');
  assert.equal(fl.length, 1);
  assert.equal(fl[0].msg.url, VIEW);
  assert.equal(fl[0].opt.frameId, 3);
  const st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'ready');
});

test('napaka strežnika, prazen prepis, neveljaven odgovor', async () => {
  let t = setup(async () => new Response('', { status: 500 }));
  t.listeners.wr(req()); await tick();
  let st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'error');
  assert.match(st.transcript.text, /HTTP 500/);
  assert.match(st.transcript.text, /F5/);
  let r = await t.listeners.msg({ type: 'ss-save-transcript', tabId: 5, options: {} }, {});
  assert.equal(r.ok, false);
  assert.equal(t.downloads.length, 0);

  t = setup(async () => new Response('\uFEFF{"entries":[]}', { status: 200 }));
  t.listeners.wr(req()); await tick();
  st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'empty');
  assert.match(st.transcript.text, /Ta posnetek nima prepisa/);
  assert.equal(t.badges.text, '');

  t = setup(async () => new Response('<html>Prijava</html>', { status: 200 }));
  t.listeners.wr(req()); await tick();
  st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'error');
});

test('ponastavitev stanja: nalaganje strani, SPA navigacija, zaprt zavihek', async () => {
  const t = setup(async () => okResponse());
  t.listeners.wr(req()); await tick();
  // F5 / nova stran
  t.listeners.up(5, { status: 'loading', url: 'https://fake-my.sharepoint.com/x' });
  let st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'none');
  assert.equal(t.badges.text, '');

  // SPA: sprememba naslova več kot 3 s po zahtevi počisti prepis
  t.listeners.wr(req()); await tick();
  const s0 = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(s0.transcript.state, 'ready');
  t.clock.offset = 10000;
  t.listeners.up(5, { url: 'https://fake-my.sharepoint.com/personal/u_fake/_layouts/15/stream.aspx?id=DRUGI' });
  t.clock.offset = 0;
  st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'none');

  // sprememba samo #hash ali takoj po zahtevi ne briše
  t.listeners.wr(req()); await tick();
  t.listeners.up(5, { url: 'https://fake-my.sharepoint.com/personal/u_fake/_layouts/15/stream.aspx?id=a#t=5' });
  st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'ready');

  t.listeners.rm(5);
  st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.transcript.state, 'none');
});

test('video in prepis sta neodvisna: značka ▼, prepis ne briše videa, video ne briše prepisa', async () => {
  const t = setup(async () => okResponse());
  t.listeners.wr(req({ url: MANIFEST, frameId: 2, requestHeaders: [{ name: 'x-spopactoken', value: 'T' }] }));
  assert.equal(t.badges.text, '▼');
  t.listeners.wr(req()); await tick();
  assert.equal(t.badges.text, '▼');
  const st = await t.listeners.msg({ type: 'ss-state', tabId: 5 }, {});
  assert.equal(st.detected, true);
  assert.equal(st.hasManifest, true);
  assert.equal(st.transcript.state, 'ready');
  assert.match(t.badges.title, /prepis zaznan/);
});

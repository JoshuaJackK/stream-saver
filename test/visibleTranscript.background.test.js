'use strict';
// Ozadje: ss-save-visible-transcript pokliče okvir in shrani datoteko (sintetični parsed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('@xmldom/xmldom');
const SRC = path.join(__dirname, '..', 'src');

test('ss-save-visible-transcript: prenese parsed iz okvirja in shrani .txt', async () => {
  const downloads = []; const blobs = [];
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const parsed = {
    entries: [{ id: 'dom-0', text: 'Pozdravljeni', speaker: 'Ana', speakerId: '', startMs: 7000, endMs: 10000, lang: '' }],
    stats: { lines: 1, speakers: 1, language: '', skippedEmpty: 0, skippedBadTime: 0 }
  };
  const browser = {
    webRequest: { onBeforeSendHeaders: { addListener() {} }, onHeadersReceived: { addListener() {}, removeListener() {} } },
    tabs: {
      onRemoved: ev('rm'), onUpdated: ev('up'),
      get: async (id) => ({ id, title: 'Test.mp4 - Microsoft Stream', url: 'https://fake-my.sharepoint.com/x' }),
      sendMessage: async (id, msg) => {
        if (msg.type === 'ss-collect-visible-transcript') return { ok: true, parsed };
        return null;
      }
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    downloads: { download: async (o) => { downloads.push(o); return 1; }, onChanged: ev('dl') },
    runtime: { onMessage: ev('msg') },
    permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    contentScripts: { register: async () => ({ unregister: async () => {} }) }
  };
  const ctx = { browser, console: { log() {} }, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, DOMParser, Blob, fetch: async () => new Response(null, { status: 404 }) };
  ctx.globalThis = ctx; ctx.URL = class extends URL {};
  ctx.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x/' + blobs.length; };
  ctx.URL.revokeObjectURL = () => {};
  vm.createContext(ctx);
  for (const f of ['lib/mpd.js', 'lib/mp4.js', 'lib/ts.js', 'lib/engine.js', 'lib/hls.js', 'lib/hlsdl.js', 'lib/detect.js', 'lib/transcript.js', 'lib/visibleTranscript.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  ctx.SSSink = { purgeAll: async () => {}, createSink: async () => { throw new Error('n/a'); } };
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background-generic.js'), 'utf8'), ctx, { filename: 'background-generic.js' });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // mark visible pane
  await listeners.msg({ type: 'ss-visible-pane', available: true, setSize: 1 }, { tab: { id: 5 }, frameId: 2 });
  const r = await listeners.msg({ type: 'ss-save-visible-transcript', tabId: 5, options: { filename: 'Moje', format: 'txt' } }, {});
  assert.equal(r.ok, true);
  assert.equal(r.lines, 1);
  assert.equal(r.source, 'visible');
  assert.equal(downloads[0].filename, 'Moje.txt');
  const text = await blobs[0].text();
  assert.match(text, /Ana: Pozdravljeni/);
});

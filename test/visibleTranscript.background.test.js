'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('@xmldom/xmldom');
const SRC = path.join(__dirname, '..', 'src');

test('ss-save-visible-transcript: job v ozadju, napredek, shranjevanje, trajno stanje', async () => {
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
        if (msg.type === 'ss-collect-visible-transcript') {
          // simuliraj napredek
          await listeners.msg({ type: 'ss-visible-progress', jobId: msg.jobId, done: 0, total: 1, message: 'Berem…' }, { tab: { id: 5 }, frameId: 2 });
          return { ok: true, parsed };
        }
        if (msg.type === 'ss-cancel-visible-transcript') return true;
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

  await listeners.msg({ type: 'ss-visible-pane', available: true, setSize: 1 }, { tab: { id: 5 }, frameId: 2 });
  const start = await listeners.msg({ type: 'ss-save-visible-transcript', tabId: 5, options: { filename: 'Moje', format: 'txt' } }, {});
  assert.equal(start.ok, true);
  assert.equal(start.started, true);

  let st;
  for (let i = 0; i < 50; i++) {
    st = await listeners.msg({ type: 'ss-state', tabId: 5 }, {});
    if (st.visibleJob && st.visibleJob.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(st.visibleJob.status, 'done', st.visibleJob && st.visibleJob.message);
  assert.match(st.visibleJob.message, /Moje\.txt/);
  assert.equal(downloads[0].filename, 'Moje.txt');
  const bytes = Buffer.from(await blobs[0].arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.match(text, /Ana: Pozdravljeni/);
  assert.match(text, /^\uFEFFTest\.mp4\r\nSource: https:\/\/fake-my\.sharepoint\.com\/x\r\n\r\n/);
  assert.ok(!text.includes('Format:'));
});

function loadBg(browserExtras) {
  const downloads = []; const blobs = [];
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const frameCalls = [];
  const browser = Object.assign({
    webRequest: { onBeforeSendHeaders: { addListener() {} }, onHeadersReceived: { addListener() {}, removeListener() {} } },
    tabs: {
      onRemoved: ev('rm'), onUpdated: ev('up'),
      get: async (id) => ({ id, title: 'Test.mp4 - Microsoft Stream', url: 'https://fake-my.sharepoint.com/x' }),
      sendMessage: async (id, msg, opts) => {
        frameCalls.push({ frameId: opts && opts.frameId, type: msg && msg.type });
        if (browserExtras && browserExtras.sendMessage) return browserExtras.sendMessage(id, msg, opts, frameCalls);
        return null;
      }
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    downloads: { download: async (o) => { downloads.push(o); return 1; }, onChanged: ev('dl') },
    runtime: { onMessage: ev('msg') },
    permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    contentScripts: { register: async () => ({ unregister: async () => {} }) }
  }, browserExtras && browserExtras.browserPatch);
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
  return { listeners, downloads, blobs, frameCalls, browser };
}

async function waitJob(listeners, tabId) {
  let st;
  for (let i = 0; i < 80; i++) {
    st = await listeners.msg({ type: 'ss-state', tabId }, {});
    if (st.visibleJob && st.visibleJob.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 15));
  }
  return st;
}

test('preferred frame TIME: ohrani bogato napako, EN klic collect, brez retry drugih okvirjev', async () => {
  const rich = {
    ok: false,
    error: 'Manjka čas za vrstico 665 – časa ne izmišljamo. (aria-label: «Govorec 97 min 51 s»)',
    code: 'TIME',
    details: { index: 664, ordinal: 665, ariaLabel: 'Govorec 97 min 51 s' }
  };
  const { listeners, downloads, frameCalls } = loadBg({
    sendMessage: async (id, msg, opts) => {
      if (msg.type === 'ss-collect-visible-transcript') {
        if (opts.frameId === 7) return rich;
        // če bi se klical drug okvir – generik, ki bi prej prepisal napako
        return { ok: false, error: 'Zavihek Prepis ni odprt ali ni viden. Odpri Prepis v predvajalniku in poskusi znova.', code: 'NO_PANE' };
      }
      if (msg.type === 'ss-cancel-visible-transcript') return true;
      return null;
    }
  });
  await listeners.msg({ type: 'ss-visible-pane', available: true, setSize: 1214 }, { tab: { id: 9 }, frameId: 7 });
  const start = await listeners.msg({ type: 'ss-save-visible-transcript', tabId: 9, options: { filename: 'X', format: 'txt' } }, {});
  assert.equal(start.ok, true);
  const st = await waitJob(listeners, 9);
  assert.equal(st.visibleJob.status, 'error');
  assert.equal(st.visibleJob.code, 'TIME');
  assert.match(st.visibleJob.error, /Manjka čas za vrstico 665/);
  assert.match(st.visibleJob.message, /Manjka čas za vrstico 665/);
  assert.equal(st.visibleJob.details && st.visibleJob.details.ordinal, 665);
  const collects = frameCalls.filter((c) => c.type === 'ss-collect-visible-transcript');
  assert.equal(collects.length, 1, 'samo preferred okvir: ' + JSON.stringify(collects));
  assert.equal(collects[0].frameId, 7);
  assert.equal(downloads.length, 0);
});

test('preferred NO_PANE → drugi okvir uspe → download', async () => {
  const parsed = {
    entries: [{ id: 'dom-0', text: 'Ok', speaker: 'A', speakerId: '', startMs: 1000, endMs: 2000, lang: '' }],
    stats: { lines: 1, speakers: 1, language: '', skippedEmpty: 0, skippedBadTime: 0 }
  };
  const { listeners, downloads, frameCalls } = loadBg({
    sendMessage: async (id, msg, opts) => {
      if (msg.type === 'ss-collect-visible-transcript') {
        if (opts.frameId === 3) return { ok: false, error: 'Zavihek Prepis ni odprt…', code: 'NO_PANE' };
        if (opts.frameId === 0) return { ok: true, parsed };
        return { ok: false, error: 'unexpected frame ' + opts.frameId };
      }
      return null;
    }
  });
  await listeners.msg({ type: 'ss-visible-pane', available: true, setSize: 1 }, { tab: { id: 11 }, frameId: 3 });
  await listeners.msg({ type: 'ss-save-visible-transcript', tabId: 11, options: { filename: 'Y', format: 'txt' } }, {});
  const st = await waitJob(listeners, 11);
  assert.equal(st.visibleJob.status, 'done', st.visibleJob && st.visibleJob.message);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'Y.txt');
  const collects = frameCalls.filter((c) => c.type === 'ss-collect-visible-transcript');
  assert.ok(collects.length >= 2, 'preferred potem fallback: ' + JSON.stringify(collects));
  assert.equal(collects[0].frameId, 3);
  assert.ok(collects.some((c) => c.frameId === 0));
});

test('brez preferred: uspeh na frame 0 → download', async () => {
  const parsed = {
    entries: [{ id: 'dom-0', text: 'Z', speaker: 'B', speakerId: '', startMs: 0, endMs: 1, lang: '' }],
    stats: { lines: 1, speakers: 1, language: '', skippedEmpty: 0, skippedBadTime: 0 }
  };
  const { listeners, downloads } = loadBg({
    sendMessage: async (id, msg, opts) => {
      if (msg.type === 'ss-collect-visible-transcript') {
        assert.equal(opts.frameId, 0);
        return { ok: true, parsed };
      }
      return null;
    }
  });
  // ni ss-visible-pane → ni prefer
  await listeners.msg({ type: 'ss-save-visible-transcript', tabId: 12, options: { filename: 'Z', format: 'txt' } }, {});
  const st = await waitJob(listeners, 12);
  assert.equal(st.visibleJob.status, 'done', st.visibleJob && st.visibleJob.message);
  assert.equal(downloads.length, 1);
});

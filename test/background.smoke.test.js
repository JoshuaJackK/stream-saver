'use strict';
// Smoke test of background.js orchestration in Node with a stubbed WebExtension API:
// webRequest detection -> badge -> ss-state -> ss-start -> manifest fetch (with x-spopactoken) -> segments -> downloads.download
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const { DOMParser } = require('@xmldom/xmldom');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const SRC = path.join(__dirname, '..', 'src');

test('background orchestration', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bg-'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=9', '-f', 'lavfi', '-i', 'sine=duration=9',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'dash', '-seg_duration', '2',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a', path.join(dir, 'manifest.mpd')]);
  const MANIFEST = 'https://northeurope1-mediap.svc.ms/transform/videomanifest?provider=spo&docid=x&part=index&format=dash';
  // rewrite segment base so segments live on sharepoint
  let mpd = fs.readFileSync(path.join(dir, 'manifest.mpd'), 'utf8').replace('<Period', '<BaseURL>https://example-my.sharepoint.com/seg/</BaseURL><Period');
  fs.writeFileSync(path.join(dir, 'manifest.mpd'), mpd);

  const listeners = {}; const badges = {}; const downloads = []; const fetchLog = [];
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const browser = {
    webRequest: { onBeforeSendHeaders: ev('wr') },
    tabs: { onRemoved: ev('rm'), onUpdated: ev('up'), get: async (id) => ({ id, title: 'Primer predmeta – 3. predavanje.mp4 - Microsoft Stream', url: 'https://example-my.sharepoint.com/personal/u/_layouts/15/stream.aspx?id=a' }), sendMessage: async () => null },
    browserAction: { setBadgeText: async (o) => { badges.text = o.text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    downloads: { download: async (o) => { downloads.push(o); return 1; }, onChanged: ev('dl') },
    runtime: { onMessage: ev('msg') },
    permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } }
  };
  let sinkBytes = 0;
  const ctx = {
    browser, console: { log() {} }, URL, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, crypto: globalThis.crypto, DOMParser, Blob,
    fetch: async (url, init) => {
      fetchLog.push({ url, headers: init.headers, credentials: init.credentials });
      const u = new URL(url);
      const file = u.host.endsWith('svc.ms') ? path.join(dir, 'manifest.mpd') : path.join(dir, u.pathname.replace('/seg/', ''));
      if (!fs.existsSync(file)) return new Response(null, { status: 404 });
      return new Response(fs.readFileSync(file), { status: 200 });
    }
  };
  ctx.globalThis = ctx;
  ctx.URL = class extends URL {}; ctx.URL.createObjectURL = () => 'blob:moz-extension://x/1'; ctx.URL.revokeObjectURL = () => {};
  vm.createContext(ctx);
  for (const f of ['lib/mpd.js', 'lib/mp4.js', 'lib/ts.js', 'lib/engine.js', 'lib/hls.js', 'lib/hlsdl.js', 'lib/detect.js', 'lib/transcript.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  ctx.SSSink = { purgeAll: async () => {}, createSink: async () => ({ kind: 'test', write: async (u8) => { sinkBytes += u8.byteLength; }, close: async () => {}, abort: async () => {}, getBlob: async () => new Blob([]), cleanup: async () => {} }) };
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background-generic.js'), 'utf8'), ctx, { filename: 'background-generic.js' });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });

  // player inside a Teams iframe requests the manifest (tab 7, frame 3)
  listeners.wr({ url: MANIFEST, tabId: 7, frameId: 3, documentUrl: 'https://example-my.sharepoint.com/personal/u/_layouts/15/embed.aspx', originUrl: 'https://example-my.sharepoint.com/', requestHeaders: [{ name: 'x-spopactoken', value: 'TOKEN123' }] });
  assert.equal(badges.text, '▼');
  const st = await listeners.msg({ type: 'ss-state', tabId: 7 }, {});
  assert.equal(st.detected, true);
  assert.equal(st.title, 'Primer predmeta – 3. predavanje');
  assert.match(st.commands.ffmpeg, /x-spopactoken: TOKEN123/);
  assert.match(st.commands.ytdlp, /--cookies-from-browser firefox/);

  await listeners.msg({ type: 'ss-start', tabId: 7, options: { subfolder: 'Primer predmeta', mode: 'av', concurrency: 4 } }, {});
  for (let i = 0; i < 200; i++) {
    const s = await listeners.msg({ type: 'ss-state', tabId: 7 }, {});
    if (s.job && s.job.status !== 'running') { assert.equal(s.job.status, 'done', s.job.error); break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'Primer predmeta/Primer predmeta – 3. predavanje.mp4');
  const manifestFetches = fetchLog.filter((f) => /videomanifest|manifest\.mpd/.test(f.url) || f.url.includes('svc.ms'));
  const segFetches = fetchLog.filter((f) => f.url.startsWith('https://example-my.sharepoint.com/seg/'));
  assert.ok(manifestFetches.length >= 1, 'manifest fetched');
  assert.ok(manifestFetches.every((f) => f.headers['x-spopactoken'] === 'TOKEN123'));
  assert.ok(segFetches.length > 0, 'segments fetched');
  assert.ok(segFetches.every((f) => !f.headers['x-spopactoken'] && f.credentials === 'include'));
  assert.ok(sinkBytes > 100000);
  assert.equal(badges.text, 'OK');
});

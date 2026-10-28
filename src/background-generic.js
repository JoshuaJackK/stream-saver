/*
 * Stream Saver – splošno zaznavanje video tokov (HLS / DASH / navadne datoteke) na poljubni strani.
 * Dovoljenje za vse strani (<all_urls>) je NEOBVEZNO: uporabnik ga vklopi v oknu razširitve.
 * Brez njega ta del ne naredi nič (ne posluša zahtev, ne vstavlja skriptov).
 *
 * Opazovanje je samo branje glav odgovorov (brez blokiranja in brez branja teles). Prenos prek ozadja
 * ali – če strežnik zavrne – prek okvirja strani (vaše piškotke, Referer in Origin kot predvajalnik).
 * TRDO: DRM se zavrne (HLS SAMPLE-AES/FairPlay/PlayReady/Widevine, DASH ContentProtection, CENC v MP4).
 */
/* global SSMpd, SSMp4, SSEngine, SSSink, SSHls, SSHlsDl, SSDetect */
'use strict';

globalThis.SSGen = (function () {
  const MAX_STREAMS = 24;
  const gtabs = new Map(); // tabId -> {streams: Map, hidden: Set, seq, job, lastNotify}
  let deps = null;
  let enabled = false;
  let registered = null;
  let nextId = 1;

  const LOG = (...a) => (deps && deps.LOG ? deps.LOG(...a) : console.log('[Stream Saver]', ...a));

  function gstate(tabId) {
    let g = gtabs.get(tabId);
    if (!g) { g = { streams: new Map(), hidden: new Set(), job: null, notifyTimer: null }; gtabs.set(tabId, g); }
    return g;
  }
  function jobRunningAnywhere(tabId) {
    const g = gtabs.get(tabId);
    return !!(g && g.job && g.job.status === 'running');
  }
  function isDynamic(parsed) { return (parsed.warnings || []).some((w) => /dynamic/i.test(w)); }
  function pathKey(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return u; } }

  // ---------------- zaznavanje ----------------
  function onHeaders(d) {
    try {
      if (d.tabId < 0) return;
      const from = d.originUrl || d.documentUrl || '';
      if (from.startsWith('moz-extension:')) return;
      if (jobRunningAnywhere(d.tabId)) return; // lastne zahteve med prenosom ne štejemo
      const r = SSDetect.classify({
        url: d.url, method: d.method, status: d.statusCode,
        contentType: SSDetect.hdr(d.responseHeaders, 'content-type'),
        contentLength: SSDetect.hdr(d.responseHeaders, 'content-length'),
        contentRange: SSDetect.hdr(d.responseHeaders, 'content-range')
      });
      if (!r) return;
      const g = gstate(d.tabId);
      if (g.hidden.has(pathKey(d.url))) return;
      let e = g.streams.get(r.key);
      if (e) {
        e.url = d.url; e.frameId = d.frameId; e.lastSeen = Date.now();
        if (r.size && (!e.size || r.size > e.size)) e.size = r.size;
        return;
      }
      if (g.streams.size >= MAX_STREAMS) return;
      e = {
        id: nextId++, kind: r.kind, key: r.key, url: d.url, frameId: d.frameId, documentUrl: d.documentUrl || null,
        contentType: SSDetect.hdr(d.responseHeaders, 'content-type') || '', size: r.size, audioOnly: r.audioOnly,
        small: !!r.small, ext: r.ext || null, time: Date.now(), lastSeen: Date.now(), meta: null, probe: 'new'
      };
      g.streams.set(r.key, e);
      LOG('splošni tok zaznan', r.kind, d.url.slice(0, 120));
      scheduleProbe(d.tabId, e);
      changed(d.tabId);
    } catch (err) { LOG('onHeaders', err && err.message); }
  }

  function changed(tabId) {
    if (deps) deps.setBadge(tabId);
    const g = gtabs.get(tabId);
    if (!g || g.notifyTimer) return;
    g.notifyTimer = setTimeout(() => { g.notifyTimer = null; notifyTop(tabId); }, 250);
  }
  function notifyTop(tabId) {
    browser.tabs.get(tabId).then((tab) => {
      return browser.tabs.sendMessage(tabId, { type: 'ss-gupdate', state: summary(tabId, tab) }, { frameId: 0 }).catch(() => {});
    }, () => {});
  }

  // ---------------- poizvedba o toku (trajanje, kakovosti, DRM) ----------------
  const probeQueue = [];
  let probing = false;
  function scheduleProbe(tabId, e) {
    if (e.kind !== 'hls' && e.kind !== 'dash') return;
    probeQueue.push({ tabId, e });
    pumpProbes();
  }
  async function pumpProbes() {
    if (probing) return;
    probing = true;
    try {
      while (probeQueue.length) {
        const { tabId, e } = probeQueue.shift();
        if (e.probe !== 'new') continue;
        const g = gtabs.get(tabId);
        if (!g || !g.streams.has(e.key) || jobRunningAnywhere(tabId)) continue;
        e.probe = 'running';
        try { await probeEntry(tabId, e, g); e.probe = 'done'; }
        catch (err) { e.probe = 'failed'; e.meta = e.meta || { error: String(err && err.message || err) }; }
        changed(tabId);
      }
    } finally { probing = false; }
  }
  async function probeEntry(tabId, e, g) {
    const fetcher = makeFetcher(tabId, e);
    if (e.kind === 'hls') {
      const top = await SSHlsDl.loadPlaylist(fetcher, e.url);
      if (top.type === 'master') {
        const vs = SSHls.sortedVariants(top);
        const hide = new Set(vs.map((v) => pathKey(v.uri)));
        (top.renditions || []).forEach((r) => { if (r.uri) hide.add(pathKey(r.uri)); });
        hide.forEach((k) => { g.hidden.add(k); });
        for (const [k, other] of g.streams) { if (hide.has(pathKey(other.url))) g.streams.delete(k); }
        e.meta = { master: true, drm: top.drm || null, variants: vs.map((v, i) => ({ index: i, label: SSHls.describeVariant(v), audioOnly: v.audioOnly })), label: vs.length ? SSHls.describeVariant(vs[0]) : null, audioOnlyStream: !!(vs.length && vs.every((v) => v.audioOnly)) };
        if (vs.length) {
          try {
            const m = await SSHlsDl.loadPlaylist(fetcher, vs[0].uri);
            if (m.type === 'media') Object.assign(e.meta, { durationSec: m.totalDuration, live: m.live, drm: e.meta.drm || m.drm || null, iframesOnly: m.iframesOnly });
          } catch (err) { /* trajanje ni nujno */ }
        }
      } else {
        e.meta = { master: false, durationSec: top.totalDuration, live: top.live, drm: top.drm || null, iframesOnly: top.iframesOnly };
      }
    } else if (e.kind === 'dash') {
      const raw = await SSEngine.fetchWithRetry(fetcher, e.url, { maxAttempts: 3 });
      const parsed = SSMpd.parseMpd(new TextDecoder().decode(raw), e.url);
      const vids = (parsed.tracks || []).filter((t) => t.type === 'video' && !t.unsupported).sort((a, b) => ((b.height || 0) - (a.height || 0)) || (b.bandwidth - a.bandwidth));
      e.meta = { durationSec: parsed.durationSec || 0, drm: parsed.drm || null, live: isDynamic(parsed), label: vids[0] ? (vids[0].height ? vids[0].height + 'p' : 'video') : (parsed.tracks && parsed.tracks.length ? 'samo zvok' : null) };
      if (!vids[0] && parsed.tracks && parsed.tracks.length) e.audioOnly = true;
    }
  }

  // ---------------- povzetek za pojavni meni in plavajoči gumb ----------------
  function visibleStreams(g) {
    return Array.from(g.streams.values()).filter((e) => !g.hidden.has(pathKey(e.url)) && e.probe !== 'failed-hidden');
  }
  function kindLabel(e) {
    if (e.kind === 'hls') return 'HLS';
    if (e.kind === 'dash') return 'DASH';
    return (e.ext || 'datoteka').toUpperCase();
  }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return ''; } }
  function nameHint(u) { try { const p = new URL(u).pathname.split('/').filter(Boolean); return decodeURIComponent(p[p.length - 1] || ''); } catch (e) { return ''; } }

  function view(e) {
    const m = e.meta || {};
    return {
      id: e.id, kind: e.kind, kindLabel: kindLabel(e), url: e.url, host: hostOf(e.url), hint: nameHint(e.url),
      size: e.size || null, durationSec: m.durationSec || null, quality: m.label || null,
      variants: m.variants || null, live: !!m.live, drm: m.drm || null, audioOnly: !!e.audioOnly || !!m.audioOnlyStream,
      flags: SSDetect.flags(Object.assign({}, e, { meta: m })), score: SSDetect.score(Object.assign({}, e, { meta: m })),
      probing: e.probe === 'new' || e.probe === 'running', note: m.error || null
    };
  }

  function summary(tabId, tab) {
    const g = gtabs.get(tabId);
    const streams = g && !(deps && deps.hasStream(tabId)) ? visibleStreams(g).map(view).sort((a, b) => b.score - a.score) : [];
    const job = g && g.job ? Object.assign({}, g.job, { ctrl: undefined }) : null;
    const title = tab && tab.title ? tab.title : '';
    return {
      enabled, streams, mainId: streams.length ? streams[0].id : null, job,
      defaultName: SSDetect.nameFromTitle(SSMpd.titleFromTab ? SSMpd.titleFromTab(title) : title, 'posnetek'),
      pageHost: tab && tab.url ? hostOf(tab.url) : '', pageUrl: tab && tab.url ? tab.url : ''
    };
  }
  function badge(tabId) {
    if (!enabled) return null;
    const g = gtabs.get(tabId);
    if (!g || (deps && deps.hasStream(tabId) && !g.job)) return null;
    if (g.job) {
      if (g.job.status === 'running') { const pct = g.job.total ? Math.floor(g.job.done / g.job.total * 100) : 0; return { job: true, text: pct + '%', color: '#1565c0', title: `Stream Saver – prenašam (${pct} %)` }; }
      if (g.job.status === 'error') return { job: true, text: '!', color: '#c62828', title: 'Stream Saver – napaka pri prenosu' };
      if (g.job.status === 'done') return { job: true, text: 'OK', color: '#2e7d32', title: 'Stream Saver – prenos končan' };
    }
    const n = visibleStreams(g).length;
    return n ? { job: false, text: '▼', color: '#2e7d32', title: `Stream Saver – zaznanih tokov: ${n}, klikni za prenos` } : null;
  }

  // ---------------- prenos prek ozadja / okvirja ----------------
  async function bgFetch(url, opts) {
    const headers = {};
    if (opts && opts.range) headers.Range = 'bytes=' + opts.range;
    const r = await fetch(url, { credentials: 'include', headers, signal: opts && opts.signal, cache: 'no-store' });
    const ok = r.status >= 200 && r.status < 300;
    return { status: r.status, retryAfter: r.headers.get('Retry-After'), contentRange: r.headers.get('Content-Range'), buffer: ok ? await r.arrayBuffer() : null };
  }
  async function frameFetch(tabId, frameId, url, opts) {
    const headers = {};
    if (opts && opts.range) headers.Range = 'bytes=' + opts.range;
    const r = await browser.tabs.sendMessage(tabId, { type: 'ss-gfetch', url, headers }, { frameId: frameId || 0 });
    if (!r) throw new Error('Okvir strani se ne odziva (osveži stran).');
    if (r.error) throw new Error(r.error);
    return r;
  }
  /** Najprej ozadje; ob 401/403/napaki omrežja preklop na okvir strani (kot predvajalnik: piškotki, Referer, Origin). */
  function makeFetcher(tabId, entry) {
    let mode = 'bg';
    const f = async (url, opts) => {
      if (mode === 'frame') return frameFetch(tabId, entry.frameId, url, opts);
      let r;
      try { r = await bgFetch(url, opts); }
      catch (e) { if (e.name === 'AbortError') throw e; r = { status: 0, error: e }; }
      if (r.status === 401 || r.status === 403 || (r.status === 0 && r.error)) {
        try {
          const r2 = await frameFetch(tabId, entry.frameId, url, opts);
          if (r2.status >= 200 && r2.status < 300) { mode = 'frame'; LOG('preklop na prenos prek okvirja strani'); }
          return r2;
        } catch (e) { if (r.error) throw r.error; return r; }
      }
      if (r.error) throw r.error;
      return r;
    };
    f.mode = () => mode;
    return f;
  }

  // ---------------- prenos ----------------
  function extFor(kind, res, entry, mode) {
    if (res && res.ext) return res.ext;
    if (kind === 'dash') return mode === 'audio' ? 'm4a' : 'mp4';
    return entry.ext || (entry.audioOnly ? 'm4a' : 'mp4');
  }
  const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', ts: 'video/mp2t', mp3: 'audio/mpeg', ogg: 'audio/ogg' };

  async function startJob(tabId, opts) {
    const g = gstate(tabId);
    if (g.job && g.job.status === 'running') throw new Error('Prenos že teče.');
    const entry = Array.from(g.streams.values()).find((e) => e.id === opts.streamId);
    if (!entry) throw new Error('Tok ni več na voljo – osveži stran in ga predvajaj ponovno.');
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const ctrl = new AbortController();
    const mode = opts.mode === 'audio' ? 'audio' : 'av';
    const name = SSMpd.sanitizeFilename(opts.filename || SSDetect.nameFromTitle(SSMpd.titleFromTab(tab && tab.title), 'posnetek'));
    const sub = SSMpd.sanitizeSubfolder(opts.subfolder || '');
    const job = { status: 'running', done: 0, total: 0, bytes: 0, message: 'Pripravljam …', filename: name, ctrl, started: Date.now(), error: null, notes: [], warning: null };
    g.job = job;
    changed(tabId);
    let sink = null;
    let lastBadge = 0;
    const onProgress = (p) => {
      job.done = p.done; job.total = p.total; job.bytes = p.bytes; job.message = p.message || job.message;
      if (Date.now() - lastBadge > 1000) { lastBadge = Date.now(); changed(tabId); }
    };
    try {
      const fetcher = makeFetcher(tabId, entry);
      const base = { fetchBytes: fetcher, concurrency: opts.concurrency || 4, signal: ctrl.signal, onProgress };
      const sinkName = 'ss-' + Date.now() + '.bin';
      let ext, defrag = null, blobType;
      if (entry.kind === 'hls') {
        const plan = await SSHlsDl.plan({ fetchBytes: fetcher, url: entry.url, variantIndex: opts.variantIndex, mode, signal: ctrl.signal });
        if (plan.warning) job.warning = plan.warning;
        const res = await SSHlsDl.run(Object.assign({ plan, durationSec: plan.durationSec, openSink: async () => { sink = await SSSink.createSink(sinkName); job.sinkKind = sink.kind; return sink; } }, base));
        sink = res.sink || sink;
        res.notes.forEach((n) => job.notes.push(n));
        ext = res.ext; if (res.needsDefrag) defrag = res.defragOpts || {};
        job.hasVideo = res.hasVideo; job.hasAudio = res.hasAudio;
      } else if (entry.kind === 'dash') {
        const raw = await SSEngine.fetchWithRetry(fetcher, entry.url, { maxAttempts: 4, signal: ctrl.signal });
        const parsed = SSMpd.parseMpd(new TextDecoder().decode(raw), entry.url);
        if (parsed.drm) { const e = SSEngine.drmError(parsed.drm); throw e; }
        if (isDynamic(parsed)) throw new Error('To je živi prenos (DASH dynamic). Živih prenosov Stream Saver ne podpira.');
        const tracks = SSMpd.selectTracks(parsed, mode);
        if (!tracks.length) throw new Error('V DASH seznamu ni uporabnih sledi.');
        job.hasVideo = tracks.some((t) => t.type === 'video'); job.hasAudio = tracks.some((t) => t.type === 'audio');
        sink = await SSSink.createSink(sinkName); job.sinkKind = sink.kind;
        await SSEngine.runDownload(Object.assign({
          tracks, durationSec: parsed.durationSec, sink,
          getKey: async (track) => {
            const enc = track.encryption;
            if (enc && enc.type === 'sea' && enc.keyUri) {
              const kraw = await SSEngine.fetchWithRetry(fetcher, enc.keyUri, { maxAttempts: 4, signal: ctrl.signal });
              return { key: await crypto.subtle.importKey('raw', kraw, { name: 'AES-CBC' }, false, ['decrypt']), iv: enc.iv || null };
            }
            return null;
          }
        }, base));
        ext = job.hasVideo ? 'mp4' : 'm4a'; defrag = {};
      } else {
        sink = await SSSink.createSink(sinkName); job.sinkKind = sink.kind;
        const r = await SSEngine.runProgressive(Object.assign({ url: entry.url, sink }, base));
        if (r && r.ranged === false) job.warning = 'Strežnik ne podpira delnih prenosov – datoteka je bila prenesena naenkrat (porabi več pomnilnika).';
        ext = extFor('mp4', null, entry, mode);
        job.hasVideo = !entry.audioOnly; job.hasAudio = true;
      }
      let blob = await sink.getBlob();
      if (defrag) {
        job.message = 'Prilagajam datoteko za VLC/mpv …'; changed(tabId);
        try {
          const raw = new Uint8Array(await blob.arrayBuffer());
          if (SSMp4.isFragmented(raw)) {
            const flat = SSMp4.defragmentToProgressive(raw, null, defrag);
            blob = new Blob([flat], { type: MIME[ext] || 'video/mp4' });
          }
        } catch (e) {
          LOG('defragmentacija ni uspela', e && e.message);
          job.notes.push('Datoteka je ostala fragmentirana; če jo predvajalnik ne predvaja, jo pretvori: ffmpeg -i vhod.mp4 -c copy -movflags +faststart izhod.mp4');
        }
      }
      blob = new Blob([blob], { type: MIME[ext] || 'application/octet-stream' });
      const filename = (sub ? sub + '/' : '') + name + '.' + ext;
      job.filename = filename;
      job.message = 'Shranjujem datoteko …';
      const url = URL.createObjectURL(blob);
      let downloadId;
      try { downloadId = await browser.downloads.download({ url, filename, saveAs: !!opts.saveAs, conflictAction: 'uniquify' }); }
      catch (e) { URL.revokeObjectURL(url); throw new Error('Shranjevanje ni uspelo: ' + e.message); }
      deps.pendingDownloads.set(downloadId, { url, sink });
      sink = null;
      job.status = 'done';
      job.message = `Končano: ${(job.bytes / 1048576).toFixed(0)} MB.`;
    } catch (e) {
      LOG('splošni prenos – napaka', e);
      job.status = e.name === 'AbortError' ? 'cancelled' : 'error';
      job.error = e.name === 'AbortError' ? 'Prenos preklican.' : (e.message || String(e));
      job.message = job.error;
      if (e.code === 'DRM') job.drm = true;
      if (sink) await sink.abort();
    } finally {
      delete job.ctrl;
      changed(tabId);
    }
  }

  // ---------------- dovoljenje in vklop ----------------
  const FILTER = { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] };
  async function register() {
    try {
      if (registered) { try { await registered.unregister(); } catch (e) { /* ignore */ } registered = null; }
      registered = await browser.contentScripts.register({
        matches: ['http://*/*', 'https://*/*'], js: [{ file: '/content-generic.js' }],
        allFrames: true, matchAboutBlank: true, runAt: 'document_idle'
      });
    } catch (e) { LOG('registracija skripte ni uspela', e && e.message); }
  }
  async function enable() {
    if (enabled) return;
    try {
      browser.webRequest.onHeadersReceived.addListener(onHeaders, FILTER, ['responseHeaders']);
    } catch (e) { LOG('webRequest <all_urls> ni na voljo', e && e.message); return; }
    enabled = true;
    await register();
    LOG('splošno zaznavanje vklopljeno');
    for (const id of gtabs.keys()) changed(id);
  }
  async function disable() {
    if (!enabled) return;
    enabled = false;
    try { browser.webRequest.onHeadersReceived.removeListener(onHeaders); } catch (e) { /* ignore */ }
    if (registered) { try { await registered.unregister(); } catch (e) { /* ignore */ } registered = null; }
    for (const [id, g] of gtabs) { if (!(g.job && g.job.status === 'running')) gtabs.delete(id); if (deps) deps.setBadge(id); }
    LOG('splošno zaznavanje izklopljeno');
  }
  async function hasPermission() {
    try { return await browser.permissions.contains({ origins: ['<all_urls>'] }); } catch (e) { return false; }
  }
  async function refresh() { if (await hasPermission()) await enable(); else await disable(); }

  function init(d) {
    deps = d;
    refresh();
    try {
      browser.permissions.onAdded.addListener(() => { refresh(); });
      browser.permissions.onRemoved.addListener(() => { refresh(); });
    } catch (e) { /* ignore */ }
  }

  function reset(tabId) {
    const g = gtabs.get(tabId);
    if (!g) return false;
    if (g.job && g.job.status === 'running') return false;
    if (g.notifyTimer) clearTimeout(g.notifyTimer);
    gtabs.delete(tabId);
    return true;
  }
  function remove(tabId) { return reset(tabId); }

  /** Sporočila iz pojavnega okna / plavajočega gumba. Vrne undefined, če sporočilo ni naše. */
  function onMessage(msg, sender) {
    const tabIdOf = () => (msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id));
    if (msg.type === 'ss-g-state') {
      const tabId = tabIdOf();
      if (tabId == null) return Promise.resolve({ enabled, streams: [] });
      return browser.tabs.get(tabId).then((tab) => summary(tabId, tab), () => summary(tabId, null));
    }
    if (msg.type === 'ss-g-start') {
      const tabId = tabIdOf();
      startJob(tabId, msg.options || {}).catch((e) => {
        const g = gstate(tabId);
        g.job = { status: 'error', error: e.message, message: e.message, done: 0, total: 0, bytes: 0, notes: [] };
        changed(tabId);
      });
      return Promise.resolve(true);
    }
    if (msg.type === 'ss-g-cancel') {
      const g = gtabs.get(tabIdOf());
      if (g && g.job && g.job.ctrl) g.job.ctrl.abort();
      return Promise.resolve(true);
    }
    if (msg.type === 'ss-g-reset') {
      const tabId = tabIdOf();
      const g = gtabs.get(tabId);
      if (g && g.job && g.job.status !== 'running') g.job = null;
      changed(tabId);
      return Promise.resolve(true);
    }
    return undefined;
  }

  return { init, onMessage, reset, remove, badge, summary, onHeaders, classifyOnly: SSDetect && SSDetect.classify, _state: gtabs, isEnabled: () => enabled, enable, disable };
})();

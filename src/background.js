/* Stream Saver – ozadje: zaznavanje posnetka, upravljanje prenosov, značka v orodni vrstici. */
/* global SSMpd, SSMp4, SSEngine, SSSink, SSTranscript */
'use strict';

const LOG = (...a) => console.log('[Stream Saver]', ...a);
const tabs = new Map(); // tabId -> state
let lastMediaTab = null;

function tabState(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = { manifest: null, transcode: {}, encrypted: false, page: null, job: null };
    tabs.set(tabId, s);
  }
  return s;
}
function hasDetection(s) { return !!(s && (s.manifest || Object.keys(s.transcode).length)); }
function hasTranscript(s) { return !!(s && s.transcript && (s.transcript.status === 'ready' || s.transcript.status === 'loading')); }

// ---------------- badge ----------------
function setBadge(tabId) {
  const s = tabs.get(tabId);
  let text = '', color = '#2e7d32', title = 'Stream Saver – ni zaznanega posnetka';
  if (s && s.job && s.job.status === 'running') {
    const pct = s.job.total ? Math.floor((s.job.done / s.job.total) * 100) : 0;
    text = pct + '%'; color = '#1565c0'; title = `Stream Saver – prenašam (${pct} %)`;
  } else if (s && s.job && s.job.status === 'error') {
    text = '!'; color = '#c62828'; title = 'Stream Saver – napaka pri prenosu';
  } else if (s && s.job && s.job.status === 'done') {
    text = 'OK'; color = '#2e7d32'; title = 'Stream Saver – prenos končan';
  } else if (hasDetection(s)) {
    text = '▼'; color = '#2e7d32'; title = 'Stream Saver – posnetek zaznan, klikni za prenos';
    if (hasTranscript(s)) title += ' (prepis zaznan)';
  } else if (hasTranscript(s)) {
    text = 'T'; color = '#2e7d32'; title = 'Stream Saver – prepis zaznan, klikni za shranjevanje';
  }
  browser.browserAction.setBadgeText({ tabId, text }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  browser.browserAction.setTitle({ tabId, title }).catch(() => {});
  notifyTab(tabId);
}

/** Push current summary to all frames in the tab (for the on-page floating button). */
function notifyTab(tabId) {
  if (tabId == null || tabId < 0) return;
  browser.tabs.get(tabId).then((tab) => {
    const payload = { type: 'ss-update', state: summary(tabId, tab) };
    return browser.tabs.sendMessage(tabId, payload).catch(() => {});
  }, () => {}).then(() => {
    // Also try every frame: top-level sendMessage only hits matching frame listeners
    // that are registered; with all_frames content scripts, Firefox delivers to all.
  });
}

// ---------------- detection (webRequest sees requests from frames AND workers) ----------------
function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}
function fromExtension(d) {
  const o = d.originUrl || d.documentUrl || '';
  return o.startsWith('moz-extension:');
}

function onRequest(d) {
  if (fromExtension(d)) return;
  let url;
  try { url = new URL(d.url); } catch (e) { return; }
  // Prepis: samo zahteva, ki jo predvajalnik sam naredi za prikaz (format=json). Neodvisno od videa.
  const tr = SSTranscript.matchViewRequest(d.url, d.method);
  if (tr) { onTranscriptRequest(d, tr); return; }
  let tabId = d.tabId;
  if (tabId < 0) { if (lastMediaTab === null) return; tabId = lastMediaTab; }
  const isManifest = /\/transform\/videomanifest/i.test(url.pathname);
  const isTranscode = SSMpd.TRANSCODE_RE.test(url.pathname + '?');
  if (!isManifest && !isTranscode) return;
  const s = tabState(tabId);
  if (s.job && s.job.status === 'running') return; // our own proxied fetches – do not disturb
  lastMediaTab = tabId;
  if (isManifest) {
    if (/tempauth/i.test(d.url) && s.manifest) return;
    const tok = headerValue(d.requestHeaders, 'x-spopactoken');
    s.manifest = { url: d.url, frameId: d.frameId, time: Date.now(), spopactoken: tok || (s.manifest && s.manifest.spopactoken) || null, documentUrl: d.documentUrl || null };
    LOG('videomanifest zaznan', tabId, url.host);
    probeManifestMeta(tabId, s);
  } else {
    const q = url.searchParams;
    const part = q.get('part') || 'other';
    let trackName = (q.get('track') || '').toLowerCase();
    if (!trackName) {
      const qual = (q.get('quality') || '').toLowerCase();
      trackName = /^aud/.test(qual) ? 'audio' : 'video';
    } else if (/aud|audio/.test(trackName)) trackName = 'audio';
    else trackName = 'video';
    const key = part + ':' + trackName + ':' + (q.get('quality') || '');
    if (q.get('enableEncryption') === '1') s.encrypted = true;
    if (part === 'initsegment' || part === 'mediasegment') {
      if (!s.transcode[key]) LOG('oneDrive.transcode', key, tabId);
      s.transcode[key] = d.url; // keep newest (freshest tokens)
      if (s.transcodeFrameId === undefined) s.transcodeFrameId = d.frameId;
    }
  }
  if (s.job && s.job.status !== 'running') s.job = null;
  setBadge(tabId);
}

const FILTER = {
  urls: ['*://*.svc.ms/*', '*://*.sharepoint.com/*', '*://*.sharepoint.com.mcas.ms/*', '*://*.svc.ms.mcas.ms/*']
};
browser.webRequest.onBeforeSendHeaders.addListener(onRequest, FILTER, ['requestHeaders']);

browser.tabs.onRemoved.addListener((tabId) => {
  const s = tabs.get(tabId);
  if (!s || !s.job || s.job.status !== 'running') tabs.delete(tabId);
  if (lastMediaTab === tabId) lastMediaTab = null;
});
function stripHash(u) { return String(u || '').split('#')[0]; }
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    const s = tabs.get(tabId);
    if (s && !(s.job && s.job.status === 'running')) {
      tabs.delete(tabId);
      setBadge(tabId);
      return;
    }
    if (s && s.transcript) { s.transcript = null; setBadge(tabId); return; } // prenos videa teče, prepis pa je s prejšnje strani
  }
  // SPA navigacija (naslov se spremeni brez nalaganja strani): prepis starega posnetka ne sme ostati.
  if (info.url) {
    const s = tabs.get(tabId);
    const t = s && s.transcript;
    if (t && t.tabUrl && stripHash(info.url) !== stripHash(t.tabUrl)) {
      if (Date.now() - t.time > 3000) { s.transcript = null; setBadge(tabId); }
      else t.tabUrl = info.url; // zahteva je prišla že po navigaciji
    }
  }
});

// ---------------- transcript (prepis) ----------------
function onTranscriptRequest(d, m) {
  if (typeof d.tabId !== 'number' || d.tabId < 0) return; // zahteve brez zavihka ne pripisujemo drugemu zavihku
  const tabId = d.tabId;
  const s = tabState(tabId);
  const cur = s.transcript;
  if (cur && cur.url === d.url) {
    cur.frameId = d.frameId; cur.time = Date.now();
    if (cur.status === 'error' && !cur.fetching && Date.now() - cur.lastAttempt > 5000) loadTranscript(tabId, s);
    return;
  }
  const t = {
    url: d.url, transcriptId: m.transcriptId, frameId: d.frameId, documentUrl: d.documentUrl || null, time: Date.now(),
    status: 'loading', parsed: null, error: null, http: null, tabUrl: null, fetching: false, lastAttempt: 0, promise: null
  };
  s.transcript = t;
  LOG('prepis zaznan', tabId, 'okvir', d.frameId);
  browser.tabs.get(tabId).then((tab) => { if (s.transcript === t && tab) t.tabUrl = tab.url; }, () => {});
  setBadge(tabId);
  loadTranscript(tabId, s);
}

/** Prebere prepis z ISTEGA naslova, ki ga je predvajalnik zahteval (isti parametri, piškotki seje). */
async function fetchTranscriptBuffer(tabId, t) {
  let r;
  try { r = await bgFetch(t.url, {}, null); } catch (e) { r = { status: 0, error: e }; }
  if (r.status === 401 || r.status === 403 || (r.status === 0 && r.error)) {
    // isti naslov še enkrat iz okvirja predvajalnika (isti izvor, iste piškotke)
    try { r = await frameFetch(tabId, t.frameId, t.url, {}, null); } catch (e) { /* ostane prvi rezultat/napaka */ }
  }
  if (r.error && !r.buffer) throw new Error('Prepisa ni bilo mogoče prebrati (' + (r.error.message || r.error) + ').');
  if (r.status < 200 || r.status >= 300 || !r.buffer) {
    const e = new Error('Prepisa ni bilo mogoče prebrati (HTTP ' + r.status + ').');
    e.http = r.status;
    throw e;
  }
  return r.buffer;
}

function loadTranscript(tabId, s) {
  const t = s.transcript;
  if (!t) return Promise.resolve(null);
  if (t.promise) return t.promise;
  t.promise = (async () => {
    t.status = 'loading'; t.fetching = true; t.lastAttempt = Date.now(); t.error = null; t.http = null;
    try {
      const buf = await fetchTranscriptBuffer(tabId, t);
      const parsed = SSTranscript.parseTranscript(buf);
      t.parsed = parsed;
      t.status = parsed.stats.lines > 0 ? 'ready' : 'empty';
      LOG('prepis prebran', SSTranscript.describe(parsed.stats));
    } catch (e) {
      t.status = 'error'; t.error = e.message || String(e); t.http = e.http || null;
      LOG('prepis napaka', t.error);
    } finally {
      t.fetching = false; t.promise = null;
      if (s.transcript === t) setBadge(tabId);
    }
    return t;
  })();
  return t.promise;
}

function transcriptSummary(t) {
  if (!t) {
    return { state: 'none', level: 'warn', text: 'Prepis še ni naložen – osveži stran (F5), da ga predvajalnik znova naloži. Če se po osvežitvi ne pojavi, ta posnetek verjetno nima prepisa.' };
  }
  if (t.status === 'loading') return { state: 'loading', level: '', text: 'Prepis zaznan, nalagam …' };
  if (t.status === 'ready') {
    return { state: 'ready', level: 'ok', text: 'Prepis zaznan: ' + SSTranscript.describe(t.parsed.stats), lines: t.parsed.stats.lines, speakers: t.parsed.stats.speakers, language: t.parsed.stats.language };
  }
  if (t.status === 'empty') return { state: 'empty', level: 'warn', text: 'Ta posnetek nima prepisa (prepis je prazen).' };
  return { state: 'error', level: 'err', text: (t.error || 'Prepisa ni bilo mogoče prebrati.') + ' Osveži stran (F5) in poskusi znova.' };
}

const TR_FORMATS = { txt: { ext: '.txt', mime: 'text/plain;charset=utf-8' }, vtt: { ext: '.vtt', mime: 'text/vtt;charset=utf-8' } };

async function saveTranscript(tabId, opts) {
  const s = tabs.get(tabId);
  if (!s || !s.transcript) throw new Error(transcriptSummary(null).text);
  let t = s.transcript;
  if (t.status !== 'ready') { await loadTranscript(tabId, s); t = s.transcript; }
  if (!t || t.status === 'empty') throw new Error('Ta posnetek nima prepisa.');
  if (t.status !== 'ready') throw new Error(transcriptSummary(t).text);
  const fmt = opts.format === 'vtt' ? 'vtt' : 'txt';
  const f = TR_FORMATS[fmt];
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const name = SSMpd.sanitizeFilename(opts.filename || baseTitle(tabId, s, tab));
  const sub = SSMpd.sanitizeSubfolder(opts.subfolder || '');
  const filename = (sub ? sub + '/' : '') + name + f.ext;
  const content = fmt === 'vtt' ? SSTranscript.toVtt(t.parsed) : SSTranscript.toTxt(t.parsed);
  const blob = new Blob([content], { type: f.mime });
  const url = URL.createObjectURL(blob);
  let downloadId;
  try {
    downloadId = await browser.downloads.download({ url, filename, saveAs: !!opts.saveAs, conflictAction: 'uniquify' });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error('Shranjevanje ni uspelo: ' + e.message);
  }
  pendingDownloads.set(downloadId, { url, sink: null });
  const st = t.parsed.stats;
  return { ok: true, filename, format: fmt, lines: st.lines, speakers: st.speakers, skipped: st.skippedBadTime };
}

// ---------------- fetching ----------------
async function bgFetch(url, opts, spopactoken) {
  const headers = {};
  if (opts && opts.range) headers.Range = 'bytes=' + opts.range;
  if (spopactoken && /\.svc\.ms/i.test(new URL(url).host)) headers['x-spopactoken'] = spopactoken;
  const r = await fetch(url, { credentials: 'include', headers, signal: opts && opts.signal, cache: 'no-store' });
  const ok = r.status >= 200 && r.status < 300;
  return { status: r.status, retryAfter: r.headers.get('Retry-After'), buffer: ok ? await r.arrayBuffer() : null, contentType: r.headers.get('Content-Type') };
}
async function frameFetch(tabId, frameId, url, opts, spopactoken) {
  const headers = {};
  if (opts && opts.range) headers.Range = 'bytes=' + opts.range;
  if (spopactoken && /\.svc\.ms/i.test(new URL(url).host)) headers['x-spopactoken'] = spopactoken;
  const r = await browser.tabs.sendMessage(tabId, { type: 'ss-fetch', url, headers }, { frameId: frameId || 0 });
  if (!r) throw new Error('Okvir predvajalnika se ne odziva (osveži stran).');
  if (r.error) throw new Error(r.error);
  return r;
}
/** Fetcher that starts in the background context and switches to the player frame on 401/403. */
function makeFetcher(tabId, s) {
  let mode = 'bg';
  const frameId = (s.page && s.page.frameId !== undefined) ? s.page.frameId
    : (s.manifest ? s.manifest.frameId : (s.transcodeFrameId || 0));
  const tok = s.manifest && s.manifest.spopactoken;
  const f = async (url, opts) => {
    if (mode === 'frame') return frameFetch(tabId, frameId, url, opts, tok);
    let r;
    try { r = await bgFetch(url, opts, tok); }
    catch (e) { if (e.name === 'AbortError') throw e; r = { status: 0, error: e }; }
    if (r.status === 401 || r.status === 403 || (r.status === 0 && r.error)) {
      try {
        const r2 = await frameFetch(tabId, frameId, url, opts, tok);
        if (r2.status >= 200 && r2.status < 300) { mode = 'frame'; LOG('preklop na prenos prek okvirja predvajalnika'); }
        return r2;
      } catch (e) { if (r.error) throw r.error; return r; }
    }
    if (r.error) throw r.error;
    return r;
  };
  f.mode = () => mode;
  return f;
}

// ---------------- job ----------------
function baseTitle(tabId, s, tab) {
  const fromPage = s.page && s.page.fileName;
  return SSMpd.sanitizeFilename(fromPage || SSMpd.titleFromTab(tab && tab.title) || 'posnetek');
}

function hasTranscodeAudio(s) {
  return Object.keys(s.transcode || {}).some((k) => k.includes(':audio:'));
}
function hasTranscodeVideo(s) {
  return Object.keys(s.transcode || {}).some((k) => k.includes(':video:'));
}

async function probeManifestMeta(tabId, s) {
  if (!s.manifest || s.manifestMeta || s._probingManifest) return;
  s._probingManifest = true;
  try {
    const r = await bgFetch(s.manifest.url, {}, s.manifest.spopactoken);
    if (!(r.status >= 200 && r.status < 300) || !r.buffer) return;
    const xml = new TextDecoder().decode(r.buffer);
    const parsed = SSMpd.parseMpd(xml, s.manifest.url);
    s.manifestMeta = SSMpd.trackSummary(parsed);
    LOG('manifest meta', s.manifestMeta);
    notifyTab(tabId);
  } catch (e) {
    LOG('manifest probe failed', e && e.message);
  } finally {
    s._probingManifest = false;
  }
}

async function waitForTranscodeAudio(s, timeoutMs, signal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hasTranscodeAudio(s)) return true;
    await SSEngine.sleep(300, signal);
  }
  return hasTranscodeAudio(s);
}

async function resolveTracks(tabId, s, fetcher, mode) {
  const notes = [];
  let manifestTracks = null;
  let durationSec = (s.page && s.page.duration) || 0;

  if (s.manifest) {
    try {
      const r = await SSEngine.fetchWithRetry(fetcher, s.manifest.url, { maxAttempts: 4 });
      const xml = new TextDecoder().decode(r);
      const parsed = SSMpd.parseMpd(xml, s.manifest.url);
      if (parsed.drm) { const e = new Error(`Posnetek je zaščiten z DRM (${parsed.drm}) – prenos ni mogoč.`); e.fatal = true; throw e; }
      s.manifestMeta = SSMpd.trackSummary(parsed);
      durationSec = parsed.durationSec || durationSec;
      const tr = SSMpd.selectTracks(parsed, mode);
      if (tr.length) {
        // For av mode: if the MPD only yielded video, do NOT return yet — try to pair audio
        // from captured oneDrive.transcode URLs (Stream sometimes mislabels or delays audio).
        if (mode === 'av' && !tr.some((t) => t.type === 'audio')) {
          notes.push('manifest brez zvočne sledi – dopolnjujem iz oneDrive.transcode');
          manifestTracks = tr;
        } else {
          return { tracks: tr, durationSec, source: 'manifest', warnings: parsed.warnings || [], hasAudio: tr.some((t) => t.type === 'audio'), hasVideo: tr.some((t) => t.type === 'video') };
        }
      } else {
        notes.push('manifest brez uporabnih sledi');
      }
    } catch (e) {
      if (e.fatal) throw e;
      notes.push('manifest: ' + e.message);
      LOG('manifest ni uporaben, poskušam oneDrive.transcode', e);
    }
  }

  if (mode === 'av' && !hasTranscodeAudio(s) && (hasTranscodeVideo(s) || manifestTracks)) {
    // Player often requests audio a second or two after video — wait briefly.
    LOG('čakam na zvočne oneDrive.transcode zahteve …');
    await waitForTranscodeAudio(s, 8000, null);
  }

  let tr = SSMpd.buildTranscodeTracks(Object.values(s.transcode), mode);
  if (manifestTracks && mode === 'av') {
    const audio = tr.find((t) => t.type === 'audio');
    const video = manifestTracks.find((t) => t.type === 'video') || tr.find((t) => t.type === 'video');
    if (video && audio) {
      return { tracks: [video, audio], durationSec, source: 'manifest+transcode', warnings: notes, hasAudio: true, hasVideo: true };
    }
    if (video && !audio) {
      notes.push('zvočna sled ni bila zajeta');
      return { tracks: [video], durationSec, source: 'manifest', warnings: notes, hasAudio: false, hasVideo: true };
    }
  }
  if (tr.length) {
    return {
      tracks: tr, durationSec, source: 'transcode', warnings: notes,
      hasAudio: tr.some((t) => t.type === 'audio'),
      hasVideo: tr.some((t) => t.type === 'video')
    };
  }
  throw new Error('Segmentov ni bilo mogoče določiti (' + (notes.join('; ') || 'ni zajetih zahtev') + '). Predvajaj posnetek nekaj sekund in poskusi znova.');
}

async function keyProviderFor(s, fetcher) {
  return async (track) => {
    const enc = track.encryption;
    if (enc && enc.type === 'sea' && enc.keyUri) {
      const raw = await SSEngine.fetchWithRetry(fetcher, enc.keyUri, { maxAttempts: 4 });
      const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      return { key, iv: enc.iv || null };
    }
    if (s.page && s.page.key && s.page.key.length === 16) {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(s.page.key), { name: 'AES-CBC' }, false, ['decrypt']);
      return { key, iv: s.page.iv && s.page.iv.length === 16 ? new Uint8Array(s.page.iv) : null };
    }
    return null;
  };
}

async function startJob(tabId, opts) {
  const s = tabState(tabId);
  if (s.job && s.job.status === 'running') throw new Error('Prenos že teče.');
  if (!hasDetection(s)) throw new Error('Posnetek ni zaznan. Predvajaj ga nekaj sekund.');
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const ctrl = new AbortController();
  const mode = opts.mode || 'av';
  const name = SSMpd.sanitizeFilename(opts.filename || baseTitle(tabId, s, tab));
  const sub = SSMpd.sanitizeSubfolder(opts.subfolder || '');
  const ext = mode === 'audio' ? '.m4a' : '.mp4';
  const filename = (sub ? sub + '/' : '') + name + ext;
  const job = { status: 'running', done: 0, total: 0, bytes: 0, message: 'Pripravljam …', filename, ctrl, started: Date.now(), error: null };
  s.job = job;
  setBadge(tabId);
  let sink = null;
  let lastBadge = 0;
  try {
    const fetcher = makeFetcher(tabId, s);
    const resolved = await resolveTracks(tabId, s, fetcher, mode);
    job.source = resolved.source;
    job.hasAudio = !!resolved.hasAudio || resolved.tracks.some((t) => t.type === 'audio');
    job.hasVideo = !!resolved.hasVideo || resolved.tracks.some((t) => t.type === 'video');
    if (mode === 'av' && !job.hasAudio) {
      job.warning = 'OPOZORILO: zvočna sled ni bila najdena – datoteka bo samo video. Predvajaj posnetek še nekaj sekund (da se naloži zvok) in poskusi znova, ali preveri, da predvajalnik ni utišan na izvoru.';
    } else if (mode === 'av' && resolved.tracks.length < 2) {
      job.warning = 'Najdena je bila le ena sled (' + resolved.tracks.map((t) => t.type).join(', ') + ').';
    }
    sink = await SSSink.createSink('ss-' + Date.now() + '.mp4');
    job.sinkKind = sink.kind;
    const result = await SSEngine.runDownload({
      tracks: resolved.tracks,
      durationSec: resolved.durationSec,
      fetchBytes: fetcher,
      getKey: await keyProviderFor(s, fetcher),
      sink,
      concurrency: opts.concurrency || 4,
      signal: ctrl.signal,
      onProgress: (p) => {
        job.done = p.done; job.total = p.total; job.bytes = p.bytes; job.message = p.message;
        if (Date.now() - lastBadge > 1000) { lastBadge = Date.now(); setBadge(tabId); }
      }
    });
    job.message = 'Prilagajam datoteko za VLC/mpv …';
    setBadge(tabId);
    let blob = await sink.getBlob();
    try {
      const raw = new Uint8Array(await blob.arrayBuffer());
      if (SSMp4.isFragmented(raw)) {
        const flat = SSMp4.defragmentToProgressive(raw);
        blob = new Blob([flat], { type: 'video/mp4' });
        job.remuxed = true;
        LOG('defragmentirano za VLC', raw.byteLength, '→', flat.byteLength);
      }
    } catch (e) {
      LOG('defragmentacija ni uspela, ohranjam fragmentiran MP4', e && e.message);
      job.remuxWarning = 'Datoteka je ostala fragmentirana; VLC morda ne bo predvajal zvoka. Pretvori z: ffmpeg -i vhod.mp4 -c copy -movflags +faststart izhod.mp4';
    }
    job.message = 'Shranjujem datoteko …';
    const url = URL.createObjectURL(blob);
    let downloadId;
    try {
      downloadId = await browser.downloads.download({ url, filename, saveAs: !!opts.saveAs, conflictAction: 'uniquify' });
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error('Shranjevanje ni uspelo: ' + e.message);
    }
    pendingDownloads.set(downloadId, { url, sink });
    sink = null;
    job.status = 'done';
    job.message = `Končano: ${(result.bytes / 1048576).toFixed(0)} MB, ${result.segments} segmentov.`;
  } catch (e) {
    LOG('napaka', e);
    job.status = e.name === 'AbortError' ? 'cancelled' : 'error';
    job.error = e.name === 'AbortError' ? 'Prenos preklican.' : (e.message || String(e));
    job.message = job.error;
    if (sink) await sink.abort();
  } finally {
    delete job.ctrl;
    setBadge(tabId);
  }
}

const pendingDownloads = new Map();
browser.downloads.onChanged.addListener((delta) => {
  const p = pendingDownloads.get(delta.id);
  if (!p || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    pendingDownloads.delete(delta.id);
    setTimeout(() => { URL.revokeObjectURL(p.url); if (p.sink) p.sink.cleanup(); }, 5000);
  }
});

// ---------------- messaging ----------------
function summary(tabId, tab) {
  const s = tabs.get(tabId);
  const st = s || {};
  const job = st.job ? Object.assign({}, st.job, { ctrl: undefined }) : null;
  const pageUrl = (st.page && st.page.frameUrl && /stream\.aspx|\.sharepoint\.com/i.test(st.page.frameUrl)) ? st.page.frameUrl
    : (st.manifest && st.manifest.documentUrl && /sharepoint\.com/i.test(st.manifest.documentUrl) ? st.manifest.documentUrl : (tab && tab.url));
  const title = s ? baseTitle(tabId, s, tab) : SSMpd.sanitizeFilename(SSMpd.titleFromTab(tab && tab.title));
  const hasAudio = !!(s && (
    (s.manifestMeta && s.manifestMeta.hasAudio) ||
    Object.keys(s.transcode || {}).some((k) => k.includes(':audio:'))
  ));
  const hasVideo = !!(s && (
    (s.manifestMeta && s.manifestMeta.hasVideo) ||
    Object.keys(s.transcode || {}).some((k) => k.includes(':video:')) ||
    (s.manifest && !s.manifestMeta)
  ));
  return {
    detected: hasDetection(s),
    hasManifest: !!(s && s.manifest),
    hasTranscode: !!(s && Object.keys(s.transcode).length),
    tracksSeen: s ? Object.keys(s.transcode) : [],
    hasAudio,
    hasVideo,
    manifestMeta: s && s.manifestMeta || null,
    encrypted: !!(s && s.encrypted),
    hasKey: !!(s && s.page && s.page.key),
    title,
    manifestUrl: s && s.manifest ? s.manifest.url : null,
    transcript: transcriptSummary(s && s.transcript),
    commands: s ? {
      ytdlp: SSMpd.ytDlpCommand(pageUrl, title, true),
      ffmpeg: s.manifest ? SSMpd.ffmpegCommand(s.manifest.url, title, true, s.manifest.spopactoken) : null,
      manifest: s.manifest ? SSMpd.cleanManifestUrl(s.manifest.url) : null
    } : null,
    job
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return undefined;
  if (msg.type === 'ss-page' && sender.tab) {
    const s = tabState(sender.tab.id);
    const prev = s.page || {};
    const hadKey = !!(prev.key);
    s.page = {
      key: msg.key || prev.key || null,
      iv: msg.iv || prev.iv || null,
      fileName: msg.fileName || prev.fileName || null,
      duration: msg.duration || prev.duration || 0,
      frameUrl: msg.frameUrl || prev.frameUrl,
      frameId: (msg.key || msg.fileName || prev.frameId === undefined) ? sender.frameId : prev.frameId
    };
    if (msg.key && !hadKey) setBadge(sender.tab.id);
    else notifyTab(sender.tab.id);
    return Promise.resolve(true);
  }
  // Content scripts report Resource Timing URLs (workers may still be visible there).
  if (msg.type === 'ss-local-urls' && sender.tab && Array.isArray(msg.urls)) {
    const tabId = sender.tab.id;
    const s = tabState(tabId);
    if (s.job && s.job.status === 'running') return Promise.resolve(false);
    let changed = false;
    for (const raw of msg.urls) {
      let url;
      try { url = new URL(raw); } catch (e) { continue; }
      const isManifest = /\/transform\/videomanifest/i.test(url.pathname);
      const isTranscode = SSMpd.TRANSCODE_RE.test(url.pathname + '?');
      if (!isManifest && !isTranscode) continue;
      lastMediaTab = tabId;
      if (isManifest) {
        if (/tempauth/i.test(raw) && s.manifest) continue;
        if (!s.manifest || s.manifest.url !== raw) {
          s.manifest = {
            url: raw, frameId: sender.frameId, time: Date.now(),
            spopactoken: (s.manifest && s.manifest.spopactoken) || null,
            documentUrl: msg.frameUrl || sender.url || null
          };
          changed = true;
        }
      } else {
        const q = url.searchParams;
        const part = q.get('part') || 'other';
        if (q.get('enableEncryption') === '1') s.encrypted = true;
        if (part === 'initsegment' || part === 'mediasegment') {
          let trackName = (q.get('track') || '').toLowerCase();
          if (!trackName) {
            const qual = (q.get('quality') || '').toLowerCase();
            trackName = /^aud/.test(qual) ? 'audio' : 'video';
          } else if (/aud|audio/.test(trackName)) trackName = 'audio';
          else trackName = 'video';
          const key = part + ':' + trackName + ':' + (q.get('quality') || '');
          if (s.transcode[key] !== raw) { s.transcode[key] = raw; changed = true; }
          if (s.transcodeFrameId === undefined) s.transcodeFrameId = sender.frameId;
        }
      }
    }
    if (changed) {
      if (s.job && s.job.status !== 'running') s.job = null;
      setBadge(tabId);
    }
    return Promise.resolve(changed);
  }
  if (msg.type === 'ss-state') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    if (tabId == null) return Promise.resolve(summary(-1, null));
    return browser.tabs.get(tabId).then((tab) => summary(tabId, tab), () => summary(tabId, null));
  }
  if (msg.type === 'ss-start') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    startJob(tabId, msg.options || {}).catch((e) => {
      const s = tabState(tabId);
      s.job = { status: 'error', error: e.message, message: e.message, done: 0, total: 0, bytes: 0 };
      setBadge(tabId);
    });
    return Promise.resolve(true);
  }
  if (msg.type === 'ss-save-transcript') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    return saveTranscript(tabId, msg.options || {}).catch((e) => ({ ok: false, error: e.message || String(e) }));
  }
  if (msg.type === 'ss-cancel') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    const s = tabs.get(tabId);
    if (s && s.job && s.job.ctrl) s.job.ctrl.abort();
    return Promise.resolve(true);
  }
  if (msg.type === 'ss-reset') {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    const s = tabs.get(tabId);
    if (s && s.job && s.job.status !== 'running') s.job = null;
    setBadge(tabId);
    return Promise.resolve(true);
  }
  return undefined;
});

// leftovers from a crash / browser restart
SSSink.purgeAll();

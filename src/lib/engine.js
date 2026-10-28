/*
 * Stream Saver – pogon za prenos: prenese segmente (z omejeno vzporednostjo in ponovnimi
 * poskusi ob 429/5xx), jih po potrebi dešifrira (AES-128-CBC), združi video+zvok in jih
 * v pravem vrstnem redu sproti piše v ponor (sink) – brez kopičenja celotnega posnetka.
 * Neodvisno od okolja: fetchBytes, getKey in sink poda klicatelj. Izvoz: SSEngine.
 */
(function (root) {
  'use strict';
  const Mp4 = (typeof module !== 'undefined' && module.exports) ? require('./mp4.js') : root.SSMp4;

  function abortError() { const e = new Error('Prenos preklican.'); e.name = 'AbortError'; return e; }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function retriable(status) { return status === 0 || status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599); }

  /**
   * fetchBytes(url, {range, signal}) -> Promise<{status:number, retryAfter:string|null, buffer:ArrayBuffer|null}>
   */
  async function fetchWithRetry(fetchBytes, url, o) {
    const max = o.maxAttempts || 10;
    for (let attempt = 1; ; attempt++) {
      if (o.signal && o.signal.aborted) throw abortError();
      let r;
      try { r = await fetchBytes(url, { range: o.range, signal: o.signal }); }
      catch (e) {
        if (e && e.name === 'AbortError') throw e;
        r = { status: 0, retryAfter: null, buffer: null, error: e };
      }
      if (r.status >= 200 && r.status < 300 && r.buffer) {
        const u8 = new Uint8Array(r.buffer);
        u8.httpStatus = r.status; u8.contentRange = r.contentRange || null;
        return u8;
      }
      if (!retriable(r.status) || attempt >= max) {
        const err = new Error(r.status ? `HTTP ${r.status}` : `Omrežna napaka: ${r.error && r.error.message || r.error}`);
        err.status = r.status;
        throw err;
      }
      let delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
      const ra = r.retryAfter;
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs) && secs >= 0) delay = Math.min(Math.max(secs * 1000, 500), 120000);
        else { const d = Date.parse(ra); if (!isNaN(d)) delay = Math.min(Math.max(d - Date.now(), 500), 120000); }
      }
      delay += Math.floor(Math.random() * 400);
      if (o.onRetry) o.onRetry({ status: r.status, attempt, delayMs: delay });
      await sleep(delay, o.signal);
    }
  }

  function ivFromNumber(n) {
    const iv = new Uint8Array(16); let v = n;
    for (let i = 15; i >= 8 && v > 0; i--) { iv[i] = v % 256; v = Math.floor(v / 256); }
    return iv;
  }

  function drmError(what) {
    const e = new Error('Posnetek je zaščiten z DRM' + (what ? ' (' + what + ')' : '') + ' – prenos ni mogoč.');
    e.code = 'DRM'; return e;
  }

  /** Skupna oprema za vse vrste prenosa: napredek, ponovni poskusi, ključi, razporejevalnik segmentov. */
  function makeContext(o, total) {
    const subtle = o.subtle || (root.crypto && root.crypto.subtle);
    const ctx = { subtle, done: 0, total, bytes: 0, note: '' };
    const maxConc = Math.max(1, Math.min(16, o.concurrency || 4));
    ctx.maxConc = maxConc; ctx.conc = maxConc; ctx.okStreak = 0;
    ctx.progress = (message) => { if (message !== undefined) ctx.note = message; if (o.onProgress) o.onProgress({ done: ctx.done, total: ctx.total, bytes: ctx.bytes, message: ctx.note }); };
    ctx.onRetry = (r) => {
      if (r.status === 429 && ctx.conc > 1) { ctx.conc = Math.max(1, Math.floor(ctx.conc / 2)); ctx.okStreak = 0; }
      ctx.progress(r.status === 429
        ? `Strežnik omejuje hitrost (HTTP 429) – nov poskus čez ${Math.round(r.delayMs / 1000)} s (poskus ${r.attempt}).`
        : `Začasna napaka (${r.status ? 'HTTP ' + r.status : 'omrežje'}) – nov poskus čez ${Math.round(r.delayMs / 1000)} s.`);
    };
    ctx.get = (url, range) => fetchWithRetry(o.fetchBytes, url, { range, signal: o.signal, onRetry: ctx.onRetry });
    // AES-128 ključi iz seznama HLS: en prenos na naslov
    const keyCache = new Map();
    ctx.keyFor = (keyUri) => {
      if (!keyCache.has(keyUri)) {
        keyCache.set(keyUri, (async () => {
          if (!subtle) throw new Error('Dešifriranje (WebCrypto) ni na voljo.');
          const raw = await ctx.get(keyUri);
          if (raw.length !== 16) {
            const e = new Error('Strežnik za ključ ni vrnil 16-bajtnega AES ključa (dolžina ' + raw.length + '). Verjetno je potrebna prijava ali je to DRM.');
            e.code = 'NO_KEY'; throw e;
          }
          return subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
        })());
        keyCache.get(keyUri).catch(() => keyCache.delete(keyUri));
      }
      return keyCache.get(keyUri);
    };
    /** Dešifrira segment z HLS AES-128 (zapis enc), sicer ga vrne nespremenjenega. */
    ctx.decryptHls = async (buf, enc, number) => {
      if (!enc || !enc.keyUri) return buf;
      const key = await ctx.keyFor(enc.keyUri);
      const iv = enc.iv || ivFromNumber(number || 0);
      try { return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, buf)); }
      catch (e) { throw new Error('Dešifriranje segmenta (AES-128) ni uspelo – napačen ključ/IV ali okrnjen segment.'); }
    };
    /**
     * Prenese posle z omejeno vzporednostjo, rezultate pa predaja v pravem vrstnem redu.
     * prepare(job) -> Promise<any>, consume(result, job, idx) -> Promise
     */
    ctx.schedule = (jobs, prepare, consume, label) => new Promise((resolve, reject) => {
      const results = new Map();
      let next = 0, launched = 0, inFlight = 0, failed = null, writing = false;
      const windowMax = ctx.maxConc * 3;
      const fail = (e) => { if (!failed) { failed = e; reject(e); } };
      async function drain() {
        if (writing || failed) return;
        writing = true;
        try {
          while (results.has(next)) {
            const res = results.get(next); results.delete(next);
            await consume(res, jobs[next], next);
            next++; ctx.done++;
            ctx.progress(`Prenašam segmente … ${ctx.done}/${ctx.total}`);
          }
        } catch (e) { writing = false; return fail(e); }
        writing = false;
        if (next >= jobs.length) return resolve();
        pump();
      }
      function pump() {
        if (failed) return;
        if (o.signal && o.signal.aborted) return fail(abortError());
        while (inFlight < ctx.conc && launched < jobs.length && launched < next + windowMax) {
          const idx = launched++; const j = jobs[idx]; inFlight++;
          Promise.resolve().then(() => prepare(j)).then((res) => {
            inFlight--; results.set(idx, res);
            if (++ctx.okStreak >= 40 && ctx.conc < ctx.maxConc) { ctx.conc++; ctx.okStreak = 0; }
            drain();
          }, (e) => { inFlight--; if (e && e.status) e.message = `Segment ${j.si + 1}${label ? ' (' + label(j) + ')' : ''}: ${e.message}`; fail(e); });
        }
      }
      if (!jobs.length) resolve(); else pump();
    });
    return ctx;
  }

  /**
   * @param {object} o
   *  tracks: [{type, initUrl, initRange, initEnc, segments:[{url,time,number,range,enc}], encryption}]
   *  fetchBytes, sink:{write(Uint8Array):Promise, close():Promise}
   *  getKey(track) -> Promise<{key:CryptoKey, iv:Uint8Array|null}|null>   (DASH SEA)
   *  concurrency, signal, durationSec, onProgress({done,total,bytes,message}), subtle
   *  Segmenti z zapisom enc (HLS AES-128) se dešifrirajo z ključem s seg.enc.keyUri.
   */
  async function runDownload(o) {
    const tracks = o.tracks;
    if (!tracks || !tracks.length) throw new Error('Ni sledi za prenos.');
    const total = tracks.reduce((s, t) => s + t.segments.length + 1, 0);
    const ctx = makeContext(o, total);
    const subtle = ctx.subtle;

    // Keys (once per track)
    const keys = await Promise.all(tracks.map(async (t) => (o.getKey ? o.getKey(t) : null)));

    async function decryptMaybe(buf, ti, seg, enc) {
      if (enc && enc.keyUri) {
        const out = await ctx.decryptHls(buf, enc, seg ? seg.number : 0);
        if (Mp4.looksLikeMp4(out)) return out;
        throw new Error('Po dešifriranju segment ni veljaven MP4 – ključ ali IV nista pravilna.');
      }
      if (Mp4.looksLikeMp4(buf)) return buf;
      const k = keys[ti];
      if (!k || !subtle) {
        const e = new Error('Segmenti so šifrirani (AES-128), ključa pa ni bilo mogoče zajeti. Predvajaj posnetek nekaj sekund, osveži in poskusi znova.');
        e.code = 'NO_KEY'; throw e;
      }
      const iv = k.iv || ivFromNumber(seg ? seg.number : 0);
      let out;
      try { out = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, k.key, buf)); }
      catch (e) { throw new Error('Dešifriranje segmenta ni uspelo (napačen ključ ali IV).'); }
      if (!Mp4.looksLikeMp4(out)) throw new Error('Po dešifriranju segment ni veljaven MP4.');
      return out;
    }

    // 1) init segments
    ctx.progress('Prenašam inicializacijske segmente …');
    const inits = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.initUrl) throw new Error('Sled nima inicializacijskega segmenta.');
      const raw = await ctx.get(t.initUrl, t.initRange);
      inits.push(await decryptMaybe(raw, i, null, t.initEnc));
      ctx.done++; ctx.progress();
    }
    let merged;
    if (tracks.length > 1) merged = Mp4.mergeInits(inits, { durationSec: o.durationSec });
    else merged = Mp4.singleInit(inits[0], { durationSec: o.durationSec });
    const state = { seq: 0, offset: 0, mfra: {} };
    await o.sink.write(merged.bytes);
    state.offset += merged.bytes.length; ctx.bytes = state.offset;
    const writers = tracks.map((t, i) => {
      const map = {};
      if (tracks.length > 1) { map[merged.maps[i].oldId] = merged.maps[i].newId; map['*'] = merged.maps[i].newId; }
      return Mp4.createFragmentWriter(map, state);
    });

    // 2) interleave segments by presentation time
    const jobs = [];
    tracks.forEach((t, ti) => t.segments.forEach((seg, si) => jobs.push({ ti, si, seg, time: seg.time || 0 })));
    jobs.sort((a, b) => (a.time - b.time) || (a.ti - b.ti) || (a.si - b.si));
    ctx.progress(`Prenašam ${jobs.length} segmentov …`);
    await ctx.schedule(jobs,
      async (j) => decryptMaybe(await ctx.get(j.seg.url, j.seg.range), j.ti, j.seg, j.seg.enc),
      async (buf, j) => {
        const pieces = writers[j.ti](buf);
        for (const p of pieces) await o.sink.write(p);
        ctx.bytes = state.offset;
      },
      (j) => tracks[j.ti].type);

    // 3) random-access index + close
    const mfra = Mp4.buildMfra(state.mfra);
    await o.sink.write(mfra);
    state.offset += mfra.length; ctx.bytes = state.offset;
    await o.sink.close();
    ctx.progress('Končano.');
    return { bytes: state.offset, segments: jobs.length, tracks: tracks.length };
  }

  /**
   * HLS z MPEG-TS (ali packed AAC) segmenti: demux → fMP4 (H.264 + AAC). Preden karkoli zapiše v sink,
   * preveri podprtost; če kodeka ne zna, vrže napako s kodo TS_UNSUPPORTED (klicatelj lahko shrani surov .ts).
   *  o.sources: [{type:'video'|'audio', segments:[{url,time,number,range,enc,discontinuity}]}]
   */
  async function runTsDownload(o) {
    const Ts = (typeof module !== 'undefined' && module.exports) ? require('./ts.js') : root.SSTs;
    const sources = o.sources;
    const total = sources.reduce((s, x) => s + x.segments.length, 0);
    const ctx = makeContext(o, total);
    const prep = async (seg) => {
      const raw = await ctx.get(seg.url, seg.range);
      return ctx.decryptHls(raw, seg.enc, seg.number);
    };
    ctx.progress('Pripravljam pretvorbo MPEG-TS → MP4 …');
    // prvi segment vsakega vira: določi kodeke in ustvari init
    const primed = [];
    for (const src of sources) {
      const seg = src.segments[0];
      const buf = await prep(seg);
      let d;
      try { d = Ts.demux(buf, { fallbackPts: Math.round((seg.time || 0) * Ts.TS_HZ) }); }
      catch (e) { if (e.code === 'TS_SCRAMBLED') e.code = 'DRM'; throw e; }
      if (o.audioOnly) { d.video = null; Ts.finalize(d); }
      primed.push({ d, seg, rawLen: buf.length });
    }
    const unsupported = [].concat.apply([], primed.map((p) => p.d.unsupported));
    const anyMedia = primed.some((p) => p.d.video || p.d.audio);
    if (unsupported.length || !anyMedia) {
      const e = new Error('Kodek v segmentih MPEG-TS ni podprt za pretvorbo v MP4' + (unsupported.length ? ' (' + unsupported.join(', ') + ')' : '') + '.');
      e.code = 'TS_UNSUPPORTED'; e.unsupported = unsupported; throw e;
    }
    const mux = new Ts.TsToFmp4();
    // zvok iz ločenega vira ima prednost pred zvokom, vgrajenim v video segmente
    const demuxes = primed.map((p) => p.d);
    const sepAudio = demuxes.some((d, i) => sources[i].type === 'audio' && d.audio);
    if (sepAudio) demuxes.forEach((d, i) => { if (sources[i].type !== 'audio' && d.audio) d.audio = null; });
    const initParts = mux.prime(demuxes);
    const ordered = [];
    if (initParts.video) ordered.push(initParts.video);
    if (initParts.audio) ordered.push(initParts.audio);
    let merged;
    if (ordered.length > 1) merged = Mp4.mergeInits(ordered, { durationSec: o.durationSec });
    else merged = Mp4.singleInit(ordered[0], { durationSec: o.durationSec });
    const state = { seq: 0, offset: 0, mfra: {} };
    await o.sink.write(merged.bytes);
    state.offset += merged.bytes.length; ctx.bytes = state.offset;
    const writer = Mp4.createFragmentWriter({}, state);
    // fragmenti nosijo že končne ID-je sledi (video 1, zvok 2 ali 1); createFragmentWriter jih ne spreminja
    const emit = async (frags) => {
      for (const f of frags) { for (const p of writer(f.bytes)) await o.sink.write(p); }
      ctx.bytes = state.offset;
    };
    for (let i = 0; i < primed.length; i++) { await emit(mux.push(demuxes[i], primed[i].seg)); ctx.done++; }
    ctx.progress();

    const jobs = [];
    sources.forEach((src, si) => src.segments.forEach((seg, k) => { if (k > 0) jobs.push({ si: k, src: si, seg, time: seg.time || 0 }); }));
    jobs.sort((a, b) => (a.time - b.time) || (a.src - b.src) || (a.si - b.si));
    await ctx.schedule(jobs, (j) => prep(j.seg), async (buf, j) => {
      let d = Ts.demux(buf, { fallbackPts: Math.round((j.seg.time || 0) * Ts.TS_HZ) });
      if (o.audioOnly) d = { video: null, audio: d.audio, unsupported: [] };
      if (sources[j.src].type !== 'audio' && sepAudio) d = { video: d.video, audio: null, unsupported: [] };
      await emit(mux.push(d, j.seg));
    }, (j) => sources[j.src].type);
    await emit(mux.flush());
    const mfra = Mp4.buildMfra(state.mfra);
    await o.sink.write(mfra);
    state.offset += mfra.length; ctx.bytes = state.offset;
    await o.sink.close();
    ctx.progress('Končano.');
    return { bytes: state.offset, segments: total, tracks: ordered.length, hasVideo: !!initParts.video, hasAudio: !!initParts.audio };
  }

  /** Surov prenos segmentov (vrstni red + dešifriranje), brez pretvorbe – za .ts, ko kodek ni podprt. */
  async function runRawDownload(o) {
    const segs = o.segments;
    const ctx = makeContext(o, segs.length);
    const jobs = segs.map((seg, si) => ({ si, seg }));
    await ctx.schedule(jobs,
      async (j) => ctx.decryptHls(await ctx.get(j.seg.url, j.seg.range), j.seg.enc, j.seg.number),
      async (buf) => { await o.sink.write(buf); ctx.bytes += buf.length; });
    await o.sink.close();
    ctx.progress('Končano.');
    return { bytes: ctx.bytes, segments: segs.length };
  }

  /** Navadna datoteka (mp4/webm …): zaporedni deli z glavo Range; če strežnik Range ne podpira, ena zahteva. */
  async function runProgressive(o) {
    const chunk = o.chunkSize || 4 * 1024 * 1024;
    const ctx = makeContext(o, 1);
    ctx.progress('Začenjam prenos datoteke …');
    const first = await ctx.get(o.url, `0-${chunk - 1}`);
    let totalSize = null;
    const m = first.contentRange && /\/(\d+)\s*$/.exec(first.contentRange);
    if (m) totalSize = Number(m[1]);
    const ranged = first.httpStatus === 206 && totalSize !== null;
    if (!ranged) {
      // strežnik vrača celoto naenkrat
      await o.sink.write(first); ctx.bytes = first.length; ctx.done = 1; ctx.total = 1;
      await o.sink.close(); ctx.progress('Končano.');
      return { bytes: first.length, ranged: false };
    }
    ctx.total = Math.ceil(totalSize / chunk); ctx.done = 1;
    await o.sink.write(first); ctx.bytes = first.length;
    ctx.progress();
    const jobs = [];
    for (let i = 1; i < ctx.total; i++) jobs.push({ si: i, start: i * chunk, end: Math.min(totalSize, (i + 1) * chunk) - 1 });
    await ctx.schedule(jobs, async (j) => {
      const b = await ctx.get(o.url, `${j.start}-${j.end}`);
      if (b.httpStatus !== 206) { const e = new Error('Strežnik je nehal podpirati delne prenose (Range).'); throw e; }
      return b;
    }, async (b) => { await o.sink.write(b); ctx.bytes += b.length; });
    await o.sink.close();
    ctx.progress('Končano.');
    return { bytes: ctx.bytes, ranged: true, chunks: ctx.total };
  }

  const api = { runDownload, runTsDownload, runRawDownload, runProgressive, fetchWithRetry, retriable, sleep, ivFromNumber, drmError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

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
      if (r.status >= 200 && r.status < 300 && r.buffer) return new Uint8Array(r.buffer);
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

  /**
   * @param {object} o
   *  tracks: [{type, initUrl, initRange, segments:[{url,time,number,range}], encryption}]
   *  fetchBytes, sink:{write(Uint8Array):Promise, close():Promise}
   *  getKey(track) -> Promise<{key:CryptoKey, iv:Uint8Array|null}|null>
   *  concurrency, signal, durationSec, onProgress({done,total,bytes,message}), subtle
   */
  async function runDownload(o) {
    const subtle = o.subtle || (root.crypto && root.crypto.subtle);
    const tracks = o.tracks;
    if (!tracks || !tracks.length) throw new Error('Ni sledi za prenos.');
    const total = tracks.reduce((s, t) => s + t.segments.length + 1, 0);
    let done = 0, bytes = 0, note = '';
    const maxConc = Math.max(1, Math.min(16, o.concurrency || 4));
    let conc = maxConc, okStreak = 0;
    const progress = (message) => { if (message !== undefined) note = message; if (o.onProgress) o.onProgress({ done, total, bytes, message: note }); };
    const onRetry = (r) => {
      if (r.status === 429 && conc > 1) { conc = Math.max(1, Math.floor(conc / 2)); okStreak = 0; }
      progress(r.status === 429
        ? `Strežnik omejuje hitrost (HTTP 429) – nov poskus čez ${Math.round(r.delayMs / 1000)} s (poskus ${r.attempt}).`
        : `Začasna napaka (${r.status ? 'HTTP ' + r.status : 'omrežje'}) – nov poskus čez ${Math.round(r.delayMs / 1000)} s.`);
    };

    // Keys (once per track)
    const keys = await Promise.all(tracks.map(async (t) => (o.getKey ? o.getKey(t) : null)));

    async function decryptMaybe(buf, ti, seg) {
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
    progress('Prenašam inicializacijske segmente …');
    const inits = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.initUrl) throw new Error('Sled nima inicializacijskega segmenta.');
      const raw = await fetchWithRetry(o.fetchBytes, t.initUrl, { range: t.initRange, signal: o.signal, onRetry });
      inits.push(await decryptMaybe(raw, i, null));
      done++; progress();
    }
    let merged;
    if (tracks.length > 1) merged = Mp4.mergeInits(inits, { durationSec: o.durationSec });
    else merged = Mp4.singleInit(inits[0], { durationSec: o.durationSec });
    const state = { seq: 0, offset: 0, mfra: {} };
    await o.sink.write(merged.bytes);
    state.offset += merged.bytes.length; bytes = state.offset;
    const writers = tracks.map((t, i) => {
      const map = {};
      if (tracks.length > 1) { map[merged.maps[i].oldId] = merged.maps[i].newId; map['*'] = merged.maps[i].newId; }
      return Mp4.createFragmentWriter(map, state);
    });

    // 2) interleave segments by presentation time
    const jobs = [];
    tracks.forEach((t, ti) => t.segments.forEach((seg, si) => jobs.push({ ti, si, seg, time: seg.time || 0 })));
    jobs.sort((a, b) => (a.time - b.time) || (a.ti - b.ti) || (a.si - b.si));

    const results = new Map();
    let next = 0, launched = 0, inFlight = 0, failed = null;
    const windowMax = maxConc * 3;
    progress(`Prenašam ${jobs.length} segmentov …`);

    await new Promise((resolve, reject) => {
      let writing = false;
      const fail = (e) => { if (!failed) { failed = e; reject(e); } };
      async function drain() {
        if (writing || failed) return;
        writing = true;
        try {
          while (results.has(next)) {
            const buf = results.get(next); results.delete(next);
            const pieces = writers[jobs[next].ti](buf);
            for (const p of pieces) await o.sink.write(p);
            bytes = state.offset; next++; done++;
            progress(`Prenašam segmente … ${done}/${total}`);
          }
        } catch (e) { writing = false; return fail(e); }
        writing = false;
        if (next >= jobs.length) return resolve();
        pump();
      }
      function pump() {
        if (failed) return;
        if (o.signal && o.signal.aborted) return fail(abortError());
        while (inFlight < conc && launched < jobs.length && launched < next + windowMax) {
          const idx = launched++; const j = jobs[idx]; inFlight++;
          fetchWithRetry(o.fetchBytes, j.seg.url, { range: j.seg.range, signal: o.signal, onRetry })
            .then((raw) => decryptMaybe(raw, j.ti, j.seg))
            .then((buf) => {
              inFlight--; results.set(idx, buf);
              if (++okStreak >= 40 && conc < maxConc) { conc++; okStreak = 0; }
              drain();
            }, (e) => { inFlight--; if (e && e.status) e.message = `Segment ${j.si + 1} (${tracks[j.ti].type}): ${e.message}`; fail(e); });
        }
      }
      if (!jobs.length) resolve(); else pump();
    });

    // 3) random-access index + close
    const mfra = Mp4.buildMfra(state.mfra);
    await o.sink.write(mfra);
    state.offset += mfra.length; bytes = state.offset;
    await o.sink.close();
    progress('Končano.');
    return { bytes: state.offset, segments: jobs.length, tracks: tracks.length };
  }

  const api = { runDownload, fetchWithRetry, retriable, sleep, ivFromNumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

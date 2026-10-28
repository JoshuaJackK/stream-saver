/*
 * Stream Saver – HLS: načrt prenosa (izbira variante in zvoka) in izvedba prek pogona.
 * Neodvisno od okolja (fetchBytes in sink poda klicatelj). Izvoz: globalThis.SSHlsDl oz. module.exports.
 *
 * TRDA OMEJITEV: DRM (SAMPLE-AES, FairPlay/PlayReady/Widevine …) in neskončni (živi) prenosi se zavrnejo
 * že pri načrtovanju, preden se prenese en sam medijski segment.
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const Hls = isNode ? require('./hls.js') : root.SSHls;
  const Engine = isNode ? require('./engine.js') : root.SSEngine;

  function codeErr(msg, code) { const e = new Error(msg); e.code = code; e.fatal = true; return e; }
  function drmErr(what) { const e = Engine.drmError(what); e.fatal = true; return e; }
  const WARN_MUXED = 'Zvok je v istem toku kot video; samo zvok je mogoče izluščiti pri MPEG-TS, pri fMP4 se shrani cel posnetek.';
  const MSG_LIVE = 'To je živi prenos (seznam nima #EXT-X-ENDLIST). Živih prenosov Stream Saver ne podpira – počakaj, da se prenos konča in je na voljo posnetek.';

  async function loadPlaylist(fetchBytes, url, signal) {
    const bytes = await Engine.fetchWithRetry(fetchBytes, url, { maxAttempts: 4, signal });
    return Hls.parsePlaylist(new TextDecoder().decode(bytes), url);
  }

  function checkMedia(pl, label) {
    if (pl.drm) throw drmErr(pl.drm);
    if (pl.iframesOnly) throw codeErr('Seznam vsebuje samo I-okvirje (#EXT-X-I-FRAMES-ONLY) – to ni polni posnetek.', 'IFRAMES');
    if (pl.live) throw codeErr(MSG_LIVE, 'LIVE');
    if (!pl.segments.length) throw codeErr('Seznam' + (label ? ' (' + label + ')' : '') + ' nima segmentov.', 'EMPTY');
    const maps = new Set(pl.segments.map((s) => s.map && s.map.url + '|' + s.map.range));
    if (maps.size > 1) throw codeErr('Seznam ima več različnih inicializacijskih segmentov (EXT-X-MAP) – to še ni podprto.', 'MULTIMAP');
  }

  /**
   * Prebere seznam in izbere sledi.
   * @returns {Promise<{master, variants:[{index,label,...}], selected:number, sources:[{type,playlist}], durationSec, audioMode}>}
   */
  async function plan(o) {
    const { fetchBytes, url, signal } = o;
    const mode = o.mode || 'av';
    const top = await loadPlaylist(fetchBytes, url, signal);
    if (top.type === 'media') {
      checkMedia(top);
      const fromMuxed = mode === 'audio';
      return { master: null, variants: [], selected: 0, sources: [{ type: o.mediaType || 'video', playlist: top, audioOnlyFromMuxed: fromMuxed }], durationSec: top.totalDuration, separateAudio: false, warning: fromMuxed ? WARN_MUXED : null };
    }
    if (top.drm) throw drmErr(top.drm);
    const variants = Hls.sortedVariants(top);
    if (!variants.length) throw codeErr('Glavni seznam nima nobene variante.', 'EMPTY');
    const view = variants.map((v, i) => ({ index: i, label: Hls.describeVariant(v), bandwidth: v.bandwidth, width: v.width, height: v.height, audioOnly: v.audioOnly, codecs: v.codecs }));
    let selected = Math.min(Math.max(0, Number.isInteger(o.variantIndex) ? o.variantIndex : 0), variants.length - 1);
    const v = variants[selected];
    const sources = [];
    let separateAudio = false, warning = null;
    if (mode === 'audio') {
      const ao = Hls.pickAudioOnly(top) || Hls.pickAudio(top, v);
      if (ao && ao.uri) { sources.push({ type: 'audio', playlist: await loadPlaylist(fetchBytes, ao.uri, signal) }); }
      else { sources.push({ type: 'video', playlist: await loadPlaylist(fetchBytes, v.uri, signal), audioOnlyFromMuxed: true }); }
    } else {
      sources.push({ type: v.audioOnly ? 'audio' : 'video', playlist: await loadPlaylist(fetchBytes, v.uri, signal) });
      const a = v.audioOnly ? null : Hls.pickAudio(top, v);
      if (a && a.uri) { sources.push({ type: 'audio', playlist: await loadPlaylist(fetchBytes, a.uri, signal) }); separateAudio = true; }
    }
    sources.forEach((s) => checkMedia(s.playlist, s.type));
    const durationSec = Math.max.apply(null, sources.map((s) => s.playlist.totalDuration));
    if (sources.some((s) => s.audioOnlyFromMuxed)) warning = WARN_MUXED;
    return { master: top, variants: view, selected, sources, durationSec, separateAudio, warning };
  }

  /**
   * Izvede prenos po načrtu.
   *  o: {plan, fetchBytes, openSink():Promise<sink>, concurrency, signal, onProgress, subtle}
   * @returns {{kind:'fmp4'|'ts-remux'|'ts-raw', ext:'mp4'|'m4a'|'ts', needsDefrag:boolean, defragOpts, hasVideo, hasAudio, bytes, notes:[]}}
   */
  async function run(o) {
    const sources = o.plan.sources;
    const common = { fetchBytes: o.fetchBytes, concurrency: o.concurrency, signal: o.signal, onProgress: o.onProgress, subtle: o.subtle, durationSec: o.plan.durationSec };
    const primary = sources[0];
    const withMap = sources.filter((s) => s.playlist.segments[0].map);
    const notes = [];
    if (withMap.length) {
      if (withMap.length !== sources.length) throw codeErr('Video in zvok imata različen zapis (fMP4 in MPEG-TS) – takšne kombinacije še ne podpiram.', 'MIXED');
      const tracks = sources.map((s) => {
        const m = s.playlist.segments[0].map;
        return { type: s.type, initUrl: m.url, initRange: m.range, initEnc: m.enc, segments: s.playlist.segments };
      });
      const sink = await o.openSink();
      const r = await Engine.runDownload(Object.assign({}, common, { tracks, sink }));
      const hasVideo = sources.some((s) => s.type === 'video');
      return { kind: 'fmp4', ext: hasVideo ? 'mp4' : 'm4a', needsDefrag: true, defragOpts: { edits: true }, hasVideo, hasAudio: true, bytes: r.bytes, notes, sink };
    }
    // MPEG-TS / packed audio
    const sink = await o.openSink();
    try {
      const r = await Engine.runTsDownload(Object.assign({}, common, { sources: sources.map((s) => ({ type: s.type, segments: s.playlist.segments })), audioOnly: sources.some((s) => s.audioOnlyFromMuxed), sink }));
      return { kind: 'ts-remux', ext: r.hasVideo ? 'mp4' : 'm4a', needsDefrag: true, defragOpts: { edits: true }, hasVideo: r.hasVideo, hasAudio: r.hasAudio, bytes: r.bytes, notes, sink };
    } catch (e) {
      if (e.code !== 'TS_UNSUPPORTED') throw e;
      // Surov .ts (samo glavni vir); sink še ni bil zapisan
      if (sources.length > 1) notes.push('Zvok je v ločeni sledi, ki je v surovem .ts ne moremo združiti – shranjen je samo video tok (ffmpeg ukaz v README).');
      const r = await Engine.runRawDownload(Object.assign({}, common, { segments: primary.playlist.segments, sink }));
      notes.push('Kodek ni podprt za pretvorbo v MP4 (' + (e.unsupported && e.unsupported.join(', ') || 'neznan') + '); shranjen je surov MPEG-TS. Pretvorba: ffmpeg -i vhod.ts -c copy izhod.mp4');
      return { kind: 'ts-raw', ext: 'ts', needsDefrag: false, hasVideo: true, hasAudio: true, bytes: r.bytes, notes, sink };
    }
  }

  const api = { plan, run, loadPlaylist, checkMedia, MSG_LIVE };
  if (isNode) module.exports = api; else root.SSHlsDl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

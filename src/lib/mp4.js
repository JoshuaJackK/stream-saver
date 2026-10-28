/*
 * Stream Saver – minimalni ISO-BMFF (MP4) pripomočki.
 * Združi DASH fMP4 (video + zvok) in na koncu pretvori v klasičen (nefragmentiran) MP4,
 * ki ga pravilno predvajata VLC in mpv (ftyp + moov + en mdat, moov na začetku).
 * Med prenosom se še vedno piše fragmentirano; defragmentToProgressive naredi končni zapis.
 * Izvoz: globalThis.SSMp4 oz. module.exports.
 */
(function (root) {
  'use strict';

  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function w32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
  function w64(b, o, v) { w32(b, o, Math.floor(v / 4294967296)); w32(b, o + 4, v >>> 0); }
  function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  /** List boxes in b[start,end). Each: {type, start, size, hdr, end} */
  function boxes(b, start, end) {
    start = start || 0; end = end === undefined ? b.length : end;
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p), hdr = 8;
      const type = fourcc(b, p + 4);
      if (size === 1) { if (p + 16 > end) break; size = u64(b, p + 8); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) { out.truncated = true; break; }
      out.push({ type, start: p, size, hdr, end: p + size });
      p += size;
    }
    return out;
  }
  function child(b, box, type) { return boxes(b, box.start + box.hdr, box.end).find((x) => x.type === type) || null; }
  function children(b, box, type) { return boxes(b, box.start + box.hdr, box.end).filter((x) => !type || x.type === type); }
  function path(b, box, types) { let cur = box; for (const t of types) { if (!cur) return null; cur = child(b, cur, t); } return cur; }

  function concat(arrs) {
    let n = 0; for (const a of arrs) n += a.byteLength;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.byteLength; }
    return out;
  }
  function box(type, parts) {
    const body = concat(parts || []);
    const out = new Uint8Array(8 + body.length);
    w32(out, 0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  }
  function fullBox(type, version, flags, payload) {
    const vf = new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]);
    return box(type, [vf, payload]);
  }
  function slice(b, bx) { return b.slice(bx.start, bx.end); }

  const MEDIA_TYPES = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'sidx', 'free', 'emsg', 'prft', 'skip', 'mfra', 'ssix', 'uuid', 'pdin', 'meta']);
  /** Does this buffer start with a plausible MP4 box? Used to auto-detect whole-segment encryption. */
  function looksLikeMp4(b) {
    if (!b || b.length < 8) return false;
    const size = u32(b, 0);
    return MEDIA_TYPES.has(fourcc(b, 4)) && (size === 0 || size === 1 || (size >= 8 && size <= b.length));
  }

  // ---------- init segment inspection ----------
  function trakInfo(b, trak) {
    const tkhd = child(b, trak, 'tkhd');
    const v = b[tkhd.start + 8];
    const idOff = tkhd.start + (v === 1 ? 28 : 20);
    const hdlr = path(b, trak, ['mdia', 'hdlr']);
    const mdhd = path(b, trak, ['mdia', 'mdhd']);
    const mv = mdhd ? b[mdhd.start + 8] : 0;
    return {
      box: trak,
      trackId: u32(b, idOff), idOff,
      handler: hdlr ? fourcc(b, hdlr.start + 16) : '????',
      timescale: mdhd ? u32(b, mdhd.start + (mv === 1 ? 28 : 20)) : 0,
      encrypted: sampleEntryType(b, trak) === 'encv' || sampleEntryType(b, trak) === 'enca'
    };
  }
  // first sample entry inside stsd (fullbox header 12 + entry_count 4, then entry size+type)
  function sampleEntryType(b, trak) {
    const stsd = path(b, trak, ['mdia', 'minf', 'stbl', 'stsd']);
    return stsd && stsd.start + 24 <= stsd.end ? fourcc(b, stsd.start + 20) : null;
  }

  function parseInit(b) {
    const top = boxes(b);
    const moov = top.find((x) => x.type === 'moov');
    if (!moov) throw new Error('Inicializacijski segment nima škatle moov.');
    const traks = children(b, moov, 'trak').map((t) => trakInfo(b, t));
    const mvhd = child(b, moov, 'mvhd');
    const mv = b[mvhd.start + 8];
    return {
      bytes: b, top, moov, mvhd, traks,
      ftyp: top.find((x) => x.type === 'ftyp') || null,
      movieTimescale: u32(b, mvhd.start + (mv === 1 ? 28 : 20)),
      mvex: child(b, moov, 'mvex')
    };
  }

  function drmErr() {
    const e = new Error('Posnetek je zaščiten z DRM (CENC: encv/enca) – prenos ni mogoč.');
    e.code = 'DRM'; return e;
  }

  function trexFor(init, trackId) {
    if (!init.mvex) return null;
    return children(init.bytes, init.mvex, 'trex').find((t) => u32(init.bytes, t.start + 12) === trackId) || null;
  }
  function defaultTrex(id) {
    const p = new Uint8Array(20); w32(p, 0, id); w32(p, 4, 1); return fullBox('trex', 0, 0, p);
  }

  /**
   * Build a combined init (ftyp+moov) for N single-track inits.
   * Returns {bytes, maps:[{oldId,newId,timescale,handler}], timescales:{newId:ts}}
   */
  function mergeInits(inits, opts) {
    opts = opts || {};
    const parsed = inits.map((b) => parseInit(b));
    const primary = parsed[0];
    const maps = [];
    const trakBoxes = [], trexBoxes = [];
    parsed.forEach((p, i) => {
      if (p.traks.length !== 1) throw new Error('Pričakovana je natanko ena sled na inicializacijski segment (najdenih: ' + p.traks.length + ').');
      const t = p.traks[0];
      if (t.encrypted) throw drmErr();
      const newId = i + 1;
      const trak = slice(p.bytes, t.box);
      w32(trak, t.idOff - t.box.start, newId);
      trakBoxes.push(trak);
      const trex = trexFor(p, t.trackId);
      const tb = trex ? slice(p.bytes, trex) : defaultTrex(newId);
      w32(tb, 12, newId);
      trexBoxes.push(tb);
      maps.push({ oldId: t.trackId, newId, timescale: t.timescale, handler: t.handler });
    });
    const mvhd = slice(primary.bytes, primary.mvhd);
    w32(mvhd, mvhd.length - 4, inits.length + 1); // next_track_ID (last field)
    const mvexParts = [];
    if (opts.durationSec > 0) {
      const d = Math.round(opts.durationSec * primary.movieTimescale);
      if (d < 4294967296) { const p = new Uint8Array(4); w32(p, 0, d); mvexParts.push(fullBox('mehd', 0, 0, p)); }
      else { const p = new Uint8Array(8); w64(p, 0, d); mvexParts.push(fullBox('mehd', 1, 0, p)); }
    }
    const mvex = box('mvex', mvexParts.concat(trexBoxes));
    // keep any other moov children of the primary init (udta, meta...), but drop pssh/old mvex/trak/mvhd
    const extras = children(primary.bytes, primary.moov).filter((x) => !['mvhd', 'trak', 'mvex', 'pssh'].includes(x.type)).map((x) => slice(primary.bytes, x));
    const moov = box('moov', [mvhd].concat(trakBoxes, [mvex], extras));
    let ftyp = primary.ftyp ? slice(primary.bytes, primary.ftyp) : null;
    if (!ftyp) ftyp = box('ftyp', [new TextEncoder().encode('iso6'), new Uint8Array([0, 0, 2, 0]), new TextEncoder().encode('iso6mp41dash')]);
    const timescales = {};
    maps.forEach((m) => { timescales[m.newId] = m.timescale; });
    return { bytes: concat([ftyp, moov]), maps, timescales };
  }

  /** For a single-track download: keep init as-is (ftyp+moov only). */
  function singleInit(b, opts) {
    const p = parseInit(b);
    if (p.traks.some((t) => t.encrypted)) throw drmErr();
    const parts = [];
    if (p.ftyp) parts.push(slice(b, p.ftyp));
    parts.push(slice(b, p.moov));
    const timescales = {};
    p.traks.forEach((t) => { timescales[t.trackId] = t.timescale; });
    return { bytes: concat(parts), maps: p.traks.map((t) => ({ oldId: t.trackId, newId: t.trackId, timescale: t.timescale, handler: t.handler })), timescales };
  }

  /**
   * Fragment rewriter. Feed media segments (in output order); returns byte pieces to write.
   * Rewrites tfhd.track_ID and mfhd.sequence_number, drops styp/sidx/etc., records mfra entries.
   */
  function createFragmentWriter(trackMap /* {oldId:newId} for this input */, state) {
    // state: {seq, offset, mfra:{newId:[{time, moof}]}} shared across tracks
    return function process(b) {
      const top = boxes(b);
      if (top.truncated && !top.length) throw new Error('Segment ni veljaven MP4 (morda je šifriran ali okrnjen).');
      const pieces = [];
      for (const bx of top) {
        if (bx.type === 'moof') {
          const moofOut = state.offset;
          for (const c of children(b, bx)) {
            if (c.type === 'mfhd') { state.seq += 1; w32(b, c.start + 12, state.seq); }
            if (c.type === 'traf') {
              const tfhd = child(b, c, 'tfhd');
              if (!tfhd) continue;
              const oldId = u32(b, tfhd.start + 12);
              const newId = trackMap[oldId] !== undefined ? trackMap[oldId] : trackMap['*'];
              if (newId !== undefined) w32(b, tfhd.start + 12, newId);
              const flags = (b[tfhd.start + 9] << 16) | (b[tfhd.start + 10] << 8) | b[tfhd.start + 11];
              if (flags & 1) { // base-data-offset-present: absolute offsets – relocate
                const old = u64(b, tfhd.start + 16);
                w64(b, tfhd.start + 16, old - bx.start + moofOut);
              }
              const tfdt = child(b, c, 'tfdt');
              let time = null;
              if (tfdt) time = b[tfdt.start + 8] === 1 ? u64(b, tfdt.start + 12) : u32(b, tfdt.start + 12);
              const id = newId !== undefined ? newId : oldId;
              if (time !== null) (state.mfra[id] || (state.mfra[id] = [])).push({ time, moof: moofOut });
            }
          }
          pieces.push(b.subarray(bx.start, bx.end));
          state.offset += bx.size;
        } else if (bx.type === 'mdat') {
          pieces.push(b.subarray(bx.start, bx.end));
          state.offset += bx.size;
        }
        // styp, sidx, ssix, free, emsg, prft ... are dropped
      }
      if (!pieces.length) throw new Error('Segment ne vsebuje podatkov (moof/mdat).');
      return pieces;
    };
  }

  /** Movie fragment random access box (helps players seek in long fragmented files). */
  function buildMfra(mfra) {
    const tfras = [];
    for (const id of Object.keys(mfra).map(Number).sort((a, b) => a - b)) {
      const entries = mfra[id];
      const p = new Uint8Array(12 + entries.length * 19);
      w32(p, 0, id); w32(p, 4, 0); w32(p, 8, entries.length);
      let o = 12;
      for (const e of entries) { w64(p, o, e.time); w64(p, o + 8, e.moof); p[o + 16] = 1; p[o + 17] = 1; p[o + 18] = 1; o += 19; }
      tfras.push(fullBox('tfra', 1, 0, p));
    }
    const body = concat(tfras);
    const total = 8 + body.length + 16;
    const mfroP = new Uint8Array(4); w32(mfroP, 0, total);
    return box('mfra', [body, fullBox('mfro', 0, 0, mfroP)]);
  }

  // ---------- progressive (non-fragmented) remux ----------
  // VLC frequently plays only video from interleaved multi-track fMP4+mfra files.
  // Convert to a conventional MP4: ftyp + moov(stbl) + single mdat (moov first = faststart).

  function isFragmented(b) {
    const top = boxes(b);
    return top.some((x) => x.type === 'moof') || top.some((x) => x.type === 'mfra');
  }

  function parseTrafSamples(b, traf, trexDefaults) {
    let defDur = trexDefaults.duration || 0;
    let defSize = trexDefaults.size || 0;
    let defFlags = trexDefaults.flags || 0;
    const samples = [];
    let baseDataOffset = null;
    let dataOffset = 0;
    let haveDataOffset = false;
    for (const c of children(b, traf)) {
      if (c.type === 'tfhd') {
        const fl = ((b[c.start + 9] << 16) | (b[c.start + 10] << 8) | b[c.start + 11]) >>> 0;
        let o = c.start + 16; // after track_ID
        if (fl & 1) { baseDataOffset = u64(b, o); o += 8; }
        if (fl & 2) o += 4; // sample_description_index
        if (fl & 8) { defDur = u32(b, o); o += 4; }
        if (fl & 0x10) { defSize = u32(b, o); o += 4; }
        if (fl & 0x20) { defFlags = u32(b, o); o += 4; }
      } else if (c.type === 'trun') {
        const fl = ((b[c.start + 9] << 16) | (b[c.start + 10] << 8) | b[c.start + 11]) >>> 0;
        const cnt = u32(b, c.start + 12);
        let o = c.start + 16;
        if (fl & 1) { dataOffset = u32(b, o) | 0; haveDataOffset = true; o += 4; } // signed
        let firstFlags = defFlags;
        if (fl & 4) { firstFlags = u32(b, o); o += 4; }
        for (let i = 0; i < cnt; i++) {
          let dur = defDur, size = defSize, flags = (i === 0) ? firstFlags : defFlags, cts = 0;
          if (fl & 0x100) { dur = u32(b, o); o += 4; }
          if (fl & 0x200) { size = u32(b, o); o += 4; }
          if (fl & 0x400) { flags = u32(b, o); o += 4; }
          if (fl & 0x800) { cts = u32(b, o) | 0; o += 4; } // signed
          samples.push({ duration: dur, size, flags, ctsOffset: cts });
        }
      }
    }
    return { samples, dataOffset: haveDataOffset ? dataOffset : null, baseDataOffset };
  }

  function trexDefaultsFromMoov(b, moov, trackId) {
    const mvex = child(b, moov, 'mvex');
    const out = { duration: 0, size: 0, flags: 0 };
    if (!mvex) return out;
    for (const t of children(b, mvex, 'trex')) {
      if (u32(b, t.start + 12) !== trackId) continue;
      out.duration = u32(b, t.start + 16);
      out.size = u32(b, t.start + 20);
      out.flags = u32(b, t.start + 24);
      break;
    }
    return out;
  }

  function extractBoxBytes(b, parent, type) {
    const bx = child(b, parent, type);
    return bx ? b.slice(bx.start, bx.end) : null;
  }

  function buildStts(samples) {
    const runs = [];
    for (const s of samples) {
      if (runs.length && runs[runs.length - 1].dur === s.duration) runs[runs.length - 1].count++;
      else runs.push({ count: 1, dur: s.duration });
    }
    const data = new Uint8Array(8 + runs.length * 8);
    w32(data, 4, runs.length);
    for (let i = 0; i < runs.length; i++) {
      w32(data, 8 + i * 8, runs[i].count);
      w32(data, 12 + i * 8, runs[i].dur);
    }
    return box('stts', [data]);
  }
  function buildStsz(samples) {
    const same = samples.length && samples.every((s) => s.size === samples[0].size);
    const data = new Uint8Array(12 + (same ? 0 : samples.length * 4));
    w32(data, 4, same ? samples[0].size : 0);
    w32(data, 8, samples.length);
    if (!same) for (let i = 0; i < samples.length; i++) w32(data, 12 + i * 4, samples[i].size);
    return box('stsz', [data]);
  }
  function buildStsc(sampleCount) {
    const data = new Uint8Array(4 + 4 + 12);
    w32(data, 4, 1);
    w32(data, 8, 1);
    w32(data, 12, sampleCount);
    w32(data, 16, 1);
    return box('stsc', [data]);
  }
  function buildStco(offset) {
    // Use co64 if offset >= 2^32
    if (offset >= 4294967296) {
      const data = new Uint8Array(4 + 4 + 8);
      w32(data, 4, 1);
      w64(data, 8, offset);
      return box('co64', [data]);
    }
    const data = new Uint8Array(4 + 4 + 4);
    w32(data, 4, 1);
    w32(data, 8, offset >>> 0);
    return box('stco', [data]);
  }
  function buildStss(samples) {
    const sync = [];
    for (let i = 0; i < samples.length; i++) {
      // sample_is_non_sync_sample flag is bit 16 of sample_flags
      if (!(samples[i].flags & 0x10000)) sync.push(i + 1);
    }
    if (!sync.length) return null;
    const data = new Uint8Array(8 + sync.length * 4);
    w32(data, 4, sync.length);
    for (let i = 0; i < sync.length; i++) w32(data, 8 + i * 4, sync[i]);
    return box('stss', [data]);
  }
  function buildCtts(samples) {
    if (samples.every((s) => !s.ctsOffset)) return null;
    const runs = [];
    for (const s of samples) {
      if (runs.length && runs[runs.length - 1].offset === s.ctsOffset) runs[runs.length - 1].count++;
      else runs.push({ count: 1, offset: s.ctsOffset });
    }
    const data = new Uint8Array(8 + runs.length * 8);
    w32(data, 4, runs.length);
    for (let i = 0; i < runs.length; i++) {
      w32(data, 8 + i * 8, runs[i].count);
      w32(data, 12 + i * 8, runs[i].offset >>> 0);
    }
    return box('ctts', [data]);
  }

  function compatibleFtyp() {
    // Brands VLC/mpv/browsers accept for progressive H.264+AAC MP4
    const major = new TextEncoder().encode('isom');
    const minor = new Uint8Array([0, 0, 2, 0]);
    const compat = new TextEncoder().encode('isomiso2avc1mp41');
    return box('ftyp', [major, minor, compat]);
  }

  /**
   * Convert a fragmented MP4 (ftyp+moov+moof/mdat…[+mfra]) into a progressive MP4
   * (ftyp+moov+mdat) that VLC plays with both audio and video.
   * If input is already non-fragmented, returns it unchanged (as Uint8Array copy if needed).
   */
  function defragmentToProgressive(input, onProgress, opts) {
    opts = opts || {};
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const top = boxes(b);
    const moofCount = top.filter((x) => x.type === 'moof').length;
    if (!moofCount) return b; // already progressive

    const moovBox = top.find((x) => x.type === 'moov');
    if (!moovBox) throw new Error('Fragmentiran MP4 nima moov – defragmentacija ni mogoča.');
    const ftypBox = top.find((x) => x.type === 'ftyp');

    const moovTraks = children(b, moovBox, 'trak');
    if (!moovTraks.length) throw new Error('moov nima sledi (trak).');

    // Per-track defaults from trex
    const trackState = moovTraks.map((trak) => {
      const info = trakInfo(b, trak);
      const defs = trexDefaultsFromMoov(b, moovBox, info.trackId);
      return {
        info, trak, defs,
        samples: [],
        chunks: [] // Uint8Array payloads in order
      };
    });
    const byId = {};
    trackState.forEach((t) => { byId[t.info.trackId] = t; });

    // Walk moof+mdat pairs in file order
    let i = 0;
    while (i < top.length) {
      const bx = top[i];
      if (bx.type !== 'moof') { i++; continue; }
      const moof = bx;
      // Find following mdat (may not be immediate if free/sidx slipped in — we only emit moof/mdat)
      let mdat = null;
      let j = i + 1;
      while (j < top.length && top[j].type !== 'moof') {
        if (top[j].type === 'mdat') { mdat = top[j]; break; }
        j++;
      }
      if (!mdat) { i++; continue; }

      for (const traf of children(b, moof, 'traf')) {
        const tfhd = child(b, traf, 'tfhd');
        if (!tfhd) continue;
        const tid = u32(b, tfhd.start + 12);
        const ts = byId[tid];
        if (!ts) continue;
        const parsed = parseTrafSamples(b, traf, ts.defs);
        if (opts.edits && ts.firstTfdt === undefined) {
          const tfdt = child(b, traf, 'tfdt');
          if (tfdt) ts.firstTfdt = b[tfdt.start + 8] === 1 ? u64(b, tfdt.start + 12) : u32(b, tfdt.start + 12);
        }
        // Payload: contiguous sample bytes inside mdat. For standard DASH, data_offset
        // points from start of moof; samples are packed in order at the start of mdat body
        // when default-base-is-moof is set. We take sequential bytes from mdat for this traf's sizes.
        const totalSize = parsed.samples.reduce((s, x) => s + x.size, 0);
        // Use running offset within this mdat for this file's interleave pattern:
        // our writer emits one traf per moof and mdat contains exactly that traf's samples.
        // If multiple traf in one moof, consume sequentially from mdat payload.
        if (!mdat._cursor) mdat._cursor = mdat.start + 8;
        const start = mdat._cursor;
        const end = start + totalSize;
        if (end > mdat.end) throw new Error('mdat je krajši od vsote vzorcev (poškodovan fMP4).');
        ts.chunks.push(b.subarray(start, end));
        mdat._cursor = end;
        for (const s of parsed.samples) ts.samples.push(s);
      }
      if (onProgress) onProgress({ done: i, total: top.length });
      i = j + 1;
    }

    // Build sample tables and media data (video then audio then other — keep moov trak order)
    const mediaParts = [];
    const trakOut = [];
    const mvhdSrc = extractBoxBytes(b, moovBox, 'mvhd');
    if (!mvhdSrc) throw new Error('manjka mvhd');
    const mvhd = new Uint8Array(mvhdSrc);
    const mv = mvhd[8];
    const movieTimescale = u32(mvhd, mv === 1 ? 28 : 20);

    // Precompute mdat layout offsets (after we know moov size we patch stco — two-pass)
    // Pass A: build each trak with placeholder stco(0)
    // Neobvezni seznam urejanja (edts/elst): ohrani zamik začetka zvoka/videa in zamik zaradi B-sličic.
    // Vklopi ga samo klicatelj (HLS/TS); DASH/Stream pot ostane nespremenjena.
    let editInfo = null;
    if (opts.edits) {
      editInfo = trackState.map((ts) => {
        const sc = ts.info.timescale || 1;
        const cts0 = ts.samples.length && ts.info.handler === 'vide' ? Math.max(0, ts.samples[0].ctsOffset || 0) : 0;
        const start = ((ts.firstTfdt || 0) + cts0) / sc;
        return { start, cts0, sc };
      });
      const origin = Math.min.apply(null, editInfo.map((e) => e.start));
      editInfo.forEach((e) => { e.delaySec = e.start - origin; });
    }
    const built = trackState.map((ts, tIdx) => {
      if (!ts.samples.length) throw new Error('Sled ' + ts.info.trackId + ' nima vzorcev.');
      const payload = concat(ts.chunks);
      const mdia = child(b, ts.trak, 'mdia');
      const minf = mdia ? child(b, mdia, 'minf') : null;
      const stbl = minf ? child(b, minf, 'stbl') : null;
      const stsd = stbl ? extractBoxBytes(b, stbl, 'stsd') : null;
      if (!stsd) throw new Error('manjka stsd za sled ' + ts.info.trackId);
      const tkhd = extractBoxBytes(b, ts.trak, 'tkhd');
      const mdhd = mdia ? extractBoxBytes(b, mdia, 'mdhd') : null;
      const hdlr = mdia ? extractBoxBytes(b, mdia, 'hdlr') : null;
      let xmhd = null;
      if (minf) {
        xmhd = extractBoxBytes(b, minf, 'vmhd') || extractBoxBytes(b, minf, 'smhd') || extractBoxBytes(b, minf, 'nmhd');
      }
      if (!tkhd || !mdhd || !hdlr || !xmhd) throw new Error('nepopoln trak ' + ts.info.trackId);

      const dur = ts.samples.reduce((s, x) => s + x.duration, 0);
      // patch mdhd duration
      const mdhdP = new Uint8Array(mdhd);
      const mdv = mdhdP[8];
      w32(mdhdP, mdv === 1 ? 32 : 24, dur >>> 0);
      // patch tkhd duration in movie timescale
      const tkhdP = new Uint8Array(tkhd);
      const tkv = tkhdP[8];
      const mediaTs = ts.info.timescale || 1;
      let movieDur = Math.round(dur * movieTimescale / mediaTs);
      let edts = null;
      if (editInfo) {
        const e = editInfo[tIdx];
        const delay = e.delaySec > 0.005 ? Math.round(e.delaySec * movieTimescale) : 0;
        const skip = Math.round(e.cts0 * movieTimescale / mediaTs);
        const play = Math.max(0, movieDur - skip);
        if (delay || e.cts0) {
          const ent = [];
          const e32 = (v) => { const a = new Uint8Array(4); w32(a, 0, v >>> 0); return a; };
          if (delay) ent.push(e32(delay), e32(0xffffffff), e32(0x00010000));
          ent.push(e32(play), e32(e.cts0), e32(0x00010000));
          edts = box('edts', [fullBox('elst', 0, 0, concat([e32(delay ? 2 : 1)].concat(ent)))]);
          movieDur = delay + play;
        }
      }
      w32(tkhdP, tkv === 1 ? 36 : 28, movieDur >>> 0);

      const stts = buildStts(ts.samples);
      const stsz = buildStsz(ts.samples);
      const stsc = buildStsc(ts.samples.length);
      const stcoPlaceholder = buildStco(0);
      const stss = ts.info.handler === 'vide' ? buildStss(ts.samples) : null;
      const ctts = buildCtts(ts.samples);

      const urlBox = fullBox('url ', 0, 1, new Uint8Array(0));
      const drefData = new Uint8Array(8); w32(drefData, 4, 1);
      const dref = box('dref', [drefData, urlBox]);
      const dinf = box('dinf', [dref]);

      const stblParts = [stsd, stts, stsc, stsz, stcoPlaceholder];
      if (stss) stblParts.push(stss);
      if (ctts) stblParts.push(ctts);
      const stblBox = box('stbl', stblParts);
      const minfBox = box('minf', [xmhd, dinf, stblBox]);
      const mdiaBox = box('mdia', [mdhdP, hdlr, minfBox]);
      const trakBox = box('trak', edts ? [tkhdP, edts, mdiaBox] : [tkhdP, mdiaBox]);
      return { trakBox, payload, movieDur, mediaDur: dur };
    });

    // Duration in mvhd = max track movie duration
    const maxMovieDur = built.reduce((m, x) => Math.max(m, x.movieDur), 0);
    w32(mvhd, mv === 1 ? 32 : 24, maxMovieDur >>> 0);
    w32(mvhd, mvhd.length - 4, trackState.length + 1); // next_track_ID

    const ftyp = compatibleFtyp();
    // First assemble moov with placeholder offsets to know its size
    let moov = box('moov', [mvhd].concat(built.map((x) => x.trakBox)));
    const mdatHeader = 8;
    let dataOffset = ftyp.length + moov.length + mdatHeader;
    // Patch each trak's stco/co64 with real absolute file offset of its chunk
    const patchedTraks = [];
    for (const item of built) {
      const trak = new Uint8Array(item.trakBox);
      // find stco or co64 deep and patch first entry
      function patchOffset(buf, type, offset) {
        let pos = 8;
        const end = buf.length;
        const stack = [{ start: 8, end }];
        while (stack.length) {
          const fr = stack.pop();
          let p = fr.start;
          while (p + 8 <= fr.end) {
            const sz = u32(buf, p);
            if (sz < 8 || p + sz > fr.end) break;
            const ty = fourcc(buf, p + 4);
            if (ty === type) {
              if (type === 'stco') w32(buf, p + 16, offset >>> 0);
              else w64(buf, p + 16, offset);
              return true;
            }
            if (sz > 8) stack.push({ start: p + 8, end: p + sz });
            p += sz;
          }
        }
        return false;
      }
      const useCo64 = dataOffset >= 4294967296;
      // rebuild stco box if we need co64 but had stco — simplest: replace stco bytes
      if (useCo64) {
        // rebuild trak with co64
        // Fall through: rewrite via buildStco and reconstruct — heavy. For lecture sizes <4GB use stco.
      }
      if (!patchOffset(trak, 'stco', dataOffset) && !patchOffset(trak, 'co64', dataOffset)) {
        throw new Error('stco ni najden za popravek odmikov');
      }
      patchedTraks.push(trak);
      dataOffset += item.payload.length;
    }
    moov = box('moov', [mvhd].concat(patchedTraks));
    // If moov size changed due to ... it shouldn't (same stco size). Verify:
    const mdatPayload = concat(built.map((x) => x.payload));
    // Re-patch if moov length differs from assumption
    const expectedStart = ftyp.length + moov.length + mdatHeader;
    let cursor = expectedStart;
    // If first patch used wrong moov length, fix again
    const firstOff = (() => {
      // read stco from first trak
      const t = patchedTraks[0];
      let found = null;
      const walk = (start, end) => {
        let p = start;
        while (p + 8 <= end) {
          const sz = u32(t, p); if (sz < 8) break;
          const ty = fourcc(t, p + 4);
          if (ty === 'stco') { found = u32(t, p + 16); return; }
          if (ty === 'co64') { found = u64(t, p + 16); return; }
          if (sz > 8) walk(p + 8, p + sz);
          p += sz;
        }
      };
      walk(8, t.length);
      return found;
    })();
    if (firstOff !== expectedStart) {
      // re-patch with correct offsets
      cursor = expectedStart;
      for (let ti = 0; ti < patchedTraks.length; ti++) {
        const trak = patchedTraks[ti];
        const walkPatch = (start, end) => {
          let p = start;
          while (p + 8 <= end) {
            const sz = u32(trak, p); if (sz < 8) break;
            const ty = fourcc(trak, p + 4);
            if (ty === 'stco') { w32(trak, p + 16, cursor >>> 0); return true; }
            if (ty === 'co64') { w64(trak, p + 16, cursor); return true; }
            if (sz > 8 && walkPatch(p + 8, p + sz)) return true;
            p += sz;
          }
          return false;
        };
        walkPatch(8, trak.length);
        cursor += built[ti].payload.length;
      }
      moov = box('moov', [mvhd].concat(patchedTraks));
    }

    const mdat = new Uint8Array(8 + mdatPayload.length);
    w32(mdat, 0, mdat.length);
    mdat[4] = 0x6d; mdat[5] = 0x64; mdat[6] = 0x61; mdat[7] = 0x74;
    mdat.set(mdatPayload, 8);
    if (onProgress) onProgress({ done: 1, total: 1 });
    return concat([ftyp, moov, mdat]);
  }

  const api = { u32, w32, u64, fourcc, boxes, child, children, path, concat, box, fullBox, looksLikeMp4, parseInit, mergeInits, singleInit, createFragmentWriter, buildMfra, isFragmented, defragmentToProgressive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSMp4 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

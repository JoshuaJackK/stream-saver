/*
 * Stream Saver – minimalna pretvorba MPEG-TS (HLS segmenti) v fragmentiran MP4.
 *
 * Podprto: H.264 (stream_type 0x1b) + AAC ADTS (0x0f), pa tudi »packed audio« segmenti (.aac z ID3).
 * Vse drugo (HEVC, MPEG-2, AC-3, MP3 …) javi kot nepodprto – klicatelj nato shrani surov .ts.
 * Izhod je »navidezen« DASH-podoben tok (init + moof/mdat na sled), ki ga obdela obstoječa cev
 * (mergeInits → createFragmentWriter → defragmentToProgressive).
 * Izvoz: globalThis.SSTs oz. module.exports.
 */
(function (root) {
  'use strict';
  const Mp4 = (typeof module !== 'undefined' && module.exports) ? require('./mp4.js') : root.SSMp4;
  const { box, fullBox, concat, w32 } = Mp4;
  const TS_HZ = 90000;
  const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function enc(s) { return new TextEncoder().encode(s); }
  function err(msg, code) { const e = new Error(msg); if (code) e.code = code; return e; }

  // ---------- zaznava ----------
  /** 'ts' | 'aac' | 'mp4' | 'unknown' */
  function sniff(b) {
    if (!b || b.length < 8) return 'unknown';
    for (let s = 0; s < 188 && s + 188 < b.length; s++) {
      if (b[s] === 0x47 && b[s + 188] === 0x47 && (s + 376 >= b.length || b[s + 376] === 0x47)) return 'ts';
    }
    if (b.length > 196 && b[4] === 0x47 && b[196] === 0x47) return 'ts';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'aac';
    if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac';
    if (Mp4.looksLikeMp4(b)) return 'mp4';
    return 'unknown';
  }

  // ---------- pomožno ----------
  function readPts(b, o) {
    return ((b[o] >> 1) & 7) * 1073741824 + (((b[o + 1] << 22) | ((b[o + 2] >> 1) << 15) | (b[o + 3] << 7) | (b[o + 4] >> 1)) >>> 0);
  }
  function id3Skip(b) {
    let o = 0, pts = null;
    while (b.length - o >= 10 && b[o] === 0x49 && b[o + 1] === 0x44 && b[o + 2] === 0x33) {
      const size = ((b[o + 6] & 127) << 21) | ((b[o + 7] & 127) << 14) | ((b[o + 8] & 127) << 7) | (b[o + 9] & 127);
      // PRIV »com.apple.streaming.transportStreamTimestamp« (8 B, 33-bitni PTS)
      const body = b.subarray(o + 10, o + 10 + size);
      const tag = 'com.apple.streaming.transportStreamTimestamp';
      const s = String.fromCharCode.apply(null, body.subarray(0, Math.min(body.length, 200)));
      const idx = s.indexOf(tag);
      if (idx >= 0 && body.length >= idx + tag.length + 1 + 8) {
        const p = idx + tag.length + 1;
        pts = (body[p + 3] & 1) * 4294967296 + (((body[p + 4] << 24) | (body[p + 5] << 16) | (body[p + 6] << 8) | body[p + 7]) >>> 0);
      }
      o += 10 + size;
    }
    return { offset: o, pts };
  }

  /** Razčleni ADTS tok v okvirje. */
  function parseAdts(b, startPts) {
    const frames = []; let cfg = null; let o = 0;
    while (o + 7 <= b.length) {
      if (b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) { o++; continue; }
      const prot = b[o + 1] & 1;
      const profile = (b[o + 2] >> 6) & 3;
      const sf = (b[o + 2] >> 2) & 15;
      const chan = ((b[o + 2] & 1) << 2) | (b[o + 3] >> 6);
      const len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5);
      const hdr = prot ? 7 : 9;
      if (len < hdr || o + len > b.length) break;
      if (!cfg && sf < SAMPLE_RATES.length) cfg = { objType: profile + 1, sfIndex: sf, channels: chan || 2, sampleRate: SAMPLE_RATES[sf] };
      frames.push(b.subarray(o + hdr, o + len));
      o += len;
    }
    return { frames, cfg, startPts };
  }

  // ---------- H.264 ----------
  function splitAnnexB(b) {
    const nals = []; let i = 0, start = -1;
    const n = b.length;
    while (i + 3 <= n) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        if (start >= 0) { let e = i; while (e > start && b[e - 1] === 0) e--; if (e > start) nals.push(b.subarray(start, e)); }
        start = i + 3; i += 3;
      } else i++;
    }
    if (start >= 0 && start < n) { let e = n; while (e > start && b[e - 1] === 0) e--; if (e > start) nals.push(b.subarray(start, e)); }
    return nals;
  }

  function unescapeRbsp(b) {
    const out = []; let zeros = 0;
    for (let i = 0; i < b.length; i++) {
      if (zeros >= 2 && b[i] === 3) { zeros = 0; continue; }
      out.push(b[i]); zeros = b[i] === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(out);
  }
  function bitReader(b) {
    let pos = 0;
    const bit = () => { const v = (b[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
    const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => { let z = 0; while (!bit() && z < 32) z++; return z ? (Math.pow(2, z) - 1 + bits(z)) : 0; };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); };
    return { bit, bits, ue, se };
  }
  /** Ločljivost, profil … iz SPS (NAL vključno z glavo). */
  function parseSps(nal) {
    const r = bitReader(unescapeRbsp(nal.subarray(1)));
    const profile = r.bits(8), compat = r.bits(8), level = r.bits(8);
    r.ue();
    let chroma = 1, bitDepthL = 8, bitDepthC = 8;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue(); if (chroma === 3) r.bit();
      bitDepthL = 8 + r.ue(); bitDepthC = 8 + r.ue(); r.bit();
      if (r.bit()) { const cnt = chroma !== 3 ? 8 : 12; for (let i = 0; i < cnt; i++) if (r.bit()) { const size = i < 6 ? 16 : 64; let last = 8, next = 8; for (let j = 0; j < size; j++) { if (next) { next = (last + r.se() + 256) % 256; } last = next || last; } } }
    }
    r.ue(); // log2_max_frame_num
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.bit();
    const wMbs = r.ue() + 1, hMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const cropUnitX = chroma === 0 ? 1 : (chroma === 3 ? 1 : 2);
    const cropUnitY = (chroma === 0 ? 1 : (chroma === 1 ? 2 : 1)) * (2 - frameMbsOnly);
    const width = wMbs * 16 - (cl + cr) * cropUnitX;
    const height = (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * cropUnitY;
    return { profile, compat, level, width, height, chroma, bitDepthL, bitDepthC };
  }

  // ---------- demux TS ----------
  const VIDEO_UNSUPPORTED = { 0x01: 'MPEG-1', 0x02: 'MPEG-2', 0x10: 'MPEG-4', 0x24: 'HEVC (H.265)', 0xea: 'VC-1' };
  const AUDIO_UNSUPPORTED = { 0x03: 'MP3', 0x04: 'MP3', 0x11: 'AAC-LATM', 0x81: 'AC-3', 0x87: 'E-AC-3', 0x82: 'DTS', 0x8a: 'DTS' };

  function demuxTs(buf) {
    // poišči zaporedje paketov
    let start = -1, size = 188, sync = 0;
    for (let s = 0; s < 188 && s + 188 < buf.length; s++) {
      if (buf[s] === 0x47 && buf[s + 188] === 0x47) { start = s; size = 188; sync = 0; break; }
    }
    if (start < 0 && buf.length > 196 && buf[4] === 0x47 && buf[196] === 0x47) { start = 0; size = 192; sync = 4; }
    if (start < 0) throw err('Segment ni veljaven MPEG-TS.');

    let pmtPid = -1; const streams = []; const psi = {};
    const pes = {}; // pid -> {chunks, ...}
    const done = {}; // pid -> [pes buffers]
    const finish = (pid) => {
      const st = pes[pid]; if (!st || !st.chunks.length) return;
      (done[pid] || (done[pid] = [])).push(concat(st.chunks)); st.chunks = [];
    };
    let scrambled = false;
    for (let p = start; p + size <= buf.length; p += size) {
      const q = p + sync;
      if (buf[q] !== 0x47) continue;
      const pid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2];
      const pusi = (buf[q + 1] & 0x40) !== 0;
      const afc = (buf[q + 3] >> 4) & 3;
      if (pid === 0x1fff) continue;
      if ((buf[q + 3] >> 6) & 3) scrambled = true;
      let o = q + 4;
      if (afc & 2) o += 1 + buf[o];
      if (!(afc & 1) || o >= q + 188) continue;
      const payload = buf.subarray(o, q + 188);
      if (pid === 0 || pid === pmtPid) {
        let sec = payload;
        if (pusi) { sec = payload.subarray(1 + payload[0]); psi[pid] = { data: [], len: 0 }; }
        const acc = psi[pid]; if (!acc) continue;
        acc.data.push(sec);
        const all = concat(acc.data);
        if (all.length < 3) continue;
        const slen = ((all[1] & 0x0f) << 8) | all[2];
        if (all.length < 3 + slen) continue;
        delete psi[pid];
        if (pid === 0) {
          for (let i = 8; i + 4 <= 3 + slen - 4; i += 4) {
            const prog = (all[i] << 8) | all[i + 1];
            if (prog !== 0 && pmtPid < 0) pmtPid = ((all[i + 2] & 0x1f) << 8) | all[i + 3];
          }
        } else if (!streams.length) {
          const pil = ((all[10] & 0x0f) << 8) | all[11];
          let i = 12 + pil;
          while (i + 5 <= 3 + slen - 4) {
            const type = all[i], epid = ((all[i + 1] & 0x1f) << 8) | all[i + 2], il = ((all[i + 3] & 0x0f) << 8) | all[i + 4];
            streams.push({ type, pid: epid });
            i += 5 + il;
          }
        }
        continue;
      }
      if (!streams.some((s) => s.pid === pid)) continue;
      if (!pes[pid]) pes[pid] = { chunks: [] };
      if (pusi) finish(pid);
      pes[pid].chunks.push(payload);
    }
    Object.keys(pes).forEach((pid) => finish(Number(pid)));
    if (scrambled) throw err('Segment je šifriran na ravni MPEG-TS (scrambling) – prenos ni podprt.', 'TS_SCRAMBLED');
    if (!streams.length) throw err('MPEG-TS segment nima tabele PMT.');

    const unsupported = [];
    let vs = null, as = null;
    for (const s of streams) {
      if (s.type === 0x1b && !vs) vs = s;
      else if (s.type === 0x0f && !as) as = s;
      else if (VIDEO_UNSUPPORTED[s.type]) unsupported.push(VIDEO_UNSUPPORTED[s.type]);
      else if (AUDIO_UNSUPPORTED[s.type]) unsupported.push(AUDIO_UNSUPPORTED[s.type]);
    }
    const res = { video: null, audio: null, unsupported, firstTime: null };

    function parsePes(b) {
      if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return null;
      const plen = (b[4] << 8) | b[5];
      const flags = b[7] >> 6; const hl = b[8];
      let pts = null, dts = null;
      if (flags & 2) pts = readPts(b, 9);
      if (flags === 3) dts = readPts(b, 14); else dts = pts;
      const end = plen ? Math.min(b.length, 6 + plen) : b.length;
      return { pts, dts, data: b.subarray(9 + hl, end) };
    }

    if (vs) {
      const samples = []; let sps = null, pps = null;
      for (const raw of (done[vs.pid] || [])) {
        const p = parsePes(raw); if (!p || p.pts === null) continue;
        const nals = splitAnnexB(p.data);
        const keep = []; let sync2 = false, len = 0;
        for (const n of nals) {
          const t = n[0] & 31;
          if (t === 7) { if (!sps) sps = n.slice(); continue; }
          if (t === 8) { if (!pps) pps = n.slice(); continue; }
          if (t === 9 || t === 12) continue;
          if (t === 5) sync2 = true;
          keep.push(n); len += 4 + n.length;
        }
        if (!keep.length) continue;
        const data = new Uint8Array(len); let o = 0;
        for (const n of keep) { w32(data, o, n.length); data.set(n, o + 4); o += 4 + n.length; }
        samples.push({ pts: p.pts, dts: p.dts, data, sync: sync2 });
      }
      if (samples.length) res.video = { samples, sps, pps };
    }
    if (as) {
      const frames = []; let cfg = null;
      for (const raw of (done[as.pid] || [])) {
        const p = parsePes(raw); if (!p || p.pts === null) continue;
        const a = parseAdts(p.data);
        if (!cfg) cfg = a.cfg;
        const sr = a.cfg ? a.cfg.sampleRate : (cfg ? cfg.sampleRate : 44100);
        a.frames.forEach((f, i) => frames.push({ pts: p.pts + Math.round(i * 1024 * TS_HZ / sr), data: f }));
      }
      if (frames.length && cfg) res.audio = { frames, cfg };
    }
    finalize(res);
    return res;
  }

  function finalize(res) {
    const t = [];
    if (res.video) t.push(res.video.samples[0].dts);
    if (res.audio) t.push(res.audio.frames[0].pts);
    res.firstTime = t.length ? Math.min.apply(null, t) : null;
  }

  /** Samostojni AAC (ADTS, »packed audio«) segment. */
  function demuxPacked(buf, fallbackPts) {
    const id = id3Skip(buf);
    const a = parseAdts(buf.subarray(id.offset));
    const res = { video: null, audio: null, unsupported: [], firstTime: null };
    if (a.frames.length && a.cfg) {
      const base = id.pts !== null ? id.pts : (fallbackPts || 0);
      res.audio = { frames: a.frames.map((f, i) => ({ pts: base + Math.round(i * 1024 * TS_HZ / a.cfg.sampleRate), data: f })), cfg: a.cfg };
    }
    finalize(res);
    return res;
  }

  function demux(buf, opts) {
    const kind = sniff(buf);
    if (kind === 'ts') return demuxTs(buf);
    if (kind === 'aac') return demuxPacked(buf, opts && opts.fallbackPts);
    throw err('Segment ni niti MPEG-TS niti AAC.');
  }

  // ---------- gradnja fMP4 ----------
  function u32b(v) { const a = new Uint8Array(4); w32(a, 0, v); return a; }
  function u16b(v) { return new Uint8Array([(v >> 8) & 255, v & 255]); }
  function zeros(n) { return new Uint8Array(n); }

  function buildInit(kind, id, cfg) {
    const isVideo = kind === 'video';
    const timescale = isVideo ? TS_HZ : cfg.sampleRate;
    const matrix = new Uint8Array(36); w32(matrix, 0, 0x10000); w32(matrix, 16, 0x10000); w32(matrix, 32, 0x40000000);
    const mvhd = fullBox('mvhd', 0, 0, concat([zeros(8), u32b(1000), u32b(0), u32b(0x00010000), u16b(0x0100), zeros(10), matrix, zeros(24), u32b(id + 1)]));
    const tkhd = fullBox('tkhd', 0, 3, concat([zeros(8), u32b(id), zeros(4), u32b(0), zeros(8), u16b(0), u16b(0), u16b(isVideo ? 0 : 0x0100), u16b(0), matrix,
      u32b(isVideo ? cfg.width * 65536 : 0), u32b(isVideo ? cfg.height * 65536 : 0)]));
    const mdhd = fullBox('mdhd', 0, 0, concat([zeros(8), u32b(timescale), u32b(0), u16b(0x55c4), u16b(0)]));
    const hdlr = fullBox('hdlr', 0, 0, concat([zeros(4), enc(isVideo ? 'vide' : 'soun'), zeros(12), enc(isVideo ? 'VideoHandler' : 'SoundHandler'), zeros(1)]));
    const xmhd = isVideo ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('smhd', 0, 0, zeros(4));
    const dinf = box('dinf', [fullBox('dref', 0, 0, concat([u32b(1), fullBox('url ', 0, 1, new Uint8Array(0))]))]);
    let entry;
    if (isVideo) {
      const hp = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(cfg.profile);
      const avcC = box('avcC', [new Uint8Array([1, cfg.sps[1], cfg.sps[2], cfg.sps[3], 0xff, 0xe1]), u16b(cfg.sps.length), cfg.sps,
        new Uint8Array([1]), u16b(cfg.pps.length), cfg.pps,
        hp ? new Uint8Array([0xfc | cfg.chroma, 0xf8 | (cfg.bitDepthL - 8), 0xf8 | (cfg.bitDepthC - 8), 0]) : new Uint8Array(0)]);
      const name = new Uint8Array(32);
      entry = box('avc1', [zeros(6), u16b(1), zeros(16), u16b(cfg.width), u16b(cfg.height), u32b(0x00480000), u32b(0x00480000), zeros(4), u16b(1), name, u16b(0x18), u16b(0xffff), avcC]);
    } else {
      const asc = new Uint8Array(2);
      asc[0] = (cfg.objType << 3) | (cfg.sfIndex >> 1); asc[1] = ((cfg.sfIndex & 1) << 7) | (cfg.channels << 3);
      const dsi = concat([new Uint8Array([0x05, 2]), asc]);
      const dcd = concat([new Uint8Array([0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0]), u32b(0), u32b(0), dsi]);
      const esd = concat([new Uint8Array([0x03, 3 + dcd.length + 3, 0, 0, 0]), dcd, new Uint8Array([0x06, 1, 2])]);
      const esds = fullBox('esds', 0, 0, esd);
      entry = box('mp4a', [zeros(6), u16b(1), zeros(8), u16b(cfg.channels), u16b(16), u16b(0), u16b(0), u32b(cfg.sampleRate * 65536), esds]);
    }
    const stsd = fullBox('stsd', 0, 0, concat([u32b(1), entry]));
    const empty = (t) => fullBox(t, 0, 0, u32b(0));
    const stbl = box('stbl', [stsd, empty('stts'), empty('stsc'), fullBox('stsz', 0, 0, zeros(8)), empty('stco')]);
    const trak = box('trak', [tkhd, box('mdia', [mdhd, hdlr, box('minf', [xmhd, dinf, stbl])])]);
    const trex = fullBox('trex', 0, 0, concat([u32b(id), u32b(1), u32b(0), u32b(0), u32b(0)]));
    const ftyp = box('ftyp', [enc('isom'), u32b(512), enc('isomiso6avc1mp41')]);
    return concat([ftyp, box('moov', [mvhd, trak, box('mvex', [trex])])]);
  }

  function buildFragment(trackId, seq, baseTime, samples) {
    // samples: [{dur, size, flags, cts, data}]
    const n = samples.length;
    const mfhd = fullBox('mfhd', 0, 0, u32b(seq));
    const tfhd = fullBox('tfhd', 0, 0x020000, u32b(trackId));
    const tfdt = fullBox('tfdt', 1, 0, concat([u32b(Math.floor(baseTime / 4294967296)), u32b(baseTime >>> 0)]));
    const trunBody = new Uint8Array(8 + n * 16);
    w32(trunBody, 0, n);
    let payload = 0;
    samples.forEach((s, i) => {
      const o = 8 + i * 16;
      w32(trunBody, o, s.dur); w32(trunBody, o + 4, s.size); w32(trunBody, o + 8, s.flags); w32(trunBody, o + 12, s.cts >>> 0);
      payload += s.size;
    });
    const trun = fullBox('trun', 0, 0x000f01, trunBody);
    const trafLen = 8 + tfhd.length + tfdt.length + trun.length;
    const moofLen = 8 + mfhd.length + trafLen;
    // data_offset v poljih trun: po verzijskem/flag polju (4) in count (4)
    w32(trun, 16, moofLen + 8);
    const moof = box('moof', [mfhd, box('traf', [tfhd, tfdt, trun])]);
    const mdat = new Uint8Array(8 + payload);
    w32(mdat, 0, mdat.length); mdat.set(enc('mdat'), 4);
    let o = 8; for (const s of samples) { mdat.set(s.data, o); o += s.size; }
    return concat([moof, mdat]);
  }

  /**
   * Stanjski pretvornik: demuxane segmente (v pravem vrstnem redu) spreminja v fragmente po sledeh.
   * Zadnji video vzorec vsakega segmenta se zadrži do naslednjega (da je trajanje natančno).
   */
  class TsToFmp4 {
    constructor() { this.base = null; this.seq = 0; this.v = null; this.a = null; }
    /** Nastavi skupni začetek (90 kHz) in ustvari init segmente iz prvih demuxanih segmentov. */
    prime(demuxes) {
      const times = demuxes.map((d) => d.firstTime).filter((x) => x !== null);
      if (!times.length) throw err('V prvih segmentih ni najti videa ali zvoka.');
      this.base = Math.min.apply(null, times);
      const inits = {};
      for (const d of demuxes) {
        if (d.video && !this.v) {
          if (!d.video.sps || !d.video.pps) throw err('Video nima SPS/PPS – pretvorba ni mogoča.');
          this.v = { id: 0, off: 0, lastRaw: null, lastAdts: null, lastDur: 3000, pending: null, cfg: Object.assign({ sps: d.video.sps, pps: d.video.pps }, parseSps(d.video.sps)) };
        }
        if (d.audio && !this.a) this.a = { id: 0, next: null, lastRaw: null, cfg: d.audio.cfg };
      }
      let id = 1;
      if (this.v) { this.v.id = id++; inits.video = buildInit('video', this.v.id, this.v.cfg); }
      if (this.a) { this.a.id = id++; inits.audio = buildInit('audio', this.a.id, this.a.cfg); }
      return inits;
    }
    _unwrap(t, ref) {
      let x = t;
      if (ref !== null) while (x - ref < -4294967296) x += 8589934592;
      return x;
    }
    _videoFragment(list) {
      // list: vzorci z že znanim trajanjem (s.dur)
      const samples = list.map((s) => ({
        dur: s.dur, size: s.data.length, flags: s.sync ? 0x02000000 : 0x01010000,
        cts: Math.max(0, s.apts - s.adts), data: s.data
      }));
      return buildFragment(this.v.id, ++this.seq, Math.max(0, list[0].adts - this.base), samples);
    }
    /** @returns {Array<{kind, bytes}>} */
    push(d, seg) {
      const out = [];
      const disc = !!(seg && seg.discontinuity);
      if (d.video && this.v) {
        const v = this.v; const s = [];
        d.video.samples.forEach((x, i) => {
          const dts = this._unwrap(x.dts, v.lastRaw); const pts = this._unwrap(x.pts, dts);
          v.lastRaw = dts;
          if (i === 0 && v.lastAdts !== null) {
            const expected = v.lastAdts + v.lastDur;
            if (disc || Math.abs(dts + v.off - expected) > 10 * TS_HZ) v.off = expected - dts;
          }
          s.push({ adts: dts + v.off, apts: pts + v.off, data: x.data, sync: x.sync, dur: 0 });
        });
        const list = v.pending ? [v.pending].concat(s) : s;
        for (let i = 0; i + 1 < list.length; i++) {
          let dur = Math.round(list[i + 1].adts - list[i].adts);
          if (dur <= 0) dur = v.lastDur;
          list[i].dur = dur; v.lastDur = dur;
        }
        v.pending = list[list.length - 1]; v.lastAdts = v.pending.adts;
        if (list.length > 1) out.push({ kind: 'video', bytes: this._videoFragment(list.slice(0, -1)) });
      }
      if (d.audio && this.a) {
        const a = this.a; const sr = a.cfg.sampleRate; const f = d.audio.frames;
        const ts0 = this._unwrap(f[0].pts, a.lastRaw); a.lastRaw = ts0;
        if (a.next === null) a.next = Math.max(0, Math.round((ts0 - this.base) * sr / TS_HZ));
        const samples = f.map((x) => ({ dur: 1024, size: x.data.length, flags: 0x02000000, cts: 0, data: x.data }));
        out.push({ kind: 'audio', bytes: buildFragment(a.id, ++this.seq, a.next, samples) });
        a.next += 1024 * f.length;
      }
      return out;
    }
    /** Izprazni zadržani vzorec. */
    flush() {
      const v = this.v;
      if (!v || !v.pending) return [];
      const p = v.pending; v.pending = null; p.dur = v.lastDur;
      return [{ kind: 'video', bytes: this._videoFragment([p]) }];
    }
  }

  const api = { finalize, sniff, demux, demuxTs, demuxPacked, parseSps, parseAdts, splitAnnexB, buildInit, buildFragment, TsToFmp4, TS_HZ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSTs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

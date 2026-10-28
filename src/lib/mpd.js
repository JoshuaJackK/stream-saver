/*
 * Stream Saver – razčlenjevanje DASH manifesta (MPD) in sej oneDrive.transcode.
 * Brez odvisnosti od brskalnika: deluje v ozadju razširitve (DOMParser) in v Node
 * (testi, @xmldom/xmldom). Izvoz: globalThis.SSMpd oz. module.exports.
 */
(function (root) {
  'use strict';

  const HARD_DRM = {
    'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
    '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
    '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
    'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
    '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'W3C ClearKey'
  };
  const SEA_SCHEME = 'urn:mpeg:dash:sea:2012';

  // ---------- XML helpers (namespace-agnostic, no querySelector) ----------
  function lname(n) { return (n.localName || n.nodeName || '').replace(/^.*:/, ''); }
  function kids(el, name) {
    const out = [];
    if (!el) return out;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && (!name || lname(c) === name)) out.push(c);
    }
    return out;
  }
  function kid(el, name) { return kids(el, name)[0] || null; }
  function attr(el, name) {
    if (!el || !el.getAttribute) return null;
    const v = el.getAttribute(name);
    return v === '' || v === undefined ? null : v;
  }
  function text(el) { return el ? String(el.textContent || '').trim() : ''; }

  // ISO 8601 duration (PT1H2M3.5S, P1DT2H) -> seconds
  function parseDuration(s) {
    if (!s) return 0;
    const m = String(s).match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return 0;
    const n = (i) => parseFloat(m[i] || '0');
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
  }

  function resolveUrl(ref, base) {
    if (!ref) return base;
    const u = new URL(ref, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nevaren URL v manifestu: ' + ref);
    return u.href;
  }

  // DASH template substitution: $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$
  function expandTemplate(tpl, vars) {
    return String(tpl).replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0?(\d+)d)?\$/g, (all, name, width) => {
      if (name === '') return '$';
      let v = vars[name];
      if (v === undefined || v === null) return all;
      v = String(v);
      if (width) v = v.padStart(parseInt(width, 10), '0');
      return v;
    });
  }

  function hexToBytes(hex) {
    hex = String(hex || '').replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
    if (hex.length % 2) hex = '0' + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // Merge SegmentTemplate attributes/children from AdaptationSet level and Representation level.
  function mergedTemplate(asEl, repEl) {
    const levels = [kid(asEl, 'SegmentTemplate'), kid(repEl, 'SegmentTemplate')].filter(Boolean);
    if (!levels.length) return null;
    const names = ['media', 'initialization', 'startNumber', 'timescale', 'duration', 'presentationTimeOffset'];
    const t = {};
    for (const n of names) {
      for (const l of levels) { const v = attr(l, n); if (v !== null) t[n] = v; }
    }
    t.timeline = null;
    for (const l of levels) { const tl = kid(l, 'SegmentTimeline'); if (tl) t.timeline = tl; }
    return t;
  }

  function detectProtection(els) {
    const res = { drm: null, sea: null, other: [] };
    for (const el of els) {
      for (const cp of kids(el, 'ContentProtection')) {
        const scheme = (attr(cp, 'schemeIdUri') || '').toLowerCase();
        const uuid = scheme.replace(/^urn:uuid:/, '');
        if (HARD_DRM[uuid]) { res.drm = HARD_DRM[uuid]; continue; }
        if (scheme === SEA_SCHEME) {
          const segEnc = kid(cp, 'SegmentEncryption');
          const cryptoPeriod = kid(cp, 'CryptoPeriod');
          const encScheme = attr(segEnc, 'schemeIdUri') || '';
          res.sea = {
            scheme: /aes128-cbc|aes-128-cbc/i.test(encScheme) ? 'aes-128-cbc' : encScheme || 'unknown',
            keyUri: attr(cryptoPeriod, 'keyUriTemplate'),
            iv: attr(cryptoPeriod, 'IV') ? hexToBytes(attr(cryptoPeriod, 'IV')) : null
          };
          continue;
        }
        if (scheme === 'urn:mpeg:dash:mp4protection:2011') { res.other.push(attr(cp, 'value') || 'cenc'); continue; }
        if (scheme) res.other.push(scheme);
      }
    }
    return res;
  }

  // Infer track kind. Microsoft Stream often labels BOTH video and audio AdaptationSets
  // as mimeType="video/mp4" (ISO-BMFF); contentType may be missing. Prefer codecs /
  // audioSamplingRate / AudioChannelConfiguration / URL hints over a bare video/* mime.
  function trackType(asEl, repEl) {
    const ct = (attr(asEl, 'contentType') || '').toLowerCase();
    if (ct === 'video' || ct === 'audio' || ct === 'text') return ct;
    const codecs = (attr(repEl, 'codecs') || attr(asEl, 'codecs') || '').toLowerCase();
    if (/^(mp4a|opus|ac-3|ec-3|flac|vorbis|mha|mhm)/.test(codecs)) return 'audio';
    if (/^(avc|hvc|hev|vp0|vp09|av01|avs)/.test(codecs)) return 'video';
    if (/^(stpp|wvtt|ttml)/.test(codecs)) return 'text';
    if (attr(repEl, 'audioSamplingRate') || attr(asEl, 'audioSamplingRate')) return 'audio';
    if (kid(repEl, 'AudioChannelConfiguration') || kid(asEl, 'AudioChannelConfiguration')) return 'audio';
    const w = parseInt(attr(repEl, 'width') || attr(asEl, 'width') || '0', 10);
    const h = parseInt(attr(repEl, 'height') || attr(asEl, 'height') || '0', 10);
    if (w > 0 || h > 0) return 'video';
    // Peek at segment URL templates for track=audio / Fragments(audio= / quality=aud*
    const tpl = mergedTemplate(asEl, repEl);
    const tip = ((tpl && (tpl.media || tpl.initialization)) || '') + ' ' + (attr(repEl, 'id') || '');
    if (/track=audio|fragments\(\s*audio\s*=|quality=aud|[^a-z]audio[^a-z]/i.test(tip)) return 'audio';
    if (/track=video|fragments\(\s*video\s*=|quality=v(?!orb)/i.test(tip)) return 'video';
    const mime = (attr(repEl, 'mimeType') || attr(asEl, 'mimeType') || '').toLowerCase();
    if (/^audio\//.test(mime)) return 'audio';
    if (/^video\//.test(mime)) return 'video'; // only after codecs / audio hints
    if (/^(text|application)\//.test(mime)) return 'text';
    return 'unknown';
  }

  function repScore(rep) {
    const bw = parseInt(attr(rep, 'bandwidth') || '0', 10);
    const h = parseInt(attr(rep, 'height') || '0', 10);
    return h * 1e9 + bw;
  }

  /**
   * Parse a DASH MPD document.
   * @param {Document} doc  parsed XML
   * @param {string} manifestUrl  absolute URL of the manifest (base for relative URLs)
   * @returns {{durationSec:number, tracks:Array, drm:string|null, warnings:string[]}}
   * Track: {type, id, bandwidth, codecs, width, height, mimeType, initUrl, initRange,
   *         segments:[{url, time, number, range}], timescale, encryption}
   */
  function parseMpdDocument(doc, manifestUrl) {
    const mpd = doc.documentElement;
    if (!mpd || lname(mpd) !== 'MPD') throw new Error('Dokument ni DASH manifest (MPD).');
    const warnings = [];
    if ((attr(mpd, 'type') || 'static') === 'dynamic') warnings.push('Manifest je "dynamic" (živi prenos) – podprt je samo posnetek.');
    const mpdDuration = parseDuration(attr(mpd, 'mediaPresentationDuration'));
    let base = manifestUrl;
    const mpdBase = kid(mpd, 'BaseURL');
    if (mpdBase) base = resolveUrl(text(mpdBase), base);

    const periods = kids(mpd, 'Period');
    if (!periods.length) throw new Error('Manifest nima elementa Period.');
    if (periods.length > 1) warnings.push('Manifest ima več obdobij (Period); uporabljeno je prvo.');
    const period = periods[0];
    const periodDur = parseDuration(attr(period, 'duration')) || mpdDuration;
    const periodBase = kid(period, 'BaseURL') ? resolveUrl(text(kid(period, 'BaseURL')), base) : base;

    const tracks = [];
    let drm = null;

    function buildTrackFromRep(as, rep, type) {
      const prot = detectProtection([as, rep]);
      if (prot.drm) drm = prot.drm;
      const asBase = kid(as, 'BaseURL') ? resolveUrl(text(kid(as, 'BaseURL')), periodBase) : periodBase;
      const repBase = kid(rep, 'BaseURL') ? resolveUrl(text(kid(rep, 'BaseURL')), asBase) : asBase;
      const vars = { RepresentationID: attr(rep, 'id') || '', Bandwidth: attr(rep, 'bandwidth') || '' };
      const track = {
        type,
        id: attr(rep, 'id') || '',
        bandwidth: parseInt(attr(rep, 'bandwidth') || '0', 10),
        codecs: attr(rep, 'codecs') || attr(as, 'codecs') || '',
        width: parseInt(attr(rep, 'width') || attr(as, 'width') || '0', 10) || null,
        height: parseInt(attr(rep, 'height') || attr(as, 'height') || '0', 10) || null,
        mimeType: attr(rep, 'mimeType') || attr(as, 'mimeType') || '',
        lang: attr(as, 'lang') || attr(rep, 'lang') || null,
        initUrl: null, initRange: null, segments: [], timescale: 1,
        encryption: prot.sea ? Object.assign({ type: 'sea' }, prot.sea) : null,
        protectionOther: prot.other
      };
      const tpl = mergedTemplate(as, rep);
      const segList = kid(rep, 'SegmentList') || kid(as, 'SegmentList');
      if (tpl) {
        const timescale = parseInt(tpl.timescale || '1', 10) || 1;
        const startNumber = parseInt(tpl.startNumber || '1', 10);
        track.timescale = timescale;
        if (tpl.initialization) track.initUrl = resolveUrl(expandTemplate(tpl.initialization, vars), repBase);
        if (!tpl.media) throw new Error('SegmentTemplate brez atributa media.');
        if (tpl.timeline) {
          let t = 0, num = startNumber;
          const ss = kids(tpl.timeline, 'S');
          for (let i = 0; i < ss.length; i++) {
            const s = ss[i];
            if (attr(s, 't') !== null) t = Number(attr(s, 't'));
            const d = Number(attr(s, 'd') || '0');
            let r = parseInt(attr(s, 'r') || '0', 10);
            if (r < 0) {
              const next = ss[i + 1] && attr(ss[i + 1], 't') !== null ? Number(attr(ss[i + 1], 't')) : periodDur * timescale;
              r = Math.max(0, Math.ceil((next - t) / d) - 1);
            }
            if (!(d > 0)) continue;
            for (let k = 0; k <= r; k++) {
              track.segments.push({ url: resolveUrl(expandTemplate(tpl.media, Object.assign({ Number: num, Time: t }, vars)), repBase), time: t / timescale, number: num });
              t += d; num++;
            }
          }
        } else {
          const d = Number(tpl.duration || '0');
          if (!(d > 0) || !(periodDur > 0)) throw new Error('SegmentTemplate brez trajanja segmentov ali brez trajanja posnetka.');
          const count = Math.ceil((periodDur * timescale) / d - 1e-9);
          for (let i = 0; i < count; i++) {
            track.segments.push({ url: resolveUrl(expandTemplate(tpl.media, Object.assign({ Number: startNumber + i, Time: i * d }, vars)), repBase), time: (i * d) / timescale, number: startNumber + i });
          }
        }
      } else if (segList) {
        const init = kid(segList, 'Initialization');
        if (init) { track.initUrl = resolveUrl(attr(init, 'sourceURL') || '', repBase); track.initRange = attr(init, 'range'); }
        const timescale = parseInt(attr(segList, 'timescale') || '1', 10) || 1;
        const d = Number(attr(segList, 'duration') || '0');
        track.timescale = timescale;
        kids(segList, 'SegmentURL').forEach((su, i) => {
          track.segments.push({ url: resolveUrl(attr(su, 'media') || '', repBase), range: attr(su, 'mediaRange'), time: (i * d) / timescale, number: i + 1 });
        });
      } else {
        warnings.push(`Sled ${type}: SegmentBase (ena datoteka) ni podprt za prenos v brskalniku.`);
        track.unsupported = true;
        track.singleFileUrl = repBase;
      }
      return track;
    }

    for (const as of kids(period, 'AdaptationSet')) {
      const reps = kids(as, 'Representation');
      if (!reps.length) continue;
      // One AdaptationSet can contain both video and audio Representations (rare) —
      // pick the best of each kind instead of a single highest-bandwidth rep.
      const best = {};
      for (const rep of reps) {
        const type = trackType(as, rep);
        if (type === 'text' || type === 'unknown') continue;
        if (!best[type] || repScore(rep) > repScore(best[type])) best[type] = rep;
      }
      for (const type of Object.keys(best)) {
        tracks.push(buildTrackFromRep(as, best[type], type));
      }
    }
    // Safety net: reclassify any remaining "video" track that is clearly audio.
    for (const t of tracks) {
      if (t.type !== 'video') continue;
      const tip = (t.initUrl || '') + ' ' + (t.segments[0] && t.segments[0].url || '') + ' ' + t.id;
      if (/^(mp4a|opus|ac-3|ec-3)/i.test(t.codecs) || /track=audio|fragments\(\s*audio\s*=|quality=aud/i.test(tip)) {
        t.type = 'audio';
        t.width = null; t.height = null;
      }
    }
    return { durationSec: periodDur, tracks, drm, warnings };
  }

  function parseMpd(xmlText, manifestUrl, DOMParserImpl) {
    const P = DOMParserImpl || root.DOMParser;
    const doc = new P().parseFromString(xmlText, 'application/xml');
    const err = doc.getElementsByTagName('parsererror');
    if (err && err.length) throw new Error('Manifesta ni mogoče razčleniti (neveljaven XML).');
    return parseMpdDocument(doc, manifestUrl);
  }

  function audioScore(t) {
    // Prefer higher bitrate; slight preference for stereo AAC over unknowns.
    return (t.bandwidth || 0) + (/mp4a/i.test(t.codecs || '') ? 1 : 0);
  }

  /** Pick video + audio tracks for the requested content mode. */
  function selectTracks(parsed, mode) {
    const usable = parsed.tracks.filter((t) => !t.unsupported && t.segments && t.segments.length);
    const videos = usable.filter((t) => t.type === 'video').sort((a, b) => ((b.height || 0) - (a.height || 0)) || (b.bandwidth - a.bandwidth));
    const audios = usable.filter((t) => t.type === 'audio').sort((a, b) => audioScore(b) - audioScore(a));
    const video = videos[0] || null;
    const audio = audios[0] || null;
    if (mode === 'audio') return audio ? [audio] : [];
    if (mode === 'video') return video ? [video] : [];
    // av (default): require both when available; never silently drop a found audio track
    return [video, audio].filter(Boolean);
  }

  function trackSummary(parsed) {
    const usable = (parsed.tracks || []).filter((t) => !t.unsupported);
    return {
      hasVideo: usable.some((t) => t.type === 'video'),
      hasAudio: usable.some((t) => t.type === 'audio'),
      videoCount: usable.filter((t) => t.type === 'video').length,
      audioCount: usable.filter((t) => t.type === 'audio').length,
      types: usable.map((t) => t.type + ':' + (t.id || '?') + ':' + (t.codecs || ''))
    };
  }

  // ---------- oneDrive.transcode session (newer Stream delivery) ----------
  const TRANSCODE_RE = /\/oneDrive\.transcode(?:\?|$)/i;

  /**
   * Rebuild the per-track segment list from oneDrive.transcode URLs the player requested.
   * Every media segment URL differs only in segmentTime, stepping by wsd from ppst to ppd.
   */
  function buildTranscodeTracks(urls, mode) {
    const per = {};
    let encrypted = false;
    for (const u of urls) {
      let url;
      try { url = new URL(u); } catch (e) { continue; }
      if (!TRANSCODE_RE.test(url.pathname + '?')) continue;
      const q = url.searchParams;
      if (q.get('enableEncryption') === '1') encrypted = true;
      const part = q.get('part');
      if (part !== 'initsegment' && part !== 'mediasegment') continue;
      // Prefer explicit track=; fall back to quality=aud* / quality=v*
      let name = (q.get('track') || '').toLowerCase();
      if (!name) {
        const qual = (q.get('quality') || '').toLowerCase();
        if (/^aud/.test(qual) || qual === 'audio') name = 'audio';
        else if (/^v/.test(qual) || qual === 'video') name = 'video';
        else name = 'video';
      }
      if (name !== 'audio' && name !== 'video') {
        if (/aud|audio/.test(name)) name = 'audio';
        else name = 'video';
      }
      const quality = q.get('quality') || '';
      // Key by track+quality so we can later pick the best quality per track.
      const key = name + '|' + quality;
      const t = per[key] || (per[key] = { name, quality, initUrl: null, sample: null, wsd: null, ppd: null, ppst: null });
      for (const k of ['wsd', 'ppd', 'ppst']) if (t[k] === null && q.get(k) !== null) t[k] = q.get(k);
      if (part === 'initsegment') t.initUrl = url.href; // newest token wins
      if (part === 'mediasegment') {
        t.sample = url.href;
        for (const k of ['wsd', 'ppd', 'ppst']) if (q.get(k) !== null) t[k] = q.get(k);
      }
    }
    // Pick one quality per track (prefer the one with most complete data; for video prefer non-empty quality name length as weak signal)
    const chosen = {};
    for (const t of Object.values(per)) {
      if (!t.initUrl || !t.sample) continue;
      const wsd = Number(t.wsd), ppd = Number(t.ppd), ppst = Number(t.ppst || 0);
      if (!(wsd > 0) || !(ppd > ppst)) continue;
      const prev = chosen[t.name];
      // Prefer longer quality id for video (vhigh > vlow heuristically) and any complete audio.
      if (!prev || (t.quality || '').length > (prev.quality || '').length) chosen[t.name] = t;
    }
    const tracks = [];
    for (const t of Object.values(chosen)) {
      const wsd = Number(t.wsd), ppd = Number(t.ppd), ppst = Number(t.ppst || 0);
      const count = Math.ceil((ppd - ppst) / wsd);
      const segments = [];
      for (let i = 0; i < count; i++) {
        const su = new URL(t.sample);
        const st = ppst + i * wsd;
        su.searchParams.set('segmentTime', String(st));
        // Use seconds for interleave sorting (ticks / 1e7 is Stream's usual timescale).
        segments.push({ url: su.href, time: st / 10000000, number: i + 1 });
      }
      tracks.push({
        type: t.name === 'audio' ? 'audio' : 'video',
        id: t.quality || t.name,
        initUrl: t.initUrl,
        segments,
        encryption: encrypted ? { type: 'page-key' } : null
      });
    }
    const video = tracks.find((x) => x.type === 'video');
    const audio = tracks.find((x) => x.type === 'audio');
    if (mode === 'audio') return audio ? [audio] : [];
    if (mode === 'video') return video ? [video] : [];
    return [video, audio].filter(Boolean);
  }

  // ---------- fallback commands ----------
  function cleanManifestUrl(url) {
    const i = url.indexOf('index&format=dash');
    if (i !== -1) return url.slice(0, i + 'index&format=dash'.length);
    return url;
  }
  function shellQuote(s, win) {
    s = String(s);
    if (win) return '"' + s.replace(/"/g, '""') + '"';
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  function ytDlpCommand(pageUrl, fileBase, win) {
    const out = (fileBase || '%(title)s') + '.%(ext)s';
    return `yt-dlp --cookies-from-browser firefox -o ${shellQuote(out, win)} ${shellQuote(pageUrl, win)}`;
  }
  function ffmpegCommand(manifestUrl, fileBase, win, spopactoken) {
    const hdr = spopactoken ? `-headers ${shellQuote('x-spopactoken: ' + spopactoken + '\r\n', win)} ` : '';
    return `ffmpeg ${hdr}-i ${shellQuote(cleanManifestUrl(manifestUrl), win)} -map 0:v:0 -map 0:a:0? -c copy ${shellQuote((fileBase || 'posnetek') + '.mp4', win)}`;
  }

  // Keep Slovenian letters; strip what Windows/Firefox refuse in file names.
  function sanitizeFilename(name) {
    let s = String(name || '').normalize('NFC');
    s = s.replace(/\.(mp4|m4a|mov|mkv)$/i, '');
    s = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]+/g, '_').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[.\s]+|[.\s]+$/g, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
    if (s.length > 150) s = s.slice(0, 150).trim();
    return s || 'posnetek';
  }
  function sanitizeSubfolder(p) {
    return String(p || '').split(/[\\/]+/).map((x) => x.trim())
      .filter((x) => x && !/^\.+$/.test(x)).map((x) => sanitizeFilename(x)).join('/');
  }
  function titleFromTab(title) {
    return String(title || '')
      .replace(/\s*[-|–]\s*(Microsoft Stream|Microsoft Teams|OneDrive|SharePoint)\s*$/i, '')
      .replace(/^\(\d+\)\s*/, '').trim();
  }

  const api = {
    parseMpd, parseMpdDocument, parseDuration, expandTemplate, resolveUrl, hexToBytes, selectTracks, trackSummary,
    buildTranscodeTracks, cleanManifestUrl, ytDlpCommand, ffmpegCommand, sanitizeFilename,
    sanitizeSubfolder, titleFromTab, TRANSCODE_RE, HARD_DRM
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSMpd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

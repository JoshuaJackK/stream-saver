/*
 * Stream Saver – splošno zaznavanje video tokov (čista logika, brez omrežja).
 * Odloča samo na podlagi URL-ja, glave Content-Type, Content-Length/Range in stanja – telesa odgovorov ne bere.
 * Izvoz: globalThis.SSDetect oz. module.exports.
 */
(function (root) {
  'use strict';

  const MIN_VIDEO_BYTES = 512 * 1024;     // manjše datoteke so skoraj gotovo sličice/predogledi/oglasi
  const MIN_AUDIO_BYTES = 1024 * 1024;
  const SHORT_SEC = 8;                    // krajše je verjetno oglas/predogled

  // Oglasna in sledilna omrežja – nikoli ne ponujamo njihovih tokov.
  const AD_HOST_RE = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagservices\.com|adsystem\.com|moatads\.com|adnxs\.com|2mdn\.net|imasdk\.googleapis\.com|adform\.net|adsrvr\.org|innovid\.com|serving-sys\.com|teads\.tv|spotxchange\.com|springserve\.com|smartadserver\.com|adition\.com|criteo\.com|scorecardresearch\.com)$/i;
  // YouTube: zahteve so ločeni kosi (itag/range), zato jih ne obravnavamo kot posnetek.
  const UNSUPPORTED_HOST_RE = /(^|\.)(googlevideo\.com)$/i;
  // Stream/SharePoint ima svoj vmesnik in podatke; ne podvajamo.
  const STREAM_PATH_RE = /\/transform\/(videomanifest|videotranscode|thumbnail|streamtranscode)/i;
  const SEGMENT_PATH_RE = /(\.(ts|m4s|m4f|cmfv|cmfa|cmft|aac|ac3|ec3|vtt|webvtt|srt|key|bin)$)|\/(seg|segment|chunk|frag|fragment|part)[-_]?\d+|[-_](seg|segment|chunk|frag)[-_]?\d+|\/fragments\(|\/QualityLevels\(|init[-_.]\w*\.mp4$/i;
  const PREVIEW_RE = /(thumb|sprite|storyboard|poster|trailer-preview|preview[-_.]|\/previews?\/|hover|teaser|\/ads?\/|[-_/.]ad[-_/.]|advert|preroll|midroll|vast|sponsor)/i;

  const HLS_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/(mpegurl|x-mpegurl)|application\/x-mpegurl)/i;
  const DASH_TYPES = /^application\/dash\+xml/i;

  function parse(u) { try { return new URL(u); } catch (e) { return null; } }
  function hdr(headers, name) {
    if (!headers) return null;
    if (Array.isArray(headers)) { const h = headers.find((x) => x.name.toLowerCase() === name); return h ? h.value : null; }
    return headers[name] || null;
  }

  /** Skupna velikost iz Content-Range (bytes a-b/total) ali Content-Length. */
  function sizeOf(status, contentLength, contentRange) {
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) return Number(m[1]);
      return null;
    }
    if (status === 206) return null;
    const n = Number(contentLength);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * @param {{url, status, contentType, contentLength, contentRange, method}} r
   * @returns {null | {kind:'hls'|'dash'|'mp4', audioOnly:boolean, size:number|null, key:string, small?:boolean}}
   */
  function classify(r) {
    if (!r || !r.url) return null;
    if (r.method && r.method !== 'GET') return null;
    if (!(r.status === 200 || r.status === 206)) return null;
    const u = parse(r.url);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
    if (AD_HOST_RE.test(u.hostname) || UNSUPPORTED_HOST_RE.test(u.hostname)) return null;
    if (STREAM_PATH_RE.test(u.pathname)) return null;
    const path = u.pathname;
    const ct = String(r.contentType || '').split(';')[0].trim().toLowerCase();
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(path) || [])[1];
    const e = ext ? ext.toLowerCase() : '';
    const keyPath = u.origin + u.pathname;
    const key = (e === 'm3u8' || e === 'mpd') ? keyPath : keyPath + u.search;

    if (e === 'm3u8' || HLS_TYPES.test(ct)) {
      if (e === 'm3u' && !HLS_TYPES.test(ct)) return null;
      if (/^audio\//.test(ct) && e !== 'm3u8') return null; // internetni radio (.m3u)
      return { kind: 'hls', audioOnly: false, size: null, key };
    }
    if (e === 'mpd' || DASH_TYPES.test(ct)) return { kind: 'dash', audioOnly: false, size: null, key };

    if (SEGMENT_PATH_RE.test(path)) return null;
    if (ct === 'video/mp2t' || ct === 'video/iso.segment' || ct === 'audio/aac' || ct === 'audio/mp2t') return null;
    // Odzivi na Range zahteve iz sredine datoteke so kosi iste datoteke – ključ je že enak, velikost iz Content-Range.
    const size = sizeOf(r.status, r.contentLength, r.contentRange);
    const isVideoCt = /^video\//.test(ct) && ct !== 'video/mp2t';
    const isAudioCt = /^audio\//.test(ct);
    const isOctet = ct === 'application/octet-stream' || ct === 'binary/octet-stream' || ct === '';
    const videoExt = /^(mp4|m4v|mov|webm|mkv)$/.test(e);
    const audioExt = /^(m4a|mp3|ogg|oga|opus|flac|wav)$/.test(e);
    let audioOnly;
    if (isVideoCt || (isOctet && videoExt)) audioOnly = false;
    else if (isAudioCt || (isOctet && audioExt)) audioOnly = true;
    else return null;
    if (r.contentRange && /^bytes\s+\d+-\d+\/\*/.test(r.contentRange)) return null; // neznana velikost
    const min = audioOnly ? MIN_AUDIO_BYTES : MIN_VIDEO_BYTES;
    if (size !== null && size < min) return null;
    // Ad/predogled po imenu
    const out = { kind: 'mp4', audioOnly, size, key: (videoExt || audioExt) ? keyPath : keyPath + u.search };
    if (PREVIEW_RE.test(path)) out.small = true;
    // 'ext' za predlogo imena
    out.ext = (isVideoCt && /webm/.test(ct)) ? 'webm' : (e && /^(mp4|m4v|mov|webm|mkv|m4a|mp3|ogg|oga|opus|flac|wav)$/.test(e) ? e : (/webm/.test(ct) ? 'webm' : (/ogg/.test(ct) ? 'ogg' : (audioOnly ? 'm4a' : 'mp4'))));
    return out;
  }

  /** Oznake za prikaz: kratek / samo zvok / predogled. */
  function flags(entry) {
    const f = [];
    if (entry.audioOnly) f.push('samo zvok');
    if (entry.small) f.push('verjetno predogled/oglas');
    if (entry.meta && entry.meta.durationSec && entry.meta.durationSec < SHORT_SEC) f.push('zelo kratek');
    if (entry.meta && entry.meta.live) f.push('v živo');
    if (entry.meta && entry.meta.drm) f.push('DRM');
    return f;
  }

  /** Ali naj bo vnos privzeto izbran (glavni posnetek)? Večji/daljši je boljši; oznake ga potisnejo nazaj. */
  function score(entry) {
    let s = 0;
    const m = entry.meta || {};
    if (entry.kind === 'hls' || entry.kind === 'dash') s += 40;
    if (m.durationSec) s += Math.min(50, m.durationSec / 6);
    if (entry.size) s += Math.min(30, entry.size / (20 * 1024 * 1024));
    if (entry.audioOnly) s -= 25;
    if (entry.small) s -= 40;
    if (m.durationSec && m.durationSec < SHORT_SEC) s -= 60;
    if (m.live || m.drm) s -= 100;
    if (entry.role === 'variant') s -= 80;
    return s;
  }

  /** Ime datoteke iz naslova strani (dovoljeni znaki); brez končnice. */
  function nameFromTitle(title, fallback) {
    let t = String(title || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^[.\s]+|[.\s]+$/g, '');
    if (t.length > 120) t = t.slice(0, 120).trim();
    return t || fallback || 'posnetek';
  }

  const api = { classify, flags, score, nameFromTitle, sizeOf, hdr, MIN_VIDEO_BYTES, MIN_AUDIO_BYTES, SHORT_SEC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SSDetect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

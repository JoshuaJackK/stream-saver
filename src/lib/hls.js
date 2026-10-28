/*
 * Stream Saver – razčlenjevalnik HLS (m3u8): glavni (master) in predvajalni (media) seznami.
 * Čista logika brez omrežja (testi v Nodu). Izvoz: globalThis.SSHls oz. module.exports.
 *
 * TRDA OMEJITEV: seznami z DRM (SAMPLE-AES, KEYFORMAT com.apple.streamingkeydelivery / PlayReady / Widevine …)
 * se zaznajo in označijo (polje drm); razširitev jih nikoli ne prenese. Podprto je samo navadno AES-128
 * (METHOD=AES-128, KEYFORMAT identity), kjer je ključ javen naslov, ki ga predvajalnik sam prenese.
 */
(function (root) {
  'use strict';

  /** Razčleni seznam atributov: KEY=VAL,KEY="v,v" */
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function resolveUrl(ref, base) {
    try { return new URL(ref, base).href; } catch (e) { return ref; }
  }

  function hexToBytes(hex) {
    let h = String(hex || '').replace(/^0x/i, '');
    if (h.length % 2) h = '0' + h;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    if (out.length > 16) return out.slice(out.length - 16);
    if (out.length < 16) { const p = new Uint8Array(16); p.set(out, 16 - out.length); return p; }
    return out;
  }

  /** Vrne ime DRM sistema/načina ali null, če je ključ navaden (AES-128 + identity) ali ga ni. */
  function drmOfKey(a) {
    const method = String(a.METHOD || '').toUpperCase();
    if (!method || method === 'NONE') return null;
    const fmt = String(a.KEYFORMAT || 'identity').toLowerCase();
    const uri = String(a.URI || '').toLowerCase();
    if (/apple\.streamingkeydelivery/.test(fmt) || /^skd:/.test(uri)) return 'FairPlay';
    if (/playready/.test(fmt)) return 'PlayReady';
    if (/edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|widevine/.test(fmt) || /widevine/.test(uri)) return 'Widevine';
    if (method !== 'AES-128') return method; // SAMPLE-AES, SAMPLE-AES-CTR, SAMPLE-AES-CENC …
    if (fmt !== 'identity') return a.KEYFORMAT;
    return null;
  }

  function isMaster(text) { return /#EXT-X-STREAM-INF/.test(text); }

  function parsePlaylist(text, baseUrl) {
    text = String(text || '').replace(/^\uFEFF/, '');
    if (!/^#EXTM3U/.test(text.trimStart())) throw new Error('Datoteka ni seznam HLS (#EXTM3U).');
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    return isMaster(text) ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
  }

  function parseMaster(lines, baseUrl) {
    const variants = [], renditions = [];
    let drm = null, pending = null;
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF:')) { pending = parseAttrs(line.slice(18)); continue; }
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(line.slice(13));
        renditions.push({
          type: (a.TYPE || '').toUpperCase(), groupId: a['GROUP-ID'] || '', name: a.NAME || '', language: a.LANGUAGE || '',
          isDefault: /^YES$/i.test(a.DEFAULT || ''), autoselect: /^YES$/i.test(a.AUTOSELECT || ''),
          uri: a.URI ? resolveUrl(a.URI, baseUrl) : null, channels: a.CHANNELS || ''
        });
        continue;
      }
      if (line.startsWith('#EXT-X-SESSION-KEY:') || line.startsWith('#EXT-X-KEY:')) {
        const d = drmOfKey(parseAttrs(line.slice(line.indexOf(':') + 1)));
        if (d) drm = drm || d;
        continue;
      }
      if (line[0] === '#') continue;
      if (pending) {
        const a = pending; pending = null;
        const res = /^(\d+)x(\d+)$/i.exec(a.RESOLUTION || '');
        const codecs = a.CODECS || '';
        const cl = codecs.toLowerCase();
        const hasVideoCodec = /avc1|avc3|hvc1|hev1|vp0?9|av01|dvh1|dvhe|mp4v/.test(cl);
        const hasAudioCodec = /mp4a|ac-3|ec-3|opus|flac|mp3/.test(cl);
        variants.push({
          uri: resolveUrl(line, baseUrl),
          bandwidth: Number(a.BANDWIDTH) || 0,
          avgBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0,
          width: res ? Number(res[1]) : 0, height: res ? Number(res[2]) : 0,
          codecs, frameRate: Number(a['FRAME-RATE']) || 0,
          audioGroup: a.AUDIO || '', subtitleGroup: a.SUBTITLES || '',
          audioOnly: codecs ? (hasAudioCodec && !hasVideoCodec) : false
        });
      }
    }
    return { type: 'master', variants, renditions, drm, url: baseUrl };
  }

  function parseMedia(lines, baseUrl) {
    const out = {
      type: 'media', url: baseUrl, targetDuration: 0, mediaSequence: 0, endList: false, playlistType: '',
      iframesOnly: false, segments: [], drm: null, totalDuration: 0, version: 1
    };
    let seq = 0, time = 0, key = null, map = null, dur = null, range = null, lastRangeEnd = {}, disc = false;
    for (const line of lines) {
      if (!line) continue;
      if (line[0] === '#') {
        if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.slice(8)) || 0; continue; }
        if (line.startsWith('#EXT-X-TARGETDURATION:')) { out.targetDuration = parseFloat(line.slice(22)) || 0; continue; }
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { seq = out.mediaSequence = parseInt(line.slice(22), 10) || 0; continue; }
        if (line.startsWith('#EXT-X-VERSION:')) { out.version = parseInt(line.slice(15), 10) || 1; continue; }
        if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) { out.playlistType = line.slice(21).trim().toUpperCase(); continue; }
        if (line === '#EXT-X-ENDLIST') { out.endList = true; continue; }
        if (line === '#EXT-X-I-FRAMES-ONLY') { out.iframesOnly = true; continue; }
        if (line === '#EXT-X-DISCONTINUITY') { disc = true; continue; }
        if (line.startsWith('#EXT-X-BYTERANGE:')) {
          const m = /^(\d+)(?:@(\d+))?$/.exec(line.slice(17).trim());
          if (m) range = { len: Number(m[1]), off: m[2] !== undefined ? Number(m[2]) : null };
          continue;
        }
        if (line.startsWith('#EXT-X-KEY:')) {
          const a = parseAttrs(line.slice(11));
          const d = drmOfKey(a);
          if (d) { out.drm = out.drm || d; key = { method: String(a.METHOD).toUpperCase(), drm: d }; continue; }
          const method = String(a.METHOD || 'NONE').toUpperCase();
          if (method === 'NONE') key = null;
          else key = { method: 'AES-128', keyUri: a.URI ? resolveUrl(a.URI, baseUrl) : null, iv: a.IV ? hexToBytes(a.IV) : null };
          continue;
        }
        if (line.startsWith('#EXT-X-MAP:')) {
          const a = parseAttrs(line.slice(11));
          let r = null;
          const m = /^(\d+)(?:@(\d+))?$/.exec(a.BYTERANGE || '');
          if (m) r = `${Number(m[2] || 0)}-${Number(m[2] || 0) + Number(m[1]) - 1}`;
          map = { url: resolveUrl(a.URI || '', baseUrl), range: r, enc: key && key.keyUri ? { keyUri: key.keyUri, iv: key.iv } : null };
          continue;
        }
        continue;
      }
      // URI line
      if (dur === null) continue; // URI brez EXTINF – ignoriraj
      const url = resolveUrl(line, baseUrl);
      let rangeStr = null;
      if (range) {
        const start = range.off !== null ? range.off : (lastRangeEnd[url] || 0);
        rangeStr = `${start}-${start + range.len - 1}`;
        lastRangeEnd[url] = start + range.len;
      }
      out.segments.push({
        url, duration: dur, time, number: seq, range: rangeStr,
        enc: key && key.keyUri ? { keyUri: key.keyUri, iv: key.iv } : null,
        map, discontinuity: disc
      });
      time += dur; out.totalDuration += dur; seq++; dur = null; range = null; disc = false;
    }
    out.live = !out.endList && out.playlistType !== 'VOD';
    return out;
  }

  /** Variante, urejene od najboljše: najprej video, po pasovni širini (nato po ločljivosti). */
  function sortedVariants(master) {
    const v = master.variants.slice();
    v.sort((a, b) => ((a.audioOnly ? 1 : 0) - (b.audioOnly ? 1 : 0)) || (b.bandwidth - a.bandwidth) || (b.height - a.height) || (b.width - a.width));
    return v;
  }

  /** Izberi zvočno rendicijo za varianto (privzeta, sicer prva z URI). null = zvok je v varianti sami. */
  function pickAudio(master, variant) {
    if (!variant || !variant.audioGroup) return null;
    const group = master.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup);
    const withUri = group.filter((r) => r.uri);
    if (!withUri.length) return null;
    return withUri.find((r) => r.isDefault) || withUri.find((r) => r.autoselect) || withUri[0];
  }

  /** Najcenejša čisto zvočna sled (za način »samo zvok«): zvočna rendicija ali čisto zvočna varianta. */
  function pickAudioOnly(master) {
    const v = master.variants.filter((x) => x.audioOnly).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (v) return { uri: v.uri, name: 'audio' };
    const r = master.renditions.filter((x) => x.type === 'AUDIO' && x.uri);
    return r.find((x) => x.isDefault) || r[0] || null;
  }

  function describeVariant(v) {
    const parts = [];
    if (v.height) parts.push(v.height + 'p'); else if (v.audioOnly) parts.push('samo zvok');
    if (v.bandwidth) parts.push((v.bandwidth / 1e6).toFixed(v.bandwidth >= 1e7 ? 0 : 1).replace('.', ',') + ' Mb/s');
    if (v.frameRate) parts.push(Math.round(v.frameRate) + ' sl/s');
    return parts.join(' · ') || 'varianta';
  }

  const api = { parseAttrs, parsePlaylist, parseMaster, parseMedia, isMaster, drmOfKey, sortedVariants, pickAudio, pickAudioOnly, describeVariant, hexToBytes, resolveUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSHls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

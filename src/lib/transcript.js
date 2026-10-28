/*
 * Stream Saver – prepis (transcript) posnetka iz Microsoft Stream.
 * Brez odvisnosti od brskalnika (ozadje razširitve in Node testi). Izvoz: globalThis.SSTranscript oz. module.exports.
 *
 * Pravilo: razširitev shrani SAMO prepis, ki ga predvajalnik sam naloži (zahteva z `format=json`).
 * Tukaj se zato prepozna samo ta ena oblika naslova; drugih oblik (format=vtt, docx, prenos …) ne sestavljamo in ne kličemo.
 */
(function (root) {
  'use strict';

  const VIEW_RE = /\/_api\/.*\/media\/transcripts\/([^/?#]+)\/streamContent\/?$/i;
  const HOST_RE = /(^|\.)sharepoint\.com(\.mcas\.ms)?$/i;
  const OFFSET_RE = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/;

  /**
   * Ali je naslov zahteva, ki jo predvajalnik naloži za prikaz prepisa (…/media/transcripts/<id>/streamContent?format=json)?
   * Vrne { transcriptId } ali null. Vse drugo (format=vtt, docx, brez formata, druga pot) vrne null.
   */
  function matchViewRequest(urlStr, method) {
    if (method && String(method).toUpperCase() !== 'GET') return null;
    let u;
    try { u = new URL(urlStr); } catch (e) { return null; }
    if (u.protocol !== 'https:' || !HOST_RE.test(u.hostname)) return null;
    const m = VIEW_RE.exec(u.pathname);
    if (!m) return null;
    const fmt = (u.searchParams.get('format') || '').toLowerCase();
    if (fmt !== 'json') return null;
    let id = m[1];
    try { id = decodeURIComponent(id); } catch (e) { /* ostane kodirano */ }
    return { transcriptId: id };
  }

  /** "HH:MM:SS.fffffff" (7 decimalk, ure lahko imajo več števk) -> milisekunde (zaokroženo). Neveljavno -> null. */
  function parseOffset(str) {
    if (typeof str !== 'string') return null;
    const m = OFFSET_RE.exec(str.trim());
    if (!m) return null;
    const h = parseInt(m[1], 10), mi = parseInt(m[2], 10), se = parseInt(m[3], 10);
    if (mi > 59 || se > 59) return null;
    const frac = (m[4] || '').padEnd(7, '0').slice(0, 7); // desetinke mikrosekunde (ticks)
    const ms = Math.round(parseInt(frac, 10) / 10000);
    return ((h * 60 + mi) * 60 + se) * 1000 + ms;
  }

  const p2 = (n) => String(n).padStart(2, '0');
  /** milisekunde -> HH:MM:SS.mmm (ure vsaj 2 števki) */
  function formatVttTime(ms) {
    const total = Math.max(0, Math.round(ms));
    const h = Math.floor(total / 3600000), mi = Math.floor((total % 3600000) / 60000), se = Math.floor((total % 60000) / 1000), x = total % 1000;
    return `${p2(h)}:${p2(mi)}:${p2(se)}.${String(x).padStart(3, '0')}`;
  }
  /** milisekunde -> H:MM:SS (sekunde odrezane) */
  function formatTxtTime(ms) {
    const sec = Math.floor(Math.max(0, ms) / 1000);
    return `${Math.floor(sec / 3600)}:${p2(Math.floor((sec % 3600) / 60))}:${p2(sec % 60)}`;
  }

  /** Surovi odgovor (niz ali bajti, z BOM ali brez) -> razčlenjen prepis. Vrže napako, če oblika ni prepoznana. */
  function parseTranscript(input) {
    let text;
    if (typeof input === 'string') text = input;
    else text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(input);
    text = text.replace(/^\uFEFF/, '');
    let doc;
    try { doc = JSON.parse(text); } catch (e) { throw new Error('Odgovor ni veljaven prepis (JSON).'); }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) throw new Error('Odgovor nima seznama vrstic prepisa (entries).');
    const entries = [];
    let skippedEmpty = 0, skippedBadTime = 0;
    for (const e of doc.entries) {
      if (!e || typeof e !== 'object') continue;
      const t = typeof e.text === 'string' ? e.text.replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join('\n') : '';
      if (!t) { skippedEmpty++; continue; }
      const startMs = parseOffset(e.startOffset);
      if (startMs === null) { skippedBadTime++; continue; }
      let endMs = parseOffset(e.endOffset);
      if (endMs === null || endMs <= startMs) endMs = startMs + 1; // VTT zahteva konec > začetek
      const speaker = typeof e.speakerDisplayName === 'string' ? e.speakerDisplayName.replace(/\s+/g, ' ').trim() : '';
      entries.push({
        id: typeof e.id === 'string' ? e.id : '',
        text: t,
        speaker,
        speakerId: typeof e.speakerId === 'string' ? e.speakerId : '',
        startMs, endMs,
        lang: typeof e.spokenLanguageTag === 'string' ? e.spokenLanguageTag : ''
      });
    }
    // stabilno razvrščanje po začetku (že razvrščeni podatki ostanejo nespremenjeni)
    const ordered = entries.map((e, i) => [e, i]).sort((a, b) => a[0].startMs - b[0].startMs || a[1] - b[1]).map((x) => x[0]);
    const speakers = new Set();
    const langs = new Map();
    for (const e of ordered) {
      const key = e.speakerId || e.speaker;
      if (key) speakers.add(key);
      if (e.lang) langs.set(e.lang, (langs.get(e.lang) || 0) + 1);
    }
    let language = '', best = 0;
    for (const [l, n] of langs) if (n > best) { best = n; language = l; }
    return {
      entries: ordered,
      stats: { lines: ordered.length, speakers: speakers.size, language, skippedEmpty, skippedBadTime }
    };
  }

  /**
   * Microsoft v prepisu besede »če/Če/četudi/že« včasih zapiše kot »èe/Èe/èetudi/ëe«. Znaki è, È, ë, Ë v slovenščini
   * ne obstajajo, zato jih ob shranjevanju vedno zamenjamo: è→č, È→Č, ë→ž, Ë→Ž (samo pri izvozu; podatki ostanejo nespremenjeni).
   */
  function fixEncoding(str) {
    return String(str).replace(/[èÈëË]/g, (c) => ({ 'è': 'č', 'È': 'Č', 'ë': 'ž', 'Ë': 'Ž' })[c]);
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** WebVTT: ena replika na vrstico prepisa, govorec kot <v Ime>…</v>, brez združevanja. */
  function toVtt(parsed) {
    const cues = parsed.entries.map((e) => {
      const body = esc(fixEncoding(e.text));
      const line = e.speaker ? `<v ${esc(fixEncoding(e.speaker))}>${body}</v>` : body;
      return `${formatVttTime(e.startMs)} --> ${formatVttTime(e.endMs)}\n${line}`;
    });
    return 'WEBVTT\n\n' + cues.join('\n\n') + (cues.length ? '\n' : '');
  }

  /** Berljivo besedilo: ena vrstica na vrstico prepisa, `[H:MM:SS] Ime: besedilo`; UTF-8 z BOM (Beležnica), konci vrstic CRLF. */
  function toTxt(parsed) {
    const lines = parsed.entries.map((e) => {
      const body = fixEncoding(e.text).replace(/\n/g, ' ');
      return `[${formatTxtTime(e.startMs)}] ${e.speaker ? fixEncoding(e.speaker) + ': ' : ''}${body}`;
    });
    return '\uFEFF' + lines.join('\r\n') + (lines.length ? '\r\n' : '');
  }

  /** Slovenski samostalnik v pravi obliki: forms = [ednina, dvojina, množina(3–4), množina(5+)] */
  function plural(n, forms) {
    const m = Math.abs(n) % 100;
    if (m === 1) return forms[0];
    if (m === 2) return forms[1];
    if (m === 3 || m === 4) return forms[2];
    return forms[3];
  }
  function describe(stats) {
    let s = `${stats.lines} ${plural(stats.lines, ['vrstica', 'vrstici', 'vrstice', 'vrstic'])}, ${stats.speakers} ${plural(stats.speakers, ['govorec', 'govorca', 'govorci', 'govorcev'])}`;
    if (stats.language) s += `, jezik ${stats.language}`;
    return s;
  }

  const api = { matchViewRequest, parseOffset, formatVttTime, formatTxtTime, parseTranscript, toVtt, toTxt, fixEncoding, plural, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSTranscript = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

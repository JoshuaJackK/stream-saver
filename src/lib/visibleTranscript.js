/*
 * Stream Saver – branje prepisa iz že prikazanega zavihka Prepis (DOM).
 * Brez omrežja in brez branja src/innerHTML (avatarji lahko vsebujejo žetone).
 * Izvoz: globalThis.SSVisibleTranscript oz. module.exports.
 */
(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 90000;
  const ENTRY_SEL = '[data-testid="entryRenderer"]';

  function err(msg, code) {
    const e = new Error(msg);
    if (code) e.code = code;
    return e;
  }

  /** "0:07" | "1:37:51" | "10:05" -> ms. Neveljavno -> null. */
  function parseVisibleTime(label) {
    if (typeof label !== 'string') return null;
    const s = label.trim();
    let m = /^(\d+):([0-5]?\d):([0-5]?\d)$/.exec(s);
    if (m) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000;
    m = /^(\d+):([0-5]?\d)$/.exec(s);
    if (m) return (+m[1] * 60 + +m[2]) * 1000;
    return null;
  }

  /**
   * aria-label oblike »Govorec 1 min 37 s« / »Govorec 2 h 3 min 4 s« / »Govorec 12 s«.
   * Vrne { speaker, ms } ali null.
   */
  function parseAriaLabel(label) {
    if (typeof label !== 'string') return null;
    const s = label.trim();
    let m = /^(.*?)\s+(\d+)\s*h\s+(\d+)\s*min\s+(\d+)\s*s\s*$/i.exec(s);
    if (m) return { speaker: m[1].trim(), ms: ((+m[2] * 60 + +m[3]) * 60 + +m[4]) * 1000 };
    m = /^(.*?)\s+(\d+)\s*min\s+(\d+)\s*s\s*$/i.exec(s);
    if (m) return { speaker: m[1].trim(), ms: (+m[2] * 60 + +m[3]) * 1000 };
    m = /^(.*?)\s+(\d+)\s*s\s*$/i.exec(s);
    if (m) return { speaker: m[1].trim(), ms: (+m[2]) * 1000 };
    return null;
  }

  function textOf(el) {
    if (!el) return '';
    return String(el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function findTranscriptRoot(doc) {
    if (!doc || !doc.querySelector) return null;
    const labels = ['Prepis', 'Transcript', 'Transkript', 'Transcripción', 'Transcription'];
    for (const lab of labels) {
      const el = doc.querySelector('[role="complementary"][aria-label="' + lab + '"]');
      if (el) return el;
    }
    const any = doc.querySelector(ENTRY_SEL);
    return any ? (any.getRootNode && any.getRootNode() === doc ? doc : doc.body || doc.documentElement) : null;
  }

  function findScrollParent(el) {
    let n = el;
    while (n && n !== n.ownerDocument && n !== n.ownerDocument.documentElement) {
      if (n.nodeType === 1) {
        let oy = '';
        try {
          oy = (n.ownerDocument.defaultView.getComputedStyle(n).overflowY || '').toLowerCase();
        } catch (e) { oy = ''; }
        const sh = n.scrollHeight || 0, ch = n.clientHeight || 0;
        if (ch > 0 && sh > ch + 1 && (oy === 'auto' || oy === 'scroll' || oy === 'overlay')) return n;
      }
      n = n.parentElement;
    }
    return (el && el.ownerDocument && (el.ownerDocument.scrollingElement || el.ownerDocument.documentElement)) || null;
  }

  /**
   * Prebere trenutno nameščene vrstice v korenu. Ne bere src/innerHTML.
   * Vrne Map index -> { index, text, speaker, timeMs, setSize }.
   */
  function harvestMounted(root, into) {
    const map = into || new Map();
    if (!root || !root.querySelectorAll) return map;
    const nodes = root.querySelectorAll(ENTRY_SEL);
    for (const node of nodes) {
      const wrap = node.id && /^entry-(\d+)$/.test(node.id) ? node
        : (node.querySelector && node.querySelector('[id^="entry-"]')) || node;
      const idAttr = wrap.id || node.id || '';
      const im = /^entry-(\d+)$/.exec(idAttr);
      if (!im) continue;
      const index = parseInt(im[1], 10);
      const sub = (wrap.querySelector && wrap.querySelector('#sub-entry-' + index))
        || (root.querySelector && root.querySelector('#sub-entry-' + index));
      if (!sub) continue;
      const pos = sub.getAttribute && sub.getAttribute('aria-posinset');
      const set = sub.getAttribute && sub.getAttribute('aria-setsize');
      if (pos != null && String(pos) !== String(index + 1)) continue;
      const setSize = set != null ? parseInt(set, 10) : null;
      if (setSize != null && (!Number.isFinite(setSize) || setSize <= 0)) continue;

      const text = textOf(sub);
      if (!text) continue;

      let speaker = '';
      const header = wrap.querySelector && wrap.querySelector('[role="listitem"][class*="itemHeader-"]');
      if (header) {
        const nameEl = header.querySelector('[class*="itemDisplayName-"]') || header;
        speaker = textOf(nameEl);
      }

      let timeMs = null;
      const ts = wrap.querySelector && wrap.querySelector('#Header-timestamp-' + index);
      if (ts) timeMs = parseVisibleTime(textOf(ts));
      const aria = parseAriaLabel(wrap.getAttribute && wrap.getAttribute('aria-label'));
      if (timeMs == null && aria) timeMs = aria.ms;
      if (!speaker && aria) speaker = aria.speaker || '';

      const prev = map.get(index);
      if (prev && prev.text === text && prev.timeMs != null && timeMs == null) {
        // ohrani že znan čas
      } else {
        map.set(index, {
          index,
          text,
          speaker: speaker || (prev && prev.speaker) || '',
          timeMs: timeMs != null ? timeMs : (prev ? prev.timeMs : null),
          setSize: setSize != null ? setSize : (prev ? prev.setSize : null)
        });
      }
    }
    return map;
  }

  function inferSetSize(map) {
    let total = null;
    for (const e of map.values()) {
      if (e.setSize != null) {
        if (total == null) total = e.setSize;
        else if (total !== e.setSize) throw err('Vrstice prepisa se ne ujemajo (različen aria-setsize).', 'SETSIZE');
      }
    }
    return total;
  }

  /**
   * Dopolni govorce naprej po sosednjih indekih; zgradi obliko kot SSTranscript.parseTranscript.
   * Manjkajoči indeksi ali čas -> napaka (brez delnega izvoza).
   */
  function assembleParsed(map, expectedTotal) {
    if (!map || map.size === 0) throw err('V zavihku Prepis ni bilo mogoče prebrati nobene vrstice.', 'EMPTY');
    const total = expectedTotal != null ? expectedTotal : inferSetSize(map);
    if (total == null || total <= 0) throw err('Števila vrstic prepisa (aria-setsize) ni bilo mogoče določiti.', 'SETSIZE');
    if (map.size !== total) {
      const missing = [];
      for (let i = 0; i < total; i++) if (!map.has(i)) missing.push(i);
      throw err(
        'Prepis ni bil v celoti prebran (' + map.size + '/' + total + '). Manjkajo indeksi: '
          + missing.slice(0, 12).join(', ') + (missing.length > 12 ? ' …' : '') + '.',
        'INCOMPLETE'
      );
    }
    let lastSpeaker = '';
    const entries = [];
    for (let i = 0; i < total; i++) {
      const e = map.get(i);
      if (!e || !e.text) throw err('Manjka besedilo vrstice ' + i + '.', 'INCOMPLETE');
      if (e.timeMs == null || !Number.isFinite(e.timeMs)) {
        throw err('Manjka čas za vrstico ' + i + ' – časa ne izmišljamo.', 'TIME');
      }
      if (e.speaker) lastSpeaker = e.speaker;
      else e.speaker = lastSpeaker;
      entries.push({
        id: 'dom-' + i,
        text: e.text,
        speaker: e.speaker || '',
        speakerId: '',
        startMs: e.timeMs,
        endMs: e.timeMs + 1,
        lang: ''
      });
    }
    for (let i = 0; i < entries.length - 1; i++) {
      const next = entries[i + 1].startMs;
      if (next > entries[i].startMs) entries[i].endMs = next;
    }
    if (entries.length) {
      const last = entries[entries.length - 1];
      if (last.endMs <= last.startMs) last.endMs = last.startMs + 1000;
    }
    const speakers = new Set();
    for (const e of entries) if (e.speaker) speakers.add(e.speaker);
    return {
      entries,
      stats: { lines: entries.length, speakers: speakers.size, language: '', skippedEmpty: 0, skippedBadTime: 0 }
    };
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(err('Prekinjeno.', 'ABORT'));
      const t = setTimeout(resolve, ms);
      if (signal) {
        const onAb = () => { clearTimeout(t); reject(err('Prekinjeno.', 'ABORT')); };
        signal.addEventListener('abort', onAb, { once: true });
      }
    });
  }

  function probeVisiblePane(doc) {
    const root = findTranscriptRoot(doc);
    if (!root) return { available: false, setSize: null, mounted: 0 };
    const map = harvestMounted(root, new Map());
    let setSize = null;
    try { setSize = inferSetSize(map); } catch (e) { setSize = null; }
    if (map.size === 0 && !root.querySelector(ENTRY_SEL)) return { available: false, setSize: null, mounted: 0 };
    return { available: map.size > 0 || !!root.querySelector(ENTRY_SEL), setSize, mounted: map.size };
  }

  /**
   * Po uporabnikovem kliku: drsi po virtualnem seznamu, zbira vrstice, obnovi položaj drsnika.
   * opts: { timeoutMs, signal, waitMs, root, scrollEl } – root/scrollEl za teste.
   */
  async function collectVisibleTranscript(doc, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const waitMs = opts.waitMs != null ? opts.waitMs : 120;
    const signal = opts.signal;
    const root = opts.root || findTranscriptRoot(doc);
    if (!root) throw err('Zavihek Prepis ni odprt ali ni viden. Odpri Prepis v predvajalniku in poskusi znova.', 'NO_PANE');

    const first = root.querySelector(ENTRY_SEL);
    if (!first) throw err('V zavihku Prepis ni vrstic. Počakaj, da se naložijo, ali osveži stran.', 'NO_ROWS');

    const scrollEl = opts.scrollEl || findScrollParent(first) || findScrollParent(root);
    const savedTop = scrollEl ? scrollEl.scrollTop : 0;
    const savedLeft = scrollEl ? scrollEl.scrollLeft : 0;
    const map = new Map();
    const t0 = Date.now();

    try {
      harvestMounted(root, map);
      let total = null;
      try { total = inferSetSize(map); } catch (e) { if (e.code === 'SETSIZE') throw e; }

      if (scrollEl) {
        try { scrollEl.scrollTop = 0; } catch (e) { /* ignore */ }
        await sleep(waitMs, signal);
        harvestMounted(root, map);
        try { total = inferSetSize(map) || total; } catch (e) { if (e.code === 'SETSIZE') throw e; }
      }

      if (total == null || total <= 0) {
        throw err('Števila vrstic prepisa ni bilo mogoče določiti. Preveri, da je zavihek Prepis odprt.', 'SETSIZE');
      }

      let stagnant = 0;
      let lastSize = map.size;
      while (map.size < total && Date.now() - t0 < timeoutMs) {
        if (signal && signal.aborted) throw err('Prekinjeno.', 'ABORT');
        if (!scrollEl) break;

        const missing = [];
        for (let i = 0; i < total; i++) if (!map.has(i)) missing.push(i);
        const target = missing.length ? missing[0] : total - 1;
        const maxScroll = Math.max(0, (scrollEl.scrollHeight || 0) - (scrollEl.clientHeight || 0));
        const frac = total > 1 ? target / (total - 1) : 0;
        const jump = Math.floor(frac * maxScroll);
        const step = Math.max(48, Math.floor((scrollEl.clientHeight || 200) * 0.7));
        const prevTop = scrollEl.scrollTop;
        // najprej poskusi skok proti manjkajočemu, sicer korak navzdol
        if (missing.length && Math.abs(prevTop - jump) > step) {
          scrollEl.scrollTop = jump;
        } else {
          scrollEl.scrollTop = Math.min(maxScroll, prevTop + step);
        }
        await sleep(waitMs, signal);
        harvestMounted(root, map);

        if (map.size === lastSize && Math.abs((scrollEl.scrollTop || 0) - prevTop) < 1) {
          stagnant++;
          if (stagnant >= 20) break;
        } else {
          stagnant = 0;
          lastSize = map.size;
        }
      }

      return assembleParsed(map, total);
    } finally {
      if (scrollEl) {
        try { scrollEl.scrollTop = savedTop; scrollEl.scrollLeft = savedLeft; } catch (e) { /* ignore */ }
      }
    }
  }

  const api = {
    DEFAULT_TIMEOUT_MS,
    parseVisibleTime,
    parseAriaLabel,
    findTranscriptRoot,
    findScrollParent,
    harvestMounted,
    inferSetSize,
    assembleParsed,
    probeVisiblePane,
    collectVisibleTranscript,
    textOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSVisibleTranscript = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

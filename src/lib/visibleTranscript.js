/*
 * Stream Saver – branje prepisa iz že prikazanega zavihka Prepis (DOM).
 * Brez omrežja in brez branja src/innerHTML (avatarji lahko vsebujejo žetone).
 * Izvoz: globalThis.SSVisibleTranscript oz. module.exports.
 */
(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 90000;
  const DEFAULT_MAX_ITERS = 4000;
  const ENTRY_SEL = '[data-testid="entryRenderer"]';

  function err(msg, code, details) {
    const e = new Error(msg);
    if (code) e.code = code;
    if (details != null) e.details = details;
    return e;
  }

  function parseVisibleTime(label) {
    if (typeof label !== 'string') return null;
    const s = label.trim();
    let m = /^(\d+):([0-5]?\d):([0-5]?\d)$/.exec(s);
    if (m) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000;
    m = /^(\d+):([0-5]?\d)$/.exec(s);
    if (m) return (+m[1] * 60 + +m[2]) * 1000;
    return null;
  }

  function parseAriaLabel(label) {
    if (typeof label !== 'string') return null;
    const s = label.trim();
    // Preverjene oblike: "… N h|ura M min [S s]" (sekunde neobvezne), "… N min S s", "… N s".
    // Enote h|ura (ne "ure"/"ur"/"hour"); minute so v vseh opazovanih vzorcih z urami.
    let m = /^(.*?)\s+(\d+)\s*(?:h|ura)\s+(\d+)\s*min(?:\s+(\d+)\s*s)?\s*$/i.exec(s);
    if (m) {
      const hours = +m[2], mins = +m[3], secs = m[4] != null ? +m[4] : 0;
      if (mins > 59 || secs > 59) return null;
      return { speaker: m[1].trim(), ms: ((hours * 60 + mins) * 60 + secs) * 1000 };
    }
    m = /^(.*?)\s+(\d+)\s*min\s+(\d+)\s*s\s*$/i.exec(s);
    if (m) {
      const secs = +m[3];
      if (secs > 59) return null;
      return { speaker: m[1].trim(), ms: (+m[2] * 60 + secs) * 1000 };
    }
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
    return any ? (doc.body || doc.documentElement) : null;
  }

  /** Drsnik znotraj meje (zavihek Prepis), sicer navzgor po drevesu. Nikoli ne vrača window, če obstaja notranji. */
  function findScrollParent(el, boundary) {
    const doc = el && el.ownerDocument;
    if (!el || !doc) return null;
    let n = el;
    let fallback = null;
    while (n && n !== doc.documentElement) {
      if (boundary && n === boundary) break;
      if (n.nodeType === 1) {
        let oy = '';
        try { oy = (doc.defaultView.getComputedStyle(n).overflowY || '').toLowerCase(); } catch (e) { oy = ''; }
        const sh = n.scrollHeight || 0, ch = n.clientHeight || 0;
        if (ch > 0 && sh > ch + 1 && (oy === 'auto' || oy === 'scroll' || oy === 'overlay')) {
          if (boundary && boundary.contains && boundary.contains(n)) return n;
          if (!fallback) fallback = n;
          if (boundary && (n === boundary || (boundary.contains && boundary.contains(n)))) return n;
        }
      }
      n = n.parentElement;
    }
    if (fallback) return fallback;
    if (boundary) {
      const sh = boundary.scrollHeight || 0, ch = boundary.clientHeight || 0;
      if (ch > 0 && sh > ch + 1) return boundary;
    }
    return doc.scrollingElement || doc.documentElement;
  }

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
      const ariaRaw = wrap.getAttribute && wrap.getAttribute('aria-label');
      const aria = parseAriaLabel(ariaRaw);
      if (timeMs == null && aria) timeMs = aria.ms;
      if (!speaker && aria) speaker = aria.speaker || '';

      const prev = map.get(index);
      if (prev && prev.text === text && prev.timeMs != null && timeMs == null) {
        /* keep */
      } else {
        map.set(index, {
          index,
          text,
          speaker: speaker || (prev && prev.speaker) || '',
          timeMs: timeMs != null ? timeMs : (prev ? prev.timeMs : null),
          setSize: setSize != null ? setSize : (prev ? prev.setSize : null),
          ariaLabel: (typeof ariaRaw === 'string' && ariaRaw.trim()) ? ariaRaw.trim()
            : (prev && prev.ariaLabel) || null
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
        const ordinal = i + 1; // 1-based za uporabnika
        const raw = (e.ariaLabel && String(e.ariaLabel).trim()) || '';
        // aria-label vsebuje govorca + čas (ne besedila predavanja) – varno za napako
        if (raw && !parseAriaLabel(raw)) {
          throw err(
            'Nepodprta oblika časa pri vrstici ' + ordinal
              + ' (aria-label: «' + raw + '»). Časa ne izmišljamo.',
            'TIME_UNKNOWN',
            { index: i, ordinal: ordinal, ariaLabel: raw }
          );
        }
        throw err(
          'Manjka čas za vrstico ' + ordinal + ' – časa ne izmišljamo.'
            + (raw ? ' (aria-label: «' + raw + '»)' : ''),
          'TIME',
          { index: i, ordinal: ordinal, ariaLabel: raw || null }
        );
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

  /** Počakaj na spremembo DOM (novi vnosi) ali potek časa. Brez behavior:smooth. */
  function waitForDomChange(root, pred, opts) {
    opts = opts || {};
    const ms = opts.waitMs != null ? opts.waitMs : 400;
    const signal = opts.signal;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(err('Prekinjeno.', 'ABORT'));
      if (pred()) return resolve(true);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { obs.disconnect(); } catch (e) { /* */ }
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAb);
        resolve(v);
      };
      const onAb = () => { finish(false); reject(err('Prekinjeno.', 'ABORT')); };
      const obs = new (root.ownerDocument.defaultView.MutationObserver)(() => {
        if (pred()) finish(true);
      });
      try {
        obs.observe(root, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        /* fallback na čas */
      }
      const t = setTimeout(() => finish(pred()), ms);
      if (signal) signal.addEventListener('abort', onAb, { once: true });
    });
  }

  function setScrollTop(el, top) {
    // Samo takojšnji pomik – brez smooth (sicer zanka bere med animacijo in niha).
    const v = Math.max(0, top);
    if (typeof el.scrollTo === 'function') {
      try { el.scrollTo({ top: v, left: el.scrollLeft || 0, behavior: 'instant' }); } catch (e) {
        try { el.scrollTo(el.scrollLeft || 0, v); } catch (e2) { el.scrollTop = v; }
      }
    } else {
      el.scrollTop = v;
    }
    // nekateri brskalniki ignorirajo 'instant' – vedno še neposredno
    el.scrollTop = v;
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

  function firstMissing(map, total) {
    for (let i = 0; i < total; i++) if (!map.has(i)) return i;
    return total;
  }

  function listMissing(map, total) {
    const missing = [];
    for (let i = 0; i < total; i++) if (!map.has(i)) missing.push(i);
    return missing;
  }

  function groupContiguous(indices) {
    const segs = [];
    for (const idx of indices) {
      if (!segs.length || idx !== segs[segs.length - 1].end + 1) segs.push({ start: idx, end: idx });
      else segs[segs.length - 1].end = idx;
    }
    return segs;
  }

  /** Stabilen podpis trenutno nameščenih vrstic (ne kumulativnega zemljevida). */
  function mountedSignature(root) {
    if (!root || !root.querySelectorAll) return '';
    const parts = [];
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
      const text = sub ? textOf(sub) : '';
      const aria = (wrap.getAttribute && wrap.getAttribute('aria-label')) || '';
      const set = sub && sub.getAttribute ? (sub.getAttribute('aria-setsize') || '') : '';
      parts.push(index + '\x1f' + text + '\x1f' + aria + '\x1f' + set);
    }
    return parts.join('\x1e');
  }

  /**
   * Počakaj, da se nameščeno okno umiri: dve zaporedni enaki podpisni sliki.
   * Ne konča ob prvem povečanju kumulativnega map.size.
   */
  async function waitSettled(root, opts) {
    opts = opts || {};
    const waitMs = opts.waitMs != null ? opts.waitMs : 180;
    const signal = opts.signal;
    const need = opts.stableCount != null ? opts.stableCount : 2;
    const maxRounds = opts.maxRounds != null ? opts.maxRounds : 3;
    let prev = mountedSignature(root);
    let equal = 1;
    for (let round = 0; round < maxRounds && equal < need; round++) {
      await sleep(Math.max(1, waitMs), signal);
      const next = mountedSignature(root);
      if (next === prev) equal++;
      else { prev = next; equal = 1; }
    }
    return prev;
  }

  function findMountedEntry(root, index) {
    if (!root || !root.querySelector) return null;
    return root.querySelector('#entry-' + index)
      || root.querySelector('[id="entry-' + index + '"]');
  }

  /**
   * Ciljano popravilo lukenj po monotonem prehodu do dna.
   * Samo manjkajoči segmenti; scrollIntoView na predhodni nameščeni sidro.
   * Ne zažene celotnega prehoda z vrha znova. Ne izmišlja vrstic.
   */
  async function repairMissingHoles(root, scrollEl, map, total, opts) {
    opts = opts || {};
    const waitMs = opts.waitMs != null ? opts.waitMs : 180;
    const signal = opts.signal;
    const onProgress = opts.onProgress;
    const maxSegs = opts.maxSegs != null ? opts.maxSegs : 12;
    const maxSegLen = opts.maxSegLen != null ? opts.maxSegLen : 40;
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 5;

    let missing = listMissing(map, total);
    if (!missing.length) return;
    const segs = groupContiguous(missing).slice(0, maxSegs);

    for (const seg of segs) {
      const segLen = seg.end - seg.start + 1;
      if (segLen > maxSegLen) continue;
      if (onProgress) {
        onProgress({
          done: map.size, total,
          message: 'Dopolnjujem manjkajoče vrstice ' + seg.start + '–' + seg.end + ' …'
        });
      }
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal && signal.aborted) throw err('Prekinjeno.', 'ABORT');
        let allHave = true;
        for (let i = seg.start; i <= seg.end; i++) if (!map.has(i)) { allHave = false; break; }
        if (allHave) break;

        let anchorEl = null;
        let anchorIdx = -1;
        for (let a = seg.start - 1; a >= Math.max(0, seg.start - 40); a--) {
          anchorEl = findMountedEntry(root, a);
          if (anchorEl) { anchorIdx = a; break; }
        }
        if (!anchorEl) {
          for (let a = seg.end + 1; a <= Math.min(total - 1, seg.end + 40); a++) {
            anchorEl = findMountedEntry(root, a);
            if (anchorEl) { anchorIdx = a; break; }
          }
        }

        if (anchorEl && typeof anchorEl.scrollIntoView === 'function') {
          const block = attempt === 0 ? 'start' : (attempt === 1 ? 'center' : 'nearest');
          try { anchorEl.scrollIntoView({ block: block, behavior: 'instant' }); } catch (e1) {
            try { anchorEl.scrollIntoView(true); } catch (e2) { /* */ }
          }
          if (scrollEl && attempt >= 1) {
            const nudge = Math.max(16, Math.floor((scrollEl.clientHeight || 200) * 0.12));
            const dir = anchorIdx >= 0 && anchorIdx < seg.start ? 1 : -1;
            setScrollTop(scrollEl, Math.max(0, (scrollEl.scrollTop || 0) + dir * nudge * attempt));
          }
        } else if (scrollEl) {
          // Grobo sidro: nekaj korakov nazaj od dna / naprej – preverimo nameščeno okno.
          const maxScroll = Math.max(0, (scrollEl.scrollHeight || 0) - (scrollEl.clientHeight || 0));
          const step = Math.max(40, Math.floor((scrollEl.clientHeight || 200) * 0.55));
          setScrollTop(scrollEl, Math.max(0, maxScroll - step * (attempt + 1)));
        }

        await waitSettled(root, { waitMs, signal, stableCount: 2, maxRounds: 3 });
        harvestMounted(root, map);
      }
    }
  }

  /**
   * Monoton predhodni algoritem (za regresijski test): skok na frac*maxScroll
   * lahko niha gor/dol. Izvozeno samo za teste.
   */
  function planScrollLegacy(prevTop, missing0, total, maxScroll, clientHeight) {
    const step = Math.max(48, Math.floor((clientHeight || 200) * 0.7));
    const target = missing0 != null ? missing0 : total - 1;
    const frac = total > 1 ? target / (total - 1) : 0;
    const jump = Math.floor(frac * maxScroll);
    if (missing0 != null && Math.abs(prevTop - jump) > step) return { top: jump, mode: 'jump' };
    return { top: Math.min(maxScroll, prevTop + step), mode: 'step' };
  }

  /** Novi načrt: samo naprej (ali ostanek na dnu). Nikoli nazaj. Ob koncu manjši korak. */
  function planScrollMonotonic(prevTop, maxScroll, clientHeight, nearEnd) {
    const frac = nearEnd ? 0.30 : 0.55;
    const step = Math.max(40, Math.floor((clientHeight || 200) * frac));
    if (prevTop >= maxScroll - 1) return { top: maxScroll, mode: 'bottom' };
    return { top: Math.min(maxScroll, prevTop + step), mode: 'step' };
  }

  /**
   * Zbira vse vrstice z monotonim drsenjem navzdol + MutationObserver.
   * opts.onProgress({done,total,message}), opts.scrollTrace (array) za teste.
   */
  async function collectVisibleTranscript(doc, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxIters = opts.maxIters != null ? opts.maxIters : DEFAULT_MAX_ITERS;
    const waitMs = opts.waitMs != null ? opts.waitMs : 180;
    const signal = opts.signal;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const scrollTrace = opts.scrollTrace || null;
    const root = opts.root || findTranscriptRoot(doc);
    if (!root) throw err('Zavihek Prepis ni odprt ali ni viden. Odpri Prepis v predvajalniku in poskusi znova.', 'NO_PANE');

    const first = root.querySelector(ENTRY_SEL);
    if (!first) throw err('V zavihku Prepis ni vrstic. Počakaj, da se naložijo, ali osveži stran.', 'NO_ROWS');

    const scrollEl = opts.scrollEl || findScrollParent(first, root) || findScrollParent(first) || findScrollParent(root);
    const savedTop = scrollEl ? scrollEl.scrollTop : 0;
    const savedLeft = scrollEl ? scrollEl.scrollLeft : 0;
    const map = new Map();
    const t0 = Date.now();

    const report = (msg) => {
      if (onProgress) {
        let total = null;
        try { total = inferSetSize(map); } catch (e) { /* */ }
        onProgress({ done: map.size, total: total, message: msg });
      }
    };

    try {
      harvestMounted(root, map);
      let total = null;
      try { total = inferSetSize(map); } catch (e) { if (e.code === 'SETSIZE') throw e; }

      if (scrollEl) {
        setScrollTop(scrollEl, 0);
        if (scrollTrace) scrollTrace.push(0);
        await waitSettled(root, { waitMs: Math.min(waitMs, 120), signal, stableCount: 2, maxRounds: 3 });
        harvestMounted(root, map);
        try { total = inferSetSize(map) || total; } catch (e) { if (e.code === 'SETSIZE') throw e; }
      }

      if (total == null || total <= 0) {
        throw err('Števila vrstic prepisa ni bilo mogoče določiti. Preveri, da je zavihek Prepis odprt.', 'SETSIZE');
      }
      report('Berem viden prepis: ' + map.size + '/' + total + ' …');

      let stagnant = 0;
      let lastSize = map.size;
      let iters = 0;
      let passesAtBottom = 0;

      while (map.size < total) {
        if (signal && signal.aborted) throw err('Prekinjeno.', 'ABORT');
        if (Date.now() - t0 >= timeoutMs) {
          throw err(
            'Časovna omejitev pri branju vidnega prepisa (' + map.size + '/' + total + '). '
              + 'Poskusi znova z odprtim zavihkom Prepis.',
            'TIMEOUT'
          );
        }
        if (++iters > maxIters) {
          throw err('Preveč korakov pri branju vidnega prepisa (' + map.size + '/' + total + ').', 'ITERS');
        }
        if (!scrollEl) break;

        const maxScroll = Math.max(0, (scrollEl.scrollHeight || 0) - (scrollEl.clientHeight || 0));
        const prevTop = scrollEl.scrollTop || 0;
        const need = firstMissing(map, total);
        const nearEnd = (need >= Math.max(0, total - 40))
          || (maxScroll > 0 && prevTop >= maxScroll * 0.82);
        const plan = planScrollMonotonic(prevTop, maxScroll, scrollEl.clientHeight || 200, nearEnd);
        setScrollTop(scrollEl, plan.top);
        if (scrollTrace) scrollTrace.push(plan.top);

        // Umiri nameščeno okno (2 enaka podpisa), nato šele poženi v map.
        await waitSettled(root, { waitMs, signal, stableCount: 2, maxRounds: 3 });
        harvestMounted(root, map);
        report('Berem viden prepis: ' + map.size + '/' + total + ' …');

        if (map.size === lastSize) {
          stagnant++;
          if (plan.mode === 'bottom' || (scrollEl.scrollTop || 0) >= maxScroll - 1) {
            passesAtBottom++;
            await waitSettled(root, { waitMs, signal, stableCount: 2, maxRounds: 2 });
            harvestMounted(root, map);
            if (map.size > lastSize) { stagnant = 0; lastSize = map.size; passesAtBottom = 0; continue; }
            // Po nekaj umiritvah na dnu → ciljano popravilo lukenj (ne nov prehod z vrha).
            if (passesAtBottom >= 3) break;
          } else if (stagnant >= 40) {
            break;
          }
        } else {
          stagnant = 0;
          passesAtBottom = 0;
          lastSize = map.size;
        }

        // varovalo med monotonim prehodom: scrollTop se ne sme zmanjšati
        if ((scrollEl.scrollTop || 0) + 0.5 < prevTop && prevTop > 0) {
          setScrollTop(scrollEl, Math.max(prevTop, plan.top));
        }
      }

      if (map.size < total && scrollEl) {
        await repairMissingHoles(root, scrollEl, map, total, {
          waitMs, signal,
          onProgress: onProgress ? (p) => onProgress(p) : null
        });
      }

      report('Preverjam vseh ' + total + ' vrstic …');
      return assembleParsed(map, total);
    } finally {
      if (scrollEl) {
        try {
          setScrollTop(scrollEl, savedTop);
          scrollEl.scrollLeft = savedLeft;
        } catch (e) { /* ignore */ }
      }
    }
  }

  const api = {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_ITERS,
    parseVisibleTime,
    parseAriaLabel,
    findTranscriptRoot,
    findScrollParent,
    harvestMounted,
    inferSetSize,
    assembleParsed,
    probeVisiblePane,
    collectVisibleTranscript,
    planScrollLegacy,
    planScrollMonotonic,
    firstMissing,
    listMissing,
    groupContiguous,
    mountedSignature,
    waitSettled,
    repairMissingHoles,
    setScrollTop,
    textOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SSVisibleTranscript = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

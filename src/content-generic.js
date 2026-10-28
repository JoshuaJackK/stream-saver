/*
 * Stream Saver – splošno zaznavanje: skripta za vse strani (vstavi se dinamično, šele ko uporabnik
 * vklopi dovoljenje »vse strani«).
 *  - v vseh okvirjih: posrednik za prenos (ss-gfetch) – zahteva gre z izvorom, piškotki in Referer strani;
 *  - samo v glavnem okvirju: majhen plavajoč gumb, ki se pojavi šele po zaznavi toka.
 */
(() => {
  'use strict';
  if (window.__ssGenericLoaded) return;
  window.__ssGenericLoaded = true;

  const pageFetch = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch.bind(window);
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'ss-gfetch') {
      return (async () => {
        try {
          const r = await pageFetch(msg.url, { credentials: 'include', headers: msg.headers || {}, cache: 'no-store' });
          const ok = r.status >= 200 && r.status < 300;
          return { status: r.status, retryAfter: r.headers.get('Retry-After'), contentRange: r.headers.get('Content-Range'), buffer: ok ? await r.arrayBuffer() : null };
        } catch (e) {
          return { status: 0, retryAfter: null, buffer: null, error: String(e && e.message || e) };
        }
      })();
    }
    if (msg.type === 'ss-gupdate' && isTop) { setState(msg.state); return Promise.resolve(true); }
    return undefined;
  });

  const isTop = window === window.top;
  if (!isTop) return;
  // Strani, kjer že deluje posebna podpora za Stream/SharePoint/Teams, ne dobijo drugega gumba.
  if (/(^|\.)(sharepoint\.com|cloud\.microsoft|teams\.microsoft\.com|svc\.ms)(\.mcas\.ms)?$/i.test(location.hostname)) return;

  let state = null, host = null, shadow = null, els = null, open = false, dismissed = false;
  let chosen = null, drag = null, pos = null;

  const fmtDur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h} h ${m} min` : (m ? `${m} min ${x} s` : `${x} s`); };
  const fmtSize = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB');

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => { if (k === 'text') e.textContent = props[k]; else if (k === 'class') e.className = props[k]; else e.setAttribute(k, props[k]); });
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; z-index: 2147483647; font: 13px/1.35 system-ui, "Segoe UI", sans-serif; color: #1b1b1b; }
    .pill { display: flex; align-items: center; gap: 6px; background: #0b57d0; color: #fff; border: 0; border-radius: 16px; padding: 5px 10px; cursor: pointer; box-shadow: 0 1px 6px rgba(0,0,0,.35); font: inherit; opacity: .9; user-select: none; touch-action: none; }
    .pill:hover { opacity: 1; }
    .panel { margin-top: 6px; width: 300px; max-height: 70vh; overflow: auto; background: #fff; border: 1px solid #aaa; border-radius: 8px; padding: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
    .panel[hidden] { display: none; }
    .item { display: block; padding: 4px 0; border-bottom: 1px solid #eee; cursor: pointer; }
    .item b { margin-right: 4px; } .muted { opacity: .7; font-size: 12px; } .warn { color: #a15c00; font-size: 12px; } .err { color: #b3261e; font-size: 12px; }
    input[type=text], select { width: 100%; box-sizing: border-box; margin: 3px 0 6px; padding: 4px; font: inherit; }
    button.act { font: inherit; padding: 6px 10px; margin: 4px 4px 0 0; border-radius: 4px; border: 1px solid #888; background: #f2f2f2; cursor: pointer; }
    button.go { background: #0b57d0; border-color: #0b57d0; color: #fff; font-weight: 600; width: 100%; margin: 6px 0 0; }
    .bar { height: 8px; background: #ddd; border-radius: 4px; overflow: hidden; margin: 8px 0 4px; } .bar > div { height: 100%; width: 0; background: #0b57d0; }
    @media (prefers-color-scheme: dark) { .panel { background: #23222b; color: #f0f0f4; border-color: #555; } input[type=text], select { background: #2b2a33; color: inherit; } .item { border-color: #3a3a44; } button.act { background: #2f2e38; color: inherit; } }
  `;

  function ensureUi() {
    if (host || dismissed) return;
    host = document.createElement('div');
    host.id = 'stream-saver-generic';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = el('style', { text: CSS });
    const pill = el('div', { class: 'pill', role: 'button', tabindex: '0', title: 'Stream Saver – zaznan video tok. Povleci za premik.' });
    const pillText = el('span', { text: '▼ Stream Saver' });
    pill.appendChild(pillText);
    const panel = el('div', { class: 'panel' });
    panel.hidden = true;
    const wrap = el('div', { class: 'wrap' }, [pill, panel]);
    shadow.appendChild(style); shadow.appendChild(wrap);
    els = { wrap, pill, pillText, panel };
    (document.body || document.documentElement).appendChild(host);
    applyPos();
    pill.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, moved: false, ox: wrap.offsetLeft, oy: wrap.offsetTop }; pill.setPointerCapture(ev.pointerId); });
    pill.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      pos = { x: Math.max(0, Math.min(window.innerWidth - 60, drag.ox + dx)), y: Math.max(0, Math.min(window.innerHeight - 30, drag.oy + dy)) };
      applyPos();
    });
    pill.addEventListener('pointerup', () => {
      if (drag && drag.moved) { browser.storage.local.set({ gPos: { fx: pos.x / window.innerWidth, fy: pos.y / window.innerHeight } }).catch(() => {}); }
      else { open = !open; render(); }
      drag = null;
    });
    pill.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { open = !open; render(); } });
  }
  function applyPos() {
    if (!els) return;
    const w = els.wrap;
    if (pos) { w.style.left = pos.x + 'px'; w.style.top = pos.y + 'px'; w.style.bottom = 'auto'; }
    else { w.style.left = '12px'; w.style.bottom = '12px'; w.style.top = 'auto'; }
  }

  function setState(s) {
    state = s;
    if (dismissed) return;
    const has = state && state.enabled && ((state.streams && state.streams.length) || (state.job && state.job.status));
    if (!has) { if (host) host.style.display = 'none'; return; }
    ensureUi();
    if (host) host.style.display = '';
    render();
  }

  function streamLine(st) {
    const bits = [];
    if (st.quality) bits.push(st.quality);
    if (st.durationSec) bits.push(fmtDur(st.durationSec));
    if (st.size) bits.push(fmtSize(st.size));
    if (st.host) bits.push(st.host);
    return bits.join(' · ');
  }

  let draft = { filename: '', subfolder: null, variant: 0, mode: 'av', saveAs: false, concurrency: 4 };
  function render() {
    if (!els || !state) return;
    const { panel, pillText } = els;
    const job = state.job;
    const n = state.streams.length;
    pillText.textContent = job && job.status === 'running' ? `▼ ${job.total ? Math.floor(job.done / job.total * 100) : 0} %` : `▼ Stream Saver${n ? ' (' + n + ')' : ''}`;
    panel.hidden = !open;
    if (!open) return;
    // ne prerisuj med tipkanjem
    if (shadow.activeElement && shadow.activeElement.tagName === 'INPUT' && !(job && job.status)) return;
    panel.textContent = '';
    if (job && job.status) {
      panel.appendChild(el('div', { text: job.status === 'running' ? 'Prenašam: ' + (job.filename || '') : (job.status === 'done' ? 'Prenos končan: ' + job.filename : (job.status === 'cancelled' ? 'Prenos preklican.' : 'Napaka')) }));
      if (job.status === 'running') {
        const fill = el('div'); fill.style.width = (job.total ? job.done / job.total * 100 : 0).toFixed(1) + '%';
        panel.appendChild(el('div', { class: 'bar' }, [fill]));
        panel.appendChild(el('div', { class: 'muted', text: `${job.done}/${job.total} · ${fmtSize(job.bytes || 0)} · ${job.message || ''}` }));
        const c = el('button', { class: 'act', text: 'Prekliči' });
        c.addEventListener('click', () => browser.runtime.sendMessage({ type: 'ss-g-cancel' }));
        panel.appendChild(c);
      } else {
        if (job.error) panel.appendChild(el('div', { class: 'err', text: job.error }));
        else panel.appendChild(el('div', { class: 'muted', text: 'Datoteko najdeš med prenosi (Ctrl+Shift+Y).' }));
        (job.notes || []).forEach((t) => panel.appendChild(el('div', { class: 'warn', text: t })));
        if (job.warning) panel.appendChild(el('div', { class: 'warn', text: job.warning }));
        const c = el('button', { class: 'act', text: 'Nov prenos' });
        c.addEventListener('click', () => browser.runtime.sendMessage({ type: 'ss-g-reset' }));
        panel.appendChild(c);
      }
      panel.appendChild(dismissButton());
      return;
    }
    if (!chosen || !state.streams.some((x) => x.id === chosen)) chosen = state.mainId;
    state.streams.forEach((st) => {
      const lab = el('label', { class: 'item' });
      const rb = el('input', { type: 'radio', name: 'ssg' });
      rb.checked = st.id === chosen;
      rb.addEventListener('change', () => { chosen = st.id; draft.variant = 0; render(); });
      lab.appendChild(rb);
      lab.appendChild(el('b', { text: st.kindLabel }));
      lab.appendChild(document.createTextNode(streamLine(st)));
      const fl = (st.flags || []);
      if (fl.length) lab.appendChild(el('div', { class: 'warn', text: fl.join(' · ') }));
      if (st.drm) lab.appendChild(el('div', { class: 'err', text: 'Posnetek je zaščiten z DRM – prenos ni mogoč.' }));
      else if (st.live) lab.appendChild(el('div', { class: 'err', text: 'Živi prenos – ni podprt.' }));
      panel.appendChild(lab);
    });
    const cur = state.streams.find((x) => x.id === chosen);
    if (!cur) { panel.appendChild(dismissButton()); return; }
    const fn = el('input', { type: 'text', spellcheck: 'false' });
    fn.value = draft.filename || state.defaultName || 'posnetek';
    fn.addEventListener('input', () => { draft.filename = fn.value; });
    panel.appendChild(el('div', { class: 'muted', text: 'Ime datoteke' })); panel.appendChild(fn);
    let q = null;
    if (cur.variants && cur.variants.length > 1) {
      q = el('select');
      cur.variants.forEach((v) => { const o = el('option', { value: String(v.index), text: (v.index === 0 ? 'Najboljša: ' : '') + v.label }); q.appendChild(o); });
      q.value = String(draft.variant);
      q.addEventListener('change', () => { draft.variant = Number(q.value); });
      panel.appendChild(el('div', { class: 'muted', text: 'Kakovost' })); panel.appendChild(q);
    }
    const go = el('button', { class: 'act go', text: 'Prenesi' });
    go.disabled = !!(cur.drm || cur.live);
    go.addEventListener('click', async () => {
      const st = await browser.storage.local.get(['subfolder', 'concurrency', 'saveAs']).catch(() => ({}));
      browser.runtime.sendMessage({ type: 'ss-g-start', options: {
        streamId: cur.id, filename: fn.value, subfolder: st.subfolder || '', mode: 'av', variantIndex: q ? Number(q.value) : 0,
        concurrency: st.concurrency || 4, saveAs: !!st.saveAs
      } });
    });
    panel.appendChild(go);
    panel.appendChild(el('div', { class: 'muted', text: 'Podmapa, »Shrani kot« in drugo: v oknu razširitve.' }));
    panel.appendChild(dismissButton());
  }
  function dismissButton() {
    const b = el('button', { class: 'act', text: 'Skrij na tej strani' });
    b.title = 'Gumb se na tem spletnem mestu ne bo več prikazal (vklopiš ga lahko v oknu razširitve).';
    b.addEventListener('click', async () => {
      const st = await browser.storage.local.get('gDismissed').catch(() => ({}));
      const d = st.gDismissed || {};
      d[location.hostname] = true;
      await browser.storage.local.set({ gDismissed: d }).catch(() => {});
      dismissed = true;
      if (host) { host.remove(); host = null; els = null; }
    });
    return b;
  }

  (async () => {
    try {
      const st = await browser.storage.local.get(['gDismissed', 'gPos']);
      if (st.gDismissed && st.gDismissed[location.hostname]) { dismissed = true; return; }
      if (st.gPos && typeof st.gPos.fx === 'number') pos = { x: st.gPos.fx * window.innerWidth, y: st.gPos.fy * window.innerHeight };
      const s = await browser.runtime.sendMessage({ type: 'ss-g-state' });
      if (s) setState(s);
    } catch (e) { /* ozadje še ni pripravljeno */ }
  })();
})();

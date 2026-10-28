/*
 * Stream Saver – vsebinski skript (vsi okvirji na SharePoint/OneDrive in Teams).
 * 1) Iz predvajalnika prebere ime datoteke, trajanje in AES-128 ključ.
 * 2) Na zahtevo ozadja prenese segment v kontekstu okvirja.
 * 3) Prikaže plavajoči gumb »Prenesi posnetek«, ko je posnetek zaznan.
 */
'use strict';
(function () {
  if (window.__streamSaverLoaded) return;
  window.__streamSaverLoaded = true;

  const page = window.wrappedJSObject || window;
  let lastSent = '';
  let uiState = null;
  let localDetected = false;
  let panelOpen = false;
  let trSaving = false;
  let host = null;
  let els = {};

  function toBytes(v) {
    try {
      if (!v) return null;
      if (typeof v === 'string') {
        const s = v.trim();
        if (/^[0-9a-f]{32}$/i.test(s)) return s.match(/../g).map((h) => parseInt(h, 16));
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        return Array.from(bin, (c) => c.charCodeAt(0));
      }
      if (typeof v.length === 'number') return Array.from(v);
      if (typeof v.byteLength === 'number') return Array.from(new Uint8Array(v));
    } catch (e) { /* ignore */ }
    return null;
  }

  function collect() {
    const info = { frameUrl: location.href };
    try {
      const ck = page.g_streamBootstrapContent && page.g_streamBootstrapContent.dashConfig && page.g_streamBootstrapContent.dashConfig.cdnDecryptionKey;
      if (ck && ck.valid !== false) {
        const k = toBytes(ck.keyBuffer || ck.key);
        const iv = toBytes(ck.iv);
        if (k && k.length === 16) { info.key = k; info.iv = iv && iv.length === 16 ? iv : null; }
      }
    } catch (e) { /* ignore */ }
    try {
      const fi = page.g_fileInfo;
      if (fi) {
        const n = fi.displayName || fi.name || fi.title;
        if (n) info.fileName = String(n).replace(/\.(mp4|mov|m4v|webm)$/i, '');
      }
    } catch (e) { /* ignore */ }
    try {
      const v = document.querySelector('video');
      if (v && isFinite(v.duration) && v.duration > 0) info.duration = v.duration;
    } catch (e) { /* ignore */ }
    return info;
  }

  function tick() {
    const info = collect();
    if (!info.key && !info.fileName && !info.duration) return;
    const sig = JSON.stringify([info.key, info.iv, info.fileName, Math.round(info.duration || 0)]);
    if (sig === lastSent) return;
    lastSent = sig;
    browser.runtime.sendMessage(Object.assign({ type: 'ss-page' }, info)).catch(() => {});
    // Key alone can justify showing the button before webRequest catches up.
    if (info.key || info.fileName) ensureUi();
  }
  setInterval(tick, 2000);
  setTimeout(tick, 500);

  // ---------- local Resource Timing (backup to webRequest; sees worker requests) ----------
  function scanPerformance() {
    let urls = [];
    try {
      urls = performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => typeof u === 'string' && (/videomanifest/i.test(u) || /oneDrive\.transcode/i.test(u)));
    } catch (e) { /* ignore */ }
    if (!urls.length) return;
    localDetected = true;
    ensureUi();
    browser.runtime.sendMessage({ type: 'ss-local-urls', urls, frameUrl: location.href }).catch(() => {});
  }
  setInterval(scanPerformance, 2500);
  setTimeout(scanPerformance, 800);
  try {
    const obs = new PerformanceObserver(() => scanPerformance());
    obs.observe({ type: 'resource', buffered: true });
  } catch (e) { /* ignore */ }

  // ---------- which frames get the floating UI ----------
  function isPlayerFrame() {
    const u = location.href || '';
    if (/stream\.aspx|_layouts\/15\/(stream|embed|VideoPlay)|\/:v:\//i.test(u)) return true;
    if (/sharepoint\.com/i.test(u) && (document.querySelector('video') || page.g_fileInfo || page.g_streamBootstrapContent)) return true;
    // Teams shell: only show if we ourselves saw media requests (player is often in iframe).
    if (/teams\.microsoft\.com|teams\.cloud\.microsoft/i.test(u)) {
      try {
        return performance.getEntriesByType('resource').some((e) => /videomanifest|oneDrive\.transcode|\/media\/transcripts\//i.test(e.name || ''));
      } catch (e) { return false; }
    }
    return !!document.querySelector('video');
  }

  function fmtMB(b) {
    if (!b) return '0 MB';
    return b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB';
  }

  function ensureUi() {
    if (!isPlayerFrame()) return;
    if (host) return;
    host = document.createElement('div');
    host.id = 'stream-saver-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;bottom:20px;right:20px;font-family:system-ui,Segoe UI,sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
  .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: #0061e0; color: #fff; border: none; border-radius: 999px;
    padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.28); line-height: 1.2;
  }
  .btn:hover { background: #0250bb; }
  .btn.busy { background: #1565c0; }
  .btn.done { background: #2e7d32; }
  .btn.err { background: #c62828; }
  .btn .badge {
    background: rgba(255,255,255,.22); border-radius: 999px; padding: 2px 7px;
    font-size: 12px; font-weight: 700; min-width: 1.5em; text-align: center;
  }
  .panel {
    width: 320px; max-width: calc(100vw - 32px);
    background: #fff; color: #1b1b1b; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 12px 14px 14px;
    border: 1px solid rgba(0,0,0,.08);
  }
  .panel h2 { margin: 0 0 8px; font-size: 14px; }
  .panel label { display: block; font-size: 12px; font-weight: 600; margin: 8px 0 3px; }
  .panel input, .panel select {
    width: 100%; padding: 6px 8px; border: 1px solid #bbb; border-radius: 4px;
    font-size: 13px; background: #fff; color: inherit;
  }
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  .actions button {
    flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #999;
    background: #f2f2f2; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .actions .go { background: #0061e0; border-color: #0061e0; color: #fff; }
  .actions .go:disabled, .actions button:disabled { opacity: .55; cursor: default; }
  .status { font-size: 12px; margin-top: 8px; line-height: 1.35; color: #444; }
  .status.ok { color: #1b5e20; }
  .status.err { color: #b71c1c; }
  .bar { height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .bar > i { display: block; height: 100%; width: 0; background: #0061e0; }
  .tr { margin-top: 12px; padding-top: 8px; border-top: 1px solid #ddd; }
  .tr h3 { margin: 0 0 4px; font-size: 13px; }
  .tr .actions { margin-top: 0; align-items: flex-end; }
  .tr .status.warn { color: #8a5300; }
  .hint { font-size: 11px; color: #666; margin: 6px 0 0; }
  .close {
    float: right; border: none; background: transparent; font-size: 18px;
    line-height: 1; cursor: pointer; color: #666; padding: 0 2px;
  }
</style>
<div class="wrap">
  <div class="panel" id="panel" hidden>
    <button type="button" class="close" id="close" title="Zapri" aria-label="Zapri">×</button>
    <h2>Stream Saver</h2>
    <label for="ss-fn">Ime datoteke</label>
    <input id="ss-fn" type="text" spellcheck="false">
    <label for="ss-sub">Podmapa (predmet)</label>
    <input id="ss-sub" type="text" spellcheck="false" placeholder="npr. Razvojna psihologija">
    <div id="vid">
    <div class="row">
      <div>
        <label for="ss-mode">Vsebina</label>
        <select id="ss-mode">
          <option value="av">Video + zvok</option>
          <option value="audio">Samo zvok</option>
          <option value="video">Samo video</option>
        </select>
      </div>
      <div>
        <label for="ss-conc">Vzporedno</label>
        <select id="ss-conc">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="4" selected>4</option>
          <option value="6">6</option>
          <option value="8">8</option>
        </select>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="go" id="start">Prenesi</button>
      <button type="button" id="cancel" hidden>Prekliči</button>
      <button type="button" id="again" hidden>Nov prenos</button>
    </div>
    <div class="bar" id="bar" hidden><i id="fill"></i></div>
    <div class="status" id="status"></div>
    </div>
    <div class="tr">
      <h3>Prepis</h3>
      <div class="status" id="trStatus"></div>
      <div class="row">
        <div>
          <label for="ss-trfmt">Oblika prepisa</label>
          <select id="ss-trfmt">
            <option value="txt" selected>Besedilo (.txt)</option>
            <option value="vtt">Podnapisi (.vtt)</option>
          </select>
        </div>
        <div class="actions">
          <button type="button" id="trSave">Shrani prepis</button>
        </div>
      </div>
      <div class="status" id="trMsg"></div>
    </div>
    <p class="hint">Če ikona v orodni vrstici manjka (začasni dodatek), uporabi ta gumb. Datoteka je shranjena kot običajen MP4 (primerno za VLC).</p>
  </div>
  <button type="button" class="btn" id="fab" title="Stream Saver – shrani posnetek">
    <span aria-hidden="true">▼</span>
    <span id="fabLabel">Prenesi posnetek</span>
    <span class="badge" id="fabBadge" hidden></span>
  </button>
</div>`;
    (document.documentElement || document.body).appendChild(host);
    els = {
      panel: shadow.getElementById('panel'),
      fab: shadow.getElementById('fab'),
      fabLabel: shadow.getElementById('fabLabel'),
      fabBadge: shadow.getElementById('fabBadge'),
      fn: shadow.getElementById('ss-fn'),
      sub: shadow.getElementById('ss-sub'),
      mode: shadow.getElementById('ss-mode'),
      conc: shadow.getElementById('ss-conc'),
      start: shadow.getElementById('start'),
      cancel: shadow.getElementById('cancel'),
      again: shadow.getElementById('again'),
      bar: shadow.getElementById('bar'),
      fill: shadow.getElementById('fill'),
      status: shadow.getElementById('status'),
      close: shadow.getElementById('close'),
      vid: shadow.getElementById('vid'),
      trFmt: shadow.getElementById('ss-trfmt'),
      trSave: shadow.getElementById('trSave'),
      trStatus: shadow.getElementById('trStatus'),
      trMsg: shadow.getElementById('trMsg')
    };
    els.fab.addEventListener('click', () => { panelOpen = !panelOpen; els.panel.hidden = !panelOpen; if (panelOpen) syncFormFromState(); });
    els.close.addEventListener('click', () => { panelOpen = false; els.panel.hidden = true; });
    els.start.addEventListener('click', startDownload);
    els.trSave.addEventListener('click', saveTranscript);
    els.trFmt.addEventListener('change', () => { browser.storage.local.set({ trFormat: els.trFmt.value }).catch(() => {}); });
    els.cancel.addEventListener('click', () => browser.runtime.sendMessage({ type: 'ss-cancel' }).catch(() => {}));
    els.again.addEventListener('click', () => browser.runtime.sendMessage({ type: 'ss-reset' }).then(refresh).catch(() => {}));
    browser.storage.local.get(['subfolder', 'concurrency', 'mode', 'trFormat']).then((st) => {
      if (st.trFormat === 'vtt' || st.trFormat === 'txt') els.trFmt.value = st.trFormat;
      if (st.subfolder) els.sub.value = st.subfolder;
      if (st.concurrency) els.conc.value = String(st.concurrency);
      if (st.mode) els.mode.value = st.mode;
    }).catch(() => {});
    refresh();
  }

  function syncFormFromState() {
    if (!uiState) return;
    if (uiState.title && (!els.fn.value || els.fn.dataset.auto !== '0')) {
      els.fn.value = uiState.title;
      els.fn.dataset.auto = '1';
    }
  }

  function trUsable(s) {
    const t = s && s.transcript;
    return !!(t && (t.state === 'ready' || t.state === 'loading' || t.state === 'error'));
  }

  function renderTranscript(s) {
    const t = (s && s.transcript) || { state: 'none', text: '' };
    els.trStatus.textContent = t.text || '';
    els.trStatus.className = 'status' + (t.level ? ' ' + t.level : '');
    els.trSave.disabled = trSaving || !trUsable(s);
  }

  async function saveTranscript() {
    if (trSaving) return;
    const filename = (els.fn.value || '').trim() || (uiState && uiState.title) || 'posnetek';
    const subfolder = (els.sub.value || '').trim();
    const format = els.trFmt.value === 'vtt' ? 'vtt' : 'txt';
    els.fn.dataset.auto = '0';
    trSaving = true;
    els.trSave.disabled = true;
    els.trMsg.className = 'status';
    els.trMsg.textContent = 'Shranjujem prepis …';
    try {
      await browser.storage.local.set({ subfolder, trFormat: format });
    } catch (e) { /* ignore */ }
    try {
      const r = await browser.runtime.sendMessage({ type: 'ss-save-transcript', options: { filename, subfolder, format, saveAs: false } });
      if (r && r.ok) {
        els.trMsg.className = 'status ok';
        els.trMsg.textContent = `Shranjeno kot: ${r.filename} (${r.lines} vrstic). Datoteka je med prenosi v Firefoxu (Ctrl+Shift+Y).`;
      } else {
        els.trMsg.className = 'status err';
        els.trMsg.textContent = 'Napaka: ' + ((r && r.error) || 'neznana napaka');
      }
    } catch (e) {
      els.trMsg.className = 'status err';
      els.trMsg.textContent = 'Napaka: ' + (e && e.message || e);
    }
    trSaving = false;
    refresh();
  }

  function render() {
    if (!host || !els.fab) return;
    const s = uiState;
    const job = s && s.job;
    const videoDetected = !!(s && s.detected) || localDetected || !!(s && s.hasKey);
    const detected = videoDetected || trUsable(s);
    const busy = !!(job && job.status === 'running');
    host.style.display = (detected || busy) ? '' : 'none';
    if (!detected && !busy) return;
    els.vid.hidden = !(videoDetected || busy);
    renderTranscript(s);

    let label = videoDetected ? 'Prenesi posnetek' : 'Shrani prepis';
    let cls = 'btn';
    let badge = '';
    let statusText = '';
    if (s && s.detected) {
      statusText = s.encrypted
        ? (s.hasKey ? 'Posnetek zaznan (šifriran, ključ je tu).' : 'Posnetek zaznan – pusti predvajati še nekaj sekund (ključ).')
        : 'Posnetek zaznan. Klikni za prenos.';
    } else if (localDetected || (s && s.hasKey)) {
      statusText = 'Predvajalnik zaznan – če gumb Prenesi ne deluje, počakaj še trenutek na celoten posnetek.';
    }
    let statusCls = '';

    if (job && job.status === 'running') {
      const pct = job.total ? Math.floor((job.done / job.total) * 100) : 0;
      label = 'Prenašam …';
      cls = 'btn busy';
      badge = pct + '%';
      els.bar.hidden = false;
      els.fill.style.width = pct + '%';
      statusText = `${pct} % · ${job.done}/${job.total || '?'} · ${fmtMB(job.bytes)} — ${job.message || ''}`;
      els.start.hidden = true;
      els.cancel.hidden = false;
      els.again.hidden = true;
      els.start.disabled = true;
    } else if (job && job.status === 'done') {
      label = 'Prenos končan';
      cls = 'btn done';
      badge = 'OK';
      els.bar.hidden = false;
      els.fill.style.width = '100%';
      statusText = (job.warning ? job.warning + ' ' : '') + (job.message || 'Shranjeno med prenosi v Firefoxu (Ctrl+Shift+Y).');
      statusCls = job.warning ? 'err' : 'ok';
      els.start.hidden = true;
      els.cancel.hidden = true;
      els.again.hidden = false;
      els.start.disabled = false;
    } else if (job && (job.status === 'error' || job.status === 'cancelled')) {
      label = job.status === 'cancelled' ? 'Preklicano' : 'Napaka – poskusi znova';
      cls = 'btn err';
      badge = '!';
      els.bar.hidden = true;
      statusText = job.error || job.message || 'Napaka';
      statusCls = 'err';
      els.start.hidden = true;
      els.cancel.hidden = true;
      els.again.hidden = false;
    } else {
      els.bar.hidden = true;
      els.fill.style.width = '0';
      els.start.hidden = false;
      els.cancel.hidden = true;
      els.again.hidden = true;
      els.start.disabled = !videoDetected;
      if (panelOpen) syncFormFromState();
      if (s && videoDetected && s.hasAudio === false && (els.mode.value === 'av')) {
        statusText = 'Opozorilo: zvočna sled še ni zaznana. Predvajaj posnetek še nekaj sekund, nato prenesi – sicer bo datoteka samo video.';
        statusCls = 'err';
      } else if (job && job.warning) {
        statusText = (statusText ? statusText + ' ' : '') + job.warning;
        statusCls = statusCls || 'err';
      }
    }

    els.fab.className = cls;
    els.fabLabel.textContent = label;
    if (badge) { els.fabBadge.hidden = false; els.fabBadge.textContent = badge; }
    else els.fabBadge.hidden = true;
    els.status.textContent = statusText;
    els.status.className = 'status' + (statusCls ? ' ' + statusCls : '');
  }

  async function refresh() {
    try {
      uiState = await browser.runtime.sendMessage({ type: 'ss-state' });
      if (uiState && (uiState.detected || uiState.hasKey || trUsable(uiState) || (uiState.job && uiState.job.status === 'running') || localDetected)) ensureUi();
      render();
    } catch (e) { /* extension reloading */ }
  }

  async function startDownload() {
    const filename = (els.fn.value || '').trim() || (uiState && uiState.title) || 'posnetek';
    const subfolder = (els.sub.value || '').trim();
    const mode = els.mode.value;
    const concurrency = Number(els.conc.value) || 4;
    els.fn.dataset.auto = '0';
    try {
      await browser.storage.local.set({ subfolder, concurrency, mode });
    } catch (e) { /* ignore */ }
    els.start.disabled = true;
    els.status.textContent = 'Začenjam prenos …';
    await browser.runtime.sendMessage({
      type: 'ss-start',
      options: { filename, subfolder, mode, concurrency, saveAs: false }
    }).catch((e) => {
      els.status.textContent = 'Napaka: ' + (e && e.message || e);
      els.status.className = 'status err';
      els.start.disabled = false;
    });
    refresh();
  }

  // Fetch proxy
  const pageFetch = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch.bind(window);
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'ss-fetch') {
      return (async () => {
        try {
          const r = await pageFetch(msg.url, { credentials: 'include', headers: msg.headers || {}, cache: 'no-store' });
          const ok = r.status >= 200 && r.status < 300;
          return { status: r.status, retryAfter: r.headers.get('Retry-After'), buffer: ok ? await r.arrayBuffer() : null };
        } catch (e) {
          return { status: 0, retryAfter: null, buffer: null, error: String(e && e.message || e) };
        }
      })();
    }
    if (msg.type === 'ss-update') {
      uiState = msg.state;
      if (uiState && (uiState.detected || uiState.hasKey || trUsable(uiState) || (uiState.job && uiState.job.status === 'running') || localDetected)) ensureUi();
      render();
      return Promise.resolve(true);
    }
    return undefined;
  });

  // If this looks like a player page already, create the host early (hidden until detected).
  if (isPlayerFrame()) {
    // Defer until body exists
    const boot = () => { /* button appears on first detection via ensureUi */ refresh(); };
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    refresh();
  }
})();

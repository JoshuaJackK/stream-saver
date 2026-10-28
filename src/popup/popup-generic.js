/* Stream Saver – pojavno okno: splošni video tokovi (HLS / DASH / datoteke). UI v slovenščini. */
/* global SSMpd */
'use strict';
const PopupGen = (() => {
  const $ = (id) => document.getElementById(id);
  let g = null, tabId = null, sel = null, sig = '', named = false, justEnabled = false, host = '', dismissedHere = false;
  const ctx = { setStatus: null, fmtMB: null, fmtTime: null, refresh: null, showMain: null, saveSettings: null };

  const fmtDur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h} h ${m} min` : (m ? `${m} min ${x} s` : `${x} s`); };
  const q = (t) => '"' + String(t).replace(/"/g, '\\"') + '"';

  function init(o, id) { Object.assign(ctx, o); tabId = id; wire(); }
  function set(state) { g = state; host = (state && state.pageHost) || ''; }
  function jobActive() { return !!(g && g.job && g.job.status); }

  function hideAll() {
    ['genPerm', 'genList', 'genForm'].forEach((x) => { $(x).hidden = true; });
  }
  function hide() { hideAll(); }

  function curStream() { return g && g.streams.find((x) => x.id === sel); }

  async function loadDismissed() {
    try { const st = await browser.storage.local.get('gDismissed'); dismissedHere = !!(st.gDismissed && host && st.gDismissed[host]); } catch (e) { dismissedHere = false; }
    $('genShowBtn').hidden = !dismissedHere;
  }

  /** Vrne true, če je splošni del prevzel prikaz. */
  function render(trUsable) {
    if (!g) return false;
    const job = g.job;
    if (job && job.status) {
      hideAll(); ctx.showMain(false);
      $('progress').hidden = false;
      const running = job.status === 'running';
      $('cancel').hidden = !running; $('again').hidden = running;
      const pct = job.total ? job.done / job.total * 100 : 0;
      $('barFill').style.width = (job.status === 'done' ? 100 : pct).toFixed(1) + '%';
      let eta = '';
      if (running && job.started && pct > 1) eta = ' · še približno ' + ctx.fmtTime((Date.now() - job.started) / 1000 * (100 - pct) / pct);
      $('progressText').textContent = running ? `${pct.toFixed(1)} % · ${job.done}/${job.total} · ${ctx.fmtMB(job.bytes || 0)}${eta}` : (job.status === 'done' ? `Shranjeno kot: ${job.filename}` : '');
      $('progressMsg').textContent = [job.warning].concat(job.notes || []).filter(Boolean).join(' ') + ' ' + (job.message || '');
      if (running) ctx.setStatus('Prenašam: ' + job.filename, '');
      else if (job.status === 'done') ctx.setStatus('Prenos končan. Datoteko najdeš med prenosi v Firefoxu (Ctrl+Shift+Y).', 'ok');
      else if (job.status === 'cancelled') ctx.setStatus('Prenos je bil preklican.', 'warn');
      else ctx.setStatus('Napaka: ' + (job.error || 'neznana napaka') + (job.drm ? '' : ' Uporabiš lahko ukaza ffmpeg / yt-dlp spodaj.'), 'err');
      if (!running && job.status === 'error' && !job.drm) { $('genForm').hidden = false; $('genForm').classList.remove('empty'); }
      return true;
    }
    $('progress').hidden = true;
    if (trUsable) return false;
    if (!g.enabled && !justEnabled) {
      hideAll(); ctx.showMain(false);
      $('genPerm').hidden = false;
      ctx.setStatus('Na tej strani ni zaznanega posnetka Microsoft Stream. Za videe na drugih straneh vklopi splošno zaznavanje.', 'warn');
      return true;
    }
    ctx.showMain(false);
    if (!g.streams.length) {
      hideAll();
      $('genForm').hidden = false; $('genForm').classList.add('empty');
      ctx.setStatus(justEnabled ? 'Zaznavanje je vklopljeno. Osveži stran z videom (F5), ga predvajaj nekaj sekund in znova odpri to okno.' : 'Ni zaznanega toka. Predvajaj video nekaj sekund (če si zaznavanje pravkar vklopil, najprej osveži stran z F5). Videi, ki jih predvajalnik zahteva iz delavcev (Web Worker), morda niso vidni.', 'warn');
      loadDismissed();
      return true;
    }
    $('genPerm').hidden = true; $('genList').hidden = false; $('genForm').hidden = false; $('genForm').classList.remove('empty');
    $('common').hidden = false;
    if (!named) { $('filename').value = g.defaultName || 'posnetek'; named = true; }
    if (!sel || !g.streams.some((x) => x.id === sel)) sel = g.mainId;
    const s2 = JSON.stringify([g.streams.map((x) => [x.id, x.size, x.durationSec, x.quality, x.live, x.drm, x.probing, x.audioOnly, (x.variants || []).length]), sel]);
    if (s2 !== sig) { sig = s2; renderList(); }
    const cur = curStream();
    $('genStart').disabled = !cur || !!cur.drm || !!cur.live;
    const drm = g.streams.some((x) => x.drm);
    ctx.setStatus(`Zaznanih tokov: ${g.streams.length}. Izberi tok, preveri ime datoteke in klikni »Prenesi«.` + (drm ? ' Posnetki z DRM niso prenosljivi.' : ''), 'ok');
    loadDismissed();
    return true;
  }

  function renderList() {
    const box = $('genStreams');
    box.textContent = '';
    g.streams.forEach((st) => {
      const lab = document.createElement('label'); lab.className = 'stream';
      const rb = document.createElement('input'); rb.type = 'radio'; rb.name = 'gs'; rb.checked = st.id === sel;
      rb.addEventListener('change', () => { sel = st.id; sig = ''; render(false); });
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = st.kindLabel;
      const bits = [];
      if (st.quality) bits.push(st.quality);
      if (st.durationSec) bits.push(fmtDur(st.durationSec));
      if (st.size) bits.push(ctx.fmtMB(st.size));
      if (st.probing) bits.push('berem …');
      bits.push(st.host);
      lab.appendChild(rb); lab.appendChild(tag); lab.appendChild(document.createTextNode(' ' + bits.join(' · ')));
      (st.flags || []).forEach((f) => { const d = document.createElement('span'); d.className = 'fl'; d.textContent = f; lab.appendChild(d); });
      if (st.drm) { const d = document.createElement('span'); d.className = 'fl bad'; d.textContent = 'Posnetek je zaščiten z DRM – prenos ni mogoč.'; lab.appendChild(d); }
      else if (st.live) { const d = document.createElement('span'); d.className = 'fl bad'; d.textContent = 'Živi prenos – ni podprt.'; lab.appendChild(d); }
      if (st.note) { const d = document.createElement('span'); d.className = 'fl'; d.textContent = 'Opomba: ' + st.note; lab.appendChild(d); }
      lab.title = st.hint || '';
      box.appendChild(lab);
    });
    const cur = curStream();
    const row = $('genQualityRow'), sq = $('genQuality');
    const prevQ = sq.value;
    sq.textContent = '';
    if (cur && cur.variants && cur.variants.length > 1) {
      cur.variants.forEach((v) => { const o = document.createElement('option'); o.value = String(v.index); o.textContent = (v.index === 0 ? 'Najboljša: ' : '') + v.label; sq.appendChild(o); });
      if (prevQ && Array.from(sq.options).some((o) => o.value === prevQ)) sq.value = prevQ;
      row.hidden = false;
    } else row.hidden = true;
  }

  async function copyCmd(kind) {
    const cur = curStream();
    if (!cur) return;
    const base = SSMpd.sanitizeFilename($('filename').value || g.defaultName);
    const text = kind === 'ytdlp' ? SSMpd.ytDlpCommand(g.pageUrl, base, true) : `ffmpeg -i ${q(cur.url)} -c copy ${q(base + '.mp4')}`;
    $('genCmd').hidden = false; $('genCmd').value = text;
    try { await navigator.clipboard.writeText(text); $('note').textContent = 'Ukaz kopiran v odložišče (vsebuje naslov z morebitnimi začasnimi žetoni – ne deli ga).'; }
    catch (e) { $('genCmd').select(); $('note').textContent = 'Kopiranje ni uspelo – označi besedilo in pritisni Ctrl+C.'; }
  }

  function wire() {
    $('genEnable').addEventListener('click', () => {
      // permissions.request mora biti poklican neposredno iz klika
      browser.permissions.request({ origins: ['<all_urls>'] }).then((ok) => {
        if (ok) { justEnabled = true; $('note').textContent = 'Dovoljenje odobreno. Osveži stran z videom (F5).'; }
        else $('note').textContent = 'Dovoljenje ni bilo odobreno – splošno zaznavanje ostaja izklopljeno.';
        ctx.refresh();
      }).catch((e) => { $('note').textContent = 'Prošnja za dovoljenje ni uspela: ' + e.message; });
    });
    $('genDisable').addEventListener('click', async () => {
      try { await browser.permissions.remove({ origins: ['<all_urls>'] }); } catch (e) { /* ignore */ }
      justEnabled = false; g = Object.assign({}, g, { enabled: false, streams: [] });
      $('note').textContent = 'Splošno zaznavanje je izklopljeno.';
      setTimeout(ctx.refresh, 300);
    });
    $('genShowBtn').addEventListener('click', async () => {
      const st = await browser.storage.local.get('gDismissed');
      const d = st.gDismissed || {}; delete d[host];
      await browser.storage.local.set({ gDismissed: d });
      $('genShowBtn').hidden = true;
      $('note').textContent = 'Plavajoči gumb bo spet viden po osvežitvi strani.';
    });
    $('genStart').addEventListener('click', async () => {
      const cur = curStream();
      if (!cur) return;
      await ctx.saveSettings();
      await browser.storage.local.set({ gmode: $('genMode').value, concurrency: Number($('genConc').value) });
      $('genStart').disabled = true;
      await browser.runtime.sendMessage({ type: 'ss-g-start', tabId, options: {
        streamId: cur.id, filename: SSMpd.sanitizeFilename($('filename').value), subfolder: $('subfolder').value,
        mode: $('genMode').value, variantIndex: cur.variants && cur.variants.length > 1 ? Number($('genQuality').value) : 0,
        concurrency: Number($('genConc').value), saveAs: $('saveAs').checked
      } });
      ctx.refresh();
    });
    $('genCopyFfmpeg').addEventListener('click', () => copyCmd('ffmpeg'));
    $('genCopyYtdlp').addEventListener('click', () => copyCmd('ytdlp'));
    browser.storage.local.get(['gmode', 'concurrency']).then((st) => {
      if (st.gmode === 'audio' || st.gmode === 'av') $('genMode').value = st.gmode;
      if (st.concurrency) $('genConc').value = String(st.concurrency);
    }).catch(() => {});
  }

  return { init, set, render, hide, jobActive };
})();

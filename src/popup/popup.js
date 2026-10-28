/* Stream Saver – pojavno okno (UI v slovenščini). */
/* global SSMpd */
'use strict';
const $ = (id) => document.getElementById(id);
let tabId = null, state = null, filled = false, trSaving = false;

function fmtMB(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB'; }
function fmtTime(s) { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ' h ' : '') + m + ' min ' + (h ? '' : x + ' s'); }

function setStatus(text, cls) { const el = $('status'); el.textContent = text; el.className = 'status ' + (cls || ''); }

async function loadSettings() {
  const st = await browser.storage.local.get(['subfolder', 'concurrency', 'saveAs', 'mode', 'trFormat']);
  if (st.subfolder) $('subfolder').value = st.subfolder;
  if (st.concurrency) $('concurrency').value = String(st.concurrency);
  if (st.mode) $('mode').value = st.mode;
  if (st.trFormat === 'vtt' || st.trFormat === 'txt') $('trFormat').value = st.trFormat;
  $('saveAs').checked = !!st.saveAs;
}
function saveSettings() {
  return browser.storage.local.set({ subfolder: $('subfolder').value.trim(), concurrency: Number($('concurrency').value), saveAs: $('saveAs').checked, mode: $('mode').value, trFormat: $('trFormat').value });
}

function showMain(on) {
  $('common').hidden = !on; $('form').hidden = !on; $('transcript').hidden = !on;
}
function renderTranscript(tr, usable) {
  const st = $('trStatus');
  st.textContent = tr.text || '';
  st.className = 'status small ' + (tr.level || '');
  $('trFormat').disabled = trSaving;
  $('trSave').disabled = trSaving || !usable;
}

function render() {
  const s = state;
  if (!s) return;
  const job = s.job;
  const tr = s.transcript || { state: 'none', level: 'warn', text: '' };
  const trUsable = tr.state === 'ready' || tr.state === 'loading' || tr.state === 'error';
  $('fallback').hidden = !s.detected;
  if ((s.detected || trUsable) && !filled) { $('filename').value = s.title || 'posnetek'; filled = true; }
  renderTranscript(tr, trUsable);
  if (job && job.status === 'running') {
    showMain(false); $('progress').hidden = false; $('cancel').hidden = false; $('again').hidden = true;
    const pct = job.total ? (job.done / job.total) * 100 : 0;
    $('barFill').style.width = pct.toFixed(1) + '%';
    let eta = '';
    if (job.started && pct > 1) eta = ' · še približno ' + fmtTime(((Date.now() - job.started) / 1000) * (100 - pct) / pct);
    $('progressText').textContent = `${pct.toFixed(1)} % · ${job.done}/${job.total} segmentov · ${fmtMB(job.bytes || 0)}${eta}`;
    $('progressMsg').textContent = job.message || '';
    setStatus('Prenašam: ' + job.filename, '');
    return;
  }
  if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
    showMain(false); $('progress').hidden = false; $('cancel').hidden = true; $('again').hidden = false;
    $('barFill').style.width = job.status === 'done' ? '100%' : $('barFill').style.width;
    $('progressText').textContent = job.status === 'done' ? `Shranjeno kot: ${job.filename}` : '';
    $('progressMsg').textContent = (job.warning ? job.warning + ' ' : '') + (job.message || '');
    if (job.status === 'done') setStatus('Prenos končan. Datoteko najdeš med prenosi v Firefoxu (Ctrl+Shift+Y).', 'ok');
    else if (job.status === 'cancelled') setStatus('Prenos je bil preklican.', 'warn');
    else setStatus('Napaka: ' + (job.error || 'neznana napaka') + ' Uporabiš lahko rezervno možnost spodaj.', 'err');
    return;
  }
  $('progress').hidden = true;
  showMain(true);
  if (!s.detected) {
    $('form').hidden = true;
    if (trUsable) { setStatus('Video posnetek ni zaznan, prepis pa je na voljo (glej spodaj). Za video ga zaženi in pusti predvajati nekaj sekund.', 'warn'); return; }
    setStatus('Posnetek ni zaznan. Odpri posnetek v Microsoft Stream (SharePoint/OneDrive) ali Teams, ga zaženi in pusti predvajati nekaj sekund, nato znova odpri to okno.', 'warn');
    return;
  }
  $('form').hidden = false;
  const src = s.hasManifest ? 'DASH manifest' : 'seja oneDrive.transcode';
  let txt = `Posnetek zaznan (${src}).`;
  if (s.encrypted) txt += s.hasKey ? ' Segmenti so šifrirani (AES-128) – ključ je zajet.' : ' Segmenti so morda šifrirani; ključ še ni zajet – pusti posnetek predvajati še nekaj sekund.';
  let cls = 'ok';
  if (s.hasAudio === false && $('mode').value === 'av') {
    txt += ' Opozorilo: zvočna sled še ni zaznana – počakaj še nekaj sekund pred prenosom, sicer bo datoteka samo video.';
    cls = 'warn';
  } else if (s.hasAudio) {
    txt += ' Zvok: da.';
  }
  setStatus(txt, cls);
}

async function refresh() {
  try { state = await browser.runtime.sendMessage({ type: 'ss-state', tabId }); render(); }
  catch (e) { setStatus('Napaka pri komunikaciji z razširitvijo: ' + e.message, 'err'); }
}

async function copy(text, label) {
  if (!text) { $('note').textContent = 'Ni na voljo (manifest ni bil zaznan).'; return; }
  $('cmd').value = text;
  try { await navigator.clipboard.writeText(text); $('note').textContent = label + ' kopiran v odložišče.'; }
  catch (e) { $('cmd').select(); $('note').textContent = 'Kopiranje ni uspelo – označi besedilo in pritisni Ctrl+C.'; }
}

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  await loadSettings();
  ['subfolder', 'concurrency', 'saveAs', 'mode', 'trFormat'].forEach((id) => $(id).addEventListener('change', saveSettings));
  $('start').addEventListener('click', async () => {
    await saveSettings();
    $('start').disabled = true;
    await browser.runtime.sendMessage({ type: 'ss-start', tabId, options: {
      filename: SSMpd.sanitizeFilename($('filename').value), subfolder: $('subfolder').value,
      mode: $('mode').value, concurrency: Number($('concurrency').value), saveAs: $('saveAs').checked
    } });
    $('start').disabled = false;
    refresh();
  });
  $('trSave').addEventListener('click', async () => {
    await saveSettings();
    trSaving = true; $('trSave').disabled = true; $('trMsg').textContent = 'Shranjujem prepis …';
    try {
      const r = await browser.runtime.sendMessage({ type: 'ss-save-transcript', tabId, options: {
        filename: SSMpd.sanitizeFilename($('filename').value), subfolder: $('subfolder').value,
        format: $('trFormat').value, saveAs: $('saveAs').checked
      } });
      if (r && r.ok) {
        $('trMsg').textContent = `Shranjeno kot: ${r.filename} (${r.lines} vrstic). Datoteko najdeš med prenosi v Firefoxu (Ctrl+Shift+Y).` + (r.skipped ? ` Preskočenih vrstic z neveljavnim časom: ${r.skipped}.` : '');
      } else {
        $('trMsg').textContent = 'Napaka: ' + ((r && r.error) || 'neznana napaka');
      }
    } catch (e) {
      $('trMsg').textContent = 'Napaka: ' + e.message;
    }
    trSaving = false;
    refresh();
  });
  $('cancel').addEventListener('click', () => browser.runtime.sendMessage({ type: 'ss-cancel', tabId }).then(refresh));
  $('again').addEventListener('click', () => browser.runtime.sendMessage({ type: 'ss-reset', tabId }).then(refresh));
  $('copyYtdlp').addEventListener('click', () => copy(state && state.commands && state.commands.ytdlp, 'Ukaz yt-dlp'));
  $('copyFfmpeg').addEventListener('click', () => copy(state && state.commands && state.commands.ffmpeg, 'Ukaz ffmpeg'));
  $('copyManifest').addEventListener('click', () => copy(state && state.commands && state.commands.manifest, 'URL manifesta'));
  $('note').textContent = 'Samo za osebno uporabo posnetkov, do katerih imaš dostop.';
  await refresh();
  setInterval(refresh, 700);
});

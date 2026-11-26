/*
 * Stream Saver – enotno ustvarjanje in sproščanje blob: URL-jev ter keep-alive za Chrome MV3.
 * V Firefoxu (kjer URL.createObjectURL obstaja v ozadju) deluje neposredno brez Offscreen Documenta.
 * V Chrome MV3 Service Workerju zapiše Blob v OPFS (ali IndexedDB) in ustvari blob: URL v Offscreen Documentu.
 */
(function (root) {
  'use strict';

  const hasNativeObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  let creatingOffscreen = null;
  let keepAlivePort = null;
  let activeJobs = 0;

  async function ensureOffscreen() {
    if (hasNativeObjectUrl) return;
    if (!root.chrome || !chrome.offscreen) throw new Error('Chrome offscreen API ni na voljo.');
    if (chrome.runtime && chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctxs && ctxs.length) return;
    }
    if (creatingOffscreen) { await creatingOffscreen; return; }
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'chrome/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Ustvarjanje Blob URL-jev za prenesene posnetke in prepise.'
    }).catch((e) => {
      if (!/Only a single offscreen/i.test(String(e && e.message || e))) throw e;
    }).finally(() => { creatingOffscreen = null; });
    await creatingOffscreen;
  }

  async function beginKeepAlive() {
    activeJobs++;
    if (hasNativeObjectUrl || keepAlivePort) return;
    try {
      await ensureOffscreen();
      keepAlivePort = chrome.runtime.connect({ name: 'ss-keepalive' });
      keepAlivePort.onDisconnect.addListener(() => { keepAlivePort = null; });
    } catch (e) { /* ignore */ }
  }

  function endKeepAlive() {
    activeJobs = Math.max(0, activeJobs - 1);
    if (activeJobs === 0 && keepAlivePort) {
      try { keepAlivePort.disconnect(); } catch (e) { /* ignore */ }
      keepAlivePort = null;
    }
  }

  async function writeTempBlob(blob) {
    const key = 'ss-dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const dir = await navigator.storage.getDirectory();
        const fh = await dir.getFileHandle(key, { create: true });
        if (fh.createWritable) {
          const w = await fh.createWritable({ keepExistingData: false });
          if (blob.stream && typeof blob.stream === 'function') {
            await blob.stream().pipeTo(w);
          } else {
            await w.write(blob);
            await w.close();
          }
          return { store: 'opfs', key };
        }
      }
    } catch (e) { /* fallback to IDB */ }

    const db = await new Promise((resolve, reject) => {
      const rq = indexedDB.open('stream-saver', 1);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains('chunks')) rq.result.createObjectStore('chunks');
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const rq = tx.objectStore('chunks').put(blob, key);
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error);
    });
    return { store: 'idb', key };
  }

  async function createObjectURL(blob) {
    if (hasNativeObjectUrl) return URL.createObjectURL(blob);
    await ensureOffscreen();
    const mime = blob.type || 'application/octet-stream';
    if (blob.size <= 4 * 1024 * 1024 && /^text\//i.test(mime)) {
      const text = await blob.text();
      const r = await chrome.runtime.sendMessage({ target: 'ss-offscreen', type: 'ss-offscreen-create-url', store: 'text', text, mime });
      if (!r || !r.ok || !r.url) throw new Error((r && r.error) || 'Offscreen Blob URL ni uspel.');
      return r.url;
    }
    const loc = await writeTempBlob(blob);
    const r = await chrome.runtime.sendMessage({ target: 'ss-offscreen', type: 'ss-offscreen-create-url', store: loc.store, key: loc.key, mime });
    if (!r || !r.ok || !r.url) throw new Error((r && r.error) || 'Offscreen Blob URL ni uspel.');
    return r.url;
  }

  async function revokeObjectURL(url) {
    if (!url) return;
    if (hasNativeObjectUrl) {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      return;
    }
    try {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ target: 'ss-offscreen', type: 'ss-offscreen-revoke-url', url });
    } catch (e) { /* ignore */ }
  }

  root.SSBlob = { createObjectURL, revokeObjectURL, beginKeepAlive, endKeepAlive };
})(typeof globalThis !== 'undefined' ? globalThis : this);

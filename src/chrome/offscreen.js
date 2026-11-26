/*
 * Stream Saver (Chrome MV3) – Offscreen Document za ustvarjanje blob: URL-jev
 * iz OPFS / IndexedDB (veliki 1–4 GB posnetki brez kopiranja skozi sporočila)
 * ali kratkih besedil (prepisi .txt/.vtt), ter ohranjanje Service Workerja med prenosom.
 */
'use strict';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('stream-saver', 1);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains('chunks')) rq.result.createObjectStore('chunks');
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function idbReq(rq) {
  return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
}

const activeUrls = new Map(); // blobUrl -> { store, key }

async function createBlobUrl(msg) {
  let blob;
  if (msg.store === 'text') {
    blob = new Blob([msg.text || ''], { type: msg.mime || 'text/plain;charset=utf-8' });
  } else if (msg.store === 'opfs') {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(msg.key);
    const file = await fh.getFile();
    blob = msg.mime && file.type !== msg.mime ? new Blob([file], { type: msg.mime }) : file;
  } else if (msg.store === 'idb') {
    const db = await idbOpen();
    const tx = db.transaction('chunks', 'readonly');
    const val = await idbReq(tx.objectStore('chunks').get(msg.key));
    if (!val) throw new Error('Začasna datoteka v IndexedDB ne obstaja: ' + msg.key);
    blob = msg.mime ? new Blob([val], { type: msg.mime }) : val;
  } else {
    throw new Error('Neznan tip shrambe: ' + msg.store);
  }
  const url = URL.createObjectURL(blob);
  activeUrls.set(url, { store: msg.store, key: msg.key || null });
  return { ok: true, url };
}

async function revokeBlobUrl(url) {
  try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  const meta = activeUrls.get(url);
  activeUrls.delete(url);
  if (meta && meta.key) {
    if (meta.store === 'opfs') {
      try {
        const dir = await navigator.storage.getDirectory();
        await dir.removeEntry(meta.key);
      } catch (e) { /* ignore */ }
    } else if (meta.store === 'idb') {
      try {
        const db = await idbOpen();
        const tx = db.transaction('chunks', 'readwrite');
        await idbReq(tx.objectStore('chunks').delete(meta.key));
      } catch (e) { /* ignore */ }
    }
  }
  return { ok: true };
}

// Keep-alive port: dokler ozadje prenaša, drži povezavo odprto
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ss-keepalive') return;
  const iv = setInterval(() => {
    try { port.postMessage({ ping: Date.now() }); } catch (e) { clearInterval(iv); }
  }, 20000);
  port.onDisconnect.addListener(() => clearInterval(iv));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'ss-offscreen') return false;
  if (msg.type === 'ss-offscreen-create-url') {
    createBlobUrl(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }
  if (msg.type === 'ss-offscreen-revoke-url') {
    revokeBlobUrl(msg.url).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

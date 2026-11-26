/*
 * Stream Saver (Chrome MV3) – teče v MAIN svetu strani (SharePoint/OneDrive/Teams),
 * kjer so dosegljivi window.g_streamBootstrapContent (AES-128 ključ) in window.g_fileInfo.
 * Podatke varno posreduje vsebinski skripti (content.js) prek window.postMessage.
 */
(function () {
  'use strict';
  if (window.__streamSaverMainBridge) return;
  window.__streamSaverMainBridge = true;

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

  let lastSig = '';
  function publish(force) {
    const info = { __streamSaverMainData: true };
    try {
      const ck = window.g_streamBootstrapContent && window.g_streamBootstrapContent.dashConfig && window.g_streamBootstrapContent.dashConfig.cdnDecryptionKey;
      if (ck && ck.valid !== false) {
        const k = toBytes(ck.keyBuffer || ck.key);
        const iv = toBytes(ck.iv);
        if (k && k.length === 16) {
          info.key = k;
          info.iv = iv && iv.length === 16 ? iv : null;
        }
      }
    } catch (e) { /* ignore */ }
    try {
      const fi = window.g_fileInfo;
      if (fi) {
        const n = fi.displayName || fi.name || fi.title;
        if (n) info.fileName = String(n).replace(/\.(mp4|mov|m4v|webm)$/i, '');
      }
    } catch (e) { /* ignore */ }
    if (!info.key && !info.fileName) return;
    const sig = JSON.stringify([info.key, info.iv, info.fileName]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    try { window.postMessage(info, '*'); } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.__streamSaverMainPing === true) {
      publish(true);
    }
  });

  setTimeout(() => publish(false), 400);
  setInterval(() => publish(false), 2000);
})();

/*
 * Stream Saver – ponori (sinks) za zapis na disk med prenosom.
 * 1) OPFS (Origin Private File System, Firefox 111+): pretočen zapis v začasno datoteko na disku.
 * 2) IndexedDB: kosi po ~32 MB kot Blob; Firefox jih hrani na disku, končni Blob je sestavljen iz njih.
 * Na koncu dobimo Blob/File, iz katerega naredimo blob: URL za downloads.download().
 */
(function (root) {
  'use strict';

  async function createOpfsSink(name) {
    if (!root.navigator || !navigator.storage || !navigator.storage.getDirectory) throw new Error('OPFS ni na voljo');
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(name, { create: true });
    if (!fh.createWritable) throw new Error('createWritable ni na voljo');
    const w = await fh.createWritable({ keepExistingData: false });
    let closed = false;
    return {
      kind: 'opfs',
      write: (u8) => w.write(u8),
      close: async () => { if (!closed) { closed = true; await w.close(); } },
      abort: async () => { try { if (!closed) { closed = true; await w.abort(); } } catch (e) { /* ignore */ } try { await dir.removeEntry(name); } catch (e) { /* ignore */ } },
      getBlob: () => fh.getFile(),
      cleanup: async () => { try { await dir.removeEntry(name); } catch (e) { /* ignore */ } }
    };
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open('stream-saver', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('chunks'); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  function idbReq(rq) { return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }

  async function createIdbSink(name, chunkBytes) {
    const db = await idbOpen();
    const limit = chunkBytes || 32 * 1024 * 1024;
    let buf = [], bufLen = 0, n = 0;
    async function flush() {
      if (!bufLen) return;
      const blob = new Blob(buf, { type: 'application/octet-stream' });
      buf = []; bufLen = 0;
      const tx = db.transaction('chunks', 'readwrite');
      await idbReq(tx.objectStore('chunks').put(blob, `${name}:${String(n++).padStart(6, '0')}`));
    }
    async function removeAll() {
      const tx = db.transaction('chunks', 'readwrite');
      await idbReq(tx.objectStore('chunks').delete(IDBKeyRange.bound(`${name}:`, `${name}:\uffff`)));
    }
    return {
      kind: 'idb',
      write: async (u8) => { buf.push(u8.slice()); bufLen += u8.byteLength; if (bufLen >= limit) await flush(); },
      close: flush,
      abort: async () => { buf = []; try { await removeAll(); } catch (e) { /* ignore */ } },
      getBlob: async () => {
        const tx = db.transaction('chunks', 'readonly');
        const parts = await idbReq(tx.objectStore('chunks').getAll(IDBKeyRange.bound(`${name}:`, `${name}:\uffff`)));
        return new Blob(parts, { type: 'video/mp4' });
      },
      cleanup: removeAll
    };
  }

  async function createSink(name) {
    try { return await createOpfsSink(name); }
    catch (e) { return createIdbSink(name); }
  }

  /** Remove leftovers from interrupted downloads (OPFS files and IDB chunks). */
  async function purgeAll() {
    try {
      const dir = await navigator.storage.getDirectory();
      if (dir.keys) for await (const k of dir.keys()) { if (/^ss-/.test(k)) { try { await dir.removeEntry(k); } catch (e) { /* ignore */ } } }
    } catch (e) { /* ignore */ }
    try { const db = await idbOpen(); const tx = db.transaction('chunks', 'readwrite'); await idbReq(tx.objectStore('chunks').clear()); } catch (e) { /* ignore */ }
  }

  root.SSSink = { createSink, createOpfsSink, createIdbSink, purgeAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);

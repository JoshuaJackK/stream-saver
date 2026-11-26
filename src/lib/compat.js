/*
 * Stream Saver – združljivostna plast za Firefox (MV2) in Chrome (MV3).
 * V Firefoxu pusti privzeti `browser.*` nedotaknjen; v Chromu ovije `chrome.*`,
 * podpre vračanje Promise iz runtime.onMessage, preslika browserAction -> action
 * in omogoči varen prenos ArrayBuffer prek JSON sporočil (base64).
 */
(function (root) {
  'use strict';

  const hasNativeBrowser = typeof root.browser !== 'undefined' && root.browser && root.browser.runtime && typeof root.browser.runtime.getBrowserInfo === 'function';
  const hasChrome = typeof root.chrome !== 'undefined' && root.chrome && root.chrome.runtime;
  const isChrome = Boolean(!hasNativeBrowser && hasChrome);

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function encodeFetchResult(res) {
    if (!isChrome || !res || !res.buffer) return res;
    if (res.buffer instanceof ArrayBuffer) {
      return Object.assign({}, res, { buffer: { __ss_b64: arrayBufferToBase64(res.buffer) } });
    }
    if (ArrayBuffer.isView(res.buffer)) {
      const slice = res.buffer.buffer.slice(res.buffer.byteOffset, res.buffer.byteOffset + res.buffer.byteLength);
      return Object.assign({}, res, { buffer: { __ss_b64: arrayBufferToBase64(slice) } });
    }
    return res;
  }

  function decodeFetchResult(res) {
    if (!res || !res.buffer || typeof res.buffer !== 'object' || !res.buffer.__ss_b64) return res;
    return Object.assign({}, res, { buffer: base64ToArrayBuffer(res.buffer.__ss_b64) });
  }

  if (isChrome) {
    const c = root.chrome;

    // Ovij runtime.onMessage.addListener tako, da poslušalci, ki vrnejo Promise, delujejo tudi v Chromu.
    const listenerMap = new WeakMap();
    const wrappedOnMessage = {
      addListener(fn) {
        const wrapper = (msg, sender, sendResponse) => {
          let ret;
          try { ret = fn(msg, sender); }
          catch (err) { return false; }
          if (ret && typeof ret.then === 'function') {
            ret.then(
              (val) => { try { sendResponse(val); } catch (e) { /* channel closed */ } },
              (err) => { try { sendResponse({ ok: false, error: (err && err.message) || String(err) }); } catch (e) { /* ignore */ } }
            );
            return true;
          }
          return false;
        };
        listenerMap.set(fn, wrapper);
        c.runtime.onMessage.addListener(wrapper);
      },
      removeListener(fn) {
        const w = listenerMap.get(fn) || fn;
        c.runtime.onMessage.removeListener(w);
      },
      hasListener(fn) {
        return c.runtime.onMessage.hasListener(listenerMap.get(fn) || fn);
      }
    };

    const runtimeProxy = new Proxy(c.runtime, {
      get(target, prop) {
        if (prop === 'onMessage') return wrappedOnMessage;
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });

    const actionApi = c.action || c.browserAction;
    const browserProxy = new Proxy(c, {
      get(target, prop) {
        if (prop === 'runtime') return runtimeProxy;
        if (prop === 'browserAction') return actionApi;
        return target[prop];
      }
    });

    root.browser = browserProxy;
  }

  root.SSCompat = {
    isChrome,
    downloadsShortcut: isChrome ? 'Ctrl+J' : 'Ctrl+Shift+Y',
    browserName: isChrome ? 'Chromu' : 'Firefoxu',
    encodeFetchResult,
    decodeFetchResult,
    arrayBufferToBase64,
    base64ToArrayBuffer
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

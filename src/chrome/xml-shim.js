/*
 * Stream Saver – lahek sinhroni XML DOMParser za Chrome MV3 Service Worker
 * (kjer brskalniški DOMParser ni na voljo). Implementira natančno tisti podnabor DOM,
 * ki ga potrebuje lib/mpd.js: documentElement, getElementsByTagName, firstChild,
 * nextSibling, nodeType, localName, nodeName, getAttribute, textContent.
 */
(function (root) {
  'use strict';

  if (typeof root.DOMParser === 'function') return;

  function decodeEntities(s) {
    if (!s || s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, ent) => {
      if (ent === 'amp') return '&';
      if (ent === 'lt') return '<';
      if (ent === 'gt') return '>';
      if (ent === 'quot') return '"';
      if (ent === 'apos') return "'";
      if (ent[0] === '#') {
        const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF) {
          try { return String.fromCodePoint(cp); } catch (e) { return m; }
        }
      }
      return m;
    });
  }

  class XmlNode {
    constructor(nodeType, nodeName) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      const idx = nodeName ? nodeName.indexOf(':') : -1;
      this.localName = idx >= 0 ? nodeName.slice(idx + 1) : nodeName;
      this._attrs = Object.create(null);
      this._children = [];
      this._text = '';
      this.parentNode = null;
      this.firstChild = null;
      this.lastChild = null;
      this.nextSibling = null;
    }
    appendChild(child) {
      child.parentNode = this;
      if (this.lastChild) {
        this.lastChild.nextSibling = child;
      } else {
        this.firstChild = child;
      }
      this.lastChild = child;
      this._children.push(child);
      return child;
    }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    }
    get textContent() {
      if (this.nodeType === 3) return this._text;
      let out = '';
      for (const c of this._children) out += c.textContent;
      return out;
    }
    getElementsByTagName(tag) {
      const out = [];
      const wild = tag === '*';
      const walk = (n) => {
        for (const c of n._children) {
          if (c.nodeType === 1) {
            if (wild || c.nodeName === tag || c.localName === tag) out.push(c);
            walk(c);
          }
        }
      };
      walk(this);
      return out;
    }
  }

  function makeErrorDoc(msg) {
    const doc = new XmlNode(9, '#document');
    const err = new XmlNode(1, 'parsererror');
    const t = new XmlNode(3, '#text');
    t._text = msg;
    err.appendChild(t);
    doc.appendChild(err);
    doc.documentElement = err;
    return doc;
  }

  function parseXml(xml) {
    const src = String(xml || '');
    const len = src.length;
    const doc = new XmlNode(9, '#document');
    const stack = [doc];
    let i = 0;

    // Preskoči BOM
    if (src.charCodeAt(0) === 0xFEFF) i = 1;

    while (i < len) {
      const lt = src.indexOf('<', i);
      if (lt < 0) {
        const rest = src.slice(i);
        if (rest && stack.length > 1) {
          const tn = new XmlNode(3, '#text');
          tn._text = decodeEntities(rest);
          stack[stack.length - 1].appendChild(tn);
        }
        break;
      }
      if (lt > i && stack.length > 1) {
        const tn = new XmlNode(3, '#text');
        tn._text = decodeEntities(src.slice(i, lt));
        stack[stack.length - 1].appendChild(tn);
      }

      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt + 4);
        if (end < 0) return makeErrorDoc('Nezaprt XML komentar');
        i = end + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const end = src.indexOf(']]>', lt + 9);
        if (end < 0) return makeErrorDoc('Nezaprt CDATA');
        if (stack.length > 1) {
          const tn = new XmlNode(3, '#text');
          tn._text = src.slice(lt + 9, end);
          stack[stack.length - 1].appendChild(tn);
        }
        i = end + 3;
        continue;
      }
      if (src.startsWith('<?', lt)) {
        const end = src.indexOf('?>', lt + 2);
        if (end < 0) return makeErrorDoc('Nezaprt PI');
        i = end + 2;
        continue;
      }
      if (src.startsWith('<!DOCTYPE', lt) || src.startsWith('<!doctype', lt)) {
        const end = src.indexOf('>', lt + 9);
        if (end < 0) return makeErrorDoc('Nezaprt DOCTYPE');
        i = end + 1;
        continue;
      }

      // Zaključna oznaka </tag>
      if (src[lt + 1] === '/') {
        const gt = src.indexOf('>', lt + 2);
        if (gt < 0) return makeErrorDoc('Nezaprt zaključni tag');
        const closeName = src.slice(lt + 2, gt).trim();
        if (stack.length <= 1 || stack[stack.length - 1].nodeName !== closeName) {
          return makeErrorDoc('Neujemanje oznake: ' + closeName);
        }
        stack.pop();
        i = gt + 1;
        continue;
      }

      // Začetna oznaka <tag attr="val" ...> ali <tag .../>
      let p = lt + 1;
      while (p < len && !/[\s/>]/.test(src[p])) p++;
      const tagName = src.slice(lt + 1, p);
      if (!tagName) return makeErrorDoc('Prazno ime oznake');
      const el = new XmlNode(1, tagName);
      let selfClose = false;

      while (p < len) {
        while (p < len && /\s/.test(src[p])) p++;
        if (p >= len) return makeErrorDoc('Nepričakovan konec oznake ' + tagName);
        if (src[p] === '>') { p++; break; }
        if (src[p] === '/' && src[p + 1] === '>') { selfClose = true; p += 2; break; }

        const aStart = p;
        while (p < len && !/[\s=/>]/.test(src[p])) p++;
        const aName = src.slice(aStart, p);
        while (p < len && /\s/.test(src[p])) p++;
        let aVal = '';
        if (src[p] === '=') {
          p++;
          while (p < len && /\s/.test(src[p])) p++;
          const q = src[p];
          if (q === '"' || q === "'") {
            p++;
            const vStart = p;
            const vEnd = src.indexOf(q, vStart);
            if (vEnd < 0) return makeErrorDoc('Nezaprta vrednost atributa ' + aName);
            aVal = decodeEntities(src.slice(vStart, vEnd));
            p = vEnd + 1;
          } else {
            const vStart = p;
            while (p < len && !/[\s/>]/.test(src[p])) p++;
            aVal = decodeEntities(src.slice(vStart, p));
          }
        }
        if (aName) el._attrs[aName] = aVal;
      }

      stack[stack.length - 1].appendChild(el);
      if (!doc.documentElement && stack.length === 1) doc.documentElement = el;
      if (!selfClose) stack.push(el);
      i = p;
    }

    if (stack.length !== 1 || !doc.documentElement) {
      return makeErrorDoc('Neveljaven ali nepopoln XML');
    }
    return doc;
  }

  root.DOMParser = class DOMParserShim {
    parseFromString(text) {
      return parseXml(text);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/lib/visibleTranscript.js');
const T = require('../src/lib/transcript.js');

function makeDoc(html) {
  const { JSDOM } = require('jsdom');
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true }).window.document;
}

function entryHtml(i, total, text, opts) {
  opts = opts || {};
  const speaker = opts.speaker || 'Govorec';
  const min = opts.min != null ? opts.min : Math.floor((opts.sec || 0) / 60);
  const sec = opts.sec != null ? (opts.sec % 60) : 0;
  const aria = `${speaker} ${min} min ${sec} s`;
  const ts = opts.showTs
    ? `<span id="Header-timestamp-${i}" aria-hidden="true">${opts.tsLabel || (min + ':' + String(sec).padStart(2, '0'))}</span>`
    : '';
  const header = opts.showHeader
    ? `<div role="listitem" class="itemHeader-x"><span class="itemDisplayName-x">${speaker}</span>${ts}</div>`
    : (ts ? `<div role="listitem" class="itemHeader-x">${ts}</div>` : '');
  return `<div data-testid="entryRenderer"><div id="entry-${i}" role="group" aria-label="${aria}">${header}<div id="sub-entry-${i}" role="listitem" class="entryText-x" aria-posinset="${i + 1}" aria-setsize="${total}">${text}</div></div></div>`;
}

test('parseVisibleTime / parseAriaLabel', () => {
  assert.equal(V.parseVisibleTime('0:07'), 7000);
  assert.equal(V.parseVisibleTime('1:37:51'), 5871000);
  assert.deepEqual(V.parseAriaLabel('Ana Novak 0 min 7 s'), { speaker: 'Ana Novak', ms: 7000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 h 3 min 4 s'), { speaker: 'Speaker', ms: ((2 * 60 + 3) * 60 + 4) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 97 min 51 s'), { speaker: 'Speaker', ms: (97 * 60 + 51) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 12 s'), { speaker: 'Speaker', ms: 12000 });
  assert.equal(V.parseAriaLabel('Speaker 2 ure 3 min'), null); // ne podpiramo brez preverjenega vzorca
});

test('harvest + assemble: govorec se prenese, popoln 0..n-1', () => {
  const total = 4;
  const html = [
    entryHtml(0, total, 'Prva', { speaker: 'Ana', showHeader: true, showTs: true, sec: 7 }),
    entryHtml(1, total, 'Druga', { speaker: 'Ana', sec: 10 }),
    entryHtml(2, total, 'Tretja', { speaker: 'Bojan', showHeader: true, showTs: true, min: 1, sec: 5, tsLabel: '1:05' }),
    entryHtml(3, total, 'Četrta', { speaker: 'Bojan', min: 1, sec: 8 })
  ].join('');
  const doc = makeDoc(`<div role="complementary" aria-label="Prepis">${html}</div>`);
  const map = V.harvestMounted(V.findTranscriptRoot(doc), new Map());
  const parsed = V.assembleParsed(map, total);
  assert.equal(parsed.stats.lines, 4);
  assert.equal(parsed.entries[1].speaker, 'Ana');
  assert.match(T.toTxt(parsed), /Ana: Prva/);
});

test('assemble: manjkajoči indeks / čas', () => {
  const doc = makeDoc(entryHtml(0, 3, 'a', { sec: 1 }) + entryHtml(2, 3, 'c', { sec: 3 }));
  assert.throws(() => V.assembleParsed(V.harvestMounted(doc, new Map()), 3), /Manjkajo indeksi/);
  assert.throws(() => V.assembleParsed(new Map([[0, { index: 0, text: 'x', speaker: '', timeMs: null, setSize: 1 }]]), 1), /Manjka čas za vrstico 1/);
});

test('assemble TIME: 1-based + aria-label; TIME_UNKNOWN pri neznani obliki', () => {
  try {
    V.assembleParsed(new Map([[0, {
      index: 0, text: 'x', speaker: 'Ana', timeMs: null, setSize: 1, ariaLabel: 'Ana 5 min 0 s'
    }]]), 1);
    assert.fail('pričakovana TIME');
  } catch (e) {
    assert.equal(e.code, 'TIME');
    assert.match(e.message, /vrstico 1/);
    assert.match(e.message, /Ana 5 min 0 s/);
    assert.equal(e.details.ordinal, 1);
    assert.equal(e.details.index, 0);
  }
  const map = new Map();
  for (let i = 0; i < 5; i++) {
    map.set(i, {
      index: i, text: 't' + i, speaker: 'G', timeMs: i === 4 ? null : i * 1000, setSize: 5,
      ariaLabel: i === 4 ? 'G 2 ure 15 minut' : ('G ' + i + ' s')
    });
  }
  try {
    V.assembleParsed(map, 5);
    assert.fail('pričakovana TIME_UNKNOWN');
  } catch (e) {
    assert.equal(e.code, 'TIME_UNKNOWN');
    assert.match(e.message, /vrstici 5/);
    assert.match(e.message, /2 ure 15 minut/);
    assert.equal(e.details.ordinal, 5);
    assert.equal(e.details.index, 4);
  }
});

test('collect: po polnem map.size napredek Preverjam (ne »zbrano«)', async () => {
  const total = 3;
  const { JSDOM } = require('jsdom');
  const html = Array.from({ length: total }, (_, i) =>
    entryHtml(i, total, 'V' + i, { speaker: 'A', showHeader: i === 0, showTs: i === 0, sec: i * 2 })
  ).join('');
  const dom = new JSDOM(`<!doctype html><html><body>
    <div role="complementary" aria-label="Prepis"><div id="scroller" style="overflow-y:scroll;height:200px;">${html}</div></div>
  </body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const scroller = doc.getElementById('scroller');
  Object.defineProperty(scroller, 'clientHeight', { get: () => 200, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 200, configurable: true });
  const msgs = [];
  await V.collectVisibleTranscript(doc, {
    timeoutMs: 5000, waitMs: 5, scrollEl: scroller, maxIters: 50,
    onProgress: (p) => msgs.push(p.message || '')
  });
  assert.ok(msgs.some((m) => /Preverjam vseh 3 vrstic/.test(m)), 'msgs=' + JSON.stringify(msgs));
});

test('LEGACY planScroll: pri luknji na začetku skoči nazaj (dokaz nihanja)', () => {
  // Zbrano 0..49, manjka 50; nato smo na scrollTop visoko (npr. po koraku) – legacy skoči na frac*max
  // Po zbiranju 0..10 in 400..500 je missing[0]=11 → jump blizu vrha → nihanje z visokim prevTop
  const maxScroll = 10000;
  const client = 400;
  const tops = [];
  let top = 8000; // daleč spodaj (npr. po naključnem skoku)
  for (let k = 0; k < 6; k++) {
    const missing0 = 11; // luknja zgoraj
    const plan = V.planScrollLegacy(top, missing0, 1214, maxScroll, client);
    tops.push({ top: plan.top, mode: plan.mode });
    top = plan.top;
  }
  // vsaj en skok nazaj glede na začetni 8000
  assert.ok(tops.some((t) => t.mode === 'jump' && t.top < 8000), 'legacy mora skočiti nazaj proti manjkajočemu: ' + JSON.stringify(tops));
  // zaporedje ni monoton
  let dec = false;
  for (let i = 1; i < tops.length; i++) if (tops[i].top < tops[i - 1].top - 1) dec = true;
  assert.ok(dec, 'legacy zaporedje se zmanjša (nihanje)');
});

test('MONOTONIC planScroll: nikoli nazaj', () => {
  const maxScroll = 10000;
  let top = 0;
  const tops = [];
  for (let k = 0; k < 200; k++) {
    const plan = V.planScrollMonotonic(top, maxScroll, 400);
    assert.ok(plan.top + 0.01 >= top, 'monoton: ' + top + ' -> ' + plan.top);
    tops.push(plan.top);
    if (plan.mode === 'bottom' || plan.top >= maxScroll) { top = plan.top; break; }
    top = plan.top;
  }
  assert.equal(top, maxScroll);
  assert.ok(tops.every((t, i) => i === 0 || t >= tops[i - 1]), 'monotone non-decreasing');
});

test('collectVisibleTranscript: virtualni seznam z eviction – monoton, obnovi scroll, vsi indeksi', async () => {
  const total = 30;
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><html><body>
    <div role="complementary" aria-label="Prepis">
      <div id="scroller" style="overflow-y:scroll; height:40px;"></div>
    </div>
  </body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const scroller = doc.getElementById('scroller');
  Object.defineProperty(scroller, 'clientHeight', { get: () => 40, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 2000, configurable: true });
  let scrollTop = 0;
  const windowSize = 3;
  function remount() {
    scroller.innerHTML = '';
    const start = Math.min(total - 1, Math.floor((scrollTop / 2000) * total));
    const end = Math.min(total, start + windowSize);
    for (let i = start; i < end; i++) {
      scroller.insertAdjacentHTML('beforeend', entryHtml(i, total, 'Vrstica ' + i, {
        speaker: i < 15 ? 'A' : 'B', showHeader: i === 0 || i === 15, showTs: i === 0 || i === 15,
        sec: i * 2
      }));
    }
  }
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => { scrollTop = v; remount(); },
    configurable: true
  });
  remount();
  scroller.scrollTop = 500;
  const startTop = scroller.scrollTop;
  const trace = [];
  const parsed = await V.collectVisibleTranscript(doc, {
    timeoutMs: 15000, waitMs: 5, scrollEl: scroller, scrollTrace: trace, maxIters: 500
  });
  assert.equal(parsed.stats.lines, total);
  assert.equal(scroller.scrollTop, startTop, 'scroll obnovljen');
  // sled: po začetnem 0 samo narašča do max (obnova na koncu ni v trace – trace med zbiranjem)
  const mid = trace.slice(1); // po resetu na 0
  for (let i = 1; i < mid.length; i++) {
    assert.ok(mid[i] + 0.01 >= mid[i - 1], 'nihanje v sledi: ' + mid[i - 1] + ' -> ' + mid[i]);
  }
});

test('collect: brez zavihka / incomplete jasna napaka', async () => {
  await assert.rejects(() => V.collectVisibleTranscript(makeDoc('<p>x</p>'), { timeoutMs: 100 }), /Zavihek Prepis/);
});

test('probeVisiblePane', () => {
  const doc = makeDoc(`<div role="complementary" aria-label="Transcript">${entryHtml(0, 1, 'hi', { sec: 1 })}</div>`);
  assert.equal(V.probeVisiblePane(doc).available, true);
});

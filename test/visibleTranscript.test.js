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
  assert.deepEqual(V.parseAriaLabel('Speaker 0 min 7 s'), { speaker: 'Speaker', ms: 7000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 18 min 26 s'), { speaker: 'Speaker', ms: 1106000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 1 ura 11 min 29 s'), { speaker: 'Speaker', ms: 4289000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 1 ura 12 min'), { speaker: 'Speaker', ms: 4320000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 h 41 min 17 s'), { speaker: 'Speaker', ms: 9677000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 3 h 33 min 52 s'), { speaker: 'Speaker', ms: 12832000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 3 h 45 min'), { speaker: 'Speaker', ms: 13500000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 h 3 min 4 s'), { speaker: 'Speaker', ms: ((2 * 60 + 3) * 60 + 4) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 97 min 51 s'), { speaker: 'Speaker', ms: (97 * 60 + 51) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 12 s'), { speaker: 'Speaker', ms: 12000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 16 min'), { speaker: 'Speaker', ms: 960000 });
  assert.deepEqual(V.parseAriaLabel('dr. Andreja Poljanec 16 min'), { speaker: 'dr. Andreja Poljanec', ms: 960000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 0 min'), { speaker: 'Speaker', ms: 0 });
  assert.deepEqual(V.parseAriaLabel('Speaker 1 ura 12 s'), { speaker: 'Speaker', ms: 3612000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 1 h 12 s'), { speaker: 'Speaker', ms: 3612000 });
  assert.equal(V.parseAriaLabel('Speaker 1 ura 70 min'), null); // minute > 59
});

test('parseAriaLabel: samo ure (»N h«) in sklanjane / angleške enote', () => {
  // Resnična napaka 1.2.8 (predavanje 16:00–20:00, vrstica 722): točno 2:00:00.
  assert.deepEqual(V.parseAriaLabel('LJ - Sejna soba 2 h'), { speaker: 'LJ - Sejna soba', ms: 7200000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 h'), { speaker: 'Speaker', ms: 7200000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 1 ura'), { speaker: 'Speaker', ms: 3600000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 uri'), { speaker: 'Speaker', ms: 7200000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 3 ure 5 minut'), { speaker: 'Speaker', ms: (3 * 3600 + 300) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 ure 3 min'), { speaker: 'Speaker', ms: (2 * 3600 + 180) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 5 ur 1 minuta 2 sekundi'), { speaker: 'Speaker', ms: (5 * 3600 + 62) * 1000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 minuti 3 sekunde'), { speaker: 'Speaker', ms: 123000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 1 hour 2 minutes 3 seconds'), { speaker: 'Speaker', ms: 3723000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2 hours'), { speaker: 'Speaker', ms: 7200000 });
  assert.deepEqual(V.parseAriaLabel('Speaker 2h 41min 17s'), { speaker: 'Speaker', ms: 9677000 });
  assert.deepEqual(V.parseAriaLabel('LJ - Sejna soba 2 h 0 min 5 s'), { speaker: 'LJ - Sejna soba', ms: 7205000 });
  // Število v imenu govorca ostane v imenu.
  assert.deepEqual(V.parseAriaLabel('Sejna soba 2 16 min'), { speaker: 'Sejna soba 2', ms: 960000 });
  assert.deepEqual(V.parseAriaLabel('Sejna soba 2 1 h 3 s'), { speaker: 'Sejna soba 2', ms: 3603000 });
  // Nikoli ne izmišljamo: brez časa, napačen vrstni red, podvojene enote, prazen govorec.
  assert.equal(V.parseAriaLabel('LJ - Sejna soba'), null);
  assert.equal(V.parseAriaLabel('Sejna soba 2'), null);
  assert.equal(V.parseAriaLabel('Speaker 3 min 2 h'), null);
  assert.equal(V.parseAriaLabel('Speaker 2 h 3 h'), null);
  assert.equal(V.parseAriaLabel('2 h'), null);
  assert.equal(V.parseAriaLabel('Speaker 2 h 3 min 70 s'), null);
  assert.equal(V.parseAriaLabel(''), null);
});

test('assemble: predavanje čez 2 uri z »N h« vrstico (regresija 1.2.8)', () => {
  const labels = [
    ['LJ - Sejna soba 1 h 59 min 58 s', 7198000],
    ['LJ - Sejna soba 2 h', 7200000],
    ['LJ - Sejna soba 2 h 7 s', 7207000],
    ['LJ - Sejna soba 2 h 1 min', 7260000],
    ['LJ - Sejna soba 3 h 59 min 59 s', 14399000]
  ];
  const total = labels.length;
  const html = labels.map(([aria], i) =>
    `<div data-testid="entryRenderer"><div id="entry-${i}" role="group" aria-label="${aria}"><div id="sub-entry-${i}" role="listitem" class="entryText-x" aria-posinset="${i + 1}" aria-setsize="${total}">t${i}</div></div></div>`
  ).join('');
  const doc = makeDoc(`<div role="complementary" aria-label="Prepis">${html}</div>`);
  const map = V.harvestMounted(V.findTranscriptRoot(doc), new Map());
  const parsed = V.assembleParsed(map, total);
  assert.equal(parsed.stats.lines, total);
  parsed.entries.forEach((e, i) => {
    assert.equal(e.startMs, labels[i][1]);
    assert.equal(e.speaker, 'LJ - Sejna soba');
  });
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
      ariaLabel: i === 4 ? 'G pred dvema urama' : ('G ' + i + ' s')
    });
  }
  try {
    V.assembleParsed(map, 5);
    assert.fail('pričakovana TIME_UNKNOWN');
  } catch (e) {
    assert.equal(e.code, 'TIME_UNKNOWN');
    assert.match(e.message, /vrstici 5/);
    assert.match(e.message, /pred dvema urama/);
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


test('groupContiguous / listMissing', () => {
  const map = new Map([[0, {}], [1, {}], [5, {}], [6, {}], [7, {}], [10, {}]]);
  assert.deepEqual(V.listMissing(map, 12), [2, 3, 4, 8, 9, 11]);
  assert.deepEqual(V.groupContiguous([2, 3, 4, 8, 9, 11]), [
    { start: 2, end: 4 }, { start: 8, end: 9 }, { start: 11, end: 11 }
  ]);
});

test('collect: virtualizacija s 5-vrstično luknjo – sidro dopolni, ne izmisli', async () => {
  // Model: monoton prehod do dna nikoli ne namesti 50..54; šele scrollIntoView
  // predhodnega sidra (entry-49) odklene luknjo. Skupaj 120 vrstic.
  const total = 120;
  const holeLo = 110, holeHi = 114; // vključno – 5 vrstic blizu konca (kot 1150..1154/1214)
  const rowH = 40;
  const windowSize = 12;
  const scrollHeight = total * rowH;
  const clientHeight = 400;
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><html><body>
    <div role="complementary" aria-label="Prepis">
      <div id="scroller" style="overflow-y:scroll; height:${clientHeight}px;"></div>
    </div>
  </body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const scroller = doc.getElementById('scroller');
  Object.defineProperty(scroller, 'clientHeight', { get: () => clientHeight, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true });

  let scrollTop = 0;
  let unlockHole = false;
  let mountedRanges = [];

  function shouldMount(i) {
    if (i >= holeLo && i <= holeHi && !unlockHole) return false;
    return true;
  }

  function remount() {
    scroller.innerHTML = '';
    const start = Math.max(0, Math.min(total - 1, Math.floor(scrollTop / rowH)));
    const end = Math.min(total, start + windowSize);
    mountedRanges.push([start, end, unlockHole]);
    for (let i = start; i < end; i++) {
      if (!shouldMount(i)) continue;
      scroller.insertAdjacentHTML('beforeend', entryHtml(i, total, 'Vrstica ' + i, {
        speaker: 'S', showHeader: i === 0 || i === 60, showTs: i === 0 || i === 60,
        sec: i * 2
      }));
    }
    // scrollIntoView na nameščenih sidrih odklene luknjo
    for (const el of scroller.querySelectorAll('[id^="entry-"]')) {
      el.scrollIntoView = function scrollIntoView() {
        const m = /^entry-(\d+)$/.exec(el.id);
        if (!m) return;
        const idx = parseInt(m[1], 10);
        if (idx >= holeLo - 5 && idx <= holeHi + 1) unlockHole = true;
        scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, idx * rowH));
        remount();
      };
    }
  }

  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => {
      const next = Math.max(0, Math.min(scrollHeight - clientHeight, Number(v) || 0));
      // sam scrollTop (brez sidra) luknje ne odklene
      scrollTop = next;
      remount();
    },
    configurable: true
  });
  remount();
  scroller.scrollTop = 0;
  const startTop = scroller.scrollTop;

  const trace = [];
  const parsed = await V.collectVisibleTranscript(doc, {
    timeoutMs: 20000, waitMs: 2, scrollEl: scroller, scrollTrace: trace, maxIters: 2000
  });
  assert.equal(parsed.stats.lines, total, 'pričakovanih ' + total + ' vrstic');
  assert.equal(parsed.entries[110].text, 'Vrstica 110');
  assert.equal(parsed.entries[114].text, 'Vrstica 114');
  assert.equal(scroller.scrollTop, startTop, 'scroll obnovljen');
  // monotonost velja za glavni prehod (trace); popravilo gre prek scrollIntoView
  const mid = trace.slice(1);
  for (let i = 1; i < mid.length; i++) {
    assert.ok(mid[i] + 0.01 >= mid[i - 1], 'nihanje v sledi: ' + mid[i - 1] + ' -> ' + mid[i]);
  }
  assert.ok(unlockHole, 'luknja mora biti odklenjena prek sidra');
});

test('assemble: preverjene ura/h oblike dajo popoln TXT', () => {
  const labels = [
    ['Speaker 0 min 7 s', 7000],
    ['Speaker 16 min', 960000],
    ['dr. Andreja Poljanec 16 min', 960000],
    ['Speaker 1 ura 12 s', 3612000],
    ['Speaker 1 ura 12 min', 4320000],
    ['Speaker 3 h 45 min', 13500000]
  ];
  const map = new Map();
  const total = labels.length;
  labels.forEach(([aria, ms], i) => {
    const p = V.parseAriaLabel(aria);
    assert.ok(p, aria);
    assert.equal(p.ms, ms);
    map.set(i, { index: i, text: 't' + i, speaker: p.speaker, timeMs: p.ms, setSize: total, ariaLabel: aria });
  });
  const parsed = V.assembleParsed(map, total);
  assert.equal(parsed.stats.lines, total);
  assert.match(T.toTxt(parsed), /Speaker: t0/);
  assert.match(T.toTxt(parsed), /dr\. Andreja Poljanec: t2/);
  assert.match(T.toVtt(parsed), /WEBVTT/);
});

test('probeVisiblePane', () => {
  const doc = makeDoc(`<div role="complementary" aria-label="Transcript">${entryHtml(0, 1, 'hi', { sec: 1 })}</div>`);
  assert.equal(V.probeVisiblePane(doc).available, true);
});


function eventEntryHtml(i, total, text) {
  // Opazovano: prazen aria-label, razred eventText-*, brez časovnega žiga / govorca.
  return `<div data-testid="entryRenderer"><div id="entry-${i}" role="group" aria-label=""><div id="sub-entry-${i}" role="listitem" class="eventText-abc123" aria-posinset="${i + 1}" aria-setsize="${total}">${text}</div></div></div>`;
}

test('harvest: eventText → event:true, brez časa; prazen aria brez razreda ostane TIME', () => {
  const total = 2;
  const html = entryHtml(0, total, 'Govor', { speaker: 'Ana', showHeader: true, showTs: true, sec: 7 })
    + eventEntryHtml(1, total, 'Oseba je zaustavila prepis');
  const doc = makeDoc(`<div role="complementary" aria-label="Prepis">${html}</div>`);
  const map = V.harvestMounted(V.findTranscriptRoot(doc), new Map());
  assert.equal(map.get(1).event, true);
  assert.equal(map.get(1).timeMs, null);
  assert.equal(map.get(1).text, 'Oseba je zaustavila prepis');
  assert.equal(map.get(0).event, false);
  assert.equal(V.hasEventTextClass(doc.querySelector('#sub-entry-1')), true);
  assert.throws(
    () => V.assembleParsed(new Map([[0, { index: 0, text: 'x', speaker: '', timeMs: null, setSize: 1, ariaLabel: '', event: false }]]), 1),
    /Manjka čas za vrstico 1/
  );
});

test('assemble + TXT/VTT: terminalni sistemski dogodek ohrani vsebino, govor oštevilčen', () => {
  const total = 3;
  const html = [
    entryHtml(0, total, 'Prva', { speaker: 'Ana', showHeader: true, showTs: true, sec: 7 }),
    entryHtml(1, total, 'Druga', { speaker: 'Ana', sec: 10 }),
    eventEntryHtml(2, total, 'Oseba je zaustavila prepis')
  ].join('');
  const doc = makeDoc(`<div role="complementary" aria-label="Prepis">${html}</div>`);
  const map = V.harvestMounted(V.findTranscriptRoot(doc), new Map());
  assert.equal(map.size, 3);
  const parsed = V.assembleParsed(map, total);
  assert.equal(parsed.stats.lines, 3);
  assert.equal(parsed.stats.events, 1);
  assert.equal(parsed.stats.skippedBadTime, 0);
  assert.equal(parsed.entries[2].systemEvent, true);
  assert.equal(parsed.entries[2].startMs, null);
  assert.equal(parsed.entries[2].endMs, null);
  assert.equal(parsed.entries[2].speaker, '');
  assert.equal(parsed.entries[2].text, 'Oseba je zaustavila prepis');
  assert.equal(parsed.entries[0].speaker, 'Ana');
  assert.equal(parsed.entries[1].speaker, 'Ana');
  assert.ok(Number.isFinite(parsed.entries[0].endMs));
  assert.ok(Number.isFinite(parsed.entries[1].startMs));
  // dogodek ne podeduje govorca in ne zlomi endMs prejšnje
  assert.equal(parsed.entries[1].endMs, parsed.entries[1].startMs + 1);
  const txt = T.toTxt(parsed);
  assert.match(txt, /\[0:00:07\] Ana: Prva/);
  assert.match(txt, /\[brez časa\] Sistemski dogodek: Oseba je zaustavila prepis/);
  assert.doesNotMatch(txt, /null|undefined/i);
  const vtt = T.toVtt(parsed);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /NOTE\nSistemski dogodek brez časa: Oseba je zaustavila prepis/);
  assert.doesNotMatch(vtt, /null|undefined/i);
  assert.doesNotMatch(vtt, /NaN/);
});

test('assemble: dogodek med govorom – endMs gre na naslednji časovni vnos', () => {
  const map = new Map([
    [0, { index: 0, text: 'a', speaker: 'A', timeMs: 1000, setSize: 3, event: false }],
    [1, { index: 1, text: 'Oseba je zaustavila prepis', speaker: '', timeMs: null, setSize: 3, event: true }],
    [2, { index: 2, text: 'b', speaker: 'B', timeMs: 5000, setSize: 3, event: false }]
  ]);
  const parsed = V.assembleParsed(map, 3);
  assert.equal(parsed.entries[0].endMs, 5000);
  assert.equal(parsed.entries[1].systemEvent, true);
  assert.equal(parsed.entries[2].speaker, 'B');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/lib/visibleTranscript.js');
const T = require('../src/lib/transcript.js');

/** Minimalen DOM za teste (brez jsdom). */
function makeDoc(html) {
  // linkedom if available, else very small recursive parser is heavy – use jsdom from /tmp if present
  let JSDOM;
  try { JSDOM = require('jsdom').JSDOM; }
  catch (e) {
    try { JSDOM = require('jsdom').JSDOM; }
    catch (e2) { throw new Error('jsdom ni na voljo za teste – namesti v /tmp/jsd'); }
  }
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true }).window.document;
}

function entryHtml(i, total, text, opts) {
  opts = opts || {};
  const speaker = opts.speaker || '';
  const min = opts.min != null ? opts.min : Math.floor((opts.sec || 0) / 60);
  const sec = opts.sec != null ? (opts.sec % 60) : 0;
  const ariaSpeaker = speaker || 'Govorec';
  const aria = `${ariaSpeaker} ${min} min ${sec} s`;
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
  assert.equal(V.parseVisibleTime('bad'), null);
  assert.deepEqual(V.parseAriaLabel('Ana Novak 0 min 7 s'), { speaker: 'Ana Novak', ms: 7000 });
  assert.deepEqual(V.parseAriaLabel('X 1 h 2 min 3 s'), { speaker: 'X', ms: 3723000 });
  assert.equal(V.parseAriaLabel('samo ime'), null);
});

test('harvest + assemble: govorec se prenese, čas iz aria, popoln 0..n-1', () => {
  const total = 4;
  const html = [
    entryHtml(0, total, 'Prva', { speaker: 'Ana', showHeader: true, showTs: true, sec: 7 }),
    entryHtml(1, total, 'Druga', { speaker: 'Ana', sec: 10 }),
    entryHtml(2, total, 'Tretja', { speaker: 'Bojan', showHeader: true, showTs: true, min: 1, sec: 5, tsLabel: '1:05' }),
    entryHtml(3, total, 'Četrta', { speaker: 'Bojan', min: 1, sec: 8 })
  ].join('');
  const doc = makeDoc(`<div role="complementary" aria-label="Prepis"><div id="scroller" style="overflow-y:auto;height:50px">${html}</div></div>`);
  // jsdom may not compute scroll – harvest still works
  const root = V.findTranscriptRoot(doc);
  const map = V.harvestMounted(root, new Map());
  assert.equal(map.size, 4);
  const parsed = V.assembleParsed(map, total);
  assert.equal(parsed.stats.lines, 4);
  assert.equal(parsed.stats.speakers, 2);
  assert.equal(parsed.stats.language, '');
  assert.equal(parsed.entries[0].speaker, 'Ana');
  assert.equal(parsed.entries[1].speaker, 'Ana'); // carry
  assert.equal(parsed.entries[1].startMs, 10000);
  assert.equal(parsed.entries[2].speaker, 'Bojan');
  const txt = T.toTxt(parsed);
  assert.match(txt, /\[0:00:07\] Ana: Prva/);
  assert.match(txt, /Bojan: Tretja/);
  assert.equal(txt.charCodeAt(0), 0xFEFF);
});

test('assemble: manjkajoči indeks -> napaka, brez delnega', () => {
  const doc = makeDoc(entryHtml(0, 3, 'a', { sec: 1 }) + entryHtml(2, 3, 'c', { sec: 3 }));
  const map = V.harvestMounted(doc, new Map());
  assert.throws(() => V.assembleParsed(map, 3), /Manjkajo indeksi/);
});

test('assemble: manjkajoč čas -> napaka', () => {
  const map = new Map([[0, { index: 0, text: 'x', speaker: '', timeMs: null, setSize: 1 }]]);
  assert.throws(() => V.assembleParsed(map, 1), /Manjka čas/);
});

test('aria-posinset mora ujemati indeks', () => {
  const bad = `<div data-testid="entryRenderer"><div id="entry-0" role="group" aria-label="A 0 min 1 s"><div id="sub-entry-0" role="listitem" aria-posinset="2" aria-setsize="1">x</div></div></div>`;
  const map = V.harvestMounted(makeDoc(bad), new Map());
  assert.equal(map.size, 0);
});

test('probeVisiblePane: Prepis / Transcript', () => {
  const doc = makeDoc(`<div role="complementary" aria-label="Transcript">${entryHtml(0, 1, 'hi', { sec: 1 })}</div>`);
  const p = V.probeVisiblePane(doc);
  assert.equal(p.available, true);
  assert.equal(p.setSize, 1);
  assert.equal(V.probeVisiblePane(makeDoc('<p>x</p>')).available, false);
});

test('collectVisibleTranscript: mock scroll napolni manjkajoče in obnovi scrollTop', async () => {
  // Virtuelni seznam: naenkrat samo "okno" vrstic; scrollTop določa, katere so nameščene.
  const total = 6;
  const JSDOM = require('jsdom').JSDOM;
  const dom = new JSDOM(`<!doctype html><html><body>
    <div role="complementary" aria-label="Prepis">
      <div id="scroller" style="overflow-y:scroll; height:40px;"></div>
    </div>
  </body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const scroller = doc.getElementById('scroller');
  // simulacija: scrollHeight velik
  Object.defineProperty(scroller, 'clientHeight', { get: () => 40, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 400, configurable: true });
  let scrollTop = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => { scrollTop = v; remount(); },
    configurable: true
  });
  function remount() {
    scroller.innerHTML = '';
    const start = Math.min(total - 1, Math.floor((scrollTop / 400) * total));
    const end = Math.min(total, start + 2);
    for (let i = start; i < end; i++) {
      scroller.insertAdjacentHTML('beforeend', entryHtml(i, total, 'Vrstica ' + i, {
        speaker: i < 3 ? 'A' : 'B', showHeader: i === 0 || i === 3, showTs: i === 0 || i === 3,
        sec: i * 5, min: 0, tsLabel: '0:' + String(i * 5).padStart(2, '0')
      }));
    }
  }
  remount();
  scroller.scrollTop = 120; // odmik od začetka
  const startTop = scroller.scrollTop;
  const parsed = await V.collectVisibleTranscript(doc, { timeoutMs: 5000, waitMs: 5, scrollEl: scroller });
  assert.equal(parsed.stats.lines, total);
  assert.equal(scroller.scrollTop, startTop, 'scroll obnovljen');
  assert.equal(parsed.entries[5].text, 'Vrstica 5');
});

test('collect: brez zavihka -> jasna napaka', async () => {
  await assert.rejects(() => V.collectVisibleTranscript(makeDoc('<p>x</p>'), { timeoutMs: 100 }), /Zavihek Prepis/);
});

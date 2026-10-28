'use strict';
// Pretvorniki JSON -> VTT/TXT, statistika in prepoznava zahteve za prepis (SINTETIČNI podatki, brez pravih vsebin predavanj).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/lib/transcript.js');

const FIX = path.join(__dirname, 'fixtures', 'transcript-synthetic.json');
const bytes = fs.readFileSync(FIX);

test('fixture se začne z UTF-8 BOM', () => {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('parseOffset: zaokroževanje 7-mestnih tickov na ms, ure >= 100', () => {
  assert.equal(T.parseOffset('00:00:07.1170000'), 7117);
  assert.equal(T.parseOffset('03:55:03.1234567'), ((3 * 60 + 55) * 60 + 3) * 1000 + 123);
  assert.equal(T.parseOffset('00:00:01.9999999'), 2000); // prenos pri zaokrožitvi
  assert.equal(T.parseOffset('00:01:05.5005000'), 65501); // .5005 -> 500.5 -> 501
  assert.equal(T.parseOffset('100:00:00.0000000'), 360000000);
  assert.equal(T.parseOffset('00:00:07'), 7000);
  assert.equal(T.parseOffset('abc'), null);
  assert.equal(T.parseOffset(null), null);
  assert.equal(T.parseOffset('00:61:00.0'), null);
});

test('formatiranje časa', () => {
  assert.equal(T.formatVttTime(7117), '00:00:07.117');
  assert.equal(T.formatVttTime(360000000), '100:00:00.000');
  assert.equal(T.formatTxtTime(7117), '0:00:07');
  assert.equal(T.formatTxtTime(14103123), '3:55:03');
});

test('parseTranscript: bajti z BOM in niz z BOM dasta enak rezultat; statistika', () => {
  const a = T.parseTranscript(bytes);
  const b = T.parseTranscript(bytes.toString('utf8')); // Node ohrani BOM v nizu
  assert.deepEqual(a, b);
  assert.equal(a.entries.length, 6); // prazno besedilo preskočeno
  assert.equal(a.stats.lines, 6);
  assert.equal(a.stats.skippedEmpty, 1);
  assert.equal(a.stats.speakers, 3); // Ana, gost, Boris (vrstica brez imena ima isti id kot Boris)
  assert.equal(a.stats.language, 'sl-si');
  assert.equal(T.describe(a.stats), '6 vrstic, 3 govorci, jezik sl-si');
});

test('parseTranscript: napačen vnos', () => {
  assert.throws(() => T.parseTranscript('<html>prijava</html>'), /JSON/);
  assert.throws(() => T.parseTranscript('{"entries": 5}'), /entries/);
  const empty = T.parseTranscript('\uFEFF{"entries":[]}');
  assert.equal(empty.stats.lines, 0);
  assert.equal(T.toVtt(empty), 'WEBVTT\n\n');
});

test('toVtt: točen izpis', () => {
  const vtt = T.toVtt(T.parseTranscript(bytes));
  const expected = [
    'WEBVTT',
    '',
    '00:00:07.117 --> 00:00:13.930',
    '<v Ana Novak>Dobrodošli na izmišljenem predavanju o čebelah.</v>',
    '',
    '00:00:13.930 --> 00:00:20.000',
    '<v Ana Novak>Čebele &lt;letijo&gt; &amp; žvrgolijo – šumniki: č, š, ž.</v>',
    '',
    '00:01:05.501 --> 00:01:09.000',
    '<v Gost Ena &amp; Drugi>Vprašanje iz dvorane: ali 3 &gt; 2?</v>',
    '',
    '00:02:00.000 --> 00:02:04.000',
    'Odgovor brez imena govorca.',
    '',
    '03:55:03.123 --> 03:55:10.000',
    '<v Boris Kranjc>Zadnja misel po skoraj štirih urah.</v>',
    '',
    '03:55:10.000 --> 03:55:11.000',
    '<v Ana Novak>Konec.</v>',
    ''
  ].join('\n');
  assert.equal(vtt, expected);
});

test('toTxt: točen izpis, BOM, CRLF, ena vrstica na vrstico', () => {
  const txt = T.toTxt(T.parseTranscript(bytes));
  assert.equal(txt.charCodeAt(0), 0xfeff);
  const expected = [
    '[0:00:07] Ana Novak: Dobrodošli na izmišljenem predavanju o čebelah.',
    '[0:00:13] Ana Novak: Čebele <letijo> & žvrgolijo – šumniki: č, š, ž.',
    '[0:01:05] Gost Ena & Drugi: Vprašanje iz dvorane: ali 3 > 2?',
    '[0:02:00] Odgovor brez imena govorca.',
    '[3:55:03] Boris Kranjc: Zadnja misel po skoraj štirih urah.',
    '[3:55:10] Ana Novak: Konec.',
    ''
  ].join('\r\n');
  assert.equal(txt, '\uFEFF' + expected);
  // UTF-8 bajti: BOM + šumniki pravilno kodirani
  const buf = Buffer.from(txt, 'utf8');
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(buf.includes(Buffer.from('čebelah', 'utf8')));
});

test('večvrstično besedilo: VTT ohrani vrstice brez praznih, TXT jih združi', () => {
  const p = T.parseTranscript(JSON.stringify({ entries: [
    { text: 'prva\r\n\r\n druga ', speakerDisplayName: 'A  B', startOffset: '00:00:01.0000000', endOffset: '00:00:02.0000000', speakerId: 'x' },
    { text: 'brez konca', speakerDisplayName: '', startOffset: '00:00:03.0000000', endOffset: 'neveljavno', speakerId: '' },
    { text: 'slab čas', startOffset: 'x', endOffset: 'y' },
    { text: 'prej', speakerDisplayName: 'C', startOffset: '00:00:00.5000000', endOffset: '00:00:00.9000000', speakerId: 'c' }
  ] }));
  assert.equal(p.stats.skippedBadTime, 1);
  assert.equal(p.stats.speakers, 2);
  const vtt = T.toVtt(p);
  assert.ok(vtt.includes('00:00:00.500 --> 00:00:00.900\n<v C>prej</v>'), 'razvrščeno po začetku');
  assert.ok(vtt.includes('<v A B>prva\ndruga</v>'));
  assert.ok(vtt.includes('00:00:03.000 --> 00:00:03.001\nbrez konca'));
  assert.ok(T.toTxt(p).includes('[0:00:01] A B: prva druga\r\n'));
});

test('slovenska množina', () => {
  const f = ['vrstica', 'vrstici', 'vrstice', 'vrstic'];
  const got = [1, 2, 3, 4, 5, 11, 12, 14, 21, 101, 102, 1214].map((n) => T.plural(n, f));
  assert.deepEqual(got, ['vrstica', 'vrstici', 'vrstice', 'vrstice', 'vrstic', 'vrstic', 'vrstic', 'vrstic', 'vrstic', 'vrstica', 'vrstici', 'vrstic']);
  assert.equal(T.describe({ lines: 1214, speakers: 12, language: 'sl-si' }), '1214 vrstic, 12 govorcev, jezik sl-si');
});

const BASE = 'https://fake-my.sharepoint.com/personal/u_fake/_api/v2.1/drives/b!drive/items/ITEM/media/transcripts/TID/streamContent';
test('matchViewRequest: samo format=json pogled predvajalnika', () => {
  const ok = BASE + '?format=json&applyhighlights=false&applymediaedits=false';
  assert.deepEqual(T.matchViewRequest(ok, 'GET'), { transcriptId: 'TID' });
  assert.deepEqual(T.matchViewRequest(ok), { transcriptId: 'TID' });
  assert.deepEqual(T.matchViewRequest(ok.replace('format=json', 'format=JSON')), { transcriptId: 'TID' });
  // vse drugo je prepovedano
  assert.equal(T.matchViewRequest(BASE + '?format=vtt'), null);
  assert.equal(T.matchViewRequest(BASE + '?format=docx'), null);
  assert.equal(T.matchViewRequest(BASE), null);
  assert.equal(T.matchViewRequest(ok, 'POST'), null);
  assert.equal(T.matchViewRequest(ok.replace('/streamContent', '/download') ), null);
  assert.equal(T.matchViewRequest(ok.replace('/media/transcripts/TID/streamContent', '/media/transcripts')), null);
  assert.equal(T.matchViewRequest(ok.replace('fake-my.sharepoint.com', 'evil.example.com')), null);
  assert.equal(T.matchViewRequest(ok.replace('https:', 'http:')), null);
  assert.equal(T.matchViewRequest('not a url'), null);
});

test('popravek kodiranja: èe/Èe/èetudi/ëe → če/Če/četudi/že v TXT in VTT (besedilo + govorec), šumniki nespremenjeni', () => {
  assert.equal(T.fixEncoding('Èe danes, èetudi, ëe no'), 'Če danes, četudi, že no');
  assert.equal(T.fixEncoding('ËENO ëeno ÈE'), 'ŽENO ženo ČE');
  const ok = 'Čebele šumijo, žuželke ščebetajo – Ž Š Č č š ž ć đ é';
  assert.equal(T.fixEncoding(ok), ok);
  const mk = (text, name) => JSON.stringify({ entries: [{ text, speakerDisplayName: name, speakerId: 's1', startOffset: '00:00:01.0000000', endOffset: '00:00:02.0000000', spokenLanguageTag: 'sl-si' }] });
  const p = T.parseTranscript(mk('Èe danes, èetudi, ëe no. Šum & žuželke.', 'Ëiga Èuk'));
  assert.equal(p.entries[0].text, 'Èe danes, èetudi, ëe no. Šum & žuželke.', 'razčlenjeni podatki ostanejo nespremenjeni');
  assert.equal(T.toTxt(p), '\uFEFF[0:00:01] Žiga Čuk: Če danes, četudi, že no. Šum & žuželke.\r\n');
  assert.equal(T.toVtt(p), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Žiga Čuk>Če danes, četudi, že no. Šum &amp; žuželke.</v>\n');
});

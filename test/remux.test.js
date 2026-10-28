'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { DOMParser } = require('@xmldom/xmldom');
const M = require('../src/lib/mpd.js');
const E = require('../src/lib/engine.js');
const Mp4 = require('../src/lib/mp4.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function topTypes(buf) {
  const types = {};
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = Mp4.u32(buf, p);
    const type = Mp4.fourcc(buf, p + 4);
    if (size < 8) break;
    types[type] = (types[type] || 0) + 1;
    p += size;
  }
  return types;
}

test('defragmentToProgressive: fMP4+mfra → ftyp+moov+mdat with audio+video', {
  skip: !hasFfmpeg && 'ffmpeg not installed'
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-remux-'));
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-sc_threshold', '0',
    '-c:a', 'aac', '-f', 'dash', '-seg_duration', '2',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    path.join(dir, 'manifest.mpd')]);

  let mpdXml = fs.readFileSync(path.join(dir, 'manifest.mpd'), 'utf8');
  mpdXml = mpdXml.replace(/<BaseURL>[^<]*<\/BaseURL>/g, '');
  if (!/<BaseURL>/i.test(mpdXml)) mpdXml = mpdXml.replace('<Period', '<BaseURL>https://x/dash/</BaseURL><Period');
  const parsed2 = M.parseMpd(mpdXml, 'https://x/dash/manifest.mpd', DOMParser);
  const tracks = M.selectTracks(parsed2, 'av');
  assert.equal(tracks.length, 2);

  const files = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  const fetcher = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    const data = files[name];
    if (!data) return { status: 404, retryAfter: null, buffer: null };
    return { status: 200, retryAfter: null, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  const fragPath = path.join(dir, 'frag.mp4');
  const fd = fs.openSync(fragPath, 'w');
  await E.runDownload({
    tracks, fetchBytes: fetcher,
    sink: { write: async (u8) => fs.writeSync(fd, u8), close: async () => fs.closeSync(fd) },
    concurrency: 4, durationSec: 6
  });
  const frag = new Uint8Array(fs.readFileSync(fragPath));
  assert.equal(Mp4.isFragmented(frag), true);
  assert.ok(topTypes(frag).moof >= 2);
  assert.ok(topTypes(frag).mfra === 1);

  const flat = Mp4.defragmentToProgressive(frag);
  assert.equal(Mp4.isFragmented(flat), false);
  assert.deepEqual(topTypes(flat), { ftyp: 1, moov: 1, mdat: 1 });

  const flatPath = path.join(dir, 'flat.mp4');
  fs.writeFileSync(flatPath, flat);
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', flatPath
  ]));
  assert.deepEqual(probe.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
  assert.ok(Number(probe.format.duration) > 5 && Number(probe.format.duration) < 7);
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', flatPath, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal((dec.stderr || '').trim(), '');

  // Optional: ffmpeg -c copy -movflags +faststart should accept our flat file cleanly
  const fsPath = path.join(dir, 'faststart.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', flatPath, '-c', 'copy', '-movflags', '+faststart', fsPath]);
  const probe2 = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', fsPath
  ]));
  assert.deepEqual(probe2.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
});

test('defragment is no-op on already-progressive MP4', () => {
  // minimal: just ftyp+free — isFragmented false
  const ftyp = Mp4.box('ftyp', [new TextEncoder().encode('isom'), new Uint8Array(4), new TextEncoder().encode('isom')]);
  assert.equal(Mp4.isFragmented(ftyp), false);
  const out = Mp4.defragmentToProgressive(ftyp);
  assert.equal(out.byteLength, ftyp.byteLength);
});

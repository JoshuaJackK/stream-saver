'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { DOMParser } = require('@xmldom/xmldom');
const M = require('../src/lib/mpd.js');
const E = require('../src/lib/engine.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const BASE = 'https://northeurope1-mediap.svc.ms/transform/videomanifest?provider=spo&part=index&format=dash';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('Stream quirk: both AS mimeType=video/mp4 — audio still detected via codecs/URL', () => {
  const p = M.parseMpd(fx('stream-videomp4-both.mpd'), BASE, DOMParser);
  const summary = M.trackSummary(p);
  assert.equal(summary.hasVideo, true);
  assert.equal(summary.hasAudio, true);
  assert.deepEqual(p.tracks.map((t) => t.type).sort(), ['audio', 'video']);
  const sel = M.selectTracks(p, 'av');
  assert.equal(sel.length, 2);
  assert.equal(sel[0].type, 'video');
  assert.equal(sel[0].id, 'vhigh'); // best quality
  assert.equal(sel[1].type, 'audio');
  assert.equal(sel[1].id, 'audcopy');
  assert.match(sel[1].initUrl, /track=audio/);
  assert.match(sel[0].initUrl, /track=video/);
  assert.equal(sel[0].segments.length, 11);
  assert.equal(sel[1].segments.length, 11);
});

test('mixed AdaptationSet yields both video and audio tracks', () => {
  const p = M.parseMpd(fx('stream-mixed-as.mpd'), 'https://h/dash/manifest.mpd', DOMParser);
  assert.deepEqual(M.selectTracks(p, 'av').map((t) => t.type), ['video', 'audio']);
  assert.equal(M.selectTracks(p, 'av')[1].id, 'a');
});

test('buildTranscodeTracks pairs video+audio by track=/quality=', () => {
  const base = 'https://example-my.sharepoint.com/_api_cached/v2.1/drives/b!d/items/01X/oneDrive.transcode?version=Published&P1=1&P2=2&P3=3&P4=x&format=fmp4&enableEncryption=1';
  const urls = [
    base + '&part=initsegment&track=video&quality=vhigh',
    base + '&part=mediasegment&track=video&quality=vhigh&segmentTime=0&wsd=20000000&ppd=100000000&ppst=0',
    base + '&part=initsegment&quality=audcopy', // no track= — infer from quality=
    base + '&part=mediasegment&quality=audcopy&segmentTime=0&wsd=20000000&ppd=100000000&ppst=0',
  ];
  const tr = M.buildTranscodeTracks(urls, 'av');
  assert.deepEqual(tr.map((t) => t.type), ['video', 'audio']);
  assert.equal(tr[1].id, 'audcopy');
  assert.equal(tr[0].segments.length, 5);
  assert.equal(tr[1].segments.length, 5);
  assert.equal(tr[0].segments[1].time, 2); // normalized to seconds
});

test('e2e: Stream-shaped MPD (video/mp4 on both) muxes to file WITH audio', {
  skip: !hasFfmpeg && 'ffmpeg not installed'
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-aud-'));
  // Generate separate video-only and audio-only fMP4 DASH sets, then rewrite their
  // paths into a Stream-like MPD that mislabels audio as mimeType=video/mp4.
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=9',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-sc_threshold', '0', '-an',
    '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
    '-init_seg_name', 'v-init.m4s', '-media_seg_name', 'v-$Number%05d$.m4s',
    path.join(dir, 'v.mpd')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=9',
    '-c:a', 'aac', '-b:a', '96k', '-vn',
    '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
    '-init_seg_name', 'a-init.m4s', '-media_seg_name', 'a-$Number%05d$.m4s',
    path.join(dir, 'a.mpd')]);

  // Count segments produced
  const vSegs = fs.readdirSync(dir).filter((f) => /^v-\d+\.m4s$/.test(f)).sort();
  const aSegs = fs.readdirSync(dir).filter((f) => /^a-\d+\.m4s$/.test(f)).sort();
  assert.ok(vSegs.length >= 4 && aSegs.length >= 4, `segs v=${vSegs.length} a=${aSegs.length}`);

  // Build Stream-like MPD pointing at these files via oneDrive.transcode-shaped relative URLs
  // (we serve them from a fake host path mapped to dir).
  function timeline(count, dur = 20000000) {
    // first count-1 full + last maybe same
    return `<S t="0" d="${dur}" r="${count - 1}"/>`;
  }
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT9S">
  <Period>
    <BaseURL>https://example-my.sharepoint.com/dash/</BaseURL>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="10000000"
        initialization="v-init.m4s"
        media="v-$Number%05d$.m4s">
        <SegmentTimeline>${timeline(vSegs.length)}</SegmentTimeline>
      </SegmentTemplate>
      <Representation id="vhigh" bandwidth="800000" codecs="avc1.64001F" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet mimeType="video/mp4" lang="sl">
      <SegmentTemplate timescale="10000000"
        initialization="a-init.m4s"
        media="a-$Number%05d$.m4s">
        <SegmentTimeline>${timeline(aSegs.length)}</SegmentTimeline>
      </SegmentTemplate>
      <Representation id="audcopy" bandwidth="96000" codecs="mp4a.40.2" audioSamplingRate="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const parsed = M.parseMpd(mpd, 'https://example-my.sharepoint.com/dash/manifest.mpd', DOMParser);
  assert.equal(M.trackSummary(parsed).hasAudio, true, 'parser must see audio despite video/mp4 mime');
  const tracks = M.selectTracks(parsed, 'av');
  assert.equal(tracks.length, 2);

  const files = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  const fetcher = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    const data = files[name];
    if (!data) return { status: 404, retryAfter: null, buffer: null };
    return { status: 200, retryAfter: null, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  const out = path.join(dir, 'out.mp4');
  const fd = fs.openSync(out, 'w');
  const sink = { write: async (u8) => fs.writeSync(fd, u8), close: async () => fs.closeSync(fd) };
  await E.runDownload({ tracks, fetchBytes: fetcher, sink, concurrency: 4, durationSec: 9 });

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', out]));
  const types = probe.streams.map((x) => x.codec_type).sort();
  assert.deepEqual(types, ['audio', 'video'], 'muxed output must contain an audio stream — was: ' + JSON.stringify(probe.streams));
  const err = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal((err.stderr || '').trim(), '');
});

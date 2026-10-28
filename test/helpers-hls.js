'use strict';
// Skupna oprema za HLS teste: sintetični fixture-i (ffmpeg), lažni strežnik z Range, pomožniki za ffprobe.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const BASE = 'https://cdn.example.com/hls/';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function ff(args) { execFileSync('ffmpeg', ['-v', 'error', '-y'].concat(args), { stdio: ['ignore', 'ignore', 'inherit'] }); }
function src(w, h, dur) {
  return ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', String(dur)];
}
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k'];

function mkdir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/** Ustvari vse fixture-e; vrne mapo. Vsak posnetek je dolg 8 s (4 segmenti po 2 s). */
function buildFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hls-'));
  // 1) MPEG-TS, muxed, dve varianti + master
  mkdir(path.join(dir, 'ts'));
  ff(src(320, 180, 8).concat(H264, ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'ts/low%d.ts'), path.join(dir, 'ts/low.m3u8')]));
  ff(src(480, 270, 8).concat(H264, ['-b:v', '600k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'ts/high%d.ts'), path.join(dir, 'ts/high.m3u8')]));
  fs.writeFileSync(path.join(dir, 'ts/master.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.64000c,mp4a.40.2"', 'low.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=50000,RESOLUTION=480x270,URI="iframes.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=480x270,CODECS="avc1.64001e,mp4a.40.2"', 'high.m3u8', ''].join('\n'));
  // 2) fMP4: muxed (en init z dvema sledema)
  mkdir(path.join(dir, 'fm'));
  ff(src(320, 180, 8).concat(H264, ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(dir, 'fm/f%d.m4s'), path.join(dir, 'fm/media.m3u8')]));
  // 3) fMP4: ločen zvok (EXT-X-MEDIA)
  mkdir(path.join(dir, 'sep'));
  ff(src(320, 180, 8).concat(H264, ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes', '-master_pl_name', 'master.m3u8',
    '-hls_segment_filename', path.join(dir, 'sep/s%v_%d.m4s'), path.join(dir, 'sep/p%v.m3u8')]));
  // 4) TS z ločenim zvokom (ffmpeg: zvok v samostojnih .ts)
  mkdir(path.join(dir, 'tssep'));
  ff(src(320, 180, 8).concat(H264, ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes', '-master_pl_name', 'master.m3u8',
    '-hls_segment_filename', path.join(dir, 'tssep/s%v_%d.ts'), path.join(dir, 'tssep/p%v.m3u8')]));
  // 4b) TS, kjer se zvok začne 0,6 s po videu
  mkdir(path.join(dir, 'tsoff'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-itsoffset', '0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '8'].concat(H264, ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'tsoff/s%d.ts'), path.join(dir, 'tsoff/p.m3u8')]));
  // 5) AES-128 (TS, šifrira ffmpeg): z IV-jem in z IV iz zaporedne številke (start_number 5)
  mkdir(path.join(dir, 'aes'));
  const key = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'aes/k.bin'), key);
  fs.writeFileSync(path.join(dir, 'aes/ki1.txt'), `${BASE}aes/k.bin\n${path.join(dir, 'aes/k.bin')}\n00112233445566778899aabbccddeeff\n`);
  fs.writeFileSync(path.join(dir, 'aes/ki2.txt'), `${BASE}aes/k.bin\n${path.join(dir, 'aes/k.bin')}\n`);
  ff(src(320, 180, 6).concat(H264, ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', path.join(dir, 'aes/ki1.txt'), '-hls_segment_filename', path.join(dir, 'aes/a%d.ts'), path.join(dir, 'aes/a.m3u8')]));
  ff(src(320, 180, 6).concat(H264, ['-f', 'hls', '-hls_time', '2', '-start_number', '5', '-hls_playlist_type', 'vod', '-hls_key_info_file', path.join(dir, 'aes/ki2.txt'), '-hls_segment_filename', path.join(dir, 'aes/b%d.ts'), path.join(dir, 'aes/b.m3u8')]));
  // IV iz zaporedne številke: odstrani atribut IV (ffmpeg je uporabil številko kot IV)
  fs.writeFileSync(path.join(dir, 'aes/b-noiv.m3u8'), fs.readFileSync(path.join(dir, 'aes/b.m3u8'), 'utf8').replace(/,IV=0x[0-9a-f]+/i, ''));
  // 5b) AES-128 nad fMP4: šifriramo sami (tudi inicializacijski segment, kot zahteva specifikacija)
  const fmsrc = path.join(dir, 'fm');
  mkdir(path.join(dir, 'aesfm'));
  const iv = crypto.randomBytes(16);
  const enc = (buf, ivb) => { const c = crypto.createCipheriv('aes-128-cbc', key, ivb); return Buffer.concat([c.update(buf), c.final()]); };
  const ivOfSeq = (n) => { const b = Buffer.alloc(16); b.writeUInt32BE(n, 12); return b; };
  fs.writeFileSync(path.join(dir, 'aesfm/init.mp4'), enc(fs.readFileSync(path.join(fmsrc, 'init.mp4')), iv));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:3', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-KEY:METHOD=AES-128,URI="${BASE}aes/k.bin",IV=0x${iv.toString('hex')}`, '#EXT-X-MAP:URI="init.mp4"',
    // od drugega segmenta naprej: ključ brez IV (IV = zaporedna številka)
  ];
  const names = fs.readdirSync(fmsrc).filter((n) => /^f\d+\.m4s$/.test(n)).sort();
  names.forEach((n, i) => {
    if (i === 1) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${BASE}aes/k.bin"`);
    const seq = 3 + i;
    const data = fs.readFileSync(path.join(fmsrc, n));
    fs.writeFileSync(path.join(dir, 'aesfm', n), enc(data, i === 0 ? iv : ivOfSeq(seq)));
    lines.push('#EXTINF:2.000000,', n);
  });
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, 'aesfm/media.m3u8'), lines.join('\n'));
  // 6) DRM (SAMPLE-AES, FairPlay) – segmenti so lahko kar navadni; razširitev mora zavrniti še pred prenosom
  mkdir(path.join(dir, 'drm'));
  const tsPl = fs.readFileSync(path.join(dir, 'ts/low.m3u8'), 'utf8');
  fs.writeFileSync(path.join(dir, 'drm/sample.m3u8'), tsPl.replace('#EXTINF', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF').replace(/low(\d)\.ts/g, '../ts/low$1.ts'));
  fs.writeFileSync(path.join(dir, 'drm/widevine.m3u8'), tsPl.replace('#EXTINF', '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF').replace(/low(\d)\.ts/g, '../ts/low$1.ts'));
  fs.writeFileSync(path.join(dir, 'drm/master.m3u8'), '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-STREAM-INF:BANDWIDTH=300000\n../ts/low.m3u8\n');
  // 7) živi prenos
  fs.writeFileSync(path.join(dir, 'ts/live.m3u8'), tsPl.replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '').replace('#EXT-X-ENDLIST\n', ''));
  // 8) CENC (Widevine/PlayReady podobna šifra) v fMP4 – ffmpeg zapiše encv/sinf; init mora biti zavrnjen
  mkdir(path.join(dir, 'cenc'));
  ff(src(320, 180, 4).concat(['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p', '-an', '-encryption_scheme', 'cenc-aes-ctr',
    '-encryption_key', '00112233445566778899aabbccddeeff', '-encryption_kid', 'ffeeddccbbaa99887766554433221100',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', path.join(dir, 'cenc/all.mp4')]));
  const all = fs.readFileSync(path.join(dir, 'cenc/all.mp4'));
  const Mp4 = require('../src/lib/mp4.js');
  const top = Mp4.boxes(new Uint8Array(all));
  const firstMoof = top.find((b) => b.type === 'moof');
  fs.writeFileSync(path.join(dir, 'cenc/init.mp4'), all.subarray(0, firstMoof.start));
  fs.writeFileSync(path.join(dir, 'cenc/seg0.m4s'), all.subarray(firstMoof.start));
  fs.writeFileSync(path.join(dir, 'cenc/media.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg0.m4s\n#EXT-X-ENDLIST\n');
  // 9) HEVC v MPEG-TS (pretvorba v MP4 ni podprta → surov .ts)
  mkdir(path.join(dir, 'hevc'));
  ff(src(320, 180, 6).concat(['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'hevc/h%d.ts'), path.join(dir, 'hevc/h.m3u8')]));
  // 10) navadna datoteka (progressive)
  mkdir(path.join(dir, 'prog'));
  ff(src(320, 180, 6).concat(H264, ['-movflags', '+faststart', path.join(dir, 'prog/video.mp4')]));
  return dir;
}

/** Lažni strežnik: bere datoteke iz dir; podpira Range; šteje zahteve. */
function makeFetcher(dir, opts) {
  opts = opts || {};
  const log = [];
  const f = async (url, o) => {
    log.push({ url, range: o && o.range });
    if (!url.startsWith(BASE)) return { status: 404, retryAfter: null, buffer: null };
    const rel = decodeURIComponent(new URL(url).pathname.replace('/hls/', ''));
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) return { status: 404, retryAfter: null, buffer: null };
    if (opts.throttleEvery && log.length % opts.throttleEvery === 0) return { status: 429, retryAfter: '0', buffer: null };
    const data = fs.readFileSync(file);
    if (o && o.range && !opts.noRange) {
      const [a, b] = o.range.split('-').map(Number);
      const end = Math.min(b, data.length - 1);
      const part = data.subarray(a, end + 1);
      return { status: 206, retryAfter: null, contentRange: `bytes ${a}-${end}/${data.length}`, buffer: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    }
    return { status: 200, retryAfter: null, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  f.log = log;
  return f;
}

function sinkToFile(file) {
  const fd = fs.openSync(file, 'w');
  return { write: async (u8) => { fs.writeSync(fd, u8); }, close: async () => fs.closeSync(fd) };
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time,width,height:format=duration', '-of', 'json', file]);
  return JSON.parse(out);
}
function decodeErrors(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return (r.stderr || '').trim();
}

module.exports = { BASE, hasFfmpeg, buildFixtures, makeFetcher, sinkToFile, probe, decodeErrors };

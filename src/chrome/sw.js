/* Stream Saver (Chrome MV3) – Service Worker vstopna točka. */
'use strict';

importScripts(
  '../lib/compat.js',
  'xml-shim.js',
  '../lib/blob-bridge.js',
  '../lib/mpd.js',
  '../lib/mp4.js',
  '../lib/ts.js',
  '../lib/engine.js',
  '../lib/hls.js',
  '../lib/hlsdl.js',
  '../lib/detect.js',
  '../lib/sink.js',
  '../lib/transcript.js',
  '../lib/visibleTranscript.js',
  '../background-generic.js',
  '../background.js'
);

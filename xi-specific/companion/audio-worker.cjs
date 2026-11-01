'use strict';
// Fixed local WAV -> speech transcript worker. No URLs, shell, downloads, or provider calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SAMPLE_RATE = 16000;
const MAX_SEGMENT_SECONDS = 30;
const MAX_TEXT = 4000;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// The JS realpath walker probes inaccessible ancestor directories under AppContainer.
// Native resolution succeeds on the granted file handle without weakening the path check.
const real = fs.realpathSync.native;

function readRegular(file, root, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit ||
      !real(file).startsWith(real(root) + path.sep)) throw Error('unsafe-audio-artifact');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size) throw Error('unsafe-audio-artifact');
    const bytes = Buffer.alloc(opened.size);
    let at = 0;
    while (at < bytes.length) { const n = fs.readSync(fd, bytes, at, bytes.length - at, at); if (!n) throw Error('short-audio-artifact'); at += n; }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function parsePcmWav(bytes, maxSeconds = MAX_SEGMENT_SECONDS) {
  const invalid = (reason, extra = {}) => {
    const error = Error('invalid-pcm-wav:' + reason);
    error.pcm_diagnostics = {reason, bytes: Buffer.isBuffer(bytes) ? bytes.length : null, ...extra};
    throw error;
  };
  if (!Buffer.isBuffer(bytes) || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 30 ||
      bytes.length < 44 || bytes.length > Math.ceil(maxSeconds * SAMPLE_RATE) * 2 + 65536 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('header');
  let format = null, data = null, at = 12;
  while (at + 8 <= bytes.length) {
    const type = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    if (start + size > bytes.length) invalid('chunk-bound');
    if (type === 'fmt ') {
      if (format || size < 16) invalid('format-chunk');
      format = {kind: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bytesPerSecond: bytes.readUInt32LE(start + 8), align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14)};
    }
    if (type === 'data') { if (data) invalid('data-chunk'); data = bytes.subarray(start, start + size); }
    at = start + size + (size & 1);
  }
  if (at !== bytes.length) invalid('trailing-bytes');
  if (!format || !data) invalid('missing-format-or-data');
  if (format.kind !== 1 || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16 || format.align !== 2 || format.bytesPerSecond !== 32000) invalid('format', format);
  if (data.length % 2) invalid('sample-alignment', {data_bytes: data.length});
  if (data.length > Math.ceil(maxSeconds * SAMPLE_RATE) * 2) invalid('sample-bound', {data_bytes: data.length, samples: data.length / 2, max_samples: Math.ceil(maxSeconds * SAMPLE_RATE)});
  const samples = new Float32Array(data.length / 2);
  let nonzero = false;
  for (let i = 0; i < samples.length; i++) { const value = data.readInt16LE(i * 2); samples[i] = value / 32768; nonzero ||= value !== 0; }
  return {samples, seconds: samples.length / SAMPLE_RATE, silent_pcm: !nonzero, sha256: sha(bytes)};
}

function validateJob(job) {
  if (job?.version !== 1 || !['auto','zh','en','ja','ko','yue'].includes(job.language) ||
      !Array.isArray(job.segments) || job.segments.length < 1 || job.segments.length > 10) throw Error('invalid-audio-job');
  if (!Number.isFinite(job.source_duration_seconds) || job.source_duration_seconds <= 0 ||
      !Number.isFinite(job.start_seconds) || job.start_seconds < 0 || job.start_seconds >= job.source_duration_seconds) throw Error('invalid-audio-job');
  let end = job.start_seconds, seconds = 0;
  for (let i = 0; i < job.segments.length; i++) {
    const segment = job.segments[i];
    if (segment.file !== `clip-${i}.wav` || !Number.isFinite(segment.start_seconds) || Math.abs(segment.start_seconds - end) > 1e-7 || !Number.isFinite(segment.seconds) ||
        segment.seconds <= 0 || segment.seconds > 30) throw Error('invalid-audio-job');
    end += segment.seconds; seconds += segment.seconds;
  }
  if (seconds > 300 || end > job.source_duration_seconds + 1 / SAMPLE_RATE || !/^[a-f0-9]{64}$/.test(job.media_sha256)) throw Error('invalid-audio-job');
  return job;
}

async function transcribeWavs(job, {root = process.cwd(), native} = {}) {
  validateJob(job);
  // The pinned addon and model files are copied into the read-only runtime, never supplied by media.
  let addon;
  try { addon = native ?? require(path.join(__dirname, 'sherpa-onnx.node')); }
  catch { throw Error('audio-asr-native-load-failed'); }
  let recognizer = null, totalText = 0;
  const segments = [];
  for (const segment of job.segments) {
    let bytes;
    try { bytes = readRegular(path.join(root, segment.file), root, Math.ceil(segment.seconds * 32000) + 65536); }
    catch (error) { if (['unsafe-audio-artifact','short-audio-artifact'].includes(error.message)) throw error; throw Error('audio-wav-read-failed'); }
    const wav = parsePcmWav(bytes, segment.seconds);
    let text = '', state = 'silent_pcm';
    if (!wav.silent_pcm && wav.samples.length) {
      if (!recognizer) try { recognizer = await addon.createOfflineRecognizerAsync({
        featConfig: {sampleRate: SAMPLE_RATE, featureDim: 80},
        modelConfig: {senseVoice: {model: path.join(__dirname, 'model.int8.onnx'), language: job.language, useInverseTextNormalization: 1},
          tokens: path.join(__dirname, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0},
      }); } catch { throw Error('audio-asr-model-load-failed'); }
      let stream;
      try { stream = addon.createOfflineStream(recognizer); addon.acceptWaveformOffline(stream, {samples: wav.samples, sampleRate: SAMPLE_RATE}); }
      catch { throw Error('audio-asr-stream-failed'); }
      let result;
      try { result = JSON.parse(await addon.decodeOfflineStreamAsync(recognizer, stream)); }
      catch { throw Error('audio-asr-decode-failed'); }
      if (!result || typeof result.text !== 'string') throw Error('invalid-asr-result');
      text = result.text.replace(/<\|[^|>]*\|>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
      if (text.length > MAX_TEXT || (totalText += text.length) > 16000) throw Error('audio-transcript-text-limit');
      state = text ? 'transcribed' : 'no_transcript';
    }
    segments.push({start_ms: Math.round(segment.start_seconds * 1000), end_ms: Math.round((segment.start_seconds + wav.seconds) * 1000),
      text, state, wav_sha256: wav.sha256, samples: wav.samples.length});
  }
  // Empty ASR output is not evidence that speech was absent. PCM silence only describes samples.
  return {version: 1, kind: 'speech-transcript', media_sha256: job.media_sha256, sample_rate: SAMPLE_RATE,
    alignment: 'segment-window-not-word-timestamps', audio_understood: false, non_speech_understood: false, segments};
}

module.exports = {parsePcmWav, readRegular, validateJob, transcribeWavs};

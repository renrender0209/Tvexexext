/**
 * resolver.js  –  googlevideo.com URL resolver
 *
 * Strategy (tried in order until one succeeds):
 *   1. yt-dlp  android_vr  client  (fast, no JS challenge)
 *   2. yt-dlp  android     client  (fallback)
 *   3. yt-dlp  tv          client  (fallback)
 *   4. yt-dlp  web         client  (slowest; needs JS solver)
 *   5. Piped API instances  (parallel)
 *   6. Invidious API instances  (parallel)
 */

'use strict';

import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import pLimit from 'p-limit';
import { instanceManager } from './instances.js';

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PARALLEL = 8;
const YTDLP_TIMEOUT_MS = 28000;

// ─── Quality helpers ──────────────────────────────────────────────────────────
export function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input.startsWith('http') ? input : `https://${input}`);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    const v = url.searchParams.get('v');
    if (v) return v;
    const m = url.pathname.match(/\/(embed|shorts|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  } catch {
    const m = input.match(/(?:v=|\/)([\w-]{11})(?:[?&]|$)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Build the yt-dlp -f selector for a given quality label.
 *  best   → tries 1080p→720p→480p→360p muxed or split+audio
 *  audio  → best audio only
 *  NNNp   → specific height
 */
function buildFormatSelector(quality) {
  if (quality === 'audio') {
    return 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';
  }
  if (quality === 'best') {
    // Try split formats first (better quality), then muxed 360p itag18 as last resort
    return [
      'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]',
      'bestvideo[height<=1080]+bestaudio',
      '18', // 360p muxed – always available without PO token on android_vr
    ].join('/');
  }
  const h = parseInt(quality);
  if (!isNaN(h)) {
    return [
      `bestvideo[ext=mp4][height<=${h}]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${h}]+bestaudio`,
      `best[height<=${h}]`,
      '18',
    ].join('/');
  }
  return 'bestvideo+bestaudio/best/18';
}

// ─── yt-dlp single attempt ────────────────────────────────────────────────────
/**
 * @param {string} videoId
 * @param {string} playerClient  e.g. 'android_vr', 'android', 'tv', 'web'
 * @param {string} quality
 * @param {boolean} allStreams
 */
async function ytDlpAttempt(videoId, playerClient, quality, allStreams) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const extractorArgs = `youtube:player_client=${playerClient}`;

  if (allStreams) {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '--extractor-args', extractorArgs,
        ytUrl,
      ],
      { timeout: YTDLP_TIMEOUT_MS },
    );
    const info = JSON.parse(stdout.trim());

    const allFmts = (info.formats || []).filter(
      (f) => f.url && (f.url.includes('googlevideo.com') || f.url.includes('youtube.com/videoplayback')),
    );
    if (allFmts.length === 0) throw new Error(`[${playerClient}] No googlevideo URLs in dump-json`);

    const videoStreams = allFmts
      .filter((f) => f.vcodec && f.vcodec !== 'none')
      .map((f) => ({
        url: f.url,
        quality: f.format_note || (f.height ? `${f.height}p` : ''),
        resolution: f.width && f.height ? `${f.width}x${f.height}` : '',
        bitrate: f.tbr ? Math.round(f.tbr * 1000) : 0,
        mimeType: f.ext ? `video/${f.ext}` : '',
        codec: f.vcodec || '',
        format: f.ext || '',
        fps: f.fps || 0,
        width: f.width || 0,
        height: f.height || 0,
        videoOnly: f.acodec === 'none',
      }));

    const audioStreams = allFmts
      .filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
      .map((f) => ({
        url: f.url,
        quality: f.format_note || (f.abr ? `${Math.round(f.abr)}kbps` : ''),
        bitrate: f.abr ? Math.round(f.abr * 1000) : 0,
        mimeType: f.ext ? `audio/${f.ext}` : '',
        codec: f.acodec || '',
        format: f.ext || '',
        videoOnly: false,
      }));

    return {
      source: `yt-dlp:${playerClient}`,
      sourceType: 'yt-dlp',
      playerClient,
      title: info.title || '',
      duration: info.duration || 0,
      thumbnailUrl: info.thumbnail || '',
      uploader: info.uploader || '',
      hls: null,
      dash: null,
      videoStreams,
      audioStreams,
    };
  }

  // Fast path: --get-url
  const fmt = buildFormatSelector(quality);
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--get-url',
      '-f', fmt,
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--extractor-args', extractorArgs,
      ytUrl,
    ],
    { timeout: YTDLP_TIMEOUT_MS },
  );

  const urls = stdout.trim().split('\n').filter(Boolean);
  if (urls.length === 0) throw new Error(`[${playerClient}] yt-dlp returned no URLs`);

  const isGooglevideo = urls.some(
    (u) => u.includes('googlevideo.com') || u.includes('youtube.com/videoplayback'),
  );
  if (!isGooglevideo) throw new Error(`[${playerClient}] URLs are not googlevideo.com`);

  // Fetch metadata separately (best-effort, quick)
  let title = '', duration = 0, thumbnailUrl = '', uploader = '';
  try {
    const { stdout: meta } = await execFileAsync(
      'yt-dlp',
      [
        '--print', '%(title)s\t%(duration)s\t%(thumbnail)s\t%(uploader)s',
        '--no-playlist', '--no-warnings', '--quiet',
        '--extractor-args', extractorArgs,
        ytUrl,
      ],
      { timeout: 15000 },
    );
    const parts = meta.trim().split('\t');
    [title, , thumbnailUrl, uploader] = parts;
    duration = parseInt(parts[1]) || 0;
  } catch { /* optional */ }

  // urls[0] = video (or audio-only if quality=audio)
  // urls[1] = audio (when split format was selected)
  const videoUrl = quality === 'audio' ? null : urls[0];
  const audioUrl = quality === 'audio' ? urls[0] : (urls[1] || null);

  // Determine actual quality from URL (itag)
  const itagMatch = (videoUrl || audioUrl || '').match(/[?&]itag=(\d+)/);
  const itagQuality = itagMatch
    ? { 18: '360p', 22: '720p', 37: '1080p', 135: '480p', 136: '720p', 137: '1080p' }[itagMatch[1]] || quality
    : quality;

  return {
    videoId,
    title,
    duration,
    thumbnailUrl,
    uploader,
    source: `yt-dlp:${playerClient}`,
    sourceType: 'yt-dlp',
    playerClient,
    quality: itagQuality,
    url: videoUrl || null,
    audioUrl: audioUrl || null,
    hls: null,
    dash: null,
    mimeType: 'video/mp4',
    codec: null,
  };
}

// ─── yt-dlp with client rotation ─────────────────────────────────────────────
const PLAYER_CLIENTS = ['android_vr', 'android', 'tv', 'web'];

async function fetchWithYtDlp(videoId, quality, allStreams) {
  const errors = [];
  for (const client of PLAYER_CLIENTS) {
    try {
      const result = await ytDlpAttempt(videoId, client, quality, allStreams);
      console.log(`[yt-dlp] Success with client="${client}" for ${videoId}`);
      return result;
    } catch (err) {
      const msg = err.message || String(err);
      // Don't try further clients if it's a "video unavailable" type error
      if (msg.includes('Video unavailable') || msg.includes('Private video')) {
        throw new Error(`Video unavailable: ${videoId}`);
      }
      errors.push(`${client}: ${msg.split('\n')[0]}`);
      console.warn(`[yt-dlp] Client "${client}" failed for ${videoId}: ${msg.split('\n')[0]}`);
    }
  }
  throw new Error(`All yt-dlp clients failed for ${videoId}. Errors: ${errors.join(' | ')}`);
}

// ─── Piped / Invidious instance fallback ──────────────────────────────────────
async function fetchFromPiped(baseUrl, videoId, signal) {
  const t0 = Date.now();
  const resp = await axios.get(`${baseUrl}/streams/${videoId}`, {
    timeout: REQUEST_TIMEOUT_MS, signal,
    headers: { 'User-Agent': 'googlevideo-api/1.0' },
  });
  const data = resp.data;
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

  const videoStreams = Array.isArray(data.videoStreams) ? data.videoStreams : [];
  const audioStreams = Array.isArray(data.audioStreams) ? data.audioStreams : [];
  return {
    source: baseUrl, sourceType: 'piped', latencyMs: Date.now() - t0,
    title: data.title || '', duration: data.duration || 0,
    thumbnailUrl: data.thumbnailUrl || '', uploader: data.uploader || '',
    hls: data.hls || null, dash: data.dash || null,
    videoStreams, audioStreams,
    allStreams: [...videoStreams, ...audioStreams],
  };
}

async function fetchFromInvidious(baseUrl, videoId, signal) {
  const t0 = Date.now();
  const resp = await axios.get(`${baseUrl}/api/v1/videos/${videoId}`, {
    timeout: REQUEST_TIMEOUT_MS, signal,
    headers: { 'User-Agent': 'googlevideo-api/1.0' },
  });
  const data = resp.data;
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

  const norm = (s) => ({
    url: s.url, quality: s.qualityLabel || s.quality || '',
    resolution: s.resolution || '', bitrate: parseInt(s.bitrate || '0'),
    mimeType: s.type || '', codec: s.encoding || '', format: s.container || '',
    videoOnly: !!(s.type?.startsWith('video') && !s.type.includes('avc1')),
    fps: s.fps || 0,
    width: s.size ? parseInt(s.size.split('x')[0]) : 0,
    height: s.size ? parseInt(s.size.split('x')[1]) : 0,
  });

  const videoStreams = (data.formatStreams || []).map(norm);
  const audioStreams = (data.adaptiveFormats || [])
    .filter((s) => s.type?.startsWith('audio'))
    .map(norm);

  return {
    source: baseUrl, sourceType: 'invidious', latencyMs: Date.now() - t0,
    title: data.title || '', duration: data.lengthSeconds || 0,
    thumbnailUrl: data.videoThumbnails?.find((t) => t.quality === 'maxresdefault')?.url
      || data.videoThumbnails?.[0]?.url || '',
    uploader: data.author || '',
    hls: data.hlsUrl || null, dash: data.dashUrl || null,
    videoStreams, audioStreams,
    allStreams: [...videoStreams, ...audioStreams],
  };
}

function hasGooglevideo(streams) {
  return streams.some(
    (s) => s.url && (s.url.includes('googlevideo.com') || s.url.includes('videoplayback')),
  );
}

async function fetchFromInstances(videoId) {
  const instances = instanceManager.getAllInstances();
  const limit = pLimit(MAX_PARALLEL);
  const ac = new AbortController();
  let resolved = false;
  let firstResult = null;

  await Promise.allSettled(
    instances.map((inst) =>
      limit(async () => {
        if (resolved) return;
        try {
          const data = inst.apiType === 'piped'
            ? await fetchFromPiped(inst.url, videoId, ac.signal)
            : await fetchFromInvidious(inst.url, videoId, ac.signal);

          if (!hasGooglevideo(data.allStreams) && !data.hls && !data.dash) {
            throw new Error('No googlevideo URLs');
          }
          instanceManager.recordSuccess(inst.url, data.latencyMs);
          if (!resolved) {
            resolved = true;
            firstResult = data;
            ac.abort();
          }
        } catch (err) {
          if (err.name !== 'AbortError' && err.name !== 'CanceledError') {
            instanceManager.recordFailure(inst.url);
          }
        }
      }),
    ),
  );

  if (!firstResult) throw new Error('All instances failed');
  return firstResult;
}

// ─── Stream picker ────────────────────────────────────────────────────────────
const QUALITY_ORDER = ['1080p', '720p', '480p', '360p', '240p', '144p'];

function pickBest(streams, quality) {
  if (!streams?.length) return null;
  const gv = streams.filter(
    (s) => s.url && (s.url.includes('googlevideo.com') || s.url.includes('videoplayback')),
  );
  const pool = gv.length > 0 ? gv : streams;
  if (!pool.length) return null;

  if (quality === 'audio') {
    return pool
      .filter((s) => !s.videoOnly && (s.mimeType || '').startsWith('audio'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;
  }
  if (quality === 'best') {
    for (const q of QUALITY_ORDER) {
      const f = pool.find((s) => [s.quality, s.qualityLabel, s.resolution].some((v) => v === q));
      if (f) return f;
    }
    return pool[0];
  }
  return (
    pool.find((s) =>
      [s.quality, s.qualityLabel, s.resolution].some((v) => (v || '').toLowerCase() === quality.toLowerCase()),
    ) || pool[0]
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Resolve a YouTube video to direct googlevideo.com stream URL(s).
 *
 * Order of attempts:
 *   1. yt-dlp  (rotates: android_vr → android → tv → web)
 *   2. Piped + Invidious public instances (parallel, up to MAX_PARALLEL)
 */
export async function resolveVideoUrl(videoId, options = {}) {
  const { quality = 'best', allStreams = false } = options;

  // ── 1. yt-dlp ─────────────────────────────────────────────────────────────
  try {
    const result = await fetchWithYtDlp(videoId, quality, allStreams);
    if (allStreams) return { videoId, ...result };
    return { success: true, ...result };
  } catch (ytErr) {
    console.warn(`[resolver] yt-dlp exhausted for ${videoId}: ${ytErr.message}`);
  }

  // ── 2. Instance fallback ──────────────────────────────────────────────────
  const total = instanceManager.getAllInstances().length;
  console.log(`[resolver] Falling back to ${total} Piped/Invidious instances for ${videoId}…`);

  const data = await fetchFromInstances(videoId);

  if (allStreams) {
    return {
      videoId,
      title: data.title, duration: data.duration,
      thumbnailUrl: data.thumbnailUrl, uploader: data.uploader,
      source: data.source, sourceType: data.sourceType, latencyMs: data.latencyMs,
      hls: data.hls, dash: data.dash,
      videoStreams: data.videoStreams, audioStreams: data.audioStreams,
    };
  }

  const bestVideo = pickBest(data.videoStreams, quality === 'audio' ? 'best' : quality);
  const bestAudio = pickBest(data.audioStreams, 'audio');

  if (!bestVideo && !data.hls && !data.dash) throw new Error('No suitable stream found');

  return {
    videoId,
    title: data.title, duration: data.duration,
    thumbnailUrl: data.thumbnailUrl, uploader: data.uploader,
    source: data.source, sourceType: data.sourceType, latencyMs: data.latencyMs,
    quality: bestVideo?.quality || bestVideo?.resolution || quality,
    url: bestVideo?.url || null,
    audioUrl: bestAudio?.url || null,
    hls: data.hls, dash: data.dash,
    mimeType: bestVideo?.mimeType || null, codec: bestVideo?.codec || null,
  };
}

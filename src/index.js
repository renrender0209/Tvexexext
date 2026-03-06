/**
 * index.js  –  Express API server
 *
 * Endpoints:
 *   GET /resolve?url=<YouTube URL or video ID>[&quality=720p][&all=true]
 *   GET /resolve/:videoId[?quality=720p][?all=true]
 *   GET /health
 *   GET /stats
 */

'use strict';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { extractVideoId, resolveVideoUrl } from './resolver.js';
import { instanceManager } from './instances.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security / middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/resolve', limiter);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendError(res, status, message, details) {
  return res.status(status).json({ error: message, ...(details && { details }) });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Simple liveness check for Render health checks.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /stats
 * Returns instance health statistics.
 */
app.get('/stats', (_req, res) => {
  res.json(instanceManager.stats());
});

/**
 * GET /resolve?url=<YouTubeURL>&quality=720p&all=false
 * GET /resolve/:videoId?quality=720p&all=false
 *
 * Query params:
 *   url      – YouTube video URL or 11-char video ID
 *   quality  – 'best' (default) | '1080p' | '720p' | '480p' | '360p' | '240p' | '144p' | 'audio'
 *   all      – 'true' to return all streams instead of single best URL
 */
async function handleResolve(req, res) {
  const rawInput = req.params.videoId || req.query.url || req.query.id;
  const quality = req.query.quality || 'best';
  const allStreams = req.query.all === 'true';

  if (!rawInput) {
    return sendError(
      res,
      400,
      'Missing parameter: provide ?url=<YouTube URL or video ID> or use /resolve/:videoId',
    );
  }

  const videoId = extractVideoId(rawInput);
  if (!videoId) {
    return sendError(res, 400, 'Could not extract a valid YouTube video ID from input', {
      input: rawInput,
    });
  }

  const validQualities = ['best', '1080p', '720p', '480p', '360p', '240p', '144p', 'audio'];
  if (!validQualities.includes(quality)) {
    return sendError(res, 400, `Invalid quality. Must be one of: ${validQualities.join(', ')}`);
  }

  try {
    const result = await resolveVideoUrl(videoId, { quality, allStreams });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[resolve] Error for ${videoId}:`, err.message);
    return sendError(res, 502, 'Failed to resolve video stream', { reason: err.message });
  }
}

app.get('/resolve/:videoId', handleResolve);
app.get('/resolve', handleResolve);

/**
 * GET /
 * API documentation / welcome page
 */
app.get('/', (_req, res) => {
  res.json({
    name: 'googlevideo-api',
    description:
      'Resolves YouTube video IDs to direct googlevideo.com stream URLs using Invidious and Piped public instances.',
    version: '1.0.0',
    endpoints: {
      resolve: {
        paths: ['/resolve?url=<YouTube URL or ID>', '/resolve/:videoId'],
        queryParams: {
          url: 'YouTube video URL or 11-char video ID',
          quality:
            "'best' (default) | '1080p' | '720p' | '480p' | '360p' | '240p' | '144p' | 'audio'",
          all: "'true' to return all available streams",
        },
        examples: [
          '/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          '/resolve?url=dQw4w9WgXcQ&quality=720p',
          '/resolve/dQw4w9WgXcQ',
          '/resolve/dQw4w9WgXcQ?quality=audio',
          '/resolve/dQw4w9WgXcQ?all=true',
        ],
      },
      health: '/health',
      stats: '/stats  (instance health statistics)',
    },
  });
});

// 404 fallback
app.use((_req, res) => {
  sendError(res, 404, 'Not found');
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] googlevideo-api listening on port ${PORT}`);
});

export default app;

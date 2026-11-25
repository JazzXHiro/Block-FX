// server.js — serves the editor and turns a scene into an MP4 / GIF.
//
// Export flow:
//   POST /export            -> start a job, reply { id } immediately
//   GET  /export/:id/events -> Server-Sent Events with { status, frame, total }
//   GET  /export/:id/download -> the finished file
//
// A job opens the editor in headless Chrome (Puppeteer) at ?export=1, calls
// window.renderAt(i / fps) for every frame, reads the canvas as a PNG and pipes
// it into ffmpeg's stdin. Because the page uses the same renderer.js as the
// editor, the video matches what you see on the stage.

import express from 'express';
import puppeteer from 'puppeteer';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

const FORMATS = ['mp4', 'gif'];
const FPS_OPTIONS = [24, 30, 60];
const RESOLUTIONS = ['854x480', '1280x720', '1920x1080'];

const app = express();

// Static files: the editor itself, plus the Three.js ES module build.
app.use(express.static(path.join(ROOT, 'client')));
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three', 'build')));
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Jobs (kept in memory)
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> { id, status, frame, total, error, file, format, listeners }

function jobState(job) {
  return { status: job.status, frame: job.frame, total: job.total, error: job.error };
}

// Change a job and push the new state to every open SSE connection.
function updateJob(job, changes) {
  Object.assign(job, changes);
  const message = `data: ${JSON.stringify(jobState(job))}\n\n`;
  for (const res of job.listeners) {
    res.write(message);
    if (job.status === 'done' || job.status === 'error') res.end();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/export', (req, res) => {
  const { scene, format, fps, width, height } = req.body || {};
  if (!scene || !Array.isArray(scene.shapes) || !(scene.duration > 0)) {
    return res.status(400).send('Invalid scene');
  }
  if (!FORMATS.includes(format) || !FPS_OPTIONS.includes(fps) || !RESOLUTIONS.includes(`${width}x${height}`)) {
    return res.status(400).send('Invalid export options');
  }

  const job = {
    id: randomUUID(),
    status: 'queued',
    frame: 0,
    total: Math.ceil(scene.duration * fps),
    error: null,
    file: null,
    format,
    listeners: new Set(),
  };
  jobs.set(job.id, job);

  runExport(job, { scene, format, fps, width, height }).catch((err) => {
    console.error('Export failed:', err);
    updateJob(job, { status: 'error', error: err.message });
  });

  res.json({ id: job.id });
});

app.get('/export/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(jobState(job))}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();

  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});

app.get('/export/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).send('Export not ready');
  res.download(job.file, `animation.${job.format}`, () => {
    fs.rm(job.file, { force: true }, () => {});
    jobs.delete(job.id);
  });
});

// ---------------------------------------------------------------------------
// The export itself
// ---------------------------------------------------------------------------
function ffmpegArgs(format, fps, outFile) {
  // Input: a stream of PNG images on stdin, played at `fps`.
  const input = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  if (format === 'mp4') {
    // yuv420p = the pixel format every video player understands; faststart = playable while downloading
    return [...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile];
  }
  // GIF: build a 256-color palette from the frames first, then use it (much better quality)
  return [...input, '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', outFile];
}

function startFfmpeg(format, fps, outFile) {
  const ffmpeg = spawn(ffmpegPath, ffmpegArgs(format, fps, outFile), { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  ffmpeg.stderr.on('data', (chunk) => { log = (log + chunk).slice(-2000); });
  ffmpeg.stdin.on('error', () => {}); // a crash is reported through `finished` below
  const finished = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${log.slice(-300)}`))));
  });
  finished.catch(() => {}); // avoid an unhandled rejection if we fail before awaiting it
  return { ffmpeg, finished };
}

async function runExport(job, { scene, format, fps, width, height }) {
  const outFile = path.join(os.tmpdir(), `export-${job.id}.${format}`);
  const { ffmpeg, finished } = startFfmpeg(format, fps, outFile);

  // SwiftShader = software WebGL, so export also works on machines/servers without a GPU.
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`http://localhost:${PORT}/?export=1&w=${width}&h=${height}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.exportReady === true);
    await page.evaluate((s) => window.loadScene(s), scene);

    updateJob(job, { status: 'rendering' });
    for (let i = 0; i < job.total; i++) {
      // Render and read back in the same call, so the frame is still in the drawing buffer.
      const dataUrl = await page.evaluate((t) => {
        window.renderAt(t);
        return document.getElementById('canvas').toDataURL('image/png');
      }, i / fps);
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain'); // back-pressure
      updateJob(job, { frame: i + 1 });
    }
  } catch (err) {
    ffmpeg.kill();
    throw err;
  } finally {
    await browser.close();
  }

  updateJob(job, { status: 'encoding' });
  ffmpeg.stdin.end(); // no more frames: ffmpeg finishes the file and exits
  await finished;
  updateJob(job, { status: 'done', file: outFile });
}

app.listen(PORT, () => {
  console.log(`Editor running at http://localhost:${PORT}`);
});

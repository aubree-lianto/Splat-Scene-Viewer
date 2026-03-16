import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const FRAMES_DIR = path.join(__dirname, 'frames');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure base directories exist on startup
[FRAMES_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Start a new export session — returns a sessionId used by all subsequent calls.
// Each session gets its own subdirectory so concurrent exports don't collide.
app.post('/api/export/start', (req, res) => {
  const { width, height, fps, totalFrames } = req.body;
  const sessionId = randomUUID();
  const sessionDir = path.join(FRAMES_DIR, sessionId);

  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`Export session ${sessionId} started: ${width}x${height} @ ${fps}fps, ${totalFrames} frames`);
  res.json({ success: true, sessionId });
});

// Receive a single frame as base64 JPEG (or PNG) and save to disk
app.post('/api/export/frame', (req, res) => {
  const { sessionId, frameIndex, imageData } = req.body;
  const sessionDir = path.join(FRAMES_DIR, sessionId);

  const isJpeg = imageData.startsWith('data:image/jpeg');
  const base64Data = imageData.replace(/^data:image\/(jpeg|png);base64,/, '');
  const ext = isJpeg ? 'jpg' : 'png';
  const filename = `frame_${String(frameIndex).padStart(6, '0')}.${ext}`;
  const filepath = path.join(sessionDir, filename);

  fs.writeFileSync(filepath, base64Data, 'base64');

  if (frameIndex % 30 === 0) {
    console.log(`[${sessionId.slice(0, 8)}] Saved frame ${frameIndex}: ${filename}`);
  }

  res.json({ success: true, frameIndex });
});

// Encode saved frames to MP4 using FFmpeg
app.post('/api/export/encode', (req, res) => {
  const { sessionId, fps = 30, width = 1280, height = 720 } = req.body;
  const sessionDir = path.join(FRAMES_DIR, sessionId);
  const outputPath = path.join(OUTPUT_DIR, `${sessionId}.mp4`);

  console.log(`[${sessionId.slice(0, 8)}] Starting FFmpeg encode: ${width}x${height} @ ${fps}fps`);

  const ffmpeg = spawn('C:\\ffmpeg\\bin\\ffmpeg.exe', [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(sessionDir, 'frame_%06d.jpg'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '17',
    '-vf', `scale=${width}:${height},noise=alls=2:allf=t`,
    outputPath,
  ]);

  let stderr = '';
  let responded = false;

  const respond = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  ffmpeg.stderr.on('data', data => { stderr += data.toString(); });

  ffmpeg.on('error', err => {
    console.error('FFmpeg spawn error:', err.message);
    respond(500, {
      success: false,
      error: `FFmpeg not found. Install FFmpeg and add it to PATH: https://ffmpeg.org/download.html\n${err.message}`,
    });
  });

  ffmpeg.on('close', code => {
    if (code === 0) {
      console.log(`[${sessionId.slice(0, 8)}] Encode complete:`, outputPath);
      // Clean up session frames now that encoding is done
      fs.rmSync(sessionDir, { recursive: true, force: true });
      respond(200, { success: true, downloadUrl: `/api/export/download?session=${sessionId}` });
    } else {
      console.error(`[${sessionId.slice(0, 8)}] FFmpeg failed:\n`, stderr);
      respond(500, { success: false, error: stderr });
    }
  });
});

// Serve the finished MP4 for browser download
app.get('/api/export/download', (req, res) => {
  const { session } = req.query;
  const outputPath = path.join(OUTPUT_DIR, `${session}.mp4`);

  if (session && fs.existsSync(outputPath)) {
    res.download(outputPath, 'output.mp4');
  } else {
    res.status(404).json({ error: 'No video found. Run an export first.' });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Export server running on http://localhost:${PORT}`);
});

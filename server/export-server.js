import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const FRAMES_DIR = path.join(__dirname, 'frames');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure directories exist on startup
[FRAMES_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Start a new export session — clears any old frames
app.post('/api/export/start', (req, res) => {
  const { width, height, fps, totalFrames } = req.body;
  console.log(`Export session started: ${width}x${height} @ ${fps}fps, ${totalFrames} frames`);

  // Delete all existing frames
  if (fs.existsSync(FRAMES_DIR)) {
    fs.readdirSync(FRAMES_DIR).forEach(file => {
      fs.unlinkSync(path.join(FRAMES_DIR, file));
    });
  }

  res.json({ success: true });
});

// Receive a single frame as base64 PNG and save to disk
app.post('/api/export/frame', (req, res) => {
  const { frameIndex, imageData } = req.body;

  const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
  const filename = `frame_${String(frameIndex).padStart(6, '0')}.png`;
  const filepath = path.join(FRAMES_DIR, filename);

  fs.writeFileSync(filepath, base64Data, 'base64');

  if (frameIndex % 30 === 0) {
    console.log(`Saved frame ${frameIndex}: ${filename}`);
  }

  res.json({ success: true, frameIndex });
});

// Encode saved frames to MP4 using FFmpeg
app.post('/api/export/encode', (req, res) => {
  const { fps = 30, width = 1280, height = 720 } = req.body;
  const outputPath = path.join(OUTPUT_DIR, 'output.mp4');

  console.log(`Starting FFmpeg encode: ${width}x${height} @ ${fps}fps`);

  // Remove existing output file if present
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  const ffmpeg = spawn('C:\\ffmpeg\\bin\\ffmpeg.exe', [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(FRAMES_DIR, 'frame_%06d.png'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',   // broad player compatibility
    '-preset', 'medium',
    '-crf', '17',            // higher quality (was 23) — reduces gradient banding
    '-vf', 'noise=alls=2:allf=t', // subtle dither breaks up compression banding on smooth gradients
    '-s', `${width}x${height}`,
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
      console.log('FFmpeg encode complete:', outputPath);
      respond(200, { success: true, downloadUrl: '/api/export/download' });
    } else {
      console.error('FFmpeg failed:\n', stderr);
      respond(500, { success: false, error: stderr });
    }
  });
});

// Serve the finished MP4 for browser download
app.get('/api/export/download', (req, res) => {
  const outputPath = path.join(OUTPUT_DIR, 'output.mp4');

  if (fs.existsSync(outputPath)) {
    res.download(outputPath, 'output.mp4');
  } else {
    res.status(404).json({ error: 'No video found. Run an export first.' });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Export server running on http://localhost:${PORT}`);
});

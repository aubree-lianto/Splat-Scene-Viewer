# Splat Scene Viewer

A web-based 3D Gaussian Splats viewer with interactive camera controls, animated camera path recording, and MP4 video export.

## Features

- **Orbit & Walk modes** — switch between free-orbit camera and first-person WASD walk with mouse look
- **Camera path recording** — add keyframes, reorder by dragging, preview smooth spline animation
- **MP4 export** — render the camera path to video via a local FFmpeg server
- **Color grading** — exposure and contrast sliders applied per-pixel during export
- **Save / load paths** — camera path + render settings saved to `path.json` for deterministic re-export

## Prerequisites

- [Node.js](https://nodejs.org/) v16+
- [FFmpeg](https://ffmpeg.org/download.html) installed at `C:\ffmpeg\bin\ffmpeg.exe`
  - To use a different path, edit line 68 of [server/export-server.js](server/export-server.js)

## Setup

```bash
# Install frontend dependencies
npm install

# Install server dependencies
cd server && npm install && cd ..
```

## Running

```bash
npm start
```

This starts both the Vite dev server (`localhost:5173`) and the export server (`localhost:3001`) concurrently.

To run them separately:

```bash
npm run dev     # Vite only
npm run server  # Export server only
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Toggle Walk / Orbit mode |
| `K` | Add keyframe at current camera position |
| `P` | Play / stop camera path preview |
| `W A S D` | Move in Walk mode |
| `Mouse` | Look around (Walk mode) / orbit (Orbit mode) |
| `Esc` | Exit Walk mode |

## Export Settings

Configure before exporting via the Camera Path panel:

| Setting | Options |
|---------|---------|
| Duration | 1–60 seconds |
| FPS | 24 / 30 / 60 |
| Resolution | 720p (1280×720) / 1080p (1920×1080) |
| Exposure | 0–2 (default 1.0) |
| Contrast | 0–2 (default 1.0) |

## Export Workflow

1. Add at least 2 keyframes along the camera path
2. Adjust duration, FPS, resolution, and color grading
3. Click **Export MP4** — frames are rendered in the browser and sent to the local server
4. FFmpeg encodes the frames and the browser downloads `output.mp4`

The export server must be running (`npm start` or `npm run server`) for export to work.

## Tech Stack

| Package | Purpose |
|---------|---------|
| [@mkkellogg/gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3D) | Gaussian splat renderer |
| [Three.js](https://threejs.org/) | WebGL wrapper |
| [Vite](https://vitejs.dev/) | Dev server & build tool |
| [Express](https://expressjs.com/) | Local export server |
| [FFmpeg](https://ffmpeg.org/) | MP4 encoding |

## Project Structure

```
├── src/
│   ├── main.js           # App entry, viewer setup, UI controls
│   ├── CameraPath.js     # Spline interpolation for camera animation
│   ├── VideoExporter.js  # Frame capture and server communication
│   └── style.css         # UI styles
├── server/
│   ├── export-server.js  # Express server — receives frames, runs FFmpeg
│   └── frames/           # Temporary frame storage during export
├── index.html            # UI layout
└── vite.config.js        # Vite config with required CORS headers
```

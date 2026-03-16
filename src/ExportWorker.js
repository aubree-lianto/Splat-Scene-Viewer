import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';
import { CameraPath } from './CameraPath.js';

// BroadcastChannel used because COOP: same-origin severs the window.open()
// reference, making popup.postMessage() unreachable from the opener.
const channel = new BroadcastChannel('splat-export');

const SERVER_URL = 'http://localhost:3001';

// ── UI helpers ────────────────────────────────────────────────────────────────

const statusEl  = document.getElementById('status');
const progressEl = document.getElementById('progress-fill');
const logEl     = document.getElementById('log');

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(fraction) {
  progressEl.style.width = `${Math.round(fraction * 100)}%`;
}

function log(msg) {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Viewer bootstrap ──────────────────────────────────────────────────────────

// Hidden 1×1 canvas — we only need the WebGL context, not a visible viewport.
// The renderer is still sized to the export resolution before each render call.
const canvas = document.getElementById('render-canvas');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  precision: 'highp',
  preserveDrawingBuffer: true, // required for readPixels / toDataURL on WebGL canvas
});

let viewer = null;
let splatLoaded = false;

async function initViewer(splatUrl, cameraUp) {
  // rootElement omitted intentionally — when an external renderer is provided
  // and rootElement is null, the library uses renderer.domElement as its root,
  // which avoids a ResizeObserver on a hidden element reporting 0×0 dimensions.
  viewer = new GaussianSplats3D.Viewer({
    cameraUp,
    initialCameraPosition: [0, 0, 5],
    initialCameraLookAt:   [0, 0, 0],
    renderer,
  });

  setStatus('Loading splat…');
  log(`Loading: ${splatUrl}`);

  await viewer.addSplatScene(splatUrl, {
    showLoadingUI: false,
    onProgress: (p) => {
      setProgress(p / 100 * 0.5); // first 50% = loading
      setStatus(`Loading splat… ${Math.round(p)}%`);
    },
  });

  viewer.start();
  splatLoaded = true;
  log('Splat loaded. Waiting for export config…');
  setStatus('Ready — waiting for export config');
  setProgress(0.5);
}

// ── Export pipeline ───────────────────────────────────────────────────────────

async function runExport(config) {
  const {
    keyframes: rawKeyframes,
    splatUrl,
    cameraUp = [0, -1, 0],
    fps       = 30,
    duration  = 5,
    width     = 1280,
    height    = 720,
    exposure  = 1.0,
    contrast  = 1.0,
  } = config;

  // If the splat hasn't been loaded yet (first export), load it now.
  // Subsequent exports on the same window reuse the already-loaded scene.
  if (!splatLoaded) {
    await initViewer(splatUrl, cameraUp);
  }

  // Reconstruct THREE objects from the plain-JSON keyframes sent over the channel
  const keyframes = rawKeyframes.map(kf => ({
    id:         kf.id,
    position:   new THREE.Vector3(...kf.position),
    quaternion: new THREE.Quaternion(...kf.quaternion),
    fov:        kf.fov,
  }));

  if (keyframes.length < 2) {
    setStatus('Error: need at least 2 keyframes');
    log('Error: received fewer than 2 keyframes');
    channel.postMessage({ type: 'export-error', error: 'Need at least 2 keyframes' });
    return;
  }

  const cameraPath  = new CameraPath(keyframes);
  const totalFrames = fps * duration;

  setStatus('Starting export…');
  log(`Export: ${width}×${height} @ ${fps}fps, ${totalFrames} frames`);

  // Notify main window export has started
  channel.postMessage({ type: 'export-started', totalFrames });

  // ── tell server to prepare ────────────────────────────────────────────────
  const { sessionId } = await post('/api/export/start', { width, height, fps, totalFrames });

  // Resize renderer to export resolution
  renderer.setSize(width, height, false);

  let pendingPost = null;

  try {
    for (let i = 0; i < totalFrames; i++) {
      const t         = totalFrames > 1 ? i / (totalFrames - 1) : 0;
      const progress  = 0.5 + (i / totalFrames) * 0.45; // 50–95% of bar

      // Pose camera along the spline
      poseCamera(t, cameraPath);
      viewer.forceRenderNextFrame();
      viewer.update();

      // Drain previous frame's network POST while this frame's GPU sort runs
      if (pendingPost) await pendingPost;

      // Wait for the depth-sort worker to finish before rendering
      await waitForSort();

      viewer.render();

      // Flush GPU pipeline so readPixels/toDataURL sees the completed frame
      const gl    = renderer.getContext();
      const flush = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, flush);

      const imageData = captureFrame(renderer.domElement, exposure, contrast);

      // Fire POST without awaiting — overlaps with next frame's sort
      pendingPost = post('/api/export/frame', { sessionId, frameIndex: i, imageData });

      const msg = `Rendering frame ${i + 1} / ${totalFrames}`;
      setStatus(msg);
      setProgress(progress);
      if (i % 30 === 0) log(msg);

      channel.postMessage({ type: 'export-progress', frame: i + 1, totalFrames });
    }

    // Drain the last frame's POST
    if (pendingPost) await pendingPost;

    setStatus('Encoding video…');
    setProgress(0.97);
    log('All frames sent — encoding MP4…');

    await post('/api/export/encode', { sessionId, fps, width, height });

    setStatus('Done! Downloading…');
    setProgress(1.0);
    log('Encode complete. Triggering download…');

    // Trigger the download from the export window
    const a = document.createElement('a');
    a.href     = `${SERVER_URL}/api/export/download?session=${sessionId}`;
    a.download = 'output.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    channel.postMessage({ type: 'export-complete' });
    log('Export finished. Closing window…');

    // Give the browser a moment to initiate the download before closing
    setTimeout(() => window.close(), 2000);

  } catch (err) {
    setStatus(`Error: ${err.message}`);
    log(`Export error: ${err.message}`);
    channel.postMessage({ type: 'export-error', error: err.message });
  }
}

// ── Camera helpers ────────────────────────────────────────────────────────────

function poseCamera(t, cameraPath) {
  const cam = viewer.camera;
  cam.position.copy(cameraPath.getPositionAt(t));
  cam.quaternion.copy(cameraPath.getRotationAt(t));
  cam.fov = cameraPath.getFovAt(t);
  cam.updateProjectionMatrix();
}

// Polls until the gaussian depth sort worker has fully completed.
// Mirrors the same logic in VideoExporter._waitForSort().
function waitForSort() {
  return new Promise((resolve) => {
    const check = () => {
      if (viewer.sortRunning) {
        const waitForPromise = () => {
          if (viewer.sortPromise) {
            viewer.sortPromise.then(resolve);
          } else {
            requestAnimationFrame(waitForPromise);
          }
        };
        waitForPromise();
      } else if (viewer.sortPromise) {
        viewer.sortPromise.then(resolve);
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

// ── Frame capture ─────────────────────────────────────────────────────────────

function captureFrame(glCanvas, exposure, contrast) {
  const w = glCanvas.width;
  const h = glCanvas.height;

  const offscreen = document.createElement('canvas');
  offscreen.width  = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');

  // Black fill prevents premultiplied-alpha artifacts in FFmpeg output
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(glCanvas, 0, 0);

  if (exposure !== 1.0 || contrast !== 1.0) {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data      = imageData.data;
    const offset    = 0.5 * (1 - contrast);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = data[i + c] / 255;
        v = v * exposure * contrast + offset;
        data[i + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  return offscreen.toDataURL('image/jpeg', 0.92);
}

// ── Network ───────────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(SERVER_URL + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server error on ${path}: ${res.status}`);
  return res.json();
}

// ── BroadcastChannel listener ─────────────────────────────────────────────────

channel.addEventListener('message', (e) => {
  if (e.data?.type === 'start-export') {
    log('Received export config from main window.');
    runExport(e.data.config);
  }
});

// Signal main window that this page is open and ready to receive config
channel.postMessage({ type: 'worker-ready' });
log('Export worker ready. Waiting for main window to send config…');

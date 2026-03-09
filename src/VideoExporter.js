import * as THREE from 'three';

// Renders each frame of the camera path at export resolution and sends it
// to the local Node server as a base64 PNG. The server encodes the frames
// to MP4 using FFmpeg and serves the file for download.
export class VideoExporter {
  constructor(viewer, cameraPath, options = {}) {
    this.viewer = viewer;
    this.cameraPath = cameraPath;
    this.width    = options.width    || 1280;
    this.height   = options.height   || 720;
    this.fps      = options.fps      || 30;
    this.duration = options.duration || 5;
    this.exposure = options.exposure !== undefined ? options.exposure : 1.0;
    this.contrast = options.contrast !== undefined ? options.contrast : 1.0;
    this.serverUrl = 'http://localhost:3001';
    this.cancelled = false;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
  }

  async export() {
    if (this.cameraPath.keyframes.length < 2) {
      this.onError('Need at least 2 keyframes');
      return;
    }

    this.cancelled = false;
    const totalFrames = this.fps * this.duration;

    try {
      // Tell server to prepare and clear old frames
      await this._post('/api/export/start', {
        width: this.width,
        height: this.height,
        fps: this.fps,
        totalFrames,
      });

      const renderer = this.viewer.renderer;
      const originalSize = new THREE.Vector2();
      renderer.getSize(originalSize);
      renderer.setSize(this.width, this.height, false);

      // pendingPost lets us overlap the network POST for frame N with the
      // depth sort for frame N+1, so they run in parallel instead of serially
      let pendingPost = null;

      try {
        for (let i = 0; i < totalFrames; i++) {
          if (this.cancelled) {
            // Drain in-flight POST quietly before throwing
            if (pendingPost) await pendingPost.catch(() => {});
            throw new Error('Export cancelled');
          }

          const t = totalFrames > 1 ? i / (totalFrames - 1) : 0;

          // Pose camera and kick off the depth sort for this frame
          this._poseCamera(t);
          this.viewer.forceRenderNextFrame();
          this.viewer.update();

          // While the sort worker is running, drain the previous frame's POST
          if (pendingPost) await pendingPost;

          // Wait for the sort to fully complete before rendering.
          // sortPromise is created AFTER the GPU distance computation finishes,
          // so it may still be null immediately after update(). We poll sortRunning
          // first (set to true synchronously when sort starts) then await the promise.
          await this._waitForSort();

          this.viewer.render();
          // Force GPU pipeline flush before reading pixels — readPixels() blocks
          // until all pending draw calls complete, preventing stale frame capture
          const gl = renderer.getContext();
          const flush = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, flush);
          const imageData = this._captureFrame(renderer.domElement);

          // Fire POST without awaiting so it overlaps with the next frame's sort
          pendingPost = this._post('/api/export/frame', { frameIndex: i, imageData });

          this.onProgress((i + 1) / totalFrames, `Rendering frame ${i + 1} / ${totalFrames}`);
        }

        // Drain the final frame's POST before moving on to encode
        if (pendingPost) await pendingPost;

        // Tell server to run FFmpeg
        this.onProgress(1, 'Encoding video...');
        await this._post('/api/export/encode', {
          fps: this.fps,
          width: this.width,
          height: this.height,
        });

        // Trigger browser download
        this._triggerDownload();
        this.onComplete();

      } finally {
        // Always restore renderer size — runs on success, error, and cancel
        renderer.setSize(originalSize.x, originalSize.y, false);
      }

    } catch (err) {
      this.onError(err.message);
    }
  }

  cancel() {
    this.cancelled = true;
  }

  _poseCamera(t) {
    const cam = this.viewer.camera;
    cam.position.copy(this.cameraPath.getPositionAt(t));
    cam.quaternion.copy(this.cameraPath.getRotationAt(t));
    cam.fov = this.cameraPath.getFovAt(t);
    cam.updateProjectionMatrix();
  }

  // Wait for the splat depth sort to fully complete.
  // viewer.update() fires the sort asynchronously: it first does GPU distance
  // computation (async), then creates sortPromise and posts to the worker.
  // Awaiting sortPromise immediately after update() fails because it's still
  // null at that point. Instead we poll: wait for sortRunning to become true
  // (sort has started), then await sortPromise (sort has finished).
  _waitForSort() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.viewer.sortRunning) {
          // Sort started — now wait for the promise it creates
          const waitForPromise = () => {
            if (this.viewer.sortPromise) {
              this.viewer.sortPromise.then(resolve);
            } else {
              requestAnimationFrame(waitForPromise);
            }
          };
          waitForPromise();
        } else if (this.viewer.sortPromise) {
          // Sort already finished and promise exists
          this.viewer.sortPromise.then(resolve);
        } else {
          // Sort hasn't started yet, keep polling
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  // Read raw pixels from the WebGL canvas, apply exposure/contrast in JS,
  // composite over black (no CSS filter), return PNG data URL.
  // This avoids CSS filter compositing artifacts (static rings) that appear
  // when toDataURL() captures a canvas with filter: brightness() contrast().
  _captureFrame(glCanvas) {
    const w = glCanvas.width;
    const h = glCanvas.height;

    // Read raw RGBA pixels directly from the WebGL canvas
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d');

    // Fill black first — the WebGL canvas clears to (0,0,0,0) transparent black.
    // Compositing transparent pixels over an uninitialized canvas background
    // creates illegal premultiplied alpha values that FFmpeg encodes as rainbow rings.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    // Draw the WebGL canvas onto the black background (no CSS filter applied)
    ctx.drawImage(glCanvas, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Apply exposure and contrast to each pixel in linear-ish space
    const exp = this.exposure;
    const con = this.contrast;
    // Contrast pivot at 0.5 (standard formula)
    const offset = 0.5 * (1 - con);

    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = data[i + c] / 255;
        v *= exp;                    // exposure
        v = v * con + offset;        // contrast
        data[i + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      // alpha unchanged
    }

    ctx.putImageData(imageData, 0, 0);
    return offscreen.toDataURL('image/png');
  }

  async _post(path, body) {
    const res = await fetch(this.serverUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Server error on ${path}: ${res.status}`);
    return res.json();
  }

  _triggerDownload() {
    const a = document.createElement('a');
    a.href = `${this.serverUrl}/api/export/download`;
    a.download = 'output.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

import * as THREE from 'three';

// Renders each frame of the camera path at export resolution and sends it
// to the local Node server as a base64 PNG. The server encodes the frames
// to MP4 using FFmpeg and serves the file for download.
export class VideoExporter {
  constructor(viewer, cameraPath, options = {}) {
    this.viewer = viewer;
    this.cameraPath = cameraPath;
    this.width = 1280;
    this.height = 720;
    this.fps = 30;
    this.duration = options.duration || 5;
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
      renderer.setSize(this.width, this.height);

      for (let i = 0; i < totalFrames; i++) {
        if (this.cancelled) throw new Error('Export cancelled');

        // t goes from 0 to 1 across all frames
        const t = totalFrames > 1 ? i / (totalFrames - 1) : 0;

        // Set camera pose for this frame
        this._poseCamera(t);

        // Render the scene at export resolution using the library's full pipeline
        // (threeScene pass + splatMesh pass + helpers) so gaussians appear in the frame
        this.viewer.forceRenderNextFrame();
        this.viewer.update();
        this.viewer.render();

        // Capture frame as base64 PNG
        const imageData = renderer.domElement.toDataURL('image/png');

        // Send frame to server
        await this._post('/api/export/frame', { frameIndex: i, imageData });

        this.onProgress((i + 1) / totalFrames, `Rendering frame ${i + 1} / ${totalFrames}`);
      }

      // Restore original canvas size
      renderer.setSize(originalSize.x, originalSize.y);

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

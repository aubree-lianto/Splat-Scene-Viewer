import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';
import { CameraPath } from './CameraPath.js';
import { VideoExporter } from './VideoExporter.js';

console.log('Initializing Gaussian Splats Viewer...');

// CameraUp: Y-axis orientation (defines which direction is "up")
// initialCameraPosition: camera's starting position in the 3D space
// initalCameraLookAt: point at which the camera focuses on initially 
// preserveDrawingBuffer:true keeps canvas pixels stable after compositing,
// which is required for correct export frame capture via drawImage/toDataURL.
// Without it the WebGL spec allows the browser to clear the buffer immediately
// after presenting, giving us corrupted (ring-artifact) frames on readback.
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  precision: 'highp',
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
document.body.appendChild(renderer.domElement);

const viewer = new GaussianSplats3D.Viewer({
  cameraUp: [0, -1, 0],
  initialCameraPosition: [2.51658, 0.13117, -10.78817],
  initialCameraLookAt: [0, 4, 0],
  renderer,
  rootElement: document.body,
});

// Cache the DOM elements for efficient access throughout application
const loadingContainer = document.getElementById('loading-container');
const loadingBar = document.getElementById('loading-bar');
const loadingText = document.getElementById('loading-text');
const statsPanel = document.getElementById('stats-panel');
const fpsDisplay = document.getElementById('fps');
const pointCountDisplay = document.getElementById('point-count');
const gaussianCountDisplay = document.getElementById('gaussian-count');
const frameSceneBtn = document.getElementById('frame-scene-btn');
const resetViewBtn = document.getElementById('reset-view-btn');
const walkModeBtn = document.getElementById('walk-mode-btn');
const crosshair = document.getElementById('crosshair');
const hudMouse = document.getElementById('hud-mouse');
const hudKeys = {
  KeyW: document.getElementById('hud-w'),
  KeyA: document.getElementById('hud-a'),
  KeyS: document.getElementById('hud-s'),
  KeyD: document.getElementById('hud-d'),
};
const addKeyframeBtn = document.getElementById('add-keyframe-btn');
const previewPathBtn = document.getElementById('preview-path-btn');
const clearPathBtn = document.getElementById('clear-path-btn');
const exportBtn = document.getElementById('export-btn');
const exportBgBtn = document.getElementById('export-bg-btn');
const exportProgress = document.getElementById('export-progress');
const exportBar = document.getElementById('export-bar');
const exportText = document.getElementById('export-text');
const cancelExportBtn = document.getElementById('cancel-export-btn');
const keyframeList = document.getElementById('keyframe-list');
const pathStatus = document.getElementById('path-status');
const savePathBtn = document.getElementById('save-path-btn');
const loadPathBtn = document.getElementById('load-path-btn');
const loadPathInput = document.getElementById('load-path-input');
const durationInput = document.getElementById('duration-input');
const fpsSelect = document.getElementById('fps-select');
const resSelect = document.getElementById('res-select');
const exposureSlider = document.getElementById('exposure-slider');
const contrastSlider = document.getElementById('contrast-slider');
const exposureVal = document.getElementById('exposure-val');
const contrastVal = document.getElementById('contrast-val');

// Store initial camera configuration
const initialCameraState = {
  position: [2.51658, 0.13117, -10.78817],
  lookAt: [0, 4, 0],
  up: [0, -1, 0]
};

// Camera path state
const keyframes = [];        // { position, quaternion, fov, id }
const cameraPath = new CameraPath(keyframes);
let isPlaying = false;
let playbackStartTime = null;
let playbackDuration = 5;  // seconds for full path playback

// Walk mode state
let walkMode = false;
const keys = {};
const walkSpeed = 0.05; // units per frame
const mouseSensitivity = 0.002;
let yaw = 0;   // horizontal rotation (radians)
let pitch = 0; // vertical rotation (radians)
let pointerLockSettled = false;


// FPS Counter
// Continuously measure and display FPS to show rendering performance
// The following function helps to identify performance bottlenecks
let fps = 0;
let frameCount = 0;
let lastTime = performance.now();

function updateWalk() {
  if (!walkMode) return;

  // Get the direction the camera is actually looking
  const forward = new THREE.Vector3();
  viewer.camera.getWorldDirection(forward);

  // Right is perpendicular to forward and world up
  // Use fixed Y-up instead of camera.up (which is flipped to -Y in this scene)
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();

  const move = new THREE.Vector3();
  if (keys['KeyW']) move.addScaledVector(forward, walkSpeed);
  if (keys['KeyS']) move.addScaledVector(forward, -walkSpeed);
  if (keys['KeyA']) move.addScaledVector(right, walkSpeed);
  if (keys['KeyD']) move.addScaledVector(right, -walkSpeed);

  viewer.camera.position.add(move);

  // Keep orbit target 1 unit in front of camera so controls.update()
  // doesn't pull the camera back toward the old target
  if (move.lengthSq() > 0) {
    const dir = new THREE.Vector3();
    viewer.camera.getWorldDirection(dir);
    viewer.perspectiveControls.target.copy(viewer.camera.position).addScaledVector(dir, 1);
  }
}

// Stable counter so each keyframe keeps its capture number after reordering
let keyframeCounter = 0;

// Camera path recording — captures current camera pose as a keyframe
function addKeyframe() {
  keyframeCounter++;
  keyframes.push({
    position: viewer.camera.position.clone(),
    quaternion: viewer.camera.quaternion.clone(),
    fov: viewer.camera.fov,
    id: keyframeCounter,   // never changes, survives reorder
  });
  updateKeyframeList();
  previewPathBtn.disabled = keyframes.length < 2;
  exportBtn.disabled = keyframes.length < 2;
  exportBgBtn.disabled = keyframes.length < 2;
  pathStatus.textContent = `${keyframes.length} keyframe(s)`;

}

// Rebuild the keyframe list UI with drag-to-reorder and delete buttons
let dragSrcIndex = null;

function updateKeyframeList() {
  keyframeList.innerHTML = '';
  keyframes.forEach((kf, i) => {
    const item = document.createElement('div');
    item.className = 'keyframe-item';
    item.draggable = true;
    item.dataset.index = i;
    // Show playback order (i+1) and original capture ID so user knows which is which
    item.innerHTML = `
      <span class="kf-drag-handle">⠿</span>
      <span class="kf-order">${i + 1}.</span>
      <span class="kf-label">KF ${kf.id}</span>
      <button class="kf-delete-btn" data-index="${i}">✕</button>`;

    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = i;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.keyframe-item').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.keyframe-item').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      // Show drop line above or below based on cursor position within the item
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      item.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSrcIndex === null || dragSrcIndex === i) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertAfter = e.clientY >= midY;
      const moved = keyframes.splice(dragSrcIndex, 1)[0];
      // Recalculate target index after removal
      let targetIndex = parseInt(item.dataset.index);
      if (dragSrcIndex < targetIndex) targetIndex--;
      keyframes.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, moved);
      dragSrcIndex = null;
      updateKeyframeList();
      pathStatus.textContent = `${keyframes.length} keyframe(s)`;
    });

    item.querySelector('.kf-delete-btn').addEventListener('click', () => {
      keyframes.splice(i, 1);
      updateKeyframeList();
      previewPathBtn.disabled = keyframes.length < 2;
      exportBtn.disabled = keyframes.length < 2;
      exportBgBtn.disabled = keyframes.length < 2;
      pathStatus.textContent = keyframes.length ? `${keyframes.length} keyframe(s)` : '';
    });
    keyframeList.appendChild(item);
  });
}

// Smooth camera playback along recorded keyframe path
// Uses CatmullRom spline for position, slerp for rotation, lerp for FOV
function updatePlayback() {
  if (!isPlaying) return;

  const elapsed = (performance.now() - playbackStartTime) / 1000;
  let t = elapsed / playbackDuration;

  if (t >= 1) {
    t = 1;
    isPlaying = false;
    previewPathBtn.textContent = 'Preview';
    pathStatus.textContent = 'Playback complete';
    viewer.perspectiveControls.enabled = true;
  }

  // Delegate spline/slerp/fov math to CameraPath
  viewer.camera.position.copy(cameraPath.getPositionAt(t));
  viewer.camera.quaternion.copy(cameraPath.getRotationAt(t));
  viewer.camera.fov = cameraPath.getFovAt(t);
  viewer.camera.updateProjectionMatrix();

  // Sync orbit target so library doesn't fight camera position
  const forward = new THREE.Vector3();
  viewer.camera.getWorldDirection(forward);
  viewer.perspectiveControls.target.copy(viewer.camera.position).addScaledVector(forward, 1);
}

// Toggle playback on/off
function startPreview() {
  if (keyframes.length < 2) return;

  if (isPlaying) {
    isPlaying = false;
    previewPathBtn.textContent = 'Preview';
    pathStatus.textContent = 'Stopped';
    viewer.perspectiveControls.enabled = true;
    return;
  }

  if (walkMode) toggleWalkMode(); // exit walk mode if active
  isPlaying = true;
  playbackStartTime = performance.now();
  previewPathBtn.textContent = 'Stop';
  pathStatus.textContent = 'Playing...';
  viewer.perspectiveControls.enabled = false;
}

function updateFPS() {
  updateWalk();
  updatePlayback();
  frameCount++;
  const currentTime = performance.now();
  const delta = currentTime - lastTime;

  if (delta >= 100) {
    fps = Math.round((frameCount * 1000) / delta);
    frameCount = 0;
    lastTime = currentTime;
    fpsDisplay.textContent = `FPS: ${fps}`;
  }

  requestAnimationFrame(updateFPS);
}

updateFPS();

// Load splat with progress tracking
// Main function that loads Gaussian Splats scene from URL/file for now
async function loadSplat(url) {
  console.log('Starting splat scene load...', url);

  loadingContainer.classList.add('show');
  
  const startTime = performance.now();

  try {
    // Create a loading progress handler 
    // Callback fires during data decompression
    const progressHandler = (progress) => {
      console.log('Loading progress:', progress);
      loadingBar.style.width = `${progress}%`;
      loadingText.textContent = `Loading: ${Math.round(progress)}%`;
    };

    // Load Scene from URL/File
    // ShowLoadingUI: false as we choose not to use default loading screen provided in inital npm package
    // onProgresss: handle loading progress update
    await viewer.addSplatScene(url, {
      showLoadingUI: false,
      onProgress: progressHandler
    });

    // Calculate how long loading took 
    const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`Splat loaded successfully in ${loadTime}s`);
    // Start viewer
    viewer.start();
    console.log('Viewer started');

    // Extract statistics after short delay so splatMesh is fully initialized
    setTimeout(updateSceneStats, 500);

  } catch (error) {

    // Log detailed info for debugging
    console.error('Failed to load splat scene:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    loadingText.textContent = `Error: ${error.message}`;

  } finally {
    // Hide loading bar when done
    loadingContainer.classList.remove('show');

    // Reset bar width after fade-out transition completes (300ms matches CSS opacity transition)
    setTimeout(() => {
      loadingBar.style.width = '0%';
    }, 300);
  }
}

// Extract and display scene metadata
// Retrives scene bounding box, gaussian count, and point count
function updateSceneStats() {
  if (!viewer.splatMesh) return;

  // Extract splat/gaussian count using library's getSplatCount method
  const gaussianCount = viewer.splatMesh.getSplatCount();
  console.log(`Loaded ${gaussianCount.toLocaleString()} gaussians`);
  gaussianCountDisplay.textContent = `Gaussians: ${gaussianCount.toLocaleString()}`;
  pointCountDisplay.textContent = `Points: ${gaussianCount.toLocaleString()}`;
}

// Frame Scene - fit camera to scene bounds
// Uses library's computeBoundingBox() which returns real world-space positions
// (geometry.computeBoundingBox() returns UV/attribute space coords, not world coords)
function frameScene() {
  if (!viewer.splatMesh) {
    console.warn('No scene loaded');
    return;
  }

  console.log('Framing scene...');

  try {
    // computeBoundingBox(true) applies scene transforms → real world-space THREE.Box3
    const bbox = viewer.splatMesh.computeBoundingBox(true);
    if (!bbox) {
      console.warn('Scene bounds not available');
      return;
    }

    // bbox.min/max are Three.js Vector3 objects
    const center = [
      (bbox.min.x + bbox.max.x) / 2,
      (bbox.min.y + bbox.max.y) / 2,
      (bbox.min.z + bbox.max.z) / 2
    ];

    // Find largest dimension (ensures we frame the entire model)
    const size = Math.max(
      bbox.max.x - bbox.min.x, // Width
      bbox.max.y - bbox.min.y, // Height
      bbox.max.z - bbox.min.z  // Depth
    );

    // Fit-sphere formula: distance = (size/2) / tan(fov/2), using actual camera FOV
    const fovRad = THREE.MathUtils.degToRad(viewer.camera.fov);
    const distance = (size / 2) / Math.tan(fovRad / 2);

    // Place camera directly in front of center along +Z with 10% padding
    viewer.perspectiveControls.target.set(center[0], center[1], center[2]);
    viewer.camera.position.set(
      center[0],
      center[1],
      center[2] + distance * 1.1
    );
    viewer.perspectiveControls.update();

    console.log('Scene framed');
  } catch (error) {
    console.error('Error framing scene:', error);
  }
}

// Define function to resetView & return camera to initial position
function resetView() {
  console.log('Resetting view...');

  try {
    // Restore initial camera configuration via controls so orbit stays in sync
    viewer.perspectiveControls.target.set(...initialCameraState.lookAt);
    viewer.camera.position.set(...initialCameraState.position);
    viewer.perspectiveControls.update();
    console.log('View reset');
  } catch (error) {
    console.error('Error resetting view:', error);
  }
}

// Show a key press toast at bottom-center — for demo visibility
let _activeBadge = null;
function showKeyBadge(keyLabel, actionLabel) {
  // Remove any existing toast immediately so rapid presses don't stack
  if (_activeBadge) { _activeBadge.remove(); _activeBadge = null; }
  const badge = document.createElement('div');
  badge.className = 'walk-hud key-badge';
  badge.innerHTML = `<div class="walk-hud-row"><span class="walk-hud-key active">${keyLabel}</span></div><span class="walk-hud-label">${actionLabel}</span>`;
  document.body.appendChild(badge);
  _activeBadge = badge;
  setTimeout(() => badge.classList.add('fade-out'), 900);
  setTimeout(() => { badge.remove(); if (_activeBadge === badge) _activeBadge = null; }, 1200);
}

// Walk mode toggle
function toggleWalkMode() {
  walkMode = !walkMode;

  if (walkMode) {
    // Initialize yaw/pitch from the camera's current orientation
    // so mouse look starts from wherever the camera is pointing
    const euler = new THREE.Euler().setFromQuaternion(viewer.camera.quaternion, 'YXZ');
    yaw = euler.y;
    pitch = euler.x;

    // Disable orbit controls so they don't fight the walk camera
    viewer.perspectiveControls.enabled = false;
    // Request pointer lock so mouse movement is captured
    pointerLockSettled = false;
    document.body.requestPointerLock();
    walkModeBtn.textContent = 'Orbit Mode';
    crosshair.classList.add('show');
    hudMouse.style.display = 'inline';
  } else {
    // Re-enable orbit controls
    viewer.perspectiveControls.enabled = true;
    document.exitPointerLock();
    walkModeBtn.textContent = 'Walk Mode';
    crosshair.classList.remove('show');
    hudMouse.style.display = 'none';
  }
}

// Track held keys for WASD movement
document.addEventListener('keydown', (e) => {
  // Prevent orbit controls from handling WASD when in walk mode
  if (walkMode && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
    e.preventDefault();
  }
  keys[e.code] = true;
  if (hudKeys[e.code]) hudKeys[e.code].classList.add('active');
});
document.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (hudKeys[e.code]) hudKeys[e.code].classList.remove('active');
});

// Tab key toggles walk mode; K adds a keyframe; P previews; block C so the library's mesh cursor stays off
document.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') { e.preventDefault(); toggleWalkMode(); showKeyBadge('Tab', 'Walk Mode'); }
  if (e.code === 'KeyK') { e.preventDefault(); addKeyframe(); showKeyBadge('K', 'Add Keyframe'); }
  if (e.code === 'KeyP') { e.preventDefault(); startPreview(); showKeyBadge('P', 'Preview Path'); }
  if (e.code === 'KeyC') { e.stopImmediatePropagation(); }
});

// Mouse look — only fires while pointer is locked
document.addEventListener('mousemove', (e) => {
  if (!walkMode || !pointerLockSettled) return;
  yaw   += e.movementX * mouseSensitivity;
  pitch += e.movementY * mouseSensitivity;
  // Clamp pitch so camera can't flip upside down
  pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));

  // Rotate camera in place around its own position
  // Move target to be 1 unit in front of camera after rotation
  const euler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  const direction = new THREE.Vector3(0, 0, -1).applyEuler(euler);
  viewer.camera.quaternion.setFromEuler(euler);
  viewer.perspectiveControls.target.copy(viewer.camera.position).addScaledVector(direction, 1);
});

// Exit walk mode if pointer lock is released (e.g. user presses Escape)
// Small delay prevents brief lock drops (e.g. alt-tab) from killing walk mode
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) {
    requestAnimationFrame(() => { pointerLockSettled = true; });
  } else {
    pointerLockSettled = false;
    if (walkMode) {
      setTimeout(() => {
        if (!document.pointerLockElement && walkMode) toggleWalkMode();
      }, 200);
    }
  }
});

// Button event listeners
if (frameSceneBtn){
  frameSceneBtn.addEventListener('click', frameScene);
  console.log('Frame Scene Button listener attached');
} else {
  console.error('frameSceneBtn element not found')
}
if (resetViewBtn){
  resetViewBtn.addEventListener('click', resetView);
  console.log('Reset View Button listener attached');
} else {
  console.error('resetViewBtn element not found')
}
if (walkModeBtn) {
  walkModeBtn.addEventListener('click', toggleWalkMode);
}
if (addKeyframeBtn) addKeyframeBtn.addEventListener('click', addKeyframe);
if (previewPathBtn) previewPathBtn.addEventListener('click', startPreview);
if (clearPathBtn) clearPathBtn.addEventListener('click', () => {
  keyframes.length = 0;
  updateKeyframeList();
  previewPathBtn.disabled = true;
  exportBtn.disabled = true;
  exportBgBtn.disabled = true;
  pathStatus.textContent = '';
});

if (exportBtn) exportBtn.addEventListener('click', () => {
  const [resW, resH] = resSelect.value.split('x').map(Number);
  const exporter = new VideoExporter(viewer, cameraPath, {
    duration: playbackDuration,
    fps: Number(fpsSelect.value),
    width: resW,
    height: resH,
    exposure: Number(exposureSlider.value),
    contrast: Number(contrastSlider.value),
    onProgress: (p, msg) => {
      exportBar.style.width = `${p * 100}%`;
      exportText.textContent = msg;
    },
    onComplete: () => {
      exportProgress.style.display = 'none';
      exportBar.style.width = '0%';
      exportBtn.disabled = false;
    },
    onError: (e) => {
      exportProgress.style.display = 'none';
      exportBar.style.width = '0%';
      exportBtn.disabled = false;
      if (e !== 'Export cancelled') alert(`Export failed: ${e}`);
    },
  });
  exportBtn.disabled = true;
  exportProgress.style.display = 'block';
  exportBar.style.width = '0%';
  cancelExportBtn.onclick = () => exporter.cancel();
  exporter.export();
});

if (exportBgBtn) exportBgBtn.addEventListener('click', () => {
  const [resW, resH] = resSelect.value.split('x').map(Number);

  // Serialize keyframes to plain JSON — THREE objects can't cross the BroadcastChannel
  const config = {
    keyframes: keyframes.map(kf => ({
      id:         kf.id,
      position:   kf.position.toArray(),
      quaternion: [kf.quaternion.x, kf.quaternion.y, kf.quaternion.z, kf.quaternion.w],
      fov:        kf.fov,
    })),
    splatUrl:  splatUrl,
    cameraUp:  [0, -1, 0],
    duration:  playbackDuration,
    fps:       Number(fpsSelect.value),
    width:     resW,
    height:    resH,
    exposure:  Number(exposureSlider.value),
    contrast:  Number(contrastSlider.value),
  };

  const channel = new BroadcastChannel('splat-export');

  // Open the export window. Because COOP: same-origin severs the opener
  // reference, we can't call popup.postMessage() — use BroadcastChannel instead.
  window.open('/export.html', '_blank');

  // Wait for the worker page to signal it's ready, then send the config once.
  const onMessage = (e) => {
    if (e.data?.type === 'worker-ready') {
      channel.removeEventListener('message', onMessage);
      channel.postMessage({ type: 'start-export', config });
      pathStatus.textContent = 'Export running in background window…';
    }
    if (e.data?.type === 'export-complete') {
      pathStatus.textContent = 'Background export complete!';
      channel.close();
    }
    if (e.data?.type === 'export-error') {
      pathStatus.textContent = `Background export error: ${e.data.error}`;
      channel.close();
    }
  };
  channel.addEventListener('message', onMessage);
});

// Color grading — all via CSS filter on the canvas so it works with the splat renderer
// (the splat material sets toneMapped:false, bypassing THREE's tone mapping pipeline)
function applyColorGrading() {
  const exp = Number(exposureSlider.value);
  const con = Number(contrastSlider.value);
  viewer.renderer.domElement.style.filter = `brightness(${exp}) contrast(${con})`;
  exposureVal.textContent = exp.toFixed(2);
  contrastVal.textContent = con.toFixed(2);
  viewer.forceRenderNextFrame();
}

exposureSlider.addEventListener('input', applyColorGrading);
contrastSlider.addEventListener('input', applyColorGrading);

// Clamp duration input to valid range on change
durationInput.addEventListener('change', () => {
  playbackDuration = Math.max(1, Math.min(60, Number(durationInput.value) || 5));
  durationInput.value = playbackDuration;
});

// Save path + render settings to path.json
savePathBtn.addEventListener('click', () => {
  const [w, h] = resSelect.value.split('x').map(Number);
  const data = {
    keyframes: keyframes.map(kf => ({
      id: kf.id,
      position: kf.position.toArray(),
      quaternion: [kf.quaternion.x, kf.quaternion.y, kf.quaternion.z, kf.quaternion.w],
      fov: kf.fov,
    })),
    duration: playbackDuration,
    fps: Number(fpsSelect.value),
    width: w,
    height: h,
    exposure: Number(exposureSlider.value),
    contrast: Number(contrastSlider.value),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'path.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

// Load path.json — restore keyframes + render settings
loadPathBtn.addEventListener('click', () => loadPathInput.click());
loadPathInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      keyframes.length = 0;
      keyframeCounter = 0;
      for (const kf of data.keyframes) {
        keyframes.push({
          id: kf.id,
          position: new THREE.Vector3(...kf.position),
          quaternion: new THREE.Quaternion(...kf.quaternion),
          fov: kf.fov,
        });
        keyframeCounter = Math.max(keyframeCounter, kf.id);
      }
      if (data.duration) { playbackDuration = data.duration; durationInput.value = data.duration; }
      if (data.fps)      { fpsSelect.value = String(data.fps); }
      if (data.width && data.height) { resSelect.value = `${data.width}x${data.height}`; }
      if (data.exposure !== undefined) { exposureSlider.value = data.exposure; }
      if (data.contrast !== undefined) { contrastSlider.value = data.contrast; }
      applyColorGrading();
      updateKeyframeList();
      previewPathBtn.disabled = keyframes.length < 2;
      exportBtn.disabled = keyframes.length < 2;
      exportBgBtn.disabled = keyframes.length < 2;
      pathStatus.textContent = `Loaded ${keyframes.length} keyframe(s)`;
    } catch { alert('Invalid path.json'); }
    loadPathInput.value = '';
  };
  reader.readAsText(file);
});

// Load a .ply or .splat file via URL 
const splatUrl = 'https://huggingface.co/datasets/dylanebert/3dgs/resolve/main/bonsai/bonsai-7k.splat';

// Application entry point
// Load the inital scene 
loadSplat(splatUrl);
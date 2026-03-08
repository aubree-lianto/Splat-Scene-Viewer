import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

console.log('Initializing Gaussian Splats Viewer...');

// CameraUp: Y-axis orientation (defines which direction is "up")
// initialCameraPosition: camera's starting position in the 3D space
// initalCameraLookAt: point at which the camera focuses on initially 
const viewer = new GaussianSplats3D.Viewer({
  cameraUp: [0, -1, -0.6],
  initialCameraPosition: [-1, -4, 6],
  initialCameraLookAt: [0, 4, 0],
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

// Store initial camera configuration
// TODO: figure out whats different between initalCameraState and what this talks to
const initialCameraState = {
  position: [-1, -4, 6],
  lookAt: [0, 4, 0],
  up: [0, -1, -0.6]
};

// Reference to currently loaded 3D scene
let currentScene = null;

// FPS Counter
// TODO: ensure fps is calculated correctly; it is right now just a temporarily defined function
let fps = 0;
let frameCount = 0;
let lastTime = performance.now();

function updateFPS() {
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
    currentScene = await viewer.addSplatScene(url, { 
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
// TODO: Fix algorithm description
function frameScene() {
  if (!currentScene) {
    console.warn('No scene loaded');
    return;
  }

  console.log('Framing scene...');

  try {
    if (currentScene.getSceneBounds) {

      // Get 3D bounding box of the scene
      const bounds = currentScene.getSceneBounds();

      // Calculate center point of bounding box
      const center = [
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2
      ];

      // Find largest dimension (ensures we frame the entire model)
      const size = Math.max(
        bounds.max[0] - bounds.min[0], // Width
        bounds.max[1] - bounds.min[1], // Height
        bounds.max[2] - bounds.min[2]  // Depth
      );

      // Calculate camera distance needed to view entire model
      // Formula: distance = size / tan(FOV/2)
      const distance = size / Math.tan(Math.PI / 8); 

      // Move camera to the calculated position  
      viewer.setCamera({
        position: [
          center[0] - distance * 0.5,
          center[1] - distance * 0.5,
          center[2] + distance
        ],
        lookAt: center, // Look at model center
        up: initialCameraState.up // Maintain consistent "up" direction
      });

      // Log framed scene 
      console.log('Scene framed');
    } else {
      console.warn('Scene bounds not available');
    }
  } catch (error) {
    console.error('Error framing scene:', error);
  }
}

// Define function to resetView & return camera to initial position
function resetView() {
  console.log('Resetting view...');

  try {
    // Restore inital camera configuration
    viewer.setCamera({
      position: initialCameraState.position,
      lookAt: initialCameraState.lookAt,
      up: initialCameraState.up
    });
    console.log('View reset');
  } catch (error) {
    console.error('Error resetting view:', error);
  }
}

// Button event listeners
frameSceneBtn.addEventListener('click', frameScene);
resetViewBtn.addEventListener('click', resetView);

// Load a .ply or .splat file via URL 
const splatUrl = 'https://huggingface.co/datasets/dylanebert/3dgs/resolve/main/bonsai/bonsai-7k.splat';

// Application entry point
// Load the inital scene 
loadSplat(splatUrl);
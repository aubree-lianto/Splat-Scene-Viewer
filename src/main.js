import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

console.log('Initializing Gaussian Splats Viewer...');

const viewer = new GaussianSplats3D.Viewer({
  cameraUp: [0, -1, -0.6],
  initialCameraPosition: [-1, -4, 6],
  initialCameraLookAt: [0, 4, 0],
});

console.log('Viewer created, starting splat scene load...');
const startTime = performance.now();

viewer.addSplatScene(
  'https://huggingface.co/datasets/dylanebert/3dgs/resolve/main/bonsai/bonsai-7k.splat',
  { showLoadingUI: true }
)
.then((scene) => {
  const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`✓ Splat loaded successfully in ${loadTime}s`);
  console.log('Scene object:', scene);
  console.log('Starting viewer...');
  viewer.start();
  console.log('✓ Viewer started');
})
.catch((error) => {
  console.error('✗ Failed to load splat scene:', error);
  console.error('Error details:', {
    message: error.message,
    stack: error.stack,
    name: error.name
  });
});
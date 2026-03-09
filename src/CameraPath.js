import * as THREE from 'three';

// Encapsulates the spline/slerp interpolation math for camera path playback and export.
// Both updatePlayback() in main.js and VideoExporter use this to stay in sync.
export class CameraPath {
  constructor(keyframes) {
    this.keyframes = keyframes; // live reference to the keyframes array in main.js
  }

  // Smoothstep easing: slow start, fast middle, slow end
  _ease(t) {
    return t * t * (3 - 2 * t);
  }

  // CatmullRom spline position at normalized time t [0, 1]
  // tension 0 = tighter curves that pass cleanly through each keyframe,
  // higher tension = more overshoot between points
  getPositionAt(t) {
    const eased = this._ease(t);
    const curve = new THREE.CatmullRomCurve3(
      this.keyframes.map(kf => kf.position),
      false,       // not a closed loop
      'centripetal',  
      0.5          // tension (default, ignored by chordal but required by API)
    );
    return curve.getPoint(eased);
  }

  // Slerp rotation at normalized time t [0, 1]
  getRotationAt(t) {
    const segment = t * (this.keyframes.length - 1);
    const i = Math.min(Math.floor(segment), this.keyframes.length - 2);
    const localT = this._ease(segment - i);
    const q = new THREE.Quaternion();
    q.slerpQuaternions(this.keyframes[i].quaternion, this.keyframes[i + 1].quaternion, localT);
    return q;
  }

  // Linear FOV interpolation at normalized time t [0, 1]
  getFovAt(t) {
    const segment = t * (this.keyframes.length - 1);
    const i = Math.min(Math.floor(segment), this.keyframes.length - 2);
    const localT = this._ease(segment - i);
    return THREE.MathUtils.lerp(this.keyframes[i].fov, this.keyframes[i + 1].fov, localT);
  }
}

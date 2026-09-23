import * as THREE from 'three';

import { generateCloudNoiseData } from './noise3dData.js';

export { generateCloudNoiseData };

export function makeNoiseTexture(data, N) {
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bakes the noise in a Web Worker (≈0.6 s of CPU kept off the main thread, overlapped with downloads).
 * Resolves a Data3DTexture. Falls back to baking inline if workers are unavailable.
 */
export function createCloudNoiseAsync(N = 64) {
  return new Promise((resolve) => {
    try {
      const w = new Worker(new URL('./noise3d.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { resolve(makeNoiseTexture(new Uint8Array(e.data), N)); w.terminate(); };
      w.onerror = () => { w.terminate(); resolve(makeNoiseTexture(generateCloudNoiseData(N), N)); };
      w.postMessage(N);
    } catch {
      resolve(makeNoiseTexture(generateCloudNoiseData(N), N));
    }
  });
}

/** Neutral 1×1×1 stand-in used until the real noise arrives. */
export function placeholderNoise() {
  return makeNoiseTexture(new Uint8Array([128, 128, 128, 128]), 1);
}

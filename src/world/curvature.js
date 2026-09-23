import * as THREE from 'three';
import { CURVATURE_GLSL } from './noise.js';

/**
 * Shared Earth-curvature uniform. Everything in the world is bent relative to the camera so that
 * distant ground drops below the horizon (≈ 785 m at 100 km): Bravo's cloud seen from the
 * Lucky Dragon at 145 km has its base hidden by the curve of the Earth, as it really was.
 */
export const curvatureUniforms = { uCamPos: { value: new THREE.Vector3() } };

export function applyCurvaturePatch(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uCamPos = curvatureUniforms.uCamPos;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CURVATURE_GLSL}`)
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelMatrix * mvPosition;
        mvPosition.xyz = applyCurvature(mvPosition.xyz);
        mvPosition = viewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  const key = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => key() + '|curv';
  return mat;
}

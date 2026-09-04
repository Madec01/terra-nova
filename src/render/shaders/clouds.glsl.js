/**
 * ============================================================================
 *  TERRA NOVA — Couche nuageuse
 * ============================================================================
 *  Sphère transparente au-dessus de la surface. La couverture est pilotée par
 *  `uCoverage` (= state.globals.cloudCover, 0..1) :
 *    - à 0 : le seuil de densité est au-dessus du maximum du bruit → rien.
 *    - à 1 : le ciel est entièrement couvert.
 *
 *  Le bruit est un fbm 4 octaves en value-noise 3D, advecté lentement par
 *  `uTime` pour donner l'impression d'un système météo qui vit. La rotation
 *  propre du mesh (indépendante de la planète) est gérée côté JS.
 * ============================================================================
 */

import { NOISE_GLSL } from './planet.glsl.js';

export const cloudVertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vObject;

void main() {
  vObject = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const cloudFragmentShader = /* glsl */ `
${NOISE_GLSL}

uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform vec3  uNightAmbient;
uniform float uCoverage;
uniform float uTime;
uniform float uInsolation;
uniform float uTint;      // 0 = nuages blancs, 1 = nuages chargés/ocre (pollution)

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vObject;

void main() {
  if (uCoverage <= 0.001) discard;

  vec3 p = vObject;

  // Deux couches de bruit advectées à des vitesses différentes : les motifs
  // se déforment lentement au lieu de « glisser » en bloc.
  vec3 q = p * 2.6 + vec3(uTime * 0.010, uTime * 0.004, -uTime * 0.007);
  float warp = tnFbm3(p * 1.7 - vec3(uTime * 0.006));
  vec3 r = q + vec3(warp) * 0.85;

  float n = tnFbm4(r * 1.9);

  // Bandes latitudinales : les nuages s'organisent en ceintures, comme sur une
  // vraie planète en rotation.
  float bands = 0.5 + 0.5 * sin(p.y * 7.5 + warp * 2.2);
  n = mix(n, n * (0.55 + 0.65 * bands), 0.45);

  // Seuil piloté par la couverture. cover=0 → seuil 1.05 (inatteignable).
  float cover = clamp(uCoverage, 0.0, 1.0);
  float threshold = mix(1.05, 0.20, cover);
  float density = smoothstep(threshold, threshold + 0.26, n);
  if (density <= 0.002) discard;

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDirection);

  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.32) / 1.32, 0.0, 1.0);
  wrap *= wrap * (3.0 - 2.0 * wrap);

  // Auto-ombrage doux : les zones denses sont un peu plus grises en dessous.
  float shade = mix(1.0, 0.72, smoothstep(0.25, 1.0, density));

  vec3 white = mix(vec3(0.94, 0.95, 0.97), vec3(0.72, 0.63, 0.50), clamp(uTint, 0.0, 1.0));
  vec3 color = white * shade * uSunColor * wrap * uInsolation;
  color += white * uNightAmbient * 0.8;

  // Liseré lumineux au limbe éclairé (diffusion avant).
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
  color += uSunColor * rim * smoothstep(0.0, 0.4, ndl) * 0.25;

  // Le bord des nuages est plus fin donc plus transparent.
  float alpha = density * (0.30 + 0.62 * cover);
  alpha *= 0.35 + 0.65 * wrap;   // côté nuit, les nuages s'effacent presque

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default { cloudVertexShader, cloudFragmentShader };

/**
 * ============================================================================
 *  TERRA NOVA — Ciel : champ d'étoiles + nébuleuse de fond
 * ============================================================================
 *  Deux objets seulement :
 *   1. un THREE.Points de BALANCE.render.starCount étoiles réparties
 *      uniformément sur une sphère lointaine, avec taille, teinte et phase de
 *      scintillation propres à chaque étoile (tout est dans des attributs, le
 *      scintillement se calcule dans le shader : coût CPU nul) ;
 *   2. une grande sphère BackSide avec un dégradé très discret, pour que le
 *      vide ne soit pas un noir plat et que la planète se détache.
 *
 *  Le ciel suit la caméra en position (jamais en rotation) : impossible d'en
 *  sortir en zoomant.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';

const SKY_RADIUS = 60;

/* --- couleurs stellaires plausibles : blanc dominant, quelques bleues et
       quelques orangées. Le violet et le vert n'existent pas dans le ciel. --- */
const STAR_TINTS = [
  [0.62, 0.72, 1.00],   // bleue chaude
  [0.80, 0.86, 1.00],
  [1.00, 1.00, 1.00],   // blanche
  [1.00, 1.00, 1.00],
  [1.00, 0.97, 0.90],
  [1.00, 0.88, 0.70],   // jaune-orangée
  [1.00, 0.74, 0.52],   // orangée
];

const starVertexShader = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aTint;

uniform float uTime;
uniform float uPixelRatio;

varying vec3 vTint;
varying float vTwinkle;

void main() {
  vTint = aTint;
  // Scintillation très légère : deux sinus déphasés pour éviter la pulsation
  // mécanique d'un sinus unique.
  float t = uTime * 1.6 + aPhase * 6.28318;
  vTwinkle = 0.82 + 0.18 * (0.6 * sin(t) + 0.4 * sin(t * 1.71 + 1.3));

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * vTwinkle;
}
`;

const starFragmentShader = /* glsl */ `
varying vec3 vTint;
varying float vTwinkle;

void main() {
  // Disque doux : un point carré se voit immédiatement.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.02, r2);
  gl_FragColor = vec4(vTint * vTwinkle, a);
  #include <colorspace_fragment>
}
`;

const nebulaVertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const nebulaFragmentShader = /* glsl */ `
varying vec3 vDir;
uniform vec3 uColorA;
uniform vec3 uColorB;

// Bruit de valeur très basse fréquence : quelques nappes, rien de plus.
float h(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.31, 0.17, 0.53));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

void main() {
  float n = vnoise(vDir * 1.8) * 0.6 + vnoise(vDir * 4.3) * 0.3 + vnoise(vDir * 9.1) * 0.1;
  // Une bande de « voie lactée » diagonale, très atténuée.
  float band = exp(-pow(dot(vDir, normalize(vec3(0.42, 0.72, -0.55))) * 2.6, 2.0));
  vec3 c = mix(uColorA, uColorB, smoothstep(0.28, 0.72, n));
  c *= 0.35 + 0.65 * n;
  c += uColorB * band * 0.35;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

export class StarField {
  constructor(pixelRatio = 1) {
    this.object3D = new THREE.Group();
    this.object3D.name = 'sky';
    // Le ciel ne doit jamais être écarté par le frustum culling ni écrire dans
    // le depth buffer : il est le fond de tout.
    this.object3D.frustumCulled = false;

    this._buildNebula();
    this._buildStars(pixelRatio);
  }

  _buildNebula() {
    this.nebulaGeometry = new THREE.IcosahedronGeometry(SKY_RADIUS * 1.4, 2);
    this.nebulaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color(0.008, 0.010, 0.020) },
        uColorB: { value: new THREE.Color(0.035, 0.042, 0.075) },
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.nebula = new THREE.Mesh(this.nebulaGeometry, this.nebulaMaterial);
    this.nebula.name = 'nebula';
    this.nebula.frustumCulled = false;
    this.nebula.renderOrder = -20;
    this.object3D.add(this.nebula);
  }

  _buildStars(pixelRatio) {
    const n = Math.max(1, BALANCE.render.starCount | 0);
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const tint = new Float32Array(n * 3);

    // Répartition uniforme sur la sphère (méthode de l'anneau : z uniforme).
    for (let i = 0; i < n; i++) {
      const z = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      pos[i * 3] = Math.cos(a) * r * SKY_RADIUS;
      pos[i * 3 + 1] = z * SKY_RADIUS;
      pos[i * 3 + 2] = Math.sin(a) * r * SKY_RADIUS;

      // Distribution de magnitude : beaucoup de petites, quelques grosses.
      const m = Math.random();
      size[i] = 0.9 + m * m * m * 5.2;
      phase[i] = Math.random();

      const t = STAR_TINTS[(Math.random() * STAR_TINTS.length) | 0];
      // Les étoiles faibles sont perçues plus grises.
      const f = 0.55 + 0.45 * m;
      tint[i * 3] = t[0] * f;
      tint[i * 3 + 1] = t[1] * f;
      tint[i * 3 + 2] = t[2] * f;
    }

    this.starGeometry = new THREE.BufferGeometry();
    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starGeometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starGeometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    this.starGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_RADIUS * 1.1);

    this.starUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
    };
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.stars = new THREE.Points(this.starGeometry, this.starMaterial);
    this.stars.name = 'stars';
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -10;
    this.object3D.add(this.stars);
  }

  setPixelRatio(pr) { this.starUniforms.uPixelRatio.value = pr; }

  update(dt) { this.starUniforms.uTime.value += dt; }

  /** Recentre le ciel sur la caméra pour qu'on ne puisse jamais en sortir. */
  follow(camera) { this.object3D.position.copy(camera.position); }

  dispose() {
    this.starGeometry.dispose();
    this.starMaterial.dispose();
    this.nebulaGeometry.dispose();
    this.nebulaMaterial.dispose();
    this.object3D.clear();
  }
}

export default StarField;

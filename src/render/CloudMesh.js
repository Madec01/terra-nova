/**
 * ============================================================================
 *  TERRA NOVA — Couche nuageuse
 * ============================================================================
 *  Sphère transparente au-dessus de la surface. Tout le dessin est procédural
 *  (fbm 4 octaves) : zéro texture à charger, zéro mémoire vidéo.
 *
 *  La sphère tourne lentement sur elle-même, indépendamment de la planète :
 *  c'est ce décalage qui donne l'impression d'une circulation atmosphérique.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { clamp01 } from '../utils/math.js';
import { cloudVertexShader, cloudFragmentShader } from './shaders/clouds.glsl.js';

/** Vitesse de rotation propre de la couche (rad/s). */
const SPIN = 0.012;

export class CloudMesh {
  constructor(shared) {
    this.radius = BALANCE.planet.radius;

    this.uniforms = {
      uSunDirection: shared.uSunDirection,
      uSunColor: shared.uSunColor,
      uNightAmbient: shared.uNightAmbient,
      uInsolation: shared.uInsolation,
      uTime: shared.uTime,
      uCoverage: { value: 0 },
      uTint: { value: 0 },
    };

    this.geometry = new THREE.IcosahedronGeometry(1, 5);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'clouds';
    this.mesh.renderOrder = 2;
    // Altitude : au-dessus du relief maximal (radius * (1 + reliefScale)).
    this.mesh.scale.setScalar(this.radius * (1 + BALANCE.planet.reliefScale + 0.014));
    this.mesh.visible = false;
    this.object3D = this.mesh;
  }

  /**
   * @param {number} coverage state.globals.cloudCover, 0..1 (déjà lissé)
   * @param {number} tint     0 = nuages blancs, 1 = nuages chargés (pollution)
   */
  setCoverage(coverage, tint = 0) {
    const c = clamp01(coverage);
    this.uniforms.uCoverage.value = c;
    this.uniforms.uTint.value = clamp01(tint);
    this.mesh.visible = c > 0.004;
  }

  update(dt) {
    this.mesh.rotation.y += SPIN * dt;
    if (this.mesh.rotation.y > Math.PI * 2) this.mesh.rotation.y -= Math.PI * 2;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export default CloudMesh;

/**
 * ============================================================================
 *  TERRA NOVA — Halo atmosphérique
 * ============================================================================
 *  Une sphère un peu plus grande que la planète, rendue en BackSide avec un
 *  blending additif. On ne voit donc que la tranche d'atmosphère au limbe :
 *  c'est exactement l'effet recherché, et cela ne coûte quasiment rien.
 *
 *  Le rayon lui-même grandit un peu avec la pression : une atmosphère épaisse
 *  « déborde » visuellement plus qu'une atmosphère résiduelle.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { clamp01 } from '../utils/math.js';
import { atmosphereVertexShader, atmosphereFragmentShader } from './shaders/atmosphere.glsl.js';

export class AtmosphereMesh {
  /**
   * @param {object} shared uniforms partagés avec la planète (soleil, temps…)
   */
  constructor(shared) {
    this.radius = BALANCE.planet.radius;

    this.uniforms = {
      uSunDirection: shared.uSunDirection,
      uSunColor: shared.uSunColor,
      uInsolation: shared.uInsolation,
      uTime: shared.uTime,
      uPressure: { value: BALANCE.start.globals.pressure },
      uOxygen: { value: BALANCE.start.globals.oxygen },
    };

    this.geometry = new THREE.IcosahedronGeometry(1, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'atmosphere';
    this.mesh.renderOrder = 3;
    this.object3D = this.mesh;

    this.setState(BALANCE.start.globals.pressure, BALANCE.start.globals.oxygen);
  }

  /**
   * @param {number} pressure kPa (valeur déjà lissée par SceneManager)
   * @param {number} oxygen   % du volume atmosphérique
   */
  setState(pressure, oxygen) {
    const p = Math.max(0, pressure || 0);
    this.uniforms.uPressure.value = p;
    this.uniforms.uOxygen.value = Math.max(0, oxygen || 0);

    // Épaisseur visible : de +2 % (planète nue) à +9 % du rayon (atmosphère dense).
    const thick = 0.020 + 0.070 * clamp01(1 - Math.exp(-p / 38));
    this.mesh.scale.setScalar(this.radius * (1 + thick));

    // Sous une pression ridicule, on éteint carrément le mesh : rien à dessiner.
    this.mesh.visible = p > 0.05;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export default AtmosphereMesh;

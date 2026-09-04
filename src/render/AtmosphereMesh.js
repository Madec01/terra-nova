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
      // Les deux rayons servent au calcul analytique de l'épaisseur traversée
      // (voir atmosphereFragmentShader) : sans eux le halo dégénère en anneau
      // à bord franc.
      uPlanetRadius: { value: this.radius },
      uShellRadius: { value: this.radius * 1.02 },
    };

    // Subdivision 5 : à 4, le bord EXTÉRIEUR de la coquille dessinait un
    // polygone visible autour du halo.
    this.geometry = new THREE.IcosahedronGeometry(1, 5);
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

    // Épaisseur visible : de +1,5 % (atmosphère résiduelle) à +8 % du rayon
    // (atmosphère dense). La coquille reste au-dessus du relief maximal.
    const thick = 0.012 + 0.055 * clamp01(1 - Math.exp(-p / 38));
    const shell = this.radius * (1 + thick);
    this.mesh.scale.setScalar(shell);
    this.uniforms.uShellRadius.value = shell;

    // Sous ~4 kPa il n'y a rien à dessiner : le shader renverrait de toute
    // façon une intensité nulle, autant économiser la passe entière. C'est ce
    // qui garantit une planète de départ VRAIMENT nue, sans frange brunâtre.
    this.mesh.visible = p > 4.0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export default AtmosphereMesh;

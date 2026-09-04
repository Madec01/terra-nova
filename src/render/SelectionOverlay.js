/**
 * ============================================================================
 *  TERRA NOVA — Sélection, survol et ondes de surface
 * ============================================================================
 *  Trois choses, trois coûts minimes :
 *   1. le contour de la région sélectionnée : un LineLoop reconstruit
 *      uniquement quand la sélection change (buffer préalloué, drawRange) ;
 *   2. le même en plus discret pour le survol ;
 *   3. les ondes (clic + scan) : UNE seule sphère un peu plus grande que la
 *      planète, dont le shader dessine jusqu'à quatre anneaux se propageant
 *      depuis un point donné. Comme l'onde est calculée en distance ANGULAIRE,
 *      elle épouse naturellement la courbure du globe — bien plus juste qu'un
 *      disque plat posé en tangente.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';

/** Nombre d'ondes simultanées. */
const MAX_WAVES = 4;
/** Durée du feedback de clic (secondes). */
const PULSE_TIME = 0.5;
/** Période d'une onde de scan (secondes) : elle se répète pendant tout le scan. */
const SCAN_PERIOD = 1.6;
/** Nombre maximum de coins d'une cellule (hexagone + marge). */
const MAX_CORNERS = 8;

const waveVertex = /* glsl */ `
varying vec3 vObj;
void main() {
  vObj = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const waveFragment = /* glsl */ `
uniform vec4 uWaves[${MAX_WAVES}];    // xyz = direction du centre, w = progression (<0 : inactif)
uniform vec4 uParams[${MAX_WAVES}];   // x = rayon angulaire max, y = type (0 clic, 1 scan), z = épaisseur, w = intensité

varying vec3 vObj;

void main() {
  vec3 d = normalize(vObj);
  float acc = 0.0;
  vec3 col = vec3(0.0);

  for (int i = 0; i < ${MAX_WAVES}; i++) {
    float p = uWaves[i].w;
    if (p < 0.0) continue;
    float ang = acos(clamp(dot(d, uWaves[i].xyz), -1.0, 1.0));
    float radius = p * uParams[i].x;
    float thick = uParams[i].z;
    float ring = exp(-pow((ang - radius) / thick, 2.0));
    // Disparition en fin de course + atténuation avec la distance parcourue.
    float fade = (1.0 - p) * (1.0 - p);
    float a = ring * fade * uParams[i].w;
    acc += a;
    col += mix(vec3(0.40, 0.88, 1.00), vec3(0.55, 0.95, 0.85), uParams[i].y) * a;
  }

  if (acc <= 0.002) discard;
  gl_FragColor = vec4(col / max(acc, 0.001) * min(acc, 1.5), clamp(acc, 0.0, 1.0) * 0.9);
  #include <colorspace_fragment>
}
`;

export class SelectionOverlay {
  constructor(planetMesh) {
    this.planet = planetMesh;
    this.object3D = new THREE.Group();
    this.object3D.name = 'overlay';
    this.time = 0;

    this.selected = null;
    this.hovered = null;

    this._buildOutlines();
    this._buildWaves();
  }

  _buildOutlines() {
    const make = (color, width, opacity) => {
      const geo = new THREE.BufferGeometry();
      const arr = new Float32Array(MAX_CORNERS * 3);
      const attr = new THREE.BufferAttribute(arr, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      geo.setDrawRange(0, 0);
      // Sphère englobante fixe : jamais de recalcul, jamais de culling raté.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BALANCE.planet.radius * 1.2);
      const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthTest: true, depthWrite: false, linewidth: width,
      });
      const line = new THREE.LineLoop(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 5;
      line.visible = false;
      this.object3D.add(line);
      return { geo, attr, mat, line };
    };

    this.selLine = make(0x4fe3ff, 2, 0.95);
    this.hovLine = make(0xdfe8ee, 1, 0.45);
  }

  _buildWaves() {
    const waves = [];
    const params = [];
    for (let i = 0; i < MAX_WAVES; i++) {
      waves.push(new THREE.Vector4(0, 1, 0, -1));
      params.push(new THREE.Vector4(0.5, 0, 0.045, 1));
    }
    this._waveUniforms = {
      uWaves: { value: waves },
      uParams: { value: params },
    };

    this.waveGeometry = new THREE.IcosahedronGeometry(BALANCE.planet.radius * (1 + BALANCE.planet.reliefScale + 0.004), 4);
    this.waveMaterial = new THREE.ShaderMaterial({
      uniforms: this._waveUniforms,
      vertexShader: waveVertex,
      fragmentShader: waveFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    this.waveMesh = new THREE.Mesh(this.waveGeometry, this.waveMaterial);
    this.waveMesh.name = 'surface-waves';
    this.waveMesh.frustumCulled = false;
    this.waveMesh.renderOrder = 4;
    this.waveMesh.visible = false;
    this.object3D.add(this.waveMesh);

    /** Emplacements d'ondes : { active, kind, elapsed, duration, dir } */
    this._slots = [];
    for (let i = 0; i < MAX_WAVES; i++) {
      this._slots.push({ active: false, kind: 0, elapsed: 0, duration: 0, dir: new THREE.Vector3(0, 1, 0) });
    }
  }

  /* ==================================================================== */

  setSelected(regionId) {
    if (regionId === this.selected) return;
    this.selected = regionId;
    this._writeOutline(this.selLine, regionId, 1.010);
  }

  setHovered(regionId) {
    if (regionId === this.hovered) return;
    this.hovered = regionId;
    this._writeOutline(this.hovLine, regionId, 1.006);
  }

  /** Recalcule le contour d'une cellule à partir des sommets réels du maillage. */
  _writeOutline(target, regionId, lift) {
    if (regionId === null || regionId === undefined || regionId < 0 || !this.planet) {
      target.line.visible = false;
      target.geo.setDrawRange(0, 0);
      return;
    }
    const n = this.planet.getCellOutline(regionId, target.attr.array, lift);
    if (n <= 0) { target.line.visible = false; return; }
    target.geo.setDrawRange(0, n);
    target.attr.needsUpdate = true;
    target.line.visible = true;
  }

  /** Le contour doit suivre le relief si la planète est reconstruite. */
  refresh() {
    const s = this.selected, h = this.hovered;
    this.selected = null; this.hovered = null;
    this.setSelected(s); this.setHovered(h);
  }

  /* ==================================================================== */

  _spawn(regionId, kind, duration, maxAngle, thickness, intensity) {
    if (!this.planet || regionId === null || regionId === undefined || regionId < 0) return;
    // On prend l'emplacement libre, sinon le plus avancé (il va disparaître).
    let slot = this._slots.find((s) => !s.active);
    if (!slot) {
      slot = this._slots[0];
      for (const s of this._slots) if (s.elapsed / Math.max(s.duration, 1e-3) > slot.elapsed / Math.max(slot.duration, 1e-3)) slot = s;
    }
    const idx = this._slots.indexOf(slot);
    slot.active = true;
    slot.kind = kind;
    slot.elapsed = 0;
    slot.duration = duration;
    this.planet.getRegionDirection(regionId, slot.dir);

    const p = this._waveUniforms.uParams.value[idx];
    p.set(maxAngle, kind, thickness, intensity);
    this.waveMesh.visible = true;
  }

  /** Feedback de clic : un anneau s'agrandit et s'efface en ~0,5 s. */
  pulse(regionId) {
    this._spawn(regionId, 0, PULSE_TIME, 0.20, 0.030, 1.15);
  }

  /** Onde de scan : se propage en boucle pendant toute la durée du scan. */
  scanWave(regionId, durationSeconds = 3) {
    this._spawn(regionId, 1, Math.max(0.4, durationSeconds), 0.55, 0.045, 0.85);
  }

  /* ==================================================================== */

  update(dt) {
    this.time += dt;

    // Pulsation d'opacité du contour de sélection : douce, jamais clignotante.
    if (this.selLine.line.visible) {
      this.selLine.mat.opacity = 0.62 + 0.33 * (0.5 + 0.5 * Math.sin(this.time * 3.1));
    }
    if (this.hovLine.line.visible) {
      this.hovLine.mat.opacity = 0.30 + 0.16 * (0.5 + 0.5 * Math.sin(this.time * 2.2));
    }

    let any = false;
    const waves = this._waveUniforms.uWaves.value;
    for (let i = 0; i < MAX_WAVES; i++) {
      const s = this._slots[i];
      const w = waves[i];
      if (!s.active) { w.w = -1; continue; }
      s.elapsed += dt;
      if (s.elapsed >= s.duration) { s.active = false; w.w = -1; continue; }
      // Clic : une seule passe. Scan : l'onde se répète.
      const p = s.kind === 0
        ? s.elapsed / s.duration
        : (s.elapsed % SCAN_PERIOD) / SCAN_PERIOD;
      w.set(s.dir.x, s.dir.y, s.dir.z, p);
      any = true;
    }
    this.waveMesh.visible = any;
  }

  dispose() {
    this.selLine.geo.dispose(); this.selLine.mat.dispose();
    this.hovLine.geo.dispose(); this.hovLine.mat.dispose();
    this.waveGeometry.dispose(); this.waveMaterial.dispose();
    this.object3D.clear();
  }
}

export default SelectionOverlay;

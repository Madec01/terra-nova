/**
 * ============================================================================
 *  TERRA NOVA — Bâtiments (InstancedMesh, un par type)
 * ============================================================================
 *  Un THREE.InstancedMesh par type de bâtiment : 17 draw calls au maximum,
 *  quel que soit le nombre de constructions. Les géométries sont fabriquées
 *  procéduralement à partir de primitives Three fusionnées à la main (pas de
 *  dépendance à `three/examples`).
 *
 *  Convention de modélisation : chaque modèle est construit avec +Y vers le
 *  ciel et sa base en y = 0, dans une unité où 1 ≈ le rayon d'une cellule.
 *  L'instanciation se charge d'orienter +Y sur la normale de la région et de
 *  mettre à l'échelle selon la taille réelle de la cellule.
 *
 *  Les matrices ne sont reconstruites QUE lorsque la liste des bâtiments
 *  change (comparaison de signature) ou pour les quelques instances en cours
 *  d'animation d'apparition / de rotation.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { clamp01 } from '../utils/math.js';

/** Durée de l'animation d'apparition d'un bâtiment (secondes). */
const GROW_TIME = 0.6;

/* -------------------------------------------------------------------------- */
/*  Palette                                                                   */
/* -------------------------------------------------------------------------- */

const C = {
  metal:   [0.58, 0.60, 0.63],
  steel:   [0.42, 0.45, 0.50],
  dark:    [0.20, 0.22, 0.26],
  rust:    [0.52, 0.33, 0.20],
  copper:  [0.62, 0.40, 0.24],
  panel:   [0.13, 0.19, 0.36],
  glass:   [0.45, 0.78, 0.95],
  lamp:    [1.00, 0.72, 0.34],
  green:   [0.30, 0.62, 0.34],
  ice:     [0.72, 0.86, 0.94],
  gold:    [0.72, 0.58, 0.22],
  white:   [0.86, 0.87, 0.88],
};

/* -------------------------------------------------------------------------- */
/*  Fusion de primitives (remplace BufferGeometryUtils, hors périmètre)       */
/* -------------------------------------------------------------------------- */

const _m4 = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();

/**
 * Assemble une liste de morceaux en UNE géométrie non indexée portant
 * position / normal / aColor / aMask (aMask = 1 → surface émissive).
 */
function mergeParts(parts) {
  let total = 0;
  const prepared = [];
  for (const p of parts) {
    let g = p.geometry;
    if (g.index) g = g.toNonIndexed();
    else g = g.clone();
    if (p.matrix) {
      g.applyMatrix4(p.matrix);
      // applyMatrix4 met déjà les normales à jour.
    }
    const n = g.getAttribute('position').count;
    total += n;
    prepared.push({ g, n, color: p.color, mask: p.mask || 0 });
    // La primitive d'origine ne sert plus : on la libère tout de suite.
    if (p.geometry !== g) p.geometry.dispose();
  }

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const msk = new Float32Array(total);

  let o = 0;
  for (const p of prepared) {
    const gp = p.g.getAttribute('position').array;
    const gn = p.g.getAttribute('normal').array;
    pos.set(gp, o * 3);
    nrm.set(gn, o * 3);
    for (let i = 0; i < p.n; i++) {
      col[(o + i) * 3] = p.color[0];
      col[(o + i) * 3 + 1] = p.color[1];
      col[(o + i) * 3 + 2] = p.color[2];
      msk[o + i] = p.mask;
    }
    o += p.n;
    p.g.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aMask', new THREE.BufferAttribute(msk, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Fabrique un morceau positionné/orienté. */
function part(geometry, color, opt = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(opt.rx || 0, opt.ry || 0, opt.rz || 0);
  q.setFromEuler(e);
  m.compose(
    new THREE.Vector3(opt.x || 0, opt.y || 0, opt.z || 0),
    q,
    new THREE.Vector3(opt.sx ?? 1, opt.sy ?? 1, opt.sz ?? 1),
  );
  return { geometry, color, mask: opt.mask || 0, matrix: m };
}

const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cone = (r, h, seg = 10) => new THREE.ConeGeometry(r, h, seg, 1);
const sph = (r, seg = 10) => new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1));
const dome = (r, seg = 12) => new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1), 0, Math.PI * 2, 0, Math.PI * 0.5);
const torus = (r, t, seg = 16) => new THREE.TorusGeometry(r, t, 6, seg);

/* -------------------------------------------------------------------------- */
/*  Les 17 modèles                                                            */
/* -------------------------------------------------------------------------- */

const MODELS = {
  /** Mine : tour de forage à quatre pieds + cône de déblais. */
  mine: () => mergeParts([
    part(cone(0.52, 0.26, 8), C.rust, { x: 0.42, y: 0.13, z: 0.30 }),
    part(box(0.46, 0.16, 0.46), C.steel, { y: 0.08 }),
    part(cyl(0.05, 0.13, 0.85, 4), C.metal, { y: 0.5 }),
    part(cyl(0.10, 0.10, 0.10, 6), C.dark, { y: 0.95 }),
    part(box(0.09, 0.09, 0.09), C.lamp, { y: 1.02, mask: 1 }),
    part(box(0.30, 0.16, 0.20), C.dark, { x: -0.30, y: 0.08 }),
  ]),

  /** Raffinerie : trois cuves reliées par une passerelle. */
  refinery: () => mergeParts([
    part(cyl(0.20, 0.20, 0.62, 12), C.metal, { x: -0.24, y: 0.31 }),
    part(dome(0.20, 10), C.metal, { x: -0.24, y: 0.62 }),
    part(cyl(0.16, 0.16, 0.46, 12), C.steel, { x: 0.22, z: 0.16, y: 0.23 }),
    part(dome(0.16, 10), C.steel, { x: 0.22, z: 0.16, y: 0.46 }),
    part(cyl(0.05, 0.05, 0.80, 6), C.dark, { x: 0.26, z: -0.22, y: 0.40 }),
    part(box(0.62, 0.05, 0.10), C.dark, { y: 0.55 }),
    part(box(0.06, 0.06, 0.06), C.lamp, { x: 0.26, z: -0.22, y: 0.82, mask: 1 }),
  ]),

  /** Dépôt : empilement de conteneurs. */
  depot: () => mergeParts([
    part(box(0.34, 0.24, 0.28), C.copper, { x: -0.18, y: 0.12 }),
    part(box(0.34, 0.24, 0.28), C.steel, { x: 0.18, y: 0.12, ry: 0.2 }),
    part(box(0.30, 0.22, 0.26), C.rust, { x: 0.0, y: 0.35, ry: -0.3 }),
    part(box(0.05, 0.03, 0.26), C.lamp, { x: 0.0, y: 0.47, mask: 1 }),
  ]),

  /** Champ solaire : trois panneaux plats inclinés vers l'étoile. */
  solar: () => mergeParts([
    part(box(0.62, 0.02, 0.30), C.panel, { z: -0.30, y: 0.24, rx: -0.55, mask: 0 }),
    part(box(0.62, 0.02, 0.30), C.panel, { z: 0.0, y: 0.24, rx: -0.55 }),
    part(box(0.62, 0.02, 0.30), C.panel, { z: 0.30, y: 0.24, rx: -0.55 }),
    part(cyl(0.02, 0.02, 0.26, 5), C.steel, { z: -0.30, y: 0.13 }),
    part(cyl(0.02, 0.02, 0.26, 5), C.steel, { z: 0.0, y: 0.13 }),
    part(cyl(0.02, 0.02, 0.26, 5), C.steel, { z: 0.30, y: 0.13 }),
    part(box(0.10, 0.10, 0.10), C.dark, { x: -0.36, y: 0.05 }),
    part(box(0.05, 0.02, 0.05), C.lamp, { x: -0.36, y: 0.11, mask: 1 }),
  ]),

  /** Géothermie : cheminée large + anneau de captage au sol. */
  geothermal: () => mergeParts([
    part(torus(0.40, 0.05, 18), C.steel, { y: 0.05, rx: Math.PI / 2 }),
    part(cyl(0.13, 0.20, 0.80, 12), C.metal, { y: 0.40 }),
    part(torus(0.15, 0.03, 12), C.dark, { y: 0.66, rx: Math.PI / 2 }),
    part(cyl(0.12, 0.12, 0.05, 12), C.lamp, { y: 0.82, mask: 1 }),
    part(box(0.20, 0.14, 0.20), C.dark, { x: 0.34, y: 0.07 }),
  ]),

  /** Fusion : tore de confinement sur socle. */
  fusion: () => mergeParts([
    part(cyl(0.36, 0.40, 0.12, 14), C.dark, { y: 0.06 }),
    part(torus(0.28, 0.10, 20), C.metal, { y: 0.36, rx: Math.PI / 2 }),
    part(sph(0.11, 12), C.glass, { y: 0.36, mask: 1 }),
    part(cyl(0.05, 0.05, 0.30, 6), C.steel, { x: 0.30, y: 0.21 }),
    part(cyl(0.05, 0.05, 0.30, 6), C.steel, { x: -0.30, y: 0.21 }),
  ]),

  /** Station scientifique : dôme + mât d'antenne + parabole. */
  science_station: () => mergeParts([
    part(cyl(0.32, 0.34, 0.08, 14), C.steel, { y: 0.04 }),
    part(dome(0.30, 14), C.white, { y: 0.08 }),
    part(box(0.34, 0.06, 0.03), C.glass, { y: 0.20, z: 0.24, mask: 1 }),
    part(cyl(0.015, 0.015, 0.55, 5), C.dark, { x: 0.24, y: 0.30 }),
    part(cone(0.13, 0.10, 12), C.white, { x: 0.24, y: 0.60, rx: Math.PI * 0.78 }),
    part(box(0.04, 0.04, 0.04), C.lamp, { x: 0.24, y: 0.58, mask: 1 }),
  ]),

  /** Extracteur de glace : foreuse inclinée + treuil. */
  ice_extractor: () => mergeParts([
    part(box(0.40, 0.14, 0.34), C.steel, { y: 0.07 }),
    part(cyl(0.07, 0.07, 0.62, 8), C.metal, { y: 0.42, rz: 0.28 }),
    part(cone(0.09, 0.24, 8), C.dark, { x: 0.22, y: 0.78, rz: 0.28 }),
    part(cyl(0.16, 0.16, 0.10, 10), C.ice, { x: -0.26, y: 0.19 }),
    part(box(0.06, 0.03, 0.06), C.lamp, { x: -0.10, y: 0.15, mask: 1 }),
  ]),

  /** Usine à gaz à effet de serre : trois cheminées fumantes. */
  ghg_factory: () => mergeParts([
    part(box(0.56, 0.20, 0.40), C.dark, { y: 0.10 }),
    part(cyl(0.06, 0.09, 0.72, 9), C.rust, { x: -0.16, y: 0.56 }),
    part(cyl(0.05, 0.08, 0.56, 9), C.rust, { x: 0.06, z: 0.12, y: 0.48 }),
    part(cyl(0.05, 0.07, 0.42, 9), C.rust, { x: 0.20, z: -0.10, y: 0.41 }),
    part(cyl(0.07, 0.07, 0.04, 9), C.lamp, { x: -0.16, y: 0.92, mask: 1 }),
    part(box(0.30, 0.05, 0.05), C.steel, { y: 0.24, z: 0.20 }),
  ]),

  /** Processeur atmosphérique : tour élancée à collerettes. */
  atmo_processor: () => mergeParts([
    part(cyl(0.20, 0.26, 0.10, 12), C.dark, { y: 0.05 }),
    part(cyl(0.09, 0.15, 1.05, 12), C.metal, { y: 0.62 }),
    part(torus(0.14, 0.025, 14), C.steel, { y: 0.45, rx: Math.PI / 2 }),
    part(torus(0.12, 0.025, 14), C.steel, { y: 0.78, rx: Math.PI / 2 }),
    part(cyl(0.11, 0.09, 0.10, 12), C.glass, { y: 1.18, mask: 1 }),
    part(cone(0.10, 0.16, 12), C.metal, { y: 1.30 }),
  ]),

  /** Générateur d'oxygène : sphère de stockage sur pylônes. */
  o2_generator: () => mergeParts([
    part(cyl(0.03, 0.03, 0.42, 5), C.steel, { x: 0.18, z: 0.18, y: 0.21 }),
    part(cyl(0.03, 0.03, 0.42, 5), C.steel, { x: -0.18, z: 0.18, y: 0.21 }),
    part(cyl(0.03, 0.03, 0.42, 5), C.steel, { x: 0.18, z: -0.18, y: 0.21 }),
    part(cyl(0.03, 0.03, 0.42, 5), C.steel, { x: -0.18, z: -0.18, y: 0.21 }),
    part(sph(0.28, 14), C.white, { y: 0.68 }),
    part(torus(0.28, 0.02, 18), C.glass, { y: 0.68, rx: Math.PI / 2, mask: 1 }),
    part(box(0.16, 0.10, 0.16), C.dark, { y: 0.05 }),
  ]),

  /** Station de fonte polaire : réflecteur parabolique orienté vers le sol. */
  polar_melter: () => mergeParts([
    part(box(0.34, 0.12, 0.34), C.steel, { y: 0.06 }),
    part(cyl(0.04, 0.04, 0.34, 6), C.dark, { y: 0.29 }),
    part(cone(0.36, 0.22, 16), C.white, { y: 0.52, rx: 0.55 }),
    part(cyl(0.05, 0.05, 0.05, 8), C.lamp, { y: 0.44, rx: 0.55, mask: 1 }),
  ]),

  /** Miroir orbital : grand disque fin en orbite, en rotation. */
  orbital_mirror: () => mergeParts([
    part(cyl(0.62, 0.62, 0.012, 22), C.white, { mask: 0 }),
    part(torus(0.62, 0.022, 22), C.steel, { rx: Math.PI / 2 }),
    part(cyl(0.09, 0.09, 0.10, 8), C.dark, {}),
    part(box(0.10, 0.02, 0.02), C.lamp, { x: 0.55, mask: 1 }),
  ]),

  /** Stabilisateur climatique : grand anneau vertical sur socle. */
  climate_stabilizer: () => mergeParts([
    part(box(0.44, 0.12, 0.30), C.dark, { y: 0.06 }),
    part(torus(0.40, 0.045, 22), C.metal, { y: 0.52 }),
    part(torus(0.26, 0.03, 18), C.glass, { y: 0.52, mask: 1 }),
    part(cyl(0.04, 0.06, 0.20, 6), C.steel, { x: -0.20, y: 0.16 }),
    part(cyl(0.04, 0.06, 0.20, 6), C.steel, { x: 0.20, y: 0.16 }),
  ]),

  /** Bio-dôme : demi-sphère translucide verte + sas. */
  biodome: () => mergeParts([
    part(torus(0.40, 0.035, 20), C.steel, { y: 0.03, rx: Math.PI / 2 }),
    part(dome(0.40, 16), C.green, { y: 0.03, mask: 0 }),
    part(box(0.16, 0.14, 0.20), C.dark, { z: 0.40, y: 0.07 }),
    part(box(0.09, 0.08, 0.02), C.lamp, { z: 0.51, y: 0.07, mask: 1 }),
  ]),

  /** Tour d'ensemencement : mât à bras diffuseurs. */
  seeder: () => mergeParts([
    part(cyl(0.16, 0.20, 0.10, 10), C.dark, { y: 0.05 }),
    part(cyl(0.035, 0.055, 1.10, 8), C.metal, { y: 0.65 }),
    part(box(0.52, 0.02, 0.05), C.steel, { y: 0.82 }),
    part(box(0.05, 0.02, 0.52), C.steel, { y: 0.94 }),
    part(sph(0.07, 10), C.green, { y: 1.22, mask: 1 }),
    part(cone(0.05, 0.09, 8), C.green, { x: 0.24, y: 0.76, rx: Math.PI }),
    part(cone(0.05, 0.09, 8), C.green, { x: -0.24, y: 0.76, rx: Math.PI }),
  ]),

  /** Colonie : grappe de dômes reliés par des tubes. */
  colony: () => mergeParts([
    part(dome(0.30, 14), C.white, { x: -0.16, z: -0.08 }),
    part(dome(0.22, 12), C.white, { x: 0.24, z: 0.14 }),
    part(dome(0.16, 12), C.white, { x: 0.02, z: 0.32 }),
    part(cyl(0.055, 0.055, 0.40, 8), C.steel, { x: 0.05, y: 0.07, z: 0.03, rz: Math.PI / 2, ry: 0.5 }),
    part(cyl(0.045, 0.045, 0.30, 8), C.steel, { x: 0.14, y: 0.06, z: 0.24, rz: Math.PI / 2, ry: -0.9 }),
    part(torus(0.30, 0.02, 18), C.glass, { x: -0.16, z: -0.08, y: 0.16, rx: Math.PI / 2, mask: 1 }),
    part(torus(0.22, 0.018, 14), C.glass, { x: 0.24, z: 0.14, y: 0.12, rx: Math.PI / 2, mask: 1 }),
    part(cyl(0.015, 0.015, 0.34, 5), C.dark, { x: -0.34, y: 0.17 }),
    part(box(0.04, 0.04, 0.04), C.lamp, { x: -0.34, y: 0.36, mask: 1 }),
  ]),
};

/**
 * Réglages d'instanciation par type.
 *  scale    : facteur appliqué au rayon de la cellule
 *  altitude : décalage le long de la normale, en rayons de cellule
 *  spin     : rotation propre autour de la normale (rad/s)
 */
const TUNING = {
  orbital_mirror: { scale: 1.00, altitude: 2.4, spin: 0.55, transparent: false },
  biodome: { scale: 0.95, altitude: 0, spin: 0, transparent: true, opacity: 0.62 },
  colony: { scale: 1.00, altitude: 0, spin: 0 },
  atmo_processor: { scale: 0.85, altitude: 0, spin: 0 },
  climate_stabilizer: { scale: 0.95, altitude: 0, spin: 0.25 },
  seeder: { scale: 0.85, altitude: 0, spin: 0 },
};
const DEFAULT_TUNING = { scale: 0.90, altitude: 0, spin: 0, transparent: false, opacity: 1 };

/* -------------------------------------------------------------------------- */
/*  Matériau                                                                  */
/* -------------------------------------------------------------------------- */

const structVertex = /* glsl */ `
attribute vec3 aColor;
attribute float aMask;

varying vec3 vPartColor;
varying float vMask;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vTint;

void main() {
  #ifdef USE_INSTANCING
    mat4 im = instanceMatrix;
  #else
    mat4 im = mat4(1.0);
  #endif

  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #else
    vTint = vec3(1.0);
  #endif

  vec4 wp = modelMatrix * im * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * (mat3(im) * normal));
  vPartColor = aColor;
  vMask = aMask;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const structFragment = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uNightAmbient;
uniform float uInsolation;
uniform float uOpacity;
uniform float uTime;

varying vec3 vPartColor;
varying float vMask;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vTint;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunDirection);
  vec3 V = normalize(cameraPosition - vWorld);

  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.30) / 1.30, 0.0, 1.0);
  wrap *= wrap * (3.0 - 2.0 * wrap);

  vec3 base = vPartColor * vTint;
  vec3 color = base * uSunColor * wrap * uInsolation + base * uNightAmbient * 1.6;

  // Reflet métallique discret : sans lui les volumes se lisent mal.
  vec3 H = normalize(V + L);
  color += uSunColor * pow(max(dot(N, H), 0.0), 34.0) * 0.20 * smoothstep(-0.05, 0.15, ndl);

  // Voyants et vitrages : allumés surtout côté nuit.
  float night = 1.0 - smoothstep(-0.10, 0.12, ndl);
  float blink = 0.85 + 0.15 * sin(uTime * 2.6 + vWorld.x * 40.0);
  color += base * vMask * (0.30 + 1.55 * night) * blink * vTint;

  gl_FragColor = vec4(color, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */

export class StructureLayer {
  constructor(shared) {
    this.object3D = new THREE.Group();
    this.object3D.name = 'structures';
    this.shared = shared;
    this.time = 0;

    /** type -> { mesh, geometry, material, capacity, entries[], hasAnim } */
    this.groups = new Map();
    this._signature = 0;
    this._planet = null;

    // Scratch : aucune allocation dans sync/update.
    this._pos = new THREE.Vector3();
    this._nrm = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._scale = new THREE.Vector3();
    this._mat = new THREE.Matrix4();
    this._spinQuat = new THREE.Quaternion();
    this._color = new THREE.Color();
  }

  /** PlanetMesh sert à connaître le relief et la taille des cellules. */
  setPlanet(planetMesh) { this._planet = planetMesh; }

  /* ==================================================================== */

  _tuning(type) {
    const t = TUNING[type];
    return t ? { ...DEFAULT_TUNING, ...t } : DEFAULT_TUNING;
  }

  _ensureGroup(type, needed) {
    let g = this.groups.get(type);
    const capacity = Math.max(16, 1 << Math.ceil(Math.log2(Math.max(1, needed * 1.4))));

    if (g && g.capacity >= needed) return g;

    if (g) {
      this.object3D.remove(g.mesh);
      g.mesh.dispose();
      g.capacity = capacity;
      g.mesh = this._makeMesh(g.geometry, g.material, capacity);
      this.object3D.add(g.mesh);
      return g;
    }

    const builder = MODELS[type];
    if (!builder) return null;
    const geometry = builder();
    const tune = this._tuning(type);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: this.shared.uSunDirection,
        uSunColor: this.shared.uSunColor,
        uNightAmbient: this.shared.uNightAmbient,
        uInsolation: this.shared.uInsolation,
        uTime: this.shared.uTime,
        uOpacity: { value: tune.opacity ?? 1 },
      },
      vertexShader: structVertex,
      fragmentShader: structFragment,
      transparent: !!tune.transparent,
      depthWrite: !tune.transparent,
      side: tune.transparent ? THREE.DoubleSide : THREE.FrontSide,
    });

    g = { type, geometry, material, capacity, entries: [], tune, mesh: null };
    g.mesh = this._makeMesh(geometry, material, capacity);
    this.object3D.add(g.mesh);
    this.groups.set(type, g);
    return g;
  }

  _makeMesh(geometry, material, capacity) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Teinte par instance : sert à griser les bâtiments inactifs.
    const colors = new Float32Array(capacity * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  /* ==================================================================== */
  /*  Synchronisation avec l'état de jeu                                  */
  /* ==================================================================== */

  /**
   * Ne reconstruit les matrices que si la liste des bâtiments a changé.
   * @param {object} state
   * @param {object} regions
   */
  sync(state, regions) {
    const list = (state && state.buildings) || [];

    // Signature : dépend du type, de la région, de l'id et de l'état actif.
    let sig = list.length * 2654435761;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      sig = (sig ^ StructureLayer._hash(b.type)) * 16777619 >>> 0;
      sig = (sig + (b.region | 0) * 2246822519 + (b.active === false ? 7 : 3)) >>> 0;
      sig = (sig ^ StructureLayer._hash(String(b.id))) >>> 0;
    }
    if (sig === this._signature) return;
    this._signature = sig;

    // Regroupement par type. On réutilise les tableaux existants.
    for (const g of this.groups.values()) g._next = [];

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const g = this._ensureGroup(b.type, 1);
      if (!g) continue;
      if (!g._next) g._next = [];
      g._next.push(b);
    }

    for (const g of this.groups.values()) {
      const next = g._next || [];
      this._rebuildGroup(g, next, regions);
      g._next = null;
    }
  }

  _rebuildGroup(g, list, regions) {
    if (list.length > g.capacity) this._ensureGroup(g.type, list.length);

    // Index des instances déjà présentes : elles ne rejouent pas l'animation.
    const previous = new Map();
    for (const e of g.entries) previous.set(e.key, e);

    const entries = [];
    const planet = this._planet;

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const key = String(b.id);
      const old = previous.get(key);
      const region = b.region | 0;

      const e = old || { key, region, born: this.time, anim: 0 };
      e.region = region;
      e.active = b.active !== false;
      if (!old) { e.born = this.time; e.anim = 0; }

      // Position / orientation figées : elles ne changent jamais ensuite.
      if (!old || e.px === undefined) {
        const p = regions.positions;
        const cr = planet ? planet.cellRadius[region] : BALANCE.planet.radius;
        const size = planet ? planet.cellSize[region] : 0.08;
        const tune = g.tune;
        const nx = p[region * 3], ny = p[region * 3 + 1], nz = p[region * 3 + 2];
        const alt = cr + tune.altitude * size;
        e.px = nx * alt; e.py = ny * alt; e.pz = nz * alt;
        this._nrm.set(nx, ny, nz).normalize();
        this._quat.setFromUnitVectors(this._up, this._nrm);
        e.qx = this._quat.x; e.qy = this._quat.y; e.qz = this._quat.z; e.qw = this._quat.w;
        e.size = size * tune.scale;
        e.spin = tune.spin;
        e.phase = (StructureLayer._hash(key) % 1000) / 1000 * Math.PI * 2;
      }

      entries.push(e);
    }

    g.entries = entries;
    g.mesh.count = entries.length;
    for (let i = 0; i < entries.length; i++) this._writeInstance(g, i, entries[i]);
    g.mesh.instanceMatrix.needsUpdate = true;
    if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    g.hasAnim = entries.some((e) => e.anim < 1 || e.spin > 0);
  }

  _writeInstance(g, index, e) {
    // Apparition : 0 → 1 avec un léger dépassement (ease out back).
    // s(0) = 0 exactement, s(1) = 1, petit rebond vers t ≈ 0,7.
    const t = clamp01(e.anim);
    const u = t - 1;
    const s = t < 1 ? 1 + 2.70158 * u * u * u + 1.70158 * u * u : 1;

    this._pos.set(e.px, e.py, e.pz);
    this._quat.set(e.qx, e.qy, e.qz, e.qw);
    if (e.spin > 0) {
      this._spinQuat.setFromAxisAngle(this._up, this.time * e.spin + e.phase);
      this._quat.multiply(this._spinQuat);
    }
    this._scale.setScalar(Math.max(0.001, e.size * s));
    this._mat.compose(this._pos, this._quat, this._scale);
    g.mesh.setMatrixAt(index, this._mat);

    if (g.mesh.instanceColor) {
      const k = e.active ? 1 : 0.5;
      const arr = g.mesh.instanceColor.array;
      arr[index * 3] = k; arr[index * 3 + 1] = k; arr[index * 3 + 2] = e.active ? 1 : 0.55;
    }
  }

  /* ==================================================================== */

  update(dt) {
    this.time += dt;
    for (const g of this.groups.values()) {
      if (!g.hasAnim) continue;
      let still = false;
      let touched = false;
      for (let i = 0; i < g.entries.length; i++) {
        const e = g.entries[i];
        const growing = e.anim < 1;
        if (growing) {
          e.anim = Math.min(1, e.anim + dt / GROW_TIME);
          still = still || e.anim < 1;
        }
        if (growing || e.spin > 0) { this._writeInstance(g, i, e); touched = true; }
        if (e.spin > 0) still = true;
      }
      if (touched) {
        g.mesh.instanceMatrix.needsUpdate = true;
        if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
      }
      g.hasAnim = still;
    }
  }

  /** Position monde d'un bâtiment (utile pour un futur ciblage). */
  dispose() {
    for (const g of this.groups.values()) {
      this.object3D.remove(g.mesh);
      g.mesh.dispose();
      g.geometry.dispose();
      g.material.dispose();
    }
    this.groups.clear();
    this.object3D.clear();
    this._signature = 0;
  }

  /** Vide toutes les instances (nouvelle partie) sans détruire les géométries. */
  clear() {
    for (const g of this.groups.values()) {
      g.entries.length = 0;
      g.mesh.count = 0;
      g.hasAnim = false;
    }
    this._signature = 0;
  }

  static _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
}

export default StructureLayer;

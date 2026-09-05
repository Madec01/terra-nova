/**
 * ============================================================================
 *  TERRA NOVA — Bâtiments (InstancedMesh, un par type)
 * ============================================================================
 *  Un THREE.InstancedMesh par type de bâtiment : au plus 17 draw calls, quel
 *  que soit le nombre de constructions. Les géométries sont fabriquées
 *  procéduralement à partir de primitives Three fusionnées à la main (pas de
 *  dépendance à `three/examples`).
 *
 *  ÉCHELLE — la règle qui gouverne tout le fichier
 *  -----------------------------------------------
 *  Les modèles sont dessinés dans des unités arbitraires, puis NORMALISÉS par
 *  `fitModel()` : après passage, l'emprise au sol vaut exactement 1, la hauteur
 *  au plus MAX_ASPECT, et la base repose sur y = 0. L'instanciation multiplie
 *  ensuite par `FOOTPRINT × diamètre réel de la cellule`, mesuré sur le maillage
 *  (`PlanetMesh.cellSize`) et non deviné : un bâtiment occupe donc toujours la
 *  même fraction de sa cellule, quel que soit le nombre de régions.
 *
 *  Avec 642 régions sur un rayon de 1, une cellule mesure ≈ 0,174 unité de
 *  diamètre : à FOOTPRINT = 0,33 un bâtiment tient dans 0,057 unité, soit un
 *  peu plus que l'amplitude du relief (BALANCE.planet.reliefScale = 0,045).
 *
 *  ANCRAGE — la base est posée sur le rayon déplacé de la cellule
 *  (`PlanetMesh.cellRadius`), enfoncée d'un cheveu pour éviter tout jour, et le
 *  shader de sommet reproduit le même gonflement de limbe que la surface, sinon
 *  les bâtiments s'enfonceraient sur le bord du disque. Seul `orbital_mirror`
 *  est en orbite (voir TUNING.orbit).
 *
 *  ATTÉNUATION — deux effacements, tous deux calculés dans le shader de sommet
 *  (`cameraPosition` y est disponible), donc sans un octet de travail CPU ni
 *  la moindre reconstruction de matrice :
 *    · en DISTANCE DE LA CAMÉRA AU BÂTIMENT, entre FADE_NEAR et FADE_FAR —
 *      calé pour que le cadrage par défaut de SceneManager ne laisse plus un
 *      seul bâtiment, sans effacer ceux que `focusRegion()` vient de viser ;
 *    · au LIMBE, sur la couronne extérieure du disque (LIMB_FADE_*), où les
 *      bâtiments vus par la tranche dépassaient de la silhouette et formaient
 *      un liseré noir contre l'atmosphère.
 *  Dans les deux cas on rétrécit vers le point d'ancrage : le bâtiment rentre
 *  dans le sol, il ne clignote pas.
 *
 *  Les matrices ne sont reconstruites QUE lorsque la liste des bâtiments change
 *  (comparaison de signature) ou pour les quelques instances en cours
 *  d'animation d'apparition / de rotation.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { clamp01 } from '../utils/math.js';

/** Durée de l'animation d'apparition d'un bâtiment (secondes). */
const GROW_TIME = 0.6;

/** Fraction du DIAMÈTRE d'une cellule occupée par l'emprise d'un bâtiment. */
const FOOTPRINT = 0.33;

/** Hauteur maximale d'un modèle, en unités d'emprise (après normalisation). */
const MAX_ASPECT = 0.95;

/** Enfoncement de la base dans le sol, en unités d'emprise. */
const SINK = 0.05;

/**
 * Distances entre lesquelles les bâtiments s'effacent — mesurées de la caméra
 * AU BÂTIMENT, jamais au centre de la planète.
 *
 * La nuance décide de tout. `OrbitControls` place la caméra à `distance` de sa
 * CIBLE, et `SceneManager.focusRegion()` met cette cible sur la cellule : la
 * caméra se retrouve alors à ~2,8 du centre mais à 1,8 du bâtiment qu'on vient
 * justement de demander à voir. Un seuil pris sur le centre les effaçait au
 * moment précis où le joueur les regarde.
 *
 * Les deux contraintes à satisfaire, en distance AU BÂTIMENT :
 *   · cadrage par défaut (`_fitDistance()` ≥ 3,06 du centre) → la cellule la
 *     plus proche est à 2,06 : il ne doit plus rien rester ;
 *   · `focusRegion()` (1,82 de la cellule visée) → le bâtiment doit se voir.
 * D'où cette fenêtre serrée. Bénéfice secondaire : au limbe les cellules sont
 * mécaniquement plus loin de la caméra que celles du centre, donc elles
 * s'effacent les premières — l'atténuation travaille dans le bon sens.
 */
const FADE_NEAR = 1.75;
const FADE_FAR = 2.05;

/**
 * Effacement de LIMBE. `facing` = cos de l'angle entre la verticale locale de
 * la cellule et la direction de la caméra : 1 au point sous la caméra, 0 à
 * l'horizon géométrique. Les bâtiments proches du bord du disque étaient vus
 * par la tranche, dépassaient de la silhouette et formaient un liseré noir
 * contre le limbe atmosphérique. On les efface donc sur la couronne extérieure
 * — soit à peine les 8 derniers pour cent du rayon apparent, quelle que soit
 * la distance de la caméra (le critère est angulaire, donc invariant).
 */
const LIMB_FADE_IN = 0.12;
const LIMB_FADE_OUT = 0.40;

/** Gonflement radial du limbe : doit reproduire uLimbBulge de la surface. */
const LIMB_BULGE = 0.008;

/* -------------------------------------------------------------------------- */
/*  Palette                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Valeurs LINÉAIRES : le rendu passe par ACES (exposition 0,85) puis par
 * l'encodage sRGB, qui éclaircit fortement. Un 0,17 linéaire ressort en gris
 * ~0,40 à l'écran ; l'ancien 0,86 ressortait en blanc 0,83, d'où l'effet
 * « satellites en plastique ». Tout tient désormais entre 0,04 et 0,32, sauf
 * les voyants (émissifs).
 */
const C = {
  hull:    [0.088, 0.095, 0.110],   // gris ardoise, coque principale
  hullLt:  [0.132, 0.140, 0.155],   // même métal, panneau clair
  steel:   [0.062, 0.072, 0.090],   // gris-bleu, structure et tuyauterie
  dark:    [0.025, 0.029, 0.036],   // ombre franche, joints, socles
  deck:    [0.100, 0.098, 0.089],   // béton / plateforme
  rust:    [0.100, 0.056, 0.034],   // tôle corrodée
  copper:  [0.145, 0.076, 0.033],   // cuivre, conteneurs
  heat:    [0.175, 0.064, 0.018],   // accent thermique (géothermie, fusion)
  panel:   [0.018, 0.025, 0.052],   // photovoltaïque, presque noir bleuté
  glass:   [0.055, 0.096, 0.124],   // vitrage sombre (allumé par aMask)
  lamp:    [1.000, 0.620, 0.240],   // voyant / fenêtre, toujours aMask = 1
  ice:     [0.135, 0.178, 0.212],   // glace tassée
  bio:     [0.050, 0.120, 0.064],   // verdure sous dôme
  canvas:  [0.150, 0.156, 0.163],   // membrane d'habitat : clair mais désaturé
  // Voile réfléchissante du miroir orbital : le SEUL matériau clair du jeu,
  // et il est en orbite, jamais posé sur le paysage.
  foil:    [0.205, 0.216, 0.238],
};

/* -------------------------------------------------------------------------- */
/*  Fusion de primitives (remplace BufferGeometryUtils, hors périmètre)       */
/* -------------------------------------------------------------------------- */

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
  return geo;
}

/**
 * Normalise un modèle : centré sur x/z, base à y = 0, emprise au sol ramenée à
 * 1 et hauteur plafonnée à MAX_ASPECT. C'est CETTE fonction qui garantit qu'un
 * bâtiment tient dans sa cellule, quelles que soient les cotes du modèle.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {boolean} centered true → l'objet est centré en y (structure orbitale)
 */
function fitModel(geo, centered = false) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  const cy = centered ? (bb.min.y + bb.max.y) * 0.5 : bb.min.y;

  const w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 1e-4);
  const h = Math.max(bb.max.y - bb.min.y, 1e-4);
  const k = Math.min(1 / w, MAX_ASPECT / h);

  const pos = geo.getAttribute('position').array;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - cx) * k;
    pos[i + 1] = (pos[i + 1] - cy) * k;
    pos[i + 2] = (pos[i + 2] - cz) * k;
  }
  geo.computeBoundingBox();
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
const torus = (r, t, seg = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, 6, seg, arc);

/**
 * Socle : plateforme octogonale basse, débordant légèrement sous le sol.
 * C'est elle qui donne le CONTACT avec le terrain — sans elle, un mât planté
 * dans un polygone plat a toujours l'air de flotter.
 */
const foundation = (r, h = 0.09) => [
  part(cyl(r, r * 1.07, h, 8), C.dark, { y: h * 0.5 }),
  part(cyl(r * 0.90, r * 0.90, h * 0.45, 8), C.deck, { y: h * 1.02 }),
];

/* -------------------------------------------------------------------------- */
/*  Les 17 modèles                                                            */
/* -------------------------------------------------------------------------- */
/*  Chaque silhouette doit être reconnaissable en une fraction de seconde :    */
/*  derrick pointu, cuves rondes, boîtes empilées, panneaux plats, cheminées…  */
/*  Les cotes ci-dessous sont RELATIVES ; fitModel() fait le reste.            */

const MODELS = {
  /** Mine : derrick à quatre pieds + terril. Silhouette : pyramide effilée. */
  mine: () => mergeParts([
    ...foundation(0.44),
    part(cone(0.30, 0.22, 7), C.rust, { x: 0.40, y: 0.14, z: 0.26 }),
    // Quatre jambes convergentes.
    part(box(0.035, 0.86, 0.035), C.steel, { x: 0.15, z: 0.15, y: 0.47, rx: -0.16, rz: -0.16 }),
    part(box(0.035, 0.86, 0.035), C.steel, { x: -0.15, z: 0.15, y: 0.47, rx: -0.16, rz: 0.16 }),
    part(box(0.035, 0.86, 0.035), C.steel, { x: 0.15, z: -0.15, y: 0.47, rx: 0.16, rz: -0.16 }),
    part(box(0.035, 0.86, 0.035), C.steel, { x: -0.15, z: -0.15, y: 0.47, rx: 0.16, rz: 0.16 }),
    part(box(0.32, 0.025, 0.32), C.hull, { y: 0.42 }),
    part(box(0.20, 0.025, 0.20), C.hull, { y: 0.72 }),
    part(cyl(0.075, 0.075, 0.14, 6), C.hullLt, { y: 0.95 }),
    part(box(0.045, 0.045, 0.045), C.lamp, { y: 1.05, mask: 1 }),
    part(box(0.26, 0.15, 0.20), C.hull, { x: -0.28, y: 0.16 }),
    part(box(0.21, 0.030, 0.02), C.lamp, { x: -0.28, z: 0.105, y: 0.19, mask: 1 }),
  ]),

  /** Raffinerie : deux cuves coiffées + torchère. Silhouette : cylindres. */
  refinery: () => mergeParts([
    ...foundation(0.48),
    part(cyl(0.19, 0.19, 0.60, 12), C.hull, { x: -0.20, y: 0.42 }),
    part(dome(0.19, 12), C.hullLt, { x: -0.20, y: 0.72 }),
    part(cyl(0.145, 0.145, 0.44, 12), C.hull, { x: 0.20, z: 0.15, y: 0.34 }),
    part(dome(0.145, 10), C.hullLt, { x: 0.20, z: 0.15, y: 0.56 }),
    part(torus(0.19, 0.014, 14), C.steel, { x: -0.20, y: 0.56, rx: Math.PI / 2 }),
    // Torchère : le repère vertical qui distingue la raffinerie de tout le reste.
    part(cyl(0.032, 0.042, 0.86, 6), C.steel, { x: 0.24, z: -0.22, y: 0.55 }),
    part(cyl(0.055, 0.032, 0.09, 8), C.heat, { x: 0.24, z: -0.22, y: 1.02, mask: 1 }),
    part(box(0.56, 0.035, 0.06), C.steel, { y: 0.66 }),
    part(box(0.05, 0.045, 0.02), C.lamp, { x: -0.20, z: 0.19, y: 0.30, mask: 1 }),
    part(torus(0.192, 0.017, 16), C.lamp, { x: -0.20, y: 0.30, rx: Math.PI / 2, mask: 1 }),
  ]),

  /** Dépôt : conteneurs empilés. Silhouette : boîtes basses et larges. */
  depot: () => mergeParts([
    ...foundation(0.50, 0.07),
    part(box(0.36, 0.20, 0.24), C.copper, { x: -0.17, z: -0.04, y: 0.20 }),
    part(box(0.36, 0.20, 0.24), C.steel, { x: 0.17, z: 0.05, y: 0.20, ry: 0.16 }),
    part(box(0.30, 0.18, 0.22), C.rust, { x: -0.02, z: 0.02, y: 0.40, ry: -0.22 }),
    part(box(0.06, 0.05, 0.14), C.hullLt, { x: 0.34, z: 0.05, y: 0.20 }),
    part(box(0.24, 0.02, 0.02), C.lamp, { x: -0.02, z: 0.10, y: 0.50, mask: 1 }),
  ]),

  /** Champ solaire : trois tables inclinées. Silhouette : plat et incliné. */
  solar: () => mergeParts([
    part(cyl(0.16, 0.17, 0.10, 8), C.dark, { x: -0.34, y: 0.03 }),
    part(box(0.66, 0.018, 0.26), C.panel, { z: -0.28, y: 0.24, rx: -0.52 }),
    part(box(0.66, 0.018, 0.26), C.panel, { z: 0.02, y: 0.24, rx: -0.52 }),
    part(box(0.66, 0.018, 0.26), C.panel, { z: 0.32, y: 0.24, rx: -0.52 }),
    // Cadre clair : sans lui, les panneaux noirs disparaissent sur fond sombre.
    part(box(0.68, 0.012, 0.02), C.hullLt, { z: -0.39, y: 0.135, rx: -0.52 }),
    part(box(0.68, 0.012, 0.02), C.hullLt, { z: -0.09, y: 0.135, rx: -0.52 }),
    part(box(0.68, 0.012, 0.02), C.hullLt, { z: 0.21, y: 0.135, rx: -0.52 }),
    part(cyl(0.018, 0.018, 0.24, 5), C.steel, { z: -0.28, y: 0.12 }),
    part(cyl(0.018, 0.018, 0.24, 5), C.steel, { z: 0.02, y: 0.12 }),
    part(cyl(0.018, 0.018, 0.24, 5), C.steel, { z: 0.32, y: 0.12 }),
    part(box(0.14, 0.13, 0.14), C.hull, { x: -0.34, y: 0.14 }),
    part(box(0.115, 0.026, 0.02), C.lamp, { x: -0.34, z: 0.075, y: 0.16, mask: 1 }),
  ]),

  /** Géothermie : cheminée trapue + anneau de captage rougeoyant. */
  geothermal: () => mergeParts([
    part(torus(0.42, 0.045, 18), C.steel, { y: 0.05, rx: Math.PI / 2 }),
    part(cyl(0.30, 0.34, 0.10, 12), C.dark, { y: 0.05 }),
    part(torus(0.235, 0.028, 16), C.heat, { y: 0.10, rx: Math.PI / 2, mask: 1 }),
    part(cyl(0.15, 0.24, 0.62, 12), C.hull, { y: 0.46 }),
    part(torus(0.165, 0.026, 14), C.steel, { y: 0.62, rx: Math.PI / 2 }),
    part(cyl(0.115, 0.115, 0.030, 12), C.heat, { y: 0.782, mask: 1 }),
    part(box(0.20, 0.14, 0.18), C.hull, { x: 0.34, y: 0.09 }),
    part(box(0.04, 0.03, 0.02), C.lamp, { x: 0.34, z: 0.10, y: 0.13, mask: 1 }),
  ]),

  /** Fusion : tore de confinement couché sur un tambour. Cœur bleu. */
  fusion: () => mergeParts([
    part(cyl(0.40, 0.44, 0.16, 14), C.dark, { y: 0.08 }),
    part(cyl(0.34, 0.34, 0.06, 14), C.hullLt, { y: 0.18 }),
    part(torus(0.28, 0.095, 20), C.hull, { y: 0.40, rx: Math.PI / 2 }),
    part(torus(0.28, 0.030, 20), C.glass, { y: 0.40, rx: Math.PI / 2, mask: 1 }),
    part(sph(0.115, 12), C.glass, { y: 0.40, mask: 1 }),
    part(cyl(0.045, 0.045, 0.34, 6), C.steel, { x: 0.30, y: 0.23 }),
    part(cyl(0.045, 0.045, 0.34, 6), C.steel, { x: -0.30, y: 0.23 }),
    part(cyl(0.045, 0.045, 0.34, 6), C.steel, { z: 0.30, y: 0.23 }),
    part(cyl(0.045, 0.045, 0.34, 6), C.steel, { z: -0.30, y: 0.23 }),
  ]),

  /** Station scientifique : coupole basse + mât et parabole. */
  science_station: () => mergeParts([
    ...foundation(0.40),
    part(dome(0.29, 14), C.canvas, { y: 0.11 }),
    part(torus(0.29, 0.016, 18), C.steel, { y: 0.11, rx: Math.PI / 2 }),
    part(box(0.30, 0.05, 0.03), C.glass, { y: 0.24, z: 0.22, mask: 1 }),
    part(cyl(0.014, 0.014, 0.62, 5), C.steel, { x: 0.25, y: 0.40 }),
    part(cone(0.135, 0.11, 12), C.hullLt, { x: 0.25, y: 0.70, rx: Math.PI * 0.78 }),
    part(cyl(0.02, 0.02, 0.07, 5), C.dark, { x: 0.25, z: 0.07, y: 0.66, rx: Math.PI * 0.78 }),
    part(box(0.035, 0.035, 0.035), C.lamp, { x: 0.25, y: 0.74, mask: 1 }),
  ]),

  /** Extracteur de glace : flèche de forage inclinée + benne givrée. */
  ice_extractor: () => mergeParts([
    ...foundation(0.44, 0.07),
    part(box(0.46, 0.14, 0.32), C.hull, { y: 0.16 }),
    part(cyl(0.055, 0.055, 0.70, 8), C.steel, { x: 0.10, y: 0.52, rz: 0.42 }),
    part(box(0.03, 0.66, 0.10), C.hullLt, { x: 0.10, y: 0.52, rz: 0.42 }),
    part(cone(0.075, 0.22, 8), C.hullLt, { x: 0.36, y: 0.86, rz: 0.42 }),
    part(cyl(0.17, 0.19, 0.16, 10), C.hull, { x: -0.26, y: 0.24 }),
    part(cyl(0.155, 0.155, 0.05, 10), C.ice, { x: -0.26, y: 0.34 }),
    part(box(0.30, 0.028, 0.02), C.lamp, { x: 0.02, z: 0.165, y: 0.20, mask: 1 }),
  ]),

  /** Usine à gaz : bloc massif et trois cheminées décroissantes. */
  ghg_factory: () => mergeParts([
    part(box(0.62, 0.24, 0.42), C.hull, { y: 0.12 }),
    part(box(0.64, 0.03, 0.44), C.dark, { y: 0.25 }),
    part(cyl(0.052, 0.075, 0.78, 9), C.rust, { x: -0.18, y: 0.62 }),
    part(cyl(0.046, 0.066, 0.60, 9), C.rust, { x: 0.02, z: 0.12, y: 0.53 }),
    part(cyl(0.042, 0.060, 0.44, 9), C.rust, { x: 0.20, z: -0.10, y: 0.45 }),
    part(cyl(0.060, 0.060, 0.05, 9), C.heat, { x: -0.18, y: 1.02, mask: 1 }),
    part(cyl(0.052, 0.052, 0.04, 9), C.heat, { x: 0.02, z: 0.12, y: 0.85, mask: 1 }),
    part(box(0.30, 0.04, 0.04), C.steel, { y: 0.30, z: 0.21 }),
    part(box(0.22, 0.03, 0.02), C.lamp, { z: 0.22, y: 0.16, mask: 1 }),
  ]),

  /** Processeur atmosphérique : la TOUR — l'objet le plus élancé du jeu. */
  atmo_processor: () => mergeParts([
    part(cyl(0.24, 0.30, 0.12, 12), C.dark, { y: 0.06 }),
    part(cyl(0.085, 0.145, 1.10, 12), C.hull, { y: 0.66 }),
    part(torus(0.135, 0.022, 14), C.steel, { y: 0.46, rx: Math.PI / 2 }),
    part(torus(0.120, 0.022, 14), C.steel, { y: 0.80, rx: Math.PI / 2 }),
    part(torus(0.113, 0.015, 14), C.lamp, { y: 0.64, rx: Math.PI / 2, mask: 1 }),
    part(box(0.03, 0.90, 0.03), C.steel, { x: 0.15, y: 0.60 }),
    part(cyl(0.105, 0.088, 0.10, 12), C.glass, { y: 1.24, mask: 1 }),
    part(cone(0.095, 0.18, 12), C.hullLt, { y: 1.37 }),
    part(box(0.03, 0.03, 0.03), C.lamp, { y: 1.47, mask: 1 }),
  ]),

  /** Générateur d'oxygène : sphère cerclée sur pylônes. */
  o2_generator: () => mergeParts([
    part(cyl(0.30, 0.34, 0.09, 10), C.dark, { y: 0.045 }),
    part(box(0.045, 0.44, 0.045), C.steel, { x: 0.17, z: 0.17, y: 0.26, rx: -0.08, rz: -0.08 }),
    part(box(0.045, 0.44, 0.045), C.steel, { x: -0.17, z: 0.17, y: 0.26, rx: -0.08, rz: 0.08 }),
    part(box(0.045, 0.44, 0.045), C.steel, { x: 0.17, z: -0.17, y: 0.26, rx: 0.08, rz: -0.08 }),
    part(box(0.045, 0.44, 0.045), C.steel, { x: -0.17, z: -0.17, y: 0.26, rx: 0.08, rz: 0.08 }),
    part(sph(0.26, 14), C.hull, { y: 0.70 }),
    part(torus(0.262, 0.028, 18), C.hullLt, { y: 0.70, rx: Math.PI / 2 }),
    part(torus(0.262, 0.028, 18), C.steel, { y: 0.70, rz: Math.PI / 2 }),
    part(cyl(0.045, 0.045, 0.16, 6), C.steel, { y: 0.99 }),
    part(torus(0.245, 0.016, 18), C.lamp, { y: 0.70, rx: Math.PI / 2, mask: 1 }),
  ]),

  /** Fonte polaire : grande parabole inclinée vers le sol. */
  polar_melter: () => mergeParts([
    ...foundation(0.36, 0.08),
    part(box(0.28, 0.12, 0.28), C.hull, { y: 0.17 }),
    part(cyl(0.045, 0.055, 0.30, 6), C.steel, { y: 0.38 }),
    part(cone(0.40, 0.24, 18), C.hullLt, { y: 0.62, rx: 0.62 }),
    part(torus(0.40, 0.018, 20), C.steel, { y: 0.735, rx: Math.PI / 2 + 0.62 }),
    part(cyl(0.05, 0.05, 0.05, 8), C.heat, { y: 0.55, z: -0.03, mask: 1 }),
    part(box(0.19, 0.028, 0.02), C.lamp, { z: 0.145, y: 0.20, mask: 1 }),
  ]),

  /**
   * Miroir orbital : structure ORBITALE — anneau segmenté, voile réfléchissante
   * et poutre de rigidité. Rien de « posé », aucun socle, aucun pied.
   */
  orbital_mirror: () => mergeParts([
    part(cyl(0.60, 0.60, 0.010, 24), C.foil, { y: 0.010 }),
    part(cyl(0.58, 0.58, 0.010, 24), C.steel, { y: -0.004 }),
    part(torus(0.60, 0.020, 24), C.hull, { y: 0.006, rx: Math.PI / 2 }),
    part(torus(0.40, 0.010, 20), C.steel, { y: 0.017, rx: Math.PI / 2 }),
    // Poutre de rigidité : lit la structure comme un engin, pas comme un jeton.
    part(box(1.20, 0.022, 0.030), C.hull, { y: -0.03 }),
    part(box(0.030, 0.022, 1.20), C.hull, { y: -0.03 }),
    part(cyl(0.10, 0.10, 0.14, 8), C.dark, { y: -0.06 }),
    part(cyl(0.055, 0.055, 0.05, 8), C.glass, { y: -0.13, mask: 1 }),
    part(box(0.16, 0.020, 0.02), C.lamp, { x: 0.54, y: -0.03, mask: 1 }),
    part(box(0.16, 0.020, 0.02), C.lamp, { x: -0.54, y: -0.03, mask: 1 }),
  ]),

  /** Stabilisateur climatique : grand anneau VERTICAL. */
  climate_stabilizer: () => mergeParts([
    ...foundation(0.42, 0.08),
    part(box(0.46, 0.14, 0.26), C.hull, { y: 0.16 }),
    part(torus(0.38, 0.042, 22), C.hull, { y: 0.58 }),
    part(torus(0.29, 0.020, 20), C.glass, { y: 0.58, mask: 1 }),
    part(cyl(0.05, 0.07, 0.24, 6), C.steel, { x: -0.22, y: 0.28, rz: 0.18 }),
    part(cyl(0.05, 0.07, 0.24, 6), C.steel, { x: 0.22, y: 0.28, rz: -0.18 }),
    part(box(0.03, 0.03, 0.03), C.lamp, { y: 0.96, mask: 1 }),
  ]),

  /** Bio-dôme : coupole nervurée translucide + sas. */
  biodome: () => mergeParts([
    part(torus(0.42, 0.030, 22), C.steel, { y: 0.02, rx: Math.PI / 2 }),
    part(dome(0.42, 18), C.bio, { y: 0.02 }),
    // Nervures : elles donnent au dôme une lecture d'objet construit.
    part(torus(0.42, 0.012, 22, Math.PI), C.hullLt, { y: 0.02 }),
    part(torus(0.42, 0.012, 22, Math.PI), C.hullLt, { y: 0.02, ry: Math.PI / 2 }),
    part(torus(0.30, 0.010, 20), C.hullLt, { y: 0.31, rx: Math.PI / 2 }),
    part(box(0.16, 0.14, 0.18), C.hull, { z: 0.42, y: 0.07 }),
    part(box(0.09, 0.07, 0.02), C.lamp, { z: 0.52, y: 0.07, mask: 1 }),
    part(torus(0.395, 0.013, 22), C.lamp, { y: 0.075, rx: Math.PI / 2, mask: 1 }),
  ]),

  /** Tour d'ensemencement : mât fin à bras diffuseurs croisés. */
  seeder: () => mergeParts([
    ...foundation(0.26, 0.07),
    part(cyl(0.042, 0.068, 1.10, 8), C.hull, { y: 0.62 }),
    part(box(0.56, 0.028, 0.050), C.steel, { y: 0.80 }),
    part(box(0.050, 0.028, 0.56), C.steel, { y: 0.92 }),
    part(cone(0.048, 0.10, 8), C.bio, { x: 0.26, y: 0.74, rx: Math.PI }),
    part(cone(0.048, 0.10, 8), C.bio, { x: -0.26, y: 0.74, rx: Math.PI }),
    part(cone(0.048, 0.10, 8), C.bio, { z: 0.26, y: 0.86, rx: Math.PI }),
    part(cone(0.048, 0.10, 8), C.bio, { z: -0.26, y: 0.86, rx: Math.PI }),
    part(sph(0.062, 10), C.lamp, { y: 1.20, mask: 1 }),
  ]),

  /** Colonie : grappe de coupoles reliées par des tubes + tour de contrôle. */
  colony: () => mergeParts([
    ...foundation(0.50, 0.06),
    part(dome(0.29, 16), C.canvas, { x: -0.15, z: -0.07, y: 0.04 }),
    part(dome(0.21, 14), C.canvas, { x: 0.24, z: 0.13, y: 0.04 }),
    part(dome(0.155, 12), C.canvas, { x: 0.01, z: 0.31, y: 0.04 }),
    part(cyl(0.050, 0.050, 0.40, 8), C.hull, { x: 0.05, y: 0.10, z: 0.03, rz: Math.PI / 2, ry: 0.5 }),
    part(cyl(0.042, 0.042, 0.30, 8), C.hull, { x: 0.14, y: 0.09, z: 0.24, rz: Math.PI / 2, ry: -0.9 }),
    part(torus(0.29, 0.016, 20), C.steel, { x: -0.15, z: -0.07, y: 0.04, rx: Math.PI / 2 }),
    part(torus(0.21, 0.014, 16), C.steel, { x: 0.24, z: 0.13, y: 0.04, rx: Math.PI / 2 }),
    // Bandeau de fenêtres : c'est la signature nocturne de la colonie.
    part(torus(0.270, 0.017, 20), C.lamp, { x: -0.15, z: -0.07, y: 0.15, rx: Math.PI / 2, mask: 1 }),
    part(torus(0.196, 0.015, 16), C.lamp, { x: 0.24, z: 0.13, y: 0.12, rx: Math.PI / 2, mask: 1 }),
    part(cyl(0.030, 0.038, 0.44, 6), C.steel, { x: -0.34, y: 0.26 }),
    part(cyl(0.070, 0.055, 0.09, 8), C.hullLt, { x: -0.34, y: 0.52 }),
    part(box(0.035, 0.035, 0.035), C.lamp, { x: -0.34, y: 0.60, mask: 1 }),
  ]),
};

/**
 * Réglages d'instanciation par type.
 *  scale    : multiplicateur d'emprise (1 = FOOTPRINT × diamètre de cellule)
 *  orbit    : si défini, l'objet est en ORBITE à ce rayon (unités monde) et
 *             n'est plus posé au sol — réservé au miroir orbital
 *  spin     : rotation propre autour de la normale (rad/s)
 *  farKeep  : taille conservée au-delà de FADE_FAR (0 = disparition)
 *  tilt     : inclinaison (rad) cuite dans la géométrie avant normalisation
 */
const TUNING = {
  // Le miroir est une structure orbitale : grand, haut, et il reste
  // partiellement visible de loin (c'est de l'infrastructure spatiale).
  orbital_mirror: {
    scale: 1.95, orbit: BALANCE.planet.radius * 1.135, spin: 0.35, farKeep: 0.22,
    // Inclinaison : à plat, la voile se lisait comme une assiette POSÉE sur le
    // paysage. De biais, elle redevient un engin qui capte la lumière. À 0,62
    // rad elle se présentait trop souvent de profil (un simple trait) ; 0,42
    // garde la lecture de disque tout en cassant le parallélisme au sol.
    tilt: 0.42,
  },
  colony: { scale: 1.12, spin: 0 },
  biodome: { scale: 1.06, spin: 0, transparent: true, opacity: 0.72 },
  climate_stabilizer: { scale: 1.05, spin: 0.22 },
  fusion: { scale: 1.02 },
  atmo_processor: { scale: 0.96 },
  ghg_factory: { scale: 0.98 },
  solar: { scale: 1.02 },
  seeder: { scale: 1.06 },
  depot: { scale: 0.88 },
  mine: { scale: 0.92 },
  science_station: { scale: 0.90 },
};
const DEFAULT_TUNING = {
  scale: 1, orbit: 0, spin: 0, transparent: false, opacity: 1, farKeep: 0, tilt: 0,
};

/**
 * Rayon — distance au centre de la planète — auquel doit flotter le MARQUEUR
 * d'un bâtiment de ce type : juste au-dessus de son sommet, avec un cheveu de
 * dégagement.
 *
 * Exporté pour que `BuildingMarkers` ne devienne pas une SECONDE source de
 * vérité sur l'échelle des modèles : l'emprise, l'enfoncement et l'altitude
 * orbitale sont ceux-là mêmes qui servent à instancier la géométrie, quelques
 * lignes plus bas.
 *
 * @param {string} type
 * @param {number} cellRadius   rayon déplacé de la cellule (PlanetMesh.cellRadius)
 * @param {number} cellDiameter diamètre de la cellule (2 × PlanetMesh.cellSize)
 * @returns {number}
 */
export function markerRadius(type, cellRadius, cellDiameter) {
  const tune = TUNING[type] ? { ...DEFAULT_TUNING, ...TUNING[type] } : DEFAULT_TUNING;
  const size = cellDiameter * FOOTPRINT * tune.scale;
  // Structure orbitale : `fitModel` l'a centrée en y, son sommet est donc à
  // une demi-hauteur au-dessus de son ancrage.
  if (tune.orbit > 0) return tune.orbit + size * MAX_ASPECT * 0.5 + size * 0.5;
  return cellRadius - size * SINK + size * MAX_ASPECT + size * 0.5;
}

/* -------------------------------------------------------------------------- */
/*  Matériau                                                                  */
/* -------------------------------------------------------------------------- */

const structVertex = /* glsl */ `
attribute vec3 aColor;
attribute float aMask;

uniform float uFarKeep;
/** 1 = bâtiment posé au sol, 0 = structure orbitale (jamais effacée au limbe). */
uniform float uGrounded;

varying vec3 vPartColor;
varying float vMask;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vTint;
varying float vGround;

const float FADE_NEAR = ${FADE_NEAR.toFixed(3)};
const float FADE_FAR  = ${FADE_FAR.toFixed(3)};
const float LIMB_BULGE = ${LIMB_BULGE.toFixed(5)};
const float LIMB_FADE_IN  = ${LIMB_FADE_IN.toFixed(3)};
const float LIMB_FADE_OUT = ${LIMB_FADE_OUT.toFixed(3)};
const float PLANET_R = ${BALANCE.planet.radius.toFixed(4)};

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

  // L'ancrage (origine locale de l'instance = base du bâtiment) sert à TOUT :
  // c'est autour de lui qu'on rétrécit, et c'est lui qui donne la verticale
  // locale. On le calcule donc avant quoi que ce soit d'autre.
  vec3 anchor = (modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 radial = normalize(anchor);
  vec3 viewDir = normalize(cameraPosition - anchor);
  float facing = dot(radial, viewDir);

  // --- ATTÉNUATION À DISTANCE ------------------------------------------
  // Distance de la caméra À CE BÂTIMENT-CI (voir FADE_NEAR). On rétrécit le
  // modèle AUTOUR DE SON ANCRAGE (base à y = 0), donc le bâtiment rentre dans
  // le sol au lieu de s'évaporer sur place.
  float camDist = length(cameraPosition - anchor);
  float f = clamp((camDist - FADE_NEAR) / (FADE_FAR - FADE_NEAR), 0.0, 1.0);
  f = f * f * (3.0 - 2.0 * f);
  float shrink = mix(1.0, uFarKeep, f);

  // --- EFFACEMENT DE LIMBE ---------------------------------------------
  // Uniquement pour ce qui est POSÉ (uGrounded = 1) : une structure orbitale
  // a parfaitement le droit de se détacher au bord du disque, c'est même là
  // qu'elle se lit le mieux.
  shrink *= mix(1.0, smoothstep(LIMB_FADE_IN, LIMB_FADE_OUT, facing), uGrounded);

  vec4 wp = modelMatrix * im * vec4(position * shrink, 1.0);

  // --- MÊME GONFLEMENT DE LIMBE QUE LA SURFACE --------------------------
  // Sans cette correction, la surface se soulève au bord du disque (uLimbBulge
  // dans planet.glsl.js) mais pas les bâtiments : ils s'enfoncent exactement là
  // où l'ancrage est le plus visible.
  float rim = 1.0 - abs(facing);
  wp.xyz += radial * (PLANET_R * LIMB_BULGE * pow(rim, 6.0));

  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * (mat3(im) * normal));
  vPartColor = aColor;
  vMask = aMask;
  // Occlusion de contact : sombre au ras du sol, neutre en hauteur.
  vGround = smoothstep(0.0, 0.22, position.y);
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
varying float vGround;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunDirection);
  vec3 V = normalize(cameraPosition - vWorld);

  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.30) / 1.30, 0.0, 1.0);
  wrap *= wrap * (3.0 - 2.0 * wrap);

  vec3 base = vPartColor * vTint;

  // Occlusion de contact : le pied du bâtiment est dans son ombre propre.
  float ao = mix(0.55, 1.0, vGround);

  // uNightAmbient est calibré pour le SOL (albédo ~0,4) ; la coque d'un
  // bâtiment est cinq fois plus sombre et tombait donc à un noir absolu côté
  // nuit. On relève l'ambiante de ce facteur : le volume garde une silhouette
  // lisible au-dessus des lumières de colonie, sans devenir une lampe.
  vec3 color = base * uSunColor * wrap * uInsolation * ao
             + base * uNightAmbient * 4.2;

  // Reflet métallique discret : sans lui les volumes se lisent mal.
  vec3 H = normalize(V + L);
  color += uSunColor * pow(max(dot(N, H), 0.0), 52.0) * 0.07 * smoothstep(0.02, 0.22, ndl);

  // Liseré de silhouette côté éclairé : détache la structure du terrain.
  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 3.5);
  color += uSunColor * fres * 0.030 * smoothstep(0.05, 0.50, ndl);

  // Voyants et vitrages : discrets de jour, francs côté nuit.
  float night = 1.0 - smoothstep(-0.10, 0.12, ndl);
  float blink = 0.88 + 0.12 * sin(uTime * 2.4 + vWorld.x * 40.0 + vWorld.z * 27.0);
  color += base * vMask * (0.20 + 1.90 * night) * blink * vTint;

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
    const tune = this._tuning(type);
    // Inclinaison éventuelle CUITE dans la géométrie : elle doit être prise en
    // compte par la normalisation, sinon l'emprise mesurée serait fausse.
    const raw = builder();
    if (tune.tilt) raw.applyMatrix4(new THREE.Matrix4().makeRotationX(tune.tilt));
    // Normalisation : emprise = 1, base à y = 0 (ou centré si orbital).
    const geometry = fitModel(raw, tune.orbit > 0);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: this.shared.uSunDirection,
        uSunColor: this.shared.uSunColor,
        uNightAmbient: this.shared.uNightAmbient,
        uInsolation: this.shared.uInsolation,
        uTime: this.shared.uTime,
        uOpacity: { value: tune.opacity ?? 1 },
        uFarKeep: { value: tune.farKeep ?? 0 },
        uGrounded: { value: tune.orbit > 0 ? 0 : 1 },
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
        // cellSize = rayon moyen de la cellule ; on raisonne en DIAMÈTRE.
        const cellDia = 2 * (planet ? planet.cellSize[region] : 0.087);
        const tune = g.tune;
        const nx = p[region * 3], ny = p[region * 3 + 1], nz = p[region * 3 + 2];

        // Emprise réelle du bâtiment, en unités monde.
        e.size = cellDia * FOOTPRINT * tune.scale;
        // Orbital → rayon imposé ; sinon la base mord légèrement le terrain.
        const alt = tune.orbit > 0 ? tune.orbit : cr - e.size * SINK;
        e.px = nx * alt; e.py = ny * alt; e.pz = nz * alt;

        this._nrm.set(nx, ny, nz).normalize();
        this._quat.setFromUnitVectors(this._up, this._nrm);
        e.qx = this._quat.x; e.qy = this._quat.y; e.qz = this._quat.z; e.qw = this._quat.w;
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
    this._scale.setScalar(Math.max(0.0001, e.size * s));
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

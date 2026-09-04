/**
 * ============================================================================
 *  TERRA NOVA — Maillage de la planète
 * ============================================================================
 *  UNE SEULE BufferGeometry non indexée pour toute la surface : c'est la clé
 *  des 60 FPS. Chaque cellule du pavage de Goldberg est triangulée en éventail
 *  depuis son centre — (centre, coin k, coin k+1) — ce qui donne 5 ou 6
 *  triangles par cellule et permet d'écrire des données PAR CELLULE dans des
 *  attributs de sommet sans jamais toucher à la géométrie.
 *
 *  Fissures entre cellules : deux cellules voisines partagent un coin. Si
 *  chacune déplaçait ce coin selon SA propre élévation, un trou apparaîtrait.
 *  On précalcule donc, pour chaque coin (partagé par exactement 3 cellules),
 *  la MOYENNE des élévations des cellules qui le touchent, et on déplace le
 *  coin avec cette valeur unique. Le maillage reste étanche.
 *
 *  --- ENCODAGE DES ATTRIBUTS DYNAMIQUES -----------------------------------
 *   aData (vec4, DynamicDrawUsage)
 *     .x  température normalisée = clamp01((T°C + 120) / 200)
 *     .y  humidité (moisture)      0..1
 *     .z  végétation               0..1
 *     .w  pollution                0..1
 *
 *   aInfo (vec4, DynamicDrawUsage)
 *     .x  index de biome           entier 0..11 stocké en float (exact)
 *     .y  pack6(glace, eau liquide)
 *     .z  révélation               0..1, interpolée côté CPU (apparition douce)
 *     .w  pack6(minerais, géothermie)
 *
 *   aAux (vec4, DynamicDrawUsage)
 *     .x  densité de lumières nocturnes (population + bâtiments) 0..1
 *     .y  habitabilité             0..1
 *     .z  potentiel énergétique    0..1
 *     .w  réservé
 *
 *   pack6(a, b) = floor(a*63)*64 + floor(b*63)  → entier 0..4095.
 *   Deux canaux 6 bits (64 niveaux) tiennent exactement dans un float32 ;
 *   c'est largement assez pour une visualisation et cela évite un quatrième
 *   attribut dynamique.
 *
 *   Attributs statiques : position, normal, aCenter (centre déplacé de la
 *   cellule), aCell (id), aEdge (0 au centre → 1 sur le bord du polygone).
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { biomePaletteArray } from '../data/biomes.js';
import { clamp01 } from '../utils/math.js';
import {
  planetVertexShader, planetFragmentShader,
  oceanVertexShader, oceanFragmentShader,
} from './shaders/planet.glsl.js';

/** Quantification d'une position de coin pour regrouper les coins partagés. */
const KEY_SCALE = 1e5;

/** Encode deux valeurs 0..1 sur 6 bits chacune dans un float exact. */
function pack6(a, b) {
  const ai = Math.round(clamp01(a) * 63);
  const bi = Math.round(clamp01(b) * 63);
  return ai * 64 + bi;
}

/** Vitesse de l'animation de révélation (unités de « reveal » par seconde). */
const REVEAL_SPEED = 1 / 0.9;

export class PlanetMesh {
  /**
   * @param {object} regions  RegionManager (contrat docs/CONTRACTS.md §2)
   * @param {object} state    état de jeu (peut être null au premier appel)
   * @param {object|null} shared uniforms partagés (soleil, temps, insolation).
   *        Si absent, la planète crée les siens et fait avancer son propre temps.
   */
  constructor(regions, state, shared = null) {
    this._shared = shared;
    this._ownsTime = !shared;
    this.radius = BALANCE.planet.radius;
    this.reliefScale = BALANCE.planet.reliefScale;
    this.count = regions.count | 0;

    /** Groupe racine : surface + nappe d'eau. */
    this.object3D = new THREE.Group();
    this.object3D.name = 'planet';

    /* --- tables par cellule ------------------------------------------- */
    this.vertexStart = new Int32Array(this.count);
    this.vertexCount = new Int32Array(this.count);
    /** Élévation lissée (moyenne des coins) utilisée pour poser les bâtiments. */
    this.cellRadius = new Float32Array(this.count);
    /** Rayon moyen d'une cellule en unités monde (pour l'échelle des structures). */
    this.cellSize = new Float32Array(this.count);
    /** Valeur de révélation animée (0..1). */
    this.reveal = new Float32Array(this.count);
    /** Cellules dont la révélation est encore en cours d'animation. */
    this._revealing = new Set();

    this.meanIce = 0;
    this.meanWater = 0;

    this._buildGeometry(regions);
    this._buildMaterial(shared);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'planet-surface';
    this.mesh.frustumCulled = false;
    this.object3D.add(this.mesh);

    this._buildOcean();

    // Première initialisation : révélation instantanée de l'existant.
    const disc = regions.discovered;
    for (let i = 0; i < this.count; i++) this.reveal[i] = disc && disc[i] ? 1 : 0;
    this.updateRegions(regions, state, null);
  }

  /* ==================================================================== */
  /*  Construction géométrique                                            */
  /* ==================================================================== */

  _buildGeometry(regions) {
    const count = this.count;
    const radius = this.radius;
    const relief = this.reliefScale;
    const elevation = regions.elevation;

    // --- Passe 1 : récupérer les polygones et moyenner l'élévation aux coins.
    const polys = new Array(count);       // Float32Array(n*3) par cellule
    const polyKeys = new Array(count);    // clés de coin par cellule
    const sumElev = new Map();            // clé -> [somme, nb]
    let totalVerts = 0;

    for (let i = 0; i < count; i++) {
      const c = regions.cellCorners(i);
      const n = (c.length / 3) | 0;
      polys[i] = c;
      const keys = new Array(n);
      const e = elevation ? elevation[i] : 0;
      for (let k = 0; k < n; k++) {
        const key = PlanetMesh._cornerKey(c[k * 3], c[k * 3 + 1], c[k * 3 + 2]);
        keys[k] = key;
        const acc = sumElev.get(key);
        if (acc === undefined) sumElev.set(key, [e, 1]);
        else { acc[0] += e; acc[1]++; }
      }
      polyKeys[i] = keys;
      this.vertexStart[i] = totalVerts;
      this.vertexCount[i] = n * 3;
      totalVerts += n * 3;
    }

    // --- Passe 2 : rayon déplacé de chaque coin (une valeur unique par coin).
    const cornerRadius = new Map();
    for (const [key, acc] of sumElev) {
      cornerRadius.set(key, radius * (1 + (acc[0] / acc[1]) * relief));
    }

    // --- Passe 3 : remplissage des attributs statiques.
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const aCenter = new Float32Array(totalVerts * 3);
    const aCell = new Float32Array(totalVerts);
    const aEdge = new Float32Array(totalVerts);

    const triCount = totalVerts / 3;
    this.faceToCell = triCount > 65535 ? new Uint32Array(triCount) : new Uint16Array(triCount);

    // Accumulateur de normales : clé de sommet unique -> [nx, ny, nz].
    // Les centres sont propres à leur cellule, les coins sont partagés.
    const normalAcc = new Map();
    const accum = (key, nx, ny, nz) => {
      const a = normalAcc.get(key);
      if (a === undefined) normalAcc.set(key, [nx, ny, nz]);
      else { a[0] += nx; a[1] += ny; a[2] += nz; }
    };
    const vertexKeys = new Array(totalVerts);

    const pos = regions.positions;
    let f = 0;

    for (let i = 0; i < count; i++) {
      const c = polys[i];
      const keys = polyKeys[i];
      const n = keys.length;
      const start = this.vertexStart[i];

      // Centre déplacé selon l'élévation propre de la cellule.
      const cx0 = pos[i * 3], cy0 = pos[i * 3 + 1], cz0 = pos[i * 3 + 2];
      const cr = radius * (1 + (elevation ? elevation[i] : 0) * relief);
      const cx = cx0 * cr, cy = cy0 * cr, cz = cz0 * cr;
      this.cellRadius[i] = cr;

      const centerKey = 'c' + i;
      let perimeter = 0;

      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const r1 = cornerRadius.get(keys[k]);
        const r2 = cornerRadius.get(keys[k2]);
        const x1 = c[k * 3] * r1, y1 = c[k * 3 + 1] * r1, z1 = c[k * 3 + 2] * r1;
        const x2 = c[k2 * 3] * r2, y2 = c[k2 * 3 + 1] * r2, z2 = c[k2 * 3 + 2] * r2;

        const v = start + k * 3;
        // sommet 0 : centre
        positions[v * 3] = cx; positions[v * 3 + 1] = cy; positions[v * 3 + 2] = cz;
        aEdge[v] = 0;
        vertexKeys[v] = centerKey;
        // sommet 1 : coin k
        positions[(v + 1) * 3] = x1; positions[(v + 1) * 3 + 1] = y1; positions[(v + 1) * 3 + 2] = z1;
        aEdge[v + 1] = 1;
        vertexKeys[v + 1] = keys[k];
        // sommet 2 : coin k+1
        positions[(v + 2) * 3] = x2; positions[(v + 2) * 3 + 1] = y2; positions[(v + 2) * 3 + 2] = z2;
        aEdge[v + 2] = 1;
        vertexKeys[v + 2] = keys[k2];

        for (let t = 0; t < 3; t++) {
          aCenter[(v + t) * 3] = cx;
          aCenter[(v + t) * 3 + 1] = cy;
          aCenter[(v + t) * 3 + 2] = cz;
          aCell[v + t] = i;
        }

        // Normale de face (winding CCW vu de l'extérieur, garanti par Icosphere).
        const ux = x1 - cx, uy = y1 - cy, uz = z1 - cz;
        const wx = x2 - cx, wy = y2 - cy, wz = z2 - cz;
        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;
        accum(centerKey, nx, ny, nz);
        accum(keys[k], nx, ny, nz);
        accum(keys[k2], nx, ny, nz);

        this.faceToCell[f++] = i;

        const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
        perimeter += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }

      // Rayon approximatif de la cellule : périmètre / (2π).
      this.cellSize[i] = perimeter / (2 * Math.PI);
    }

    // --- Passe 4 : normales lissées (surface continue, pas de facettes dures).
    for (let v = 0; v < totalVerts; v++) {
      const a = normalAcc.get(vertexKeys[v]);
      let nx = a[0], ny = a[1], nz = a[2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 1e-12) { nx /= l; ny /= l; nz /= l; }
      else { nx = positions[v * 3]; ny = positions[v * 3 + 1]; nz = positions[v * 3 + 2]; }
      normals[v * 3] = nx; normals[v * 3 + 1] = ny; normals[v * 3 + 2] = nz;
    }

    /* --- attributs dynamiques ------------------------------------------ */
    const aData = new Float32Array(totalVerts * 4);
    const aInfo = new Float32Array(totalVerts * 4);
    const aAux = new Float32Array(totalVerts * 4);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));
    geo.setAttribute('aCell', new THREE.BufferAttribute(aCell, 1));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(aEdge, 1));

    this.attrData = new THREE.BufferAttribute(aData, 4);
    this.attrInfo = new THREE.BufferAttribute(aInfo, 4);
    this.attrAux = new THREE.BufferAttribute(aAux, 4);
    this.attrData.setUsage(THREE.DynamicDrawUsage);
    this.attrInfo.setUsage(THREE.DynamicDrawUsage);
    this.attrAux.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aData', this.attrData);
    geo.setAttribute('aInfo', this.attrInfo);
    geo.setAttribute('aAux', this.attrAux);

    geo.computeBoundingSphere();
    geo.boundingSphere.radius *= 1.05;   // marge : le shader peut déplacer un peu
    geo.computeBoundingBox();

    this.geometry = geo;
    this.vertexTotal = totalVerts;
    this.triangleCount = triCount;
  }

  static _cornerKey(x, y, z) {
    return Math.round(x * KEY_SCALE) + '|' + Math.round(y * KEY_SCALE) + '|' + Math.round(z * KEY_SCALE);
  }

  /* ==================================================================== */
  /*  Matériaux                                                           */
  /* ==================================================================== */

  _buildMaterial(shared) {
    const s = shared || {};
    this.uniforms = {
      uBiomePalette: { value: biomePaletteArray() },
      uSunDirection: s.uSunDirection || { value: new THREE.Vector3(1, 0.35, 0.55).normalize() },
      uSunColor: s.uSunColor || { value: new THREE.Color(1.0, 0.96, 0.90) },
      uNightAmbient: s.uNightAmbient || { value: new THREE.Color(0.055, 0.075, 0.125) },
      uInsolation: s.uInsolation || { value: 1 },
      uTime: s.uTime || { value: 0 },
      uRadius: { value: this.radius },
      uLayerFrom: { value: 0 },
      uLayerTo: { value: 0 },
      uLayerBlend: { value: 0 },
      uSelected: { value: -1 },
      uHovered: { value: -1 },
      uEdgeStrength: { value: 1 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: planetVertexShader,
      fragmentShader: planetFragmentShader,
      side: THREE.FrontSide,
      transparent: false,
      lights: false,
    });
  }

  _buildOcean() {
    this.oceanUniforms = {
      uSunDirection: this.uniforms.uSunDirection,
      uSunColor: this.uniforms.uSunColor,
      uNightAmbient: this.uniforms.uNightAmbient,
      uInsolation: this.uniforms.uInsolation,
      uTime: this.uniforms.uTime,
      uShallowColor: { value: new THREE.Color(0.16, 0.42, 0.58) },
      uDeepColor: { value: new THREE.Color(0.02, 0.10, 0.24) },
      uOpacity: { value: 0 },
    };

    this.oceanGeometry = new THREE.IcosahedronGeometry(1, 4);
    this.oceanMaterial = new THREE.ShaderMaterial({
      uniforms: this.oceanUniforms,
      vertexShader: oceanVertexShader,
      fragmentShader: oceanFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    });
    this.ocean = new THREE.Mesh(this.oceanGeometry, this.oceanMaterial);
    this.ocean.name = 'planet-ocean';
    this.ocean.renderOrder = 1;
    this.ocean.visible = false;
    this.object3D.add(this.ocean);
  }

  /**
   * Ajuste le niveau de la mer d'après la couverture d'eau globale.
   * Appelé par SceneManager avec une valeur DÉJÀ lissée dans le temps.
   */
  setWaterCoverage(coverage) {
    const c = clamp01(coverage);
    if (c <= 0.02) { this.ocean.visible = false; return; }
    this.ocean.visible = true;
    const level = BALANCE.planet.seaLevel + c * 0.9;
    const r = this.radius * (1 + level * this.reliefScale);
    this.ocean.scale.setScalar(r);
    // Opacité : une mer naissante est une flaque, une mer installée est opaque.
    const t = clamp01((c - 0.02) / 0.28);
    this.oceanUniforms.uOpacity.value = 0.30 + 0.55 * (t * t * (3 - 2 * t));
  }

  /* ==================================================================== */
  /*  Mise à jour des données                                             */
  /* ==================================================================== */

  /**
   * Réécrit les attributs dynamiques.
   * @param {object} regions
   * @param {object} state
   * @param {number[]|Set<number>|null} ids  null = toutes les cellules
   */
  updateRegions(regions, state, ids) {
    const full = ids === null || ids === undefined;
    let list = null;
    if (!full) {
      list = Array.isArray(ids) ? ids : Array.from(ids);
      // Au-delà d'un quart de la planète, la mise à jour partielle coûte plus
      // cher (tri + multiples bufferSubData) qu'un envoi complet.
      if (list.length > this.count * 0.25) { list = null; }
    }

    if (list === null) {
      let sumIce = 0, sumWater = 0;
      for (let i = 0; i < this.count; i++) {
        const r = this._writeCell(regions, i);
        sumIce += r[0]; sumWater += r[1];
      }
      this.meanIce = this.count ? sumIce / this.count : 0;
      this.meanWater = this.count ? sumWater / this.count : 0;
      this.attrData.clearUpdateRanges();
      this.attrInfo.clearUpdateRanges();
      this.attrAux.clearUpdateRanges();
      this.attrData.needsUpdate = true;
      this.attrInfo.needsUpdate = true;
      this.attrAux.needsUpdate = true;
      return;
    }

    // Mise à jour partielle : on trie pour que Three fusionne les plages
    // contiguës (les ids voisins le sont souvent : cellules voisines).
    list.sort((a, b) => a - b);
    for (let k = 0; k < list.length; k++) {
      const i = list[k] | 0;
      if (i < 0 || i >= this.count) continue;
      if (k > 0 && list[k - 1] === i) continue;   // doublon
      this._writeCell(regions, i);
      const start = this.vertexStart[i];
      const n = this.vertexCount[i];
      this.attrData.addUpdateRange(start * 4, n * 4);
      this.attrInfo.addUpdateRange(start * 4, n * 4);
      this.attrAux.addUpdateRange(start * 4, n * 4);
    }
    this.attrData.needsUpdate = true;
    this.attrInfo.needsUpdate = true;
    this.attrAux.needsUpdate = true;
  }

  /** Écrit les 3n sommets d'une cellule. Retourne [ice, water] pour les moyennes. */
  _writeCell(regions, i) {
    const temp = regions.temperature ? regions.temperature[i] : -60;
    const moisture = regions.moisture ? regions.moisture[i] : 0;
    const veg = regions.vegetation ? regions.vegetation[i] : 0;
    const poll = regions.pollution ? regions.pollution[i] : 0;
    const ice = regions.ice ? regions.ice[i] : 0;
    const water = regions.water ? regions.water[i] : 0;
    const biome = regions.biome ? regions.biome[i] : 3;
    const minerals = regions.minerals ? regions.minerals[i] : 0;
    const geo = regions.geothermal ? regions.geothermal[i] : 0;
    const hab = regions.habitability ? regions.habitability[i] : 0;
    const energy = regions.energyPotential ? regions.energyPotential[i] : geo;
    const pop = regions.population ? regions.population[i] : 0;
    const bc = regions.buildingCount ? regions.buildingCount[i] : 0;

    // Température normalisée : -120 °C → 0, +80 °C → 1.
    const tn = clamp01((temp + 120) / 200);
    // Densité de lumières nocturnes : population dominante, bâtiments d'appoint.
    const night = clamp01(clamp01(pop / 6000) * 0.85 + clamp01(bc / 5) * 0.45);

    const d0 = tn, d1 = clamp01(moisture), d2 = clamp01(veg), d3 = clamp01(poll);
    const i0 = biome, i1 = pack6(ice, water), i2 = this.reveal[i], i3 = pack6(minerals, geo);
    const x0 = night, x1 = clamp01(hab), x2 = clamp01(energy), x3 = 0;

    const dArr = this.attrData.array;
    const iArr = this.attrInfo.array;
    const xArr = this.attrAux.array;
    const start = this.vertexStart[i];
    const end = start + this.vertexCount[i];
    for (let v = start; v < end; v++) {
      const o = v * 4;
      dArr[o] = d0; dArr[o + 1] = d1; dArr[o + 2] = d2; dArr[o + 3] = d3;
      iArr[o] = i0; iArr[o + 1] = i1; iArr[o + 2] = i2; iArr[o + 3] = i3;
      xArr[o] = x0; xArr[o + 1] = x1; xArr[o + 2] = x2; xArr[o + 3] = x3;
    }

    // Détection d'un changement d'état de découverte → animation d'apparition.
    const target = regions.discovered && regions.discovered[i] ? 1 : 0;
    if (Math.abs(this.reveal[i] - target) > 1e-3) this._revealing.add(i);

    PlanetMesh._scratch2[0] = ice;
    PlanetMesh._scratch2[1] = water;
    return PlanetMesh._scratch2;
  }

  /**
   * Anime la révélation des régions. N'écrit QUE les cellules en transition,
   * donc coût nul quand rien ne change.
   */
  update(dt, regions) {
    // Le temps n'est avancé ici que si personne d'autre ne le fait (uniform
    // partagé avec SceneManager : c'est lui qui l'incrémente).
    if (this._ownsTime) this.uniforms.uTime.value += dt;
    if (this._revealing.size === 0) return;

    const disc = regions.discovered;
    const step = REVEAL_SPEED * dt;
    const iArr = this.attrInfo.array;
    let touched = false;

    for (const i of this._revealing) {
      const target = disc && disc[i] ? 1 : 0;
      let v = this.reveal[i];
      if (v < target) v = Math.min(target, v + step);
      else if (v > target) v = Math.max(target, v - step);
      // On colle à la cible dès qu'on en est assez près : pas de 0,9999 résiduel.
      const done = Math.abs(v - target) < 1e-3;
      if (done) v = target;
      this.reveal[i] = v;

      const start = this.vertexStart[i];
      const n = this.vertexCount[i];
      const end = start + n;
      for (let k = start; k < end; k++) iArr[k * 4 + 2] = v;
      this.attrInfo.addUpdateRange(start * 4, n * 4);
      touched = true;

      if (done) this._revealing.delete(i);
    }
    if (touched) this.attrInfo.needsUpdate = true;
  }

  /* ==================================================================== */
  /*  Sélection                                                           */
  /* ==================================================================== */

  /**
   * @param {THREE.Raycaster} raycaster
   * @returns {number|null} id de région, ou null si le rayon manque la planète
   */
  raycastRegion(raycaster) {
    const hits = PlanetMesh._hits;
    hits.length = 0;
    raycaster.intersectObject(this.mesh, false, hits);
    if (hits.length === 0) return null;
    const fi = hits[0].faceIndex;
    hits.length = 0;
    if (fi === undefined || fi === null || fi >= this.faceToCell.length) return null;
    return this.faceToCell[fi];
  }

  /**
   * Remplit `out` avec les coins DÉPLACÉS d'une cellule, lus directement dans
   * la géométrie (donc rigoureusement alignés sur ce qui est affiché).
   * @param {number} id
   * @param {Float32Array} out  au moins 8*3 éléments
   * @param {number} lift       facteur d'élévation (1.01 = 1 % au-dessus)
   * @returns {number} nombre de coins écrits (0 si l'id est invalide)
   */
  getCellOutline(id, out, lift = 1.008) {
    if (id === null || id === undefined || id < 0 || id >= this.count) return 0;
    const n = (this.vertexCount[id] / 3) | 0;
    const pos = this.geometry.attributes.position.array;
    const start = this.vertexStart[id];
    const max = Math.floor(out.length / 3);
    const k = Math.min(n, max);
    for (let j = 0; j < k; j++) {
      // Dans l'éventail, le sommet 1 du triangle j est le coin j.
      const v = (start + j * 3 + 1) * 3;
      out[j * 3] = pos[v] * lift;
      out[j * 3 + 1] = pos[v + 1] * lift;
      out[j * 3 + 2] = pos[v + 2] * lift;
    }
    return k;
  }

  /** Direction unitaire (depuis le centre de la planète) d'une région. */
  getRegionDirection(id, out) {
    const target = out || new THREE.Vector3();
    if (id === null || id === undefined || id < 0 || id >= this.count) return target.set(0, 1, 0);
    const start = this.vertexStart[id];
    const pos = this.geometry.attributes.position.array;
    const v = start * 3;   // sommet 0 du premier triangle = centre de la cellule
    return target.set(pos[v], pos[v + 1], pos[v + 2]).normalize();
  }

  /** Position monde du centre d'une région, à la surface du relief. */
  getRegionPosition(regions, id, out) {
    const target = out || new THREE.Vector3();
    if (id === null || id === undefined || id < 0 || id >= this.count) return target.set(0, 0, 0);
    const p = regions.positions;
    const r = this.cellRadius[id];
    return target.set(p[id * 3] * r, p[id * 3 + 1] * r, p[id * 3 + 2] * r);
  }

  /* ==================================================================== */

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.oceanGeometry.dispose();
    this.oceanMaterial.dispose();
    this.object3D.clear();
    this._revealing.clear();
  }
}

/** Scratch partagés : aucune allocation dans les boucles chaudes. */
PlanetMesh._scratch2 = new Float32Array(2);
PlanetMesh._hits = [];

export default PlanetMesh;

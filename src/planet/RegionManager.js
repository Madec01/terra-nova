/**
 * ============================================================================
 *  TERRA NOVA — RegionManager (Struct of Arrays)
 * ============================================================================
 *  Pourquoi du SoA plutôt qu'un tableau d'objets : la simulation parcourt
 *  jusqu'à 2562 régions plusieurs fois par tick. Des Float32Array contigus
 *  restent en cache CPU et évitent totalement la pression sur le GC — un
 *  tableau d'objets coûterait 10 à 30 fois plus cher et provoquerait des
 *  micro-freezes visibles au rendu.
 *
 *  Conforme à docs/CONTRACTS.md § 2.
 * ============================================================================
 */

import { BALANCE } from '../data/balance.js';
import { BIOMES } from '../data/biomes.js';
import { toLatLon, formatLatLon, weightedMean } from '../utils/math.js';
import { encodeFloat32, decodeFloat32, encodeUint8, decodeUint8 } from '../core/SaveManager.js';

/** Champs dynamiques : les SEULS qui changent en partie, donc les seuls sauvegardés. */
export const DYNAMIC_FLOAT_FIELDS = [
  'temperature', 'moisture', 'ice', 'water', 'vegetation', 'pollution', 'population',
];
export const DYNAMIC_UINT8_FIELDS = ['biome', 'discovered', 'buildingCount'];

/** Facteur d'affichage : convertit l'élévation normalisée en kilomètres « plausibles ». */
const ELEVATION_KM = 12;

export class RegionManager {
  /**
   * @param {object} geometry résultat de buildGoldberg()
   * @param {{seed:number, subdivisions:number, planetType:string}} meta
   */
  constructor(geometry, { seed = 0, subdivisions = 0, planetType = 'rocky' } = {}) {
    const n = geometry.count;

    this.count = n;
    this.seed = seed >>> 0;
    this.subdivisions = subdivisions;
    this.planetType = planetType;
    this.landingSite = -1;
    /** Niveau de mer effectif : le générateur peut le décaler selon le type de planète. */
    this.seaLevel = BALANCE.planet.seaLevel;

    /* --- géométrie (partagée avec le cache d'Icosphere, jamais mutée) --- */
    this.positions = geometry.positions;
    this.latitude = geometry.latitude;
    this.area = geometry.area;
    this.corners = geometry.corners;
    this.cornerOffsets = geometry.cornerOffsets;
    this._neighbors = geometry.neighbors;
    this.neighborOffsets = geometry.neighborOffsets;

    /* --- statiques : regénérés depuis la seed, jamais sauvegardés --- */
    this.elevation = new Float32Array(n);
    this.minerals = new Float32Array(n);
    this.geothermal = new Float32Array(n);
    this.iceInit = new Float32Array(n);
    this.fertilityBase = new Float32Array(n);
    this.radiation = new Float32Array(n);
    this.anomaly = new Uint8Array(n);

    /* --- dynamiques : sauvegardés --- */
    this.temperature = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.ice = new Float32Array(n);
    this.water = new Float32Array(n);
    this.vegetation = new Float32Array(n);
    this.pollution = new Float32Array(n);
    this.population = new Float32Array(n);
    this.biome = new Uint8Array(n);
    this.discovered = new Uint8Array(n);
    this.buildingCount = new Uint8Array(n);

    /* --- dérivées : recalculées chaque tick par la simulation --- */
    this.habitability = new Float32Array(n);
    this.energyPotential = new Float32Array(n);
  }

  /* ---------------------------------------------------------------- */
  /*  Topologie                                                        */
  /* ---------------------------------------------------------------- */

  /** Voisins de i (5 ou 6). Sous-vue : aucune allocation, appelé des milliers de fois par tick. */
  neighbors(i) {
    return this._neighbors.subarray(this.neighborOffsets[i], this.neighborOffsets[i + 1]);
  }

  neighborCount(i) {
    return this.neighborOffsets[i + 1] - this.neighborOffsets[i];
  }

  /** Itère les voisins sans créer de sous-vue du tout (boucle la plus chaude de la sim). */
  forEachNeighbor(i, fn) {
    const a = this.neighborOffsets[i], b = this.neighborOffsets[i + 1];
    for (let k = a; k < b; k++) fn(this._neighbors[k], k - a);
  }

  /** Sommets du polygone de la cellule i, ordre trigonométrique vu de l'extérieur. */
  cellCorners(i) {
    return this.corners.subarray(this.cornerOffsets[i] * 3, this.cornerOffsets[i + 1] * 3);
  }

  cornerCount(i) {
    return this.cornerOffsets[i + 1] - this.cornerOffsets[i];
  }

  /** Position du centre de la cellule (copie dans un objet : usage UI/rendu ponctuel). */
  positionOf(i) {
    return { x: this.positions[i * 3], y: this.positions[i * 3 + 1], z: this.positions[i * 3 + 2] };
  }

  latLon(i) {
    return toLatLon(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
  }

  /* ---------------------------------------------------------------- */
  /*  Vue lisible pour l'interface                                     */
  /* ---------------------------------------------------------------- */

  /** Objet complet et lisible pour le panneau de région. Ne pas appeler en boucle chaude. */
  getRegionView(i) {
    const { lat, lon } = this.latLon(i);
    const bi = this.biome[i];
    const biome = BIOMES[bi] || BIOMES[0];
    return {
      id: i,
      lat, lon,
      coords: formatLatLon(lat, lon),
      latitude: this.latitude[i],
      area: this.area[i],

      // statiques
      elevation: this.elevation[i],
      elevationKm: this.elevation[i] * ELEVATION_KM,
      minerals: this.minerals[i],
      geothermal: this.geothermal[i],
      iceInit: this.iceInit[i],
      fertilityBase: this.fertilityBase[i],
      radiation: this.radiation[i],
      anomaly: this.anomaly[i],

      // dynamiques
      temperature: this.temperature[i],
      moisture: this.moisture[i],
      ice: this.ice[i],
      water: this.water[i],
      vegetation: this.vegetation[i],
      pollution: this.pollution[i],
      population: this.population[i],
      biome: bi,
      biomeId: biome.id,
      biomeName: biome.name,
      biomeDesc: biome.desc,
      discovered: this.discovered[i],
      buildingCount: this.buildingCount[i],

      // dérivées
      habitability: this.habitability[i],
      energyPotential: this.energyPotential[i],

      isLandingSite: i === this.landingSite,
      isLand: this.elevation[i] > this.seaLevel,
      isSubmerged: this.water[i] > 0.05,
      neighbors: Array.from(this.neighbors(i)),
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Agrégats                                                         */
  /* ---------------------------------------------------------------- */

  /** Moyennes pondérées par l'aire + quelques fractions utiles à l'UI et à la sim. */
  stats() {
    const n = this.count, area = this.area;
    let totalArea = 0, land = 0, iceCov = 0, waterCov = 0, discovered = 0, population = 0;
    let anomalies = 0, buildings = 0;
    for (let i = 0; i < n; i++) {
      const a = area[i];
      totalArea += a;
      if (this.elevation[i] > this.seaLevel) land += a;
      iceCov += this.ice[i] * a;
      waterCov += this.water[i] * a;
      if (this.discovered[i]) discovered++;
      population += this.population[i];
      anomalies += this.anomaly[i];
      buildings += this.buildingCount[i];
    }
    const inv = totalArea > 0 ? 1 / totalArea : 0;
    return {
      count: n,
      landFraction: land * inv,
      iceCoverage: iceCov * inv,
      waterCoverage: waterCov * inv,
      discovered,
      discoveredRatio: n > 0 ? discovered / n : 0,
      population,
      anomalies,
      buildings,
      meanTemperature: weightedMean(this.temperature, area, n),
      meanElevation: weightedMean(this.elevation, area, n),
      meanMoisture: weightedMean(this.moisture, area, n),
      meanVegetation: weightedMean(this.vegetation, area, n),
      meanPollution: weightedMean(this.pollution, area, n),
      meanHabitability: weightedMean(this.habitability, area, n),
      meanMinerals: weightedMean(this.minerals, area, n),
      meanGeothermal: weightedMean(this.geothermal, area, n),
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Sérialisation                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * On ne sauvegarde QUE ce qui ne peut pas être recalculé : la seed et le
   * niveau de subdivision suffisent à reconstruire toute la géométrie et tous
   * les champs statiques. Une sauvegarde reste ainsi ~10x plus légère.
   */
  toJSON() {
    const json = {
      subdivisions: this.subdivisions,
      seed: this.seed,
      landingSite: this.landingSite,
    };
    for (const f of DYNAMIC_FLOAT_FIELDS) json[f] = encodeFloat32(this[f]);
    for (const f of DYNAMIC_UINT8_FIELDS) json[f] = encodeUint8(this[f]);
    return json;
  }

  /**
   * Réinjecte les champs dynamiques dans un RegionManager fraîchement regénéré.
   * Tolérant : un champ absent ou corrompu laisse la valeur issue de la genèse,
   * ce qui vaut toujours mieux qu'une partie impossible à charger.
   */
  static fromJSON(json, generated) {
    if (!json || !generated) return generated;
    const n = generated.count;

    if (Number.isInteger(json.landingSite) && json.landingSite >= 0 && json.landingSite < n) {
      generated.landingSite = json.landingSite;
    }

    for (const f of DYNAMIC_FLOAT_FIELDS) {
      const raw = json[f];
      if (typeof raw !== 'string' || raw.length === 0) continue;
      try { generated[f].set(decodeFloat32(raw, n)); } catch { /* champ ignoré */ }
    }
    for (const f of DYNAMIC_UINT8_FIELDS) {
      const raw = json[f];
      if (typeof raw !== 'string' || raw.length === 0) continue;
      try { generated[f].set(decodeUint8(raw, n)); } catch { /* champ ignoré */ }
    }
    return generated;
  }
}

export default RegionManager;

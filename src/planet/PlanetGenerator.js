/**
 * ============================================================================
 *  TERRA NOVA — Génération procédurale de la planète
 * ============================================================================
 *  Tout est déterministe à partir de la seed : la géométrie vient du cache
 *  d'Icosphere, les champs statiques d'un jeu de bruits simplex indexés par la
 *  seed. Conséquence : la sauvegarde n'a besoin de stocker que la seed et les
 *  champs dynamiques (cf. RegionManager.toJSON).
 *
 *  Le relief n'est PAS un simple bruit fractal : un bruit pur donne un
 *  « archipel de confettis » injouable. On superpose donc des plaques
 *  tectoniques (quelques larges dômes/bassins) au bruit continental, puis on
 *  recale le niveau de mer par quantile pour garantir une fraction de terres
 *  jouable quelle que soit la seed.
 * ============================================================================
 */

import { BALANCE } from '../data/balance.js';
import { BIOME_INDEX } from '../data/biomes.js';
import { SimplexNoise } from '../utils/noise.js';
import { Random } from '../utils/rng.js';
import { clamp, clamp01, smoothstep, bell } from '../utils/math.js';
import { buildGoldberg } from './Icosphere.js';
import { RegionManager } from './RegionManager.js';

/* ------------------------------------------------------------------ */
/*  Presets de types de planète                                        */
/* ------------------------------------------------------------------ */

/**
 * Paramètres MORPHOLOGIQUES (pas d'équilibrage de gameplay : celui-ci reste
 * dans balance.js). Ajouter un monde = ajouter une entrée ici, rien d'autre.
 */
export const PLANET_TYPES = {
  rocky: {
    name: 'Monde rocheux',
    desc: 'Croûte silicatée, reliefs marqués, minerais abondants. Le monde de référence.',
    continentAmplitude: 0.62, mountainAmplitude: 0.42, detailAmplitude: 0.10,
    plates: [3, 4], plateAmplitude: 0.55, plateWidth: 0.95,
    landTarget: 0.55, seaLevelShift: 0,
    mineralRichness: 1.0, mineralExponent: 2.1,
    hotspots: 5, hotspotWidth: 0.28, geothermalTarget: 0.11,
    polarIce: 0.85, basinIce: 0.35, iceScale: 1.0,
    fertility: 1.0, radiationScale: 0.55,
    anomalies: [6, 10], startTemperature: 0,
  },
  frozen: {
    name: 'Monde glacé',
    desc: 'Surface figée sous une calotte quasi globale. Reliefs émoussés.',
    continentAmplitude: 0.50, mountainAmplitude: 0.28, detailAmplitude: 0.08,
    plates: [2, 3], plateAmplitude: 0.42, plateWidth: 1.15,
    landTarget: 0.58, seaLevelShift: 0,
    mineralRichness: 0.85, mineralExponent: 2.4,
    hotspots: 3, hotspotWidth: 0.22, geothermalTarget: 0.08,
    polarIce: 1.0, basinIce: 0.75, iceScale: 1.35,
    fertility: 0.7, radiationScale: 0.40,
    anomalies: [6, 9], startTemperature: -28,
  },
  volcanic: {
    name: 'Monde volcanique',
    desc: 'Croûte jeune et fracturée, foyers géothermiques nombreux.',
    continentAmplitude: 0.58, mountainAmplitude: 0.62, detailAmplitude: 0.16,
    plates: [4, 4], plateAmplitude: 0.60, plateWidth: 0.80,
    landTarget: 0.64, seaLevelShift: 0,
    mineralRichness: 1.25, mineralExponent: 1.8,
    hotspots: 11, hotspotWidth: 0.30, geothermalTarget: 0.15,
    polarIce: 0.45, basinIce: 0.15, iceScale: 0.55,
    fertility: 0.85, radiationScale: 0.75,
    anomalies: [7, 10], startTemperature: 18,
  },
  oceanic: {
    name: 'Monde océanique',
    desc: 'Immenses bassins gelés, quelques archipels. Riche en volatiles.',
    continentAmplitude: 0.70, mountainAmplitude: 0.34, detailAmplitude: 0.09,
    plates: [2, 3], plateAmplitude: 0.65, plateWidth: 1.05,
    landTarget: 0.42, seaLevelShift: 0,
    mineralRichness: 0.75, mineralExponent: 2.6,
    hotspots: 6, hotspotWidth: 0.26, geothermalTarget: 0.12,
    polarIce: 0.90, basinIce: 0.85, iceScale: 1.20,
    fertility: 1.15, radiationScale: 0.45,
    anomalies: [6, 9], startTemperature: -6,
  },
  desert: {
    name: 'Monde désertique',
    desc: 'Presque aucune dépression profonde, très peu de volatiles piégés.',
    continentAmplitude: 0.48, mountainAmplitude: 0.46, detailAmplitude: 0.14,
    plates: [3, 4], plateAmplitude: 0.40, plateWidth: 1.00,
    landTarget: 0.68, seaLevelShift: 0,
    mineralRichness: 1.1, mineralExponent: 2.0,
    hotspots: 4, hotspotWidth: 0.24, geothermalTarget: 0.09,
    polarIce: 0.55, basinIce: 0.10, iceScale: 0.45,
    fertility: 0.75, radiationScale: 0.85,
    anomalies: [6, 10], startTemperature: 12,
  },
};

export const PLANET_TYPE_LIST = Object.entries(PLANET_TYPES).map(([id, p]) => ({ id, ...p }));

/** Décalages de seed : chaque champ doit avoir son propre bruit, sinon ils se corrèlent. */
const OFFSET = {
  continent: 0, mountain: 1013, detail: 2027, mineral: 3041,
  geothermal: 4057, ice: 5077, fertility: 6089, radiation: 7103, jitter: 8117,
};

/* ------------------------------------------------------------------ */
/*  API principale                                                     */
/* ------------------------------------------------------------------ */

/**
 * Construit une planète complète, prête à simuler.
 * @returns {RegionManager}
 */
export function generatePlanet({ seed = 1, subdivisions = BALANCE.planet.subdivisions, planetType = 'rocky' } = {}) {
  const preset = PLANET_TYPES[planetType] || PLANET_TYPES.rocky;
  const s = seed >>> 0;

  const geo = buildGoldberg(subdivisions);
  const regions = new RegionManager(geo, { seed: s, subdivisions, planetType });
  regions.seaLevel = clamp(BALANCE.planet.seaLevel + preset.seaLevelShift, -0.9, 0.9);

  const rng = new Random(s);
  const n = geo.count;
  const pos = geo.positions;

  buildElevation(regions, preset, s, rng, pos, n);
  buildMinerals(regions, preset, s, pos, n);
  buildGeothermal(regions, preset, s, rng, pos, n);
  buildIce(regions, preset, s, pos, n);
  buildFertility(regions, preset, s, pos, n);
  buildRadiation(regions, preset, s, pos, n);
  placeAnomalies(regions, preset, rng, n);
  initDynamic(regions, preset, s, pos, n);
  chooseLandingSite(regions, rng, n);

  return regions;
}

/* ------------------------------------------------------------------ */
/*  Relief                                                             */
/* ------------------------------------------------------------------ */

function buildElevation(regions, preset, seed, rng, pos, n) {
  const P = BALANCE.planet;
  const continent = new SimplexNoise(seed + OFFSET.continent);
  const mountain = new SimplexNoise(seed + OFFSET.mountain);
  const detail = new SimplexNoise(seed + OFFSET.detail);

  /* --- plaques : quelques dômes/bassins larges qui structurent les continents --- */
  const plateCount = rng.int(preset.plates[0], preset.plates[1]);
  const plates = new Float64Array(plateCount * 5); // x,y,z,amp,width
  for (let p = 0; p < plateCount; p++) {
    // Direction uniforme sur la sphère (méthode de l'archimède : z uniforme).
    const z = rng.range(-1, 1), a = rng.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    plates[p * 5] = r * Math.cos(a);
    plates[p * 5 + 1] = r * Math.sin(a);
    plates[p * 5 + 2] = z;
    // Une plaque sur trois environ s'enfonce : ça crée les vrais bassins océaniques.
    plates[p * 5 + 3] = preset.plateAmplitude * (rng.bool(0.6) ? rng.range(0.5, 1) : -rng.range(0.6, 1.15));
    plates[p * 5 + 4] = preset.plateWidth * rng.range(0.75, 1.3);
  }

  const base = new Float64Array(n);
  const fbmOpts = { octaves: 5, frequency: P.continentFrequency, persistence: 0.5, lacunarity: 2.05 };

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let v = continent.fbm(x, y, z, fbmOpts) * preset.continentAmplitude;
    for (let p = 0; p < plates.length; p += 5) {
      const d = Math.acos(clamp(x * plates[p] + y * plates[p + 1] + z * plates[p + 2], -1, 1)) / plates[p + 4];
      v += plates[p + 3] * Math.exp(-d * d);
    }
    base[i] = v;
  }

  // Seuil « terre » sur la base seule : sert de masque pour n'accrocher les
  // chaînes de montagnes qu'aux continents (une crête au fond d'un océan
  // n'aurait aucun sens géologique ni lisibilité visuelle).
  const t0 = quantileThreshold(base, regions.area, n, preset.landTarget);

  const elev = regions.elevation;
  const mOpts = { octaves: 4, frequency: BALANCE.planet.mountainFrequency, persistence: 0.55, lacunarity: 2.1 };
  const dOpts = { octaves: 3, frequency: BALANCE.planet.detailFrequency, persistence: 0.5, lacunarity: 2 };

  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const mask = smoothstep(t0 - 0.05, t0 + 0.30, base[i]);
    const ridge = Math.max(0, mountain.ridged(x, y, z, mOpts));
    raw[i] = base[i]
      + ridge * mask * preset.mountainAmplitude
      + detail.fbm(x, y, z, dOpts) * preset.detailAmplitude;
  }

  // Recalage final : on force la fraction de terres émergées à la cible du
  // preset, puis on étire autour du niveau de mer pour occuper [-1,1] sans
  // modifier cette fraction (l'homothétie est centrée sur le seuil).
  normalizeToSeaLevel(raw, regions.area, n, preset.landTarget, regions.seaLevel, elev);
}

/**
 * Retourne la valeur seuil telle que `fraction` de l'AIRE soit au-dessus.
 * Pondérer par l'aire (et non par le nombre de cellules) évite un biais :
 * les 12 pentagones sont plus petits que les hexagones.
 */
function quantileThreshold(values, area, n, fraction) {
  // Tri décroissant : on descend jusqu'à avoir couvert `fraction` de l'aire.
  const arr = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[b] - values[a]);
  let total = 0;
  for (let i = 0; i < n; i++) total += area[i];
  const goal = total * clamp01(fraction);
  let acc = 0;
  for (let k = 0; k < n; k++) {
    acc += area[arr[k]];
    if (acc >= goal) return values[arr[k]];
  }
  return values[arr[n - 1]];
}

function normalizeToSeaLevel(raw, area, n, landTarget, seaLevel, out) {
  const t = quantileThreshold(raw, area, n, landTarget);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (raw[i] < lo) lo = raw[i]; if (raw[i] > hi) hi = raw[i]; }
  const up = hi > t ? (1 - seaLevel) / (hi - t) : 1;
  const down = t > lo ? (seaLevel + 1) / (t - lo) : 1;
  const scale = Math.min(up, down);
  for (let i = 0; i < n; i++) out[i] = clamp(seaLevel + (raw[i] - t) * scale, -1, 1);
}

/* ------------------------------------------------------------------ */
/*  Minerais                                                           */
/* ------------------------------------------------------------------ */

function buildMinerals(regions, preset, seed, pos, n) {
  const noise = new SimplexNoise(seed + OFFSET.mineral);
  const elev = regions.elevation, out = regions.minerals;
  const opts = { octaves: 4, frequency: 2.7, persistence: 0.55, lacunarity: 2.1 };
  // Le gradient entre voisins décroît quand les cellules rétrécissent : on le
  // renormalise par la taille de cellule pour que n=3 et n=4 donnent la même
  // richesse moyenne.
  const gradScale = 3.2 * Math.pow(2, regions.subdivisions - 3);

  for (let i = 0; i < n; i++) {
    // Gradient d'élévation entre voisins = proxy de fracture tectonique :
    // c'est là que les filons remontent.
    let grad = 0;
    const a = regions.neighborOffsets[i], b = regions.neighborOffsets[i + 1];
    for (let k = a; k < b; k++) {
      const d = Math.abs(elev[i] - elev[regions._neighbors[k]]);
      if (d > grad) grad = d;
    }
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const nz = noise.fbm(x, y, z, opts) * 0.5 + 0.5;
    const v = clamp01(nz * 0.62 + Math.max(0, elev[i]) * 0.22 + clamp01(grad * gradScale) * 0.30 - 0.12);
    // Courbe puissance : beaucoup de régions pauvres, quelques vrais gisements.
    out[i] = clamp01(Math.pow(v, preset.mineralExponent) * preset.mineralRichness);
  }
}

/* ------------------------------------------------------------------ */
/*  Géothermie                                                         */
/* ------------------------------------------------------------------ */

function buildGeothermal(regions, preset, seed, rng, pos, n) {
  const noise = new SimplexNoise(seed + OFFSET.geothermal);
  const out = regions.geothermal;

  const k = Math.max(1, preset.hotspots);
  const spots = new Float64Array(k * 5); // x,y,z,strength,width
  for (let p = 0; p < k; p++) {
    const z = rng.range(-1, 1), a = rng.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    spots[p * 5] = r * Math.cos(a);
    spots[p * 5 + 1] = r * Math.sin(a);
    spots[p * 5 + 2] = z;
    spots[p * 5 + 3] = rng.range(0.65, 1);
    spots[p * 5 + 4] = preset.hotspotWidth * rng.range(0.7, 1.35);
  }

  const opts = { octaves: 3, frequency: 4.2, persistence: 0.5, lacunarity: 2 };
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let best = 0;
    for (let p = 0; p < spots.length; p += 5) {
      const d = Math.acos(clamp(x * spots[p] + y * spots[p + 1] + z * spots[p + 2], -1, 1)) / spots[p + 4];
      const g = spots[p + 3] * Math.exp(-d * d);
      if (g > best) best = g;
    }
    raw[i] = Math.max(0, best + (noise.fbm(x, y, z, opts) * 0.5 + 0.5) * 0.16 - 0.06);
  }

  /* La géothermie doit rester RARE : c'est la ressource qui débloque l'énergie
     gratuite. On recale donc l'échelle pour que la fraction au-dessus de 0.4
     tombe pile sur la cible du preset, quelle que soit la seed. */
  const target = clamp(preset.geothermalTarget, 0.02, 0.5);
  const v = quantileThreshold(raw, regions.area, n, target);
  const scale = v > 1e-4 ? 0.4 / v : 1;
  for (let i = 0; i < n; i++) out[i] = clamp01(raw[i] * scale);
}

/* ------------------------------------------------------------------ */
/*  Glace initiale                                                     */
/* ------------------------------------------------------------------ */

function buildIce(regions, preset, seed, pos, n) {
  const noise = new SimplexNoise(seed + OFFSET.ice);
  const lat = regions.latitude, elev = regions.elevation, out = regions.iceInit;
  const opts = { octaves: 3, frequency: 2.2, persistence: 0.5, lacunarity: 2 };
  const sea = regions.seaLevel;

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const polar = smoothstep(0.35, 0.92, Math.abs(lat[i])) * preset.polarIce;
    // Les bassins profonds piègent les volatiles : la glace y survit hors des pôles.
    const basin = smoothstep(sea + 0.05, -0.75, elev[i]) * preset.basinIce;
    const nz = noise.fbm(x, y, z, opts) * 0.5 + 0.5;
    out[i] = clamp01((Math.max(polar, basin) + polar * basin * 0.4) * (0.62 + 0.55 * nz) * preset.iceScale);
  }
}

/* ------------------------------------------------------------------ */
/*  Fertilité et radiation                                             */
/* ------------------------------------------------------------------ */

function buildFertility(regions, preset, seed, pos, n) {
  const noise = new SimplexNoise(seed + OFFSET.fertility);
  const elev = regions.elevation, geo = regions.geothermal, out = regions.fertilityBase;
  const opts = { octaves: 3, frequency: 3.4, persistence: 0.5, lacunarity: 2 };
  const sea = regions.seaLevel;

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    // Optimum juste au-dessus du niveau de mer : plaines et plateaux bas.
    const relief = bell(elev[i], sea + 0.18, 0.42);
    const highPenalty = 1 - smoothstep(0.45, 0.95, elev[i]) * 0.85;
    const volcanicPenalty = 1 - clamp01(geo[i]) * 0.55;
    const nz = noise.fbm(x, y, z, opts) * 0.5 + 0.5;
    out[i] = clamp01(relief * highPenalty * volcanicPenalty * (0.55 + 0.7 * nz) * preset.fertility);
  }
}

function buildRadiation(regions, preset, seed, pos, n) {
  const noise = new SimplexNoise(seed + OFFSET.radiation);
  const elev = regions.elevation, lat = regions.latitude, out = regions.radiation;
  const opts = { octaves: 3, frequency: 1.8, persistence: 0.5, lacunarity: 2 };

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const nz = noise.fbm(x, y, z, opts) * 0.5 + 0.5;
    // Sans atmosphère épaisse, l'altitude et l'incidence zénithale dominent.
    const altitude = clamp01(elev[i] * 0.5 + 0.5);
    const equator = 1 - Math.abs(lat[i]);
    out[i] = clamp01((0.32 * nz + 0.38 * altitude + 0.30 * equator) * preset.radiationScale + 0.08);
  }
}

/* ------------------------------------------------------------------ */
/*  Anomalies                                                          */
/* ------------------------------------------------------------------ */

/**
 * Les anomalies récompensent l'exploration : on les place sur des régions
 * « remarquables » (très riches, très chaudes ou très hautes) et jamais
 * collées les unes aux autres, pour qu'elles restent dispersées sur le globe.
 */
function placeAnomalies(regions, preset, rng, n) {
  const wanted = rng.int(preset.anomalies[0], preset.anomalies[1]);
  const score = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    score[i] = regions.minerals[i] * 1.0
      + regions.geothermal[i] * 1.1
      + Math.max(0, regions.elevation[i]) * 0.9
      + regions.radiation[i] * 0.4
      + rng.next() * 0.9;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => score[b] - score[a]);

  let placed = 0;
  for (let k = 0; k < order.length && placed < wanted; k++) {
    const i = order[k];
    let adjacent = false;
    const a = regions.neighborOffsets[i], b = regions.neighborOffsets[i + 1];
    for (let m = a; m < b; m++) if (regions.anomaly[regions._neighbors[m]]) { adjacent = true; break; }
    if (adjacent) continue;
    regions.anomaly[i] = 1;
    placed++;
  }
  // Filet de sécurité : une planète sans anomalie casserait la boucle d'exploration.
  if (placed === 0 && n > 0) regions.anomaly[order[0]] = 1;
}

/* ------------------------------------------------------------------ */
/*  Champs dynamiques initiaux                                         */
/* ------------------------------------------------------------------ */

function initDynamic(regions, preset, seed, pos, n) {
  const C = BALANCE.climate;
  const noise = new SimplexNoise(seed + OFFSET.jitter);
  const opts = { octaves: 2, frequency: 5.5, persistence: 0.5, lacunarity: 2 };
  const base = BALANCE.start.globals.temperature + preset.startTemperature;
  const sea = regions.seaLevel;

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];

    // Gradient latitudinal centré : l'équateur gagne la moitié du « swing »,
    // les pôles la perdent. Altitude : refroidissement au-dessus du niveau de mer.
    const latTerm = C.latitudeSwing * (0.5 - Math.abs(regions.latitude[i]));
    const altTerm = -C.altitudeLapse * Math.max(0, regions.elevation[i] - sea) * 0.4;
    const jitter = noise.noise3(x, y, z) * C.localVariance;
    regions.temperature[i] = base + latTerm + altTerm + jitter;

    regions.ice[i] = regions.iceInit[i];
    // Planète encore sèche : un peu d'humidité seulement là où la glace sublime.
    regions.moisture[i] = clamp01(regions.iceInit[i] * 0.12);
    regions.water[i] = 0;
    regions.vegetation[i] = 0;
    regions.pollution[i] = 0;
    regions.population[i] = 0;
    regions.discovered[i] = 0;
    regions.buildingCount[i] = 0;
    regions.habitability[i] = 0;
    regions.energyPotential[i] = 0;
    regions.biome[i] = initialBiome(regions, i, sea);
  }
}

/** Biome de genèse : sert uniquement à colorer la planète avant le premier tick. */
function initialBiome(regions, i, sea) {
  if (regions.ice[i] > 0.45) return BIOME_INDEX.ice_sheet;
  if (regions.geothermal[i] > 0.55) return BIOME_INDEX.volcanic;
  if (regions.elevation[i] > 0.62) return BIOME_INDEX.highland;
  if (regions.elevation[i] < sea) return BIOME_INDEX.barren;
  return BIOME_INDEX.barren;
}

/* ------------------------------------------------------------------ */
/*  Site d'atterrissage                                                */
/* ------------------------------------------------------------------ */

/**
 * Le site de départ conditionne toute la partie : il doit être émergé, hors
 * des calottes polaires, et minéralisé — sinon le joueur est bloqué dès le
 * premier bâtiment.
 */
function chooseLandingSite(regions, rng, n) {
  let best = -1, bestScore = -Infinity;
  const sea = regions.seaLevel;

  for (let pass = 0; pass < 2 && best < 0; pass++) {
    // Passe 2 = critères relâchés, filet de sécurité pour les seeds extrêmes.
    const maxLat = pass === 0 ? 0.55 : 0.80;
    const minMin = pass === 0 ? 0.30 : 0.05;
    const maxIce = pass === 0 ? 0.45 : 0.85;
    bestScore = -Infinity;

    for (let i = 0; i < n; i++) {
      if (regions.elevation[i] <= sea + 0.02 || regions.elevation[i] > 0.72) continue;
      if (Math.abs(regions.latitude[i]) > maxLat) continue;
      if (regions.minerals[i] < minMin) continue;
      if (regions.iceInit[i] > maxIce) continue;
      const score = regions.minerals[i] * 1.3
        + regions.fertilityBase[i] * 0.7
        + regions.geothermal[i] * 0.5
        + regions.iceInit[i] * 0.4
        - Math.abs(regions.latitude[i]) * 0.5
        - regions.radiation[i] * 0.4
        + rng.next() * 0.25;
      if (score > bestScore) { bestScore = score; best = i; }
    }
  }
  if (best < 0) best = 0;

  regions.landingSite = best;

  /* Révélation initiale : parcours en largeur depuis le site, pour que les
     régions découvertes forment une tache contiguë et non un semis aléatoire. */
  const budget = Math.max(1, Math.min(n, BALANCE.planet.initialDiscovered | 0));
  const queue = new Int32Array(n);
  let head = 0, tail = 0, revealed = 0;
  queue[tail++] = best;
  regions.discovered[best] = 1;
  revealed++;
  while (head < tail && revealed < budget) {
    const i = queue[head++];
    const a = regions.neighborOffsets[i], b = regions.neighborOffsets[i + 1];
    for (let k = a; k < b && revealed < budget; k++) {
      const j = regions._neighbors[k];
      if (regions.discovered[j]) continue;
      regions.discovered[j] = 1;
      revealed++;
      queue[tail++] = j;
    }
  }
}

export default generatePlanet;

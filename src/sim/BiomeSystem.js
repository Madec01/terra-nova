/**
 * BiomeSystem — biosphère, pollution, classification des biomes,
 * habitabilité et potentiel énergétique.
 *
 * Modèle de croissance : une « qualité de station » (0..1) est calculée par
 * région à partir d'une cloche de température, de l'humidité, de la pression,
 * de la fertilité du sol et de la pollution. La végétation suit alors une
 * logistique :
 *
 *   dv/dt = croissance * q * v * (1 - v)  -  dépérissement * (1 - q) * v
 *
 * Conséquence voulue : la vie ne peut PAS apparaître spontanément (v = 0 est
 * un point fixe), il faut l'introduire (bio-dôme, ensemenceur) ; et elle ne
 * se maintient que si la station est réellement bonne (q ≳ 0,55 avec les
 * valeurs de BALANCE). C'est ce qui donne du sens à la terraformation.
 */
import { BALANCE } from '../data/balance.js';
import { BIOME_INDEX } from '../data/biomes.js';
import { clamp, clamp01, bell, smoothstep } from '../utils/math.js';

/* Seuils de CLASSIFICATION (purement descriptifs : ils choisissent une
   couleur/étiquette, ils ne pilotent aucun coût de gameplay et n'existent donc
   pas dans BALANCE). Les seuils de végétation sont dérivés du seuil
   d'essaimage pour rester cohérents avec l'équilibrage. */
const T = {
  oceanWater: 0.5,        // fraction de la capacité de bassin → « eau libre »
  thickIce: 0.45,         // glace au-delà de laquelle la région est une calotte
  highlandElev: 0.55,     // altitude relative (au-dessus du niveau de mer)
  volcanicGeo: 0.62,      // géothermie « intense »
  wetMoisture: 0.55,
  jungleVeg: 0.75,
  forestVeg: 0.5,
  steppeFactor: 0.4,   // fraction du seuil d'essaimage → steppe
  wetlandMoisture: 0.75,
  dryMoisture: 0.25,
  /** Pondération de l'habitabilité par les nuisances locales. */
  habPollution: 0.6,
  habRadiation: 0.45,
  /** Potentiel énergétique : part solaire vs géothermique. */
  energySolar: 0.7,
  energyGeo: 0.55,
  /** Pénalité polaire du solaire (même forme que le champ solaire). */
  energyLatitude: 0.65,
};

export class BiomeSystem {
  constructor(game) {
    this.game = game;
    this._count = -1;
    this._spread = null;     // apport d'essaimage du tick (tampon réutilisé)
    this._prevBiomass = 0;
  }

  reset(ctx) {
    this._alloc(ctx.regions);
    this._prevBiomass = ctx.state.globals.biomass;
  }

  _alloc(regions) {
    if (!regions || regions.count === this._count) return;
    this._count = regions.count;
    this._spread = new Float32Array(regions.count);
  }

  tick(ctx) {
    const { state, regions, dt, tech } = ctx;
    if (!regions) return;
    this._alloc(regions);

    const B = BALANCE.biosphere;
    const P = BALANCE.pollution;
    const G = state.globals;
    const seaLevel = BALANCE.planet.seaLevel;
    const basin = BALANCE.water.basinDepth;
    const count = regions.count;
    const spread = this._spread;
    spread.fill(0);

    // Facteurs planétaires, identiques pour toutes les régions.
    const presF = G.pressure >= B.minPressure
      ? clamp01((G.pressure - B.minPressure) / B.minPressure) : 0;
    const growth = B.growthRate * tech.growthMultiplier;
    const spreadRate = B.spreadRate * tech.spreadMultiplier;
    const habW = BALANCE.habitability;
    const habPress = smoothstep(habW.minPressure, habW.idealPressure, G.pressure);
    const habOxy = smoothstep(habW.minOxygen, habW.idealOxygen, G.oxygen);
    const habStab = clamp01(G.stability / BALANCE.stability.max);
    const cloudClear = 1 - Math.min(0.45, G.cloudCover || 0) * 0.9;

    let vegSum = 0, landArea = 0, habSum = 0, areaSum = 0;

    for (let i = 0; i < count; i++) {
      const area = regions.area[i];
      areaSum += area;
      const temp = regions.temperature[i];
      const ice = regions.ice[i];
      const water = clamp01(regions.water[i] / basin);
      const moist = regions.moisture[i];
      const isOcean = water >= T.oceanWater;
      const isIce = ice >= T.thickIce;
      const isLand = !isOcean;

      /* --- Pollution : dissipation exponentielle + épuration végétale ---- */
      let poll = regions.pollution[i];
      if (dt > 0 && poll > 0) {
        const rate = P.decay + P.vegetationScrub * regions.vegetation[i];
        poll = clamp01(poll * Math.max(0, 1 - rate * dt));
        regions.pollution[i] = poll;
      }

      /* --- Croissance / dépérissement de la végétation ------------------- */
      let veg = regions.vegetation[i];
      // Ni sur l'eau libre, ni sur la glace épaisse.
      if (isOcean || isIce) {
        if (dt > 0 && veg > 0) veg = Math.max(0, veg - B.decayRate * dt);
      } else if (dt > 0) {
        const tempF = bell(temp, B.idealTemp, B.tempTolerance);
        const moistF = clamp01((moist - B.minMoisture) / Math.max(B.minMoisture, 1e-6));
        const fert = regions.fertilityBase ? regions.fertilityBase[i] : 1;
        const pollF = clamp01(1 - poll * B.pollutionPenalty);
        const q = clamp01(tempF * moistF * presF * fert * pollF);

        const grow = growth * q * veg * (1 - veg);
        const decay = B.decayRate * (1 - q) * veg;
        veg = clamp01(veg + (grow - decay) * dt);

        // Essaimage vers les voisins au-delà du seuil.
        if (veg > B.spreadThreshold) {
          const strength = (veg - B.spreadThreshold) / (1 - B.spreadThreshold);
          const amount = spreadRate * strength * dt;
          const neigh = regions.neighbors(i);
          for (let j = 0; j < neigh.length; j++) spread[neigh[j]] += amount;
        }
      }
      regions.vegetation[i] = veg;

      if (isLand) { vegSum += veg * area; landArea += area; }
    }

    /* --- Application de l'essaimage (après coup, pour rester symétrique) - */
    if (dt > 0) {
      for (let i = 0; i < count; i++) {
        const s = spread[i];
        if (s <= 0) continue;
        const water = clamp01(regions.water[i] / basin);
        if (water >= T.oceanWater || regions.ice[i] >= T.thickIce) continue;
        const before = regions.vegetation[i];
        const after = clamp01(before + s);
        regions.vegetation[i] = after;
        if (before < 1) { vegSum += (after - before) * regions.area[i]; }
      }
    }

    /* --- Biomasse globale et choc d'introduction ------------------------- */
    const biomass = landArea > 0 ? clamp(vegSum / landArea * B.globalScale, 0, B.globalScale) : 0;
    const prev = this._prevBiomass;
    G.biomass = biomass;

    if (dt > 0) {
      const ratePerYear = (biomass - prev) / dt * 365;
      if (ratePerYear > B.shockThreshold) {
        // Une biosphère implantée trop vite déséquilibre les cycles.
        const excess = clamp01((ratePerYear - B.shockThreshold) / B.shockThreshold);
        G.stability = clamp(G.stability - B.shockStability * excess * dt / 365,
          BALANCE.stability.min, BALANCE.stability.max);
      }
      this._prevBiomass = biomass;
    }

    /* --- Classification, habitabilité, potentiel énergétique ------------- */
    for (let i = 0; i < count; i++) {
      const temp = regions.temperature[i];
      const ice = regions.ice[i];
      const water = clamp01(regions.water[i] / basin);
      const moist = regions.moisture[i];
      const veg = regions.vegetation[i];
      const elev = regions.elevation[i] - seaLevel;
      const geo = regions.geothermal ? regions.geothermal[i] : 0;

      /* Biome */
      let biome;
      if (water >= T.oceanWater) biome = BIOME_INDEX.ocean;
      else if (ice >= T.thickIce) biome = BIOME_INDEX.ice_sheet;
      else if (elev >= T.highlandElev) biome = BIOME_INDEX.highland;
      else if (geo >= T.volcanicGeo && temp > BALANCE.water.meltPoint) biome = BIOME_INDEX.volcanic;
      else if (veg >= T.jungleVeg && moist >= T.wetMoisture && temp >= B.idealTemp) biome = BIOME_INDEX.jungle;
      else if (veg >= T.forestVeg) biome = BIOME_INDEX.forest;
      else if (veg >= B.spreadThreshold) biome = BIOME_INDEX.grassland;
      else if (veg >= B.spreadThreshold * T.steppeFactor) biome = BIOME_INDEX.steppe;
      else if (moist >= T.wetlandMoisture && water > 0) biome = BIOME_INDEX.wetland;
      else if (temp >= B.idealTemp && moist < T.dryMoisture) biome = BIOME_INDEX.desert;
      else if (temp < BALANCE.water.meltPoint) biome = BIOME_INDEX.tundra;
      else biome = BIOME_INDEX.barren;
      regions.biome[i] = biome;

      /* Habitabilité composite (0..1).
         MOYENNE GÉOMÉTRIQUE pondérée et non somme pondérée : température,
         pression et oxygène sont des nécessités qui ne se compensent pas
         entre elles. Avec une somme, une région à −42 °C atteignait encore
         0,54 grâce aux autres facteurs et autorisait une colonie sur la
         banquise ; ici, un seul facteur proche de zéro annule le tout.
         `1e-4` évite log(0) tout en gardant l'annulation effective. */
      const w = habW.weights;
      const tempF = bell(temp, habW.idealTemp, habW.tempTolerance);
      const waterF = clamp01(water + moist);
      const gm = (v, weight) => weight * Math.log(Math.max(v, 1e-4));
      let hab = Math.exp(
        gm(tempF, w.temperature) + gm(habPress, w.pressure) + gm(habOxy, w.oxygen)
        + gm(waterF, w.water) + gm(habStab, w.stability));
      hab *= clamp01(1 - regions.pollution[i] * T.habPollution
        - (regions.radiation ? regions.radiation[i] : 0) * T.habRadiation);
      hab = clamp01(hab);
      regions.habitability[i] = hab;
      habSum += hab * regions.area[i];

      /* Potentiel énergétique : solaire (latitude, nuages, miroirs) + géothermie */
      const lat = 1 - Math.abs(regions.latitude[i]) * T.energyLatitude;
      const solar = clamp01(lat * cloudClear * G.insolation);
      regions.energyPotential[i] = clamp01(solar * T.energySolar + geo * T.energyGeo);
    }

    G.habitability = areaSum > 0 ? habSum / areaSum : 0;
  }
}

export default BiomeSystem;

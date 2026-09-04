/**
 * BuildingSystem — production, consommation et effets locaux des bâtiments.
 *
 * Premier système du pipeline : il ne fait que REMPLIR l'accumulateur du tick
 * (`acc`) et appliquer les effets qui touchent directement les régions
 * (pollution, chaleur, végétation, humidité, glace). Aucun autre système ne
 * lit `state.buildings` pour produire des ressources.
 *
 * Choix de modèle :
 *  - la satisfaction énergétique du tick PRÉCÉDENT module la production
 *    (une usine sous-alimentée tourne au ralenti) mais JAMAIS la production
 *    d'énergie elle-même : sinon une pénurie s'auto-entretient (spirale de la
 *    mort) et le joueur ne peut plus jamais s'en sortir ;
 *  - la stabilité climatique basse ampute la production (BALANCE.stability) ;
 *  - la chaleur locale des bâtiments est déposée dans un tampon partagé
 *    (`acc.localHeat`) que le ClimateSystem lit pour les températures
 *    régionales : on évite ainsi de modifier directement les températures ici.
 *
 * DEUX CANAUX D'EFFETS PLANÉTAIRES, à ne pas confondre :
 *  - `def.global`       = un TAUX. La valeur est multipliée par `dt` et
 *    s'ACCUMULE dans l'état du monde (kPa de gaz ajoutés par jour, points de
 *    stabilité par jour…). Démonter le bâtiment arrête l'apport mais ne
 *    reprend pas ce qui a déjà été versé.
 *  - `def.globalStatic` = un NIVEAU. La valeur est simplement SOMMÉE sur les
 *    bâtiments ACTIFS, sans `dt`, et déposée dans `acc.staticGlobal`. L'état
 *    du monde est recalculé de zéro à chaque tick à partir de cette somme :
 *    démonter le bâtiment annule immédiatement son effet.
 *    C'est ce qui rend les miroirs orbitaux réversibles — sans ce canal, huit
 *    miroirs finissaient par verrouiller la planète à +80 °C.
 */
import { BALANCE } from '../data/balance.js';
import { BUILDINGS } from '../data/buildings.js';
import { clamp01 } from '../utils/math.js';

export class BuildingSystem {
  constructor(game) {
    this.game = game;

    /** Vue légère d'une région, RÉUTILISÉE pour tous les appels à outputScale. */
    this._view = {
      id: 0, latitude: 0, elevation: 0, area: 1,
      minerals: 0, geothermal: 0, ice: 0, radiation: 0, anomaly: 0,
      fertility: 0, temperature: 0, moisture: 0, water: 0,
      vegetation: 0, pollution: 0, habitability: 0, population: 0,
      biome: 0, discovered: 1, buildingCount: 0,
    };

    /** Tampons dimensionnés sur le nombre de régions (alloués une seule fois). */
    this._mines = null;      // nombre de mines par région (bonus de raffinerie)
    this._heat = null;       // chaleur locale déposée par les bâtiments (°C)
    this._count = -1;

    /** Lignes de contribution énergétique, agrégées PAR TYPE de bâtiment. */
    this._rows = new Map();
  }

  reset(ctx) {
    this._alloc(ctx.regions);
    this._rows.clear();
  }

  _alloc(regions) {
    if (!regions || regions.count === this._count) return;
    this._count = regions.count;
    this._mines = new Int32Array(regions.count);
    this._heat = new Float32Array(regions.count);
  }

  /** Remplit la vue réutilisable avec la région `i`. */
  _fill(regions, i) {
    const v = this._view;
    v.id = i;
    v.latitude = regions.latitude[i];
    v.elevation = regions.elevation[i];
    v.area = regions.area[i];
    v.minerals = regions.minerals[i];
    v.geothermal = regions.geothermal[i];
    v.ice = regions.ice[i];
    v.radiation = regions.radiation[i];
    v.anomaly = regions.anomaly[i];
    v.fertility = regions.fertilityBase ? regions.fertilityBase[i] : 0;
    v.temperature = regions.temperature[i];
    v.moisture = regions.moisture[i];
    v.water = regions.water[i];
    v.vegetation = regions.vegetation[i];
    v.pollution = regions.pollution[i];
    v.habitability = regions.habitability[i];
    v.population = regions.population[i];
    v.biome = regions.biome[i];
    v.discovered = regions.discovered[i];
    v.buildingCount = regions.buildingCount[i];
    return v;
  }

  tick(ctx) {
    const { state, regions, acc, dt, tech } = ctx;
    if (!regions) return;
    this._alloc(regions);

    const heat = this._heat;
    heat.fill(0);
    acc.localHeat = heat;   // canal partagé avec le ClimateSystem

    /* Canal « niveau » : créé à la demande (l'accumulateur de Game ne le
       connaît pas) puis remis à zéro à chaque tick. BuildingSystem étant le
       premier système du pipeline, il est toujours à jour pour les suivants. */
    const staticGlobal = acc.staticGlobal || (acc.staticGlobal = { insolation: 0 });
    for (const key in staticGlobal) staticGlobal[key] = 0;

    const buildings = state.buildings;
    const mines = this._mines;
    mines.fill(0);

    /* --- Passe 1 : temps d'arrêt et recensement des mines ---------------- */
    for (let k = 0; k < buildings.length; k++) {
      const b = buildings[k];
      if (b.downtime > 0) {
        // dt === 0 (initialisation) ne doit pas faire avancer le temps.
        b.downtime = Math.max(0, b.downtime - dt);
      }
      b.active = b.downtime <= 0;
      if (b.active && b.type === 'mine') mines[b.region]++;
    }

    /* --- Facteurs globaux ------------------------------------------------ */
    // Satisfaction énergétique du tick précédent : une usine mal alimentée
    // tourne au ralenti.
    const sat = clamp01(state.power.satisfaction ?? 1);
    // Une planète instable désorganise la logistique.
    const stabLack = 1 - clamp01((state.globals.stability ?? 0) / BALANCE.stability.max);
    const stabFactor = Math.max(0, 1 - BALANCE.stability.productionPenalty * stabLack);
    const globalMul = tech.globalEffectMultiplier;

    /* --- Passe 2 : production, consommation, effets ---------------------- */
    for (let k = 0; k < buildings.length; k++) {
      const b = buildings[k];
      const def = BUILDINGS[b.type];
      if (!def) continue;

      // Un bâtiment en panne ne consomme ni ne produit, mais reste listé.
      if (!b.active) continue;

      const region = b.region;
      const view = this._fill(regions, region);
      let scale = 1;
      if (def.outputScale) {
        const s = def.outputScale(view, state);
        scale = Number.isFinite(s) ? Math.max(0, s) : 1;
      }
      const level = b.level || 1;
      const eff = scale * level;

      /* Consommation (demande brute : c'est elle qui crée la pénurie). */
      const upkeep = def.upkeep;
      if (upkeep) {
        for (const key in upkeep) acc.consume[key] += upkeep[key];
      }

      /* Production. */
      const produces = def.produces;
      if (produces) {
        for (const key in produces) {
          const base = produces[key];
          if (!base) continue;
          const mul = tech.productionMultiplier[key] ?? 1;
          // L'énergie n'est pas modulée par la satisfaction énergétique.
          const powerMul = key === 'energy' ? 1 : sat;
          acc.produce[key] += base * eff * mul * stabFactor * powerMul;
        }
      }

      /* Bonus de voisinage (raffinerie : +matériaux par mine proche). */
      const nb = def.neighborBonus;
      if (nb) {
        let n = mines[region];
        const neigh = regions.neighbors(region);
        for (let j = 0; j < neigh.length; j++) n += mines[neigh[j]];
        if (n > 0) {
          const mul = tech.productionMultiplier[nb.resource] ?? 1;
          acc.produce[nb.resource] += nb.factor * n * mul * stabFactor * sat;
        }
      }

      /* Effets planétaires « taux » (kPa/jour de gaz, points de stabilité/jour). */
      const glob = def.global;
      if (glob) {
        for (const key in glob) {
          if (acc.global[key] === undefined) continue;
          acc.global[key] += glob[key] * eff * globalMul * sat;
        }
      }

      /* Effets planétaires « niveau » : somme brute sur les bâtiments actifs.
         Ni `dt` (ce n'est pas un taux) ni `sat` (un miroir orbital réfléchit
         la lumière qu'il ait ou non du courant — seule la panne, gérée par
         `b.active` plus haut, le retire du total). Le multiplicateur
         technologique est appliqué par le système consommateur. */
      const globStatic = def.globalStatic;
      if (globStatic) {
        for (const key in globStatic) {
          if (staticGlobal[key] === undefined) staticGlobal[key] = 0;
          staticGlobal[key] += globStatic[key] * (b.level || 1);
        }
      }

      /* Stockage et amortissement climatique. */
      if (def.storage) {
        const per = BALANCE.storage.perDepot;
        acc.capacity.energy += per.energy;
        acc.capacity.materials += per.materials;
        acc.capacity.water += per.water;
      }
      if (def.dampening) acc.dampening += def.dampening;

      /* Effets locaux sur la région. */
      const local = def.local;
      if (local) {
        if (local.heat) heat[region] += local.heat * eff * sat;
        if (dt > 0) {
          const d = dt * sat;
          if (local.pollution) regions.pollution[region] = clamp01(regions.pollution[region] + local.pollution * d);
          if (local.vegetation) regions.vegetation[region] = clamp01(regions.vegetation[region] + local.vegetation * d * tech.growthMultiplier);
          if (local.moisture) regions.moisture[region] = clamp01(regions.moisture[region] + local.moisture * d);
          if (local.water) regions.water[region] = clamp01(regions.water[region] + local.water * d);
          if (local.ice) regions.ice[region] = clamp01(regions.ice[region] + local.ice * d);
        }
      }

      /* Essaimage (tour d'ensemencement) vers les voisins. */
      const spread = def.spread;
      if (spread && dt > 0 && spread.vegetation) {
        const neigh = regions.neighbors(region);
        const amount = spread.vegetation * dt * sat * tech.spreadMultiplier;
        for (let j = 0; j < neigh.length; j++) {
          const n = neigh[j];
          regions.vegetation[n] = clamp01(regions.vegetation[n] + amount);
        }
      }

      /* Bilan énergétique agrégé par type (infobulle « d'où vient l'énergie »). */
      const netEnergy = ((produces && produces.energy) ? produces.energy * eff * (tech.productionMultiplier.energy ?? 1) * stabFactor : 0)
        - ((upkeep && upkeep.energy) ? upkeep.energy : 0);
      if (netEnergy !== 0) {
        let row = this._rows.get(b.type);
        if (!row) { row = { label: def.name, value: 0, used: false }; this._rows.set(b.type, row); }
        if (!row.used) { row.used = true; row.value = 0; acc.contributions.energy.push(row); }
        row.value += netEnergy;
      }
    }

    // On réarme les lignes pour le prochain tick (les objets sont réutilisés).
    for (const row of this._rows.values()) row.used = false;
  }
}

export default BuildingSystem;

/**
 * PopulationSystem — démographie des colonies.
 *
 * Croissance logistique classique, mais la capacité d'accueil dépend de
 * l'habitabilité LOCALE : une colonie posée sur une région à peine viable
 * plafonne très vite. La famine (plus d'eau ou plus de vivres) inverse
 * immédiatement la courbe.
 *
 * Ce système s'exécute APRÈS ResourceSystem : ses consommations sont donc
 * déposées dans `acc` (pour l'affichage) ET dans le canal différé
 * `acc.deferred` que ResourceSystem consommera au tick suivant. Un jour de
 * latence, aucun double comptage.
 */
import { BALANCE } from '../data/balance.js';
import { BUILDINGS } from '../data/buildings.js';
import { clamp, clamp01 } from '../utils/math.js';
import { ResourceSystem } from './ResourceSystem.js';

/** Fréquence maximale des alertes de famine (jours). */
const FAMINE_COOLDOWN_DAYS = 180;

export class PopulationSystem {
  constructor(game) {
    this.game = game;
    this._lastFamine = -Infinity;
  }

  reset() { this._lastFamine = -Infinity; }

  tick(ctx) {
    const { state, regions, acc, dt, bus } = ctx;
    if (!regions) return;
    const C = BALANCE.colony;

    // Remise à zéro des populations régionales (une colonie peut disparaître).
    for (let i = 0; i < regions.count; i++) regions.population[i] = 0;

    const buildings = state.buildings;
    let total = 0;
    let famine = false;

    // Manque-t-il des vivres ? ResourceSystem a déjà écrêté à zéro ce tick.
    const noWater = state.resources.water <= 0;
    const noFood = state.resources.biomass <= 0;

    for (let k = 0; k < buildings.length; k++) {
      const b = buildings[k];
      if (b.region == null || b.region < 0 || b.region >= regions.count) continue;
      const def = BUILDINGS[b.type];
      if (!def || !def.colony) continue;

      if (b.population == null) b.population = C.seedPopulation;
      let pop = Math.max(0, b.population);
      const hab = clamp01(regions.habitability[b.region]);

      if (b.active !== false && dt > 0) {
        const capacity = Math.max(1, C.capacityPerColony * hab);
        if (noWater || noFood) {
          // Famine : la population décroît tant que les vivres manquent.
          pop -= pop * C.starvationRate * dt;
          famine = true;
        } else {
          // Tant que la région reste viable, la noria de transport maintient
          // au moins l'effectif de fondation : une colonie vidée par une
          // famine peut donc repartir (pop = 0 serait un état absorbant).
          if (hab >= BALANCE.colony.minHabitability && pop < C.seedPopulation) {
            pop = C.seedPopulation;
          }
          // Croissance logistique modulée par l'habitabilité.
          pop += C.growthRate * hab * pop * (1 - pop / capacity) * dt;
        }
        pop = clamp(pop, 0, C.capacityPerColony);
      }
      b.population = pop;
      regions.population[b.region] += pop;
      total += pop;

      /* --- Flux de la colonie (par jour) -------------------------------- */
      const k1 = pop / 1000;
      const up = C.upkeepPer1k, out = C.outputPer1k;
      for (const key in up) {
        acc.consume[key] += up[key] * k1;
        ResourceSystem.defer(acc, 'consume', key, up[key] * k1);
      }
      for (const key in out) {
        acc.produce[key] += out[key] * k1;
        ResourceSystem.defer(acc, 'produce', key, out[key] * k1);
      }
    }

    state.globals.population = total;

    if (famine && dt > 0 && total > 0) {
      const day = state.time.day;
      if (day - this._lastFamine >= FAMINE_COOLDOWN_DAYS) {
        this._lastFamine = day;
        bus.emit('notify', {
          text: 'Famine dans les colonies : les réserves d’eau ou de vivres sont épuisées.',
          kind: 'danger', icon: '⌂',
        });
      }
    }
  }
}

export default PopulationSystem;

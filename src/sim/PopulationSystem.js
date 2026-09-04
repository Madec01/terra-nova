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

    // Les stocks planétaires sont-ils à sec ? ResourceSystem a déjà écrêté à
    // zéro ce tick. ATTENTION : un stock vide ne suffit PAS à affamer une
    // colonie — encore faut-il qu'elle en dépende (voir plus bas).
    const dryStock = state.resources.water <= 0;
    const emptyStock = state.resources.biomass <= 0;

    for (let k = 0; k < buildings.length; k++) {
      const b = buildings[k];
      if (b.region == null || b.region < 0 || b.region >= regions.count) continue;
      const def = BUILDINGS[b.type];
      if (!def || !def.colony) continue;

      if (b.population == null) b.population = C.seedPopulation;
      let pop = Math.max(0, b.population);
      const hab = clamp01(regions.habitability[b.region]);

      /* --- Autosuffisance de CETTE colonie -------------------------------
         Une colonie posée sur une région verte et humide se nourrit et
         s'abreuve sur place ; elle ne dépend des stocks planétaires que pour
         le RELIQUAT. C'est décisif : auparavant, un stock d'eau planétaire à
         sec (asséché par les bio-dômes et les ensemenceurs) affamait TOUTES
         les colonies, même celles installées au bord d'un lac. */
      const veg = clamp01(regions.vegetation[b.region]);
      const localWater = clamp01(regions.water[b.region] / BALANCE.water.basinDepth
        + regions.moisture[b.region]);
      const waterRelief = clamp01(localWater * C.localWaterRelief);
      const foodRelief = clamp01(veg * (C.farmPer1k.biomass / C.upkeepPer1k.biomass));

      /* PÉNURIE PROPORTIONNELLE, et non tout-ou-rien. L'ancienne règle
         (« stock vide → on perd 0,8 % par jour ») était un couperet : une
         colonie couvrant 98 % de ses besoins sur place s'éteignait exactement
         comme une colonie qui n'en couvrait aucun. On mesure donc le
         MANQUE réel, et la démographie y répond continûment :
         la pénurie freine la croissance ET ronge l'effectif au prorata. */
      const shortage = clamp01(Math.max(
        dryStock ? 1 - waterRelief : 0,
        emptyStock ? 1 - foodRelief : 0));

      if (b.active !== false && dt > 0) {
        const capacity = Math.max(1, C.capacityPerColony * hab);
        if (shortage > 0) {
          pop -= pop * C.starvationRate * shortage * dt;
          // On n'alerte le joueur que pour une disette réelle, pas pour un
          // appoint marginal apporté par les stocks.
          if (shortage > 0.25) famine = true;
        } else if (hab >= BALANCE.colony.minHabitability && pop < C.seedPopulation) {
          // Tant que la région reste viable ET approvisionnée, la noria de
          // transport maintient au moins l'effectif de fondation : une colonie
          // vidée par une famine peut repartir (pop = 0 serait absorbant).
          pop = C.seedPopulation;
        }
        // Croissance logistique, amortie par la pénurie.
        pop += C.growthRate * hab * pop * (1 - pop / capacity) * (1 - shortage) * dt;
        pop = clamp(pop, 0, C.capacityPerColony);
      }
      b.population = pop;
      regions.population[b.region] += pop;
      total += pop;

      /* --- Flux de la colonie (par jour) --------------------------------
         AUTOSUFFISANCE LOCALE. Une colonie exploite d'abord sa région :
          - elle cultive ses vivres au prorata de la végétation locale
            (`BALANCE.colony.farmPer1k`) ;
          - elle puise son eau dans les lacs et l'humidité du sol
            (`BALANCE.colony.localWaterRelief`).
         Sans cela, chaque millier d'habitants supplémentaire ponctionnait les
         stocks planétaires sans rien y remettre : la famine était structurelle
         et la population finissait toujours par s'éteindre. */
      const k1 = pop / 1000;
      const up = C.upkeepPer1k, out = C.outputPer1k;

      for (const key in up) {
        let need = up[key] * k1;
        if (key === 'water') need *= (1 - waterRelief);
        if (need <= 0) continue;
        acc.consume[key] += need;
        ResourceSystem.defer(acc, 'consume', key, need);
      }
      for (const key in out) {
        acc.produce[key] += out[key] * k1;
        ResourceSystem.defer(acc, 'produce', key, out[key] * k1);
      }
      // Agriculture locale : seule la végétation de la région la porte.
      const farm = C.farmPer1k;
      if (farm && veg > 0) {
        for (const key in farm) {
          const grown = farm[key] * k1 * veg;
          if (grown <= 0) continue;
          acc.produce[key] += grown;
          ResourceSystem.defer(acc, 'produce', key, grown);
        }
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

/**
 * ResourceSystem — bilan énergétique et application des flux de ressources.
 *
 * Ordre du pipeline oblige : les systèmes qui s'exécutent APRÈS celui-ci
 * (Population, Recherche) ne peuvent pas alimenter `acc` à temps. Ils déposent
 * donc leurs taux dans `acc.deferred`, que l'on consomme ici au tick suivant
 * (un jour de latence, invisible pour le joueur, et surtout aucun double
 * comptage).
 *
 * Modèle énergétique : la satisfaction est le ratio entre l'offre (production
 * du jour + batteries) et la demande. Elle est lissée pour éviter le
 * clignotement de l'interface, et bornée par un plancher de « brownout » :
 * même en pénurie totale, les installations conservent un minimum de
 * fonctionnement (BALANCE.power.brownoutFloor).
 */
import { BALANCE } from '../data/balance.js';
import { clamp } from '../utils/math.js';

/** Fréquence maximale des avertissements de pénurie (jours). */
const SHORTAGE_COOLDOWN_DAYS = 200;
/** Émission de `resources:changed` (jours de simulation). */
const CHANGE_EVERY_DAYS = 10;
/** Seuil sous lequel on considère qu'il y a réellement pénurie. */
const SHORTAGE_RATIO = 0.98;

export class ResourceSystem {
  constructor(game) {
    this.game = game;
    this._lastShortage = -Infinity;
    this._sinceChange = 0;
    this._keys = ['energy', 'materials', 'science', 'biomass', 'water'];
  }

  reset(ctx) {
    this._lastShortage = -Infinity;
    this._sinceChange = 0;
    // L'accumulateur de Game est réutilisé d'une partie à l'autre : on purge
    // le canal différé pour ne pas hériter des flux de la partie précédente.
    const acc = ctx && ctx.acc;
    if (acc && acc.deferred) {
      for (const k in acc.deferred.produce) acc.deferred.produce[k] = 0;
      for (const k in acc.deferred.consume) acc.deferred.consume[k] = 0;
    }
  }

  tick(ctx) {
    const { state, acc, dt, tech, bus } = ctx;
    const res = state.resources;

    /* --- Report des systèmes en aval (colonies, science passive) --------- */
    const deferred = acc.deferred;
    const dProduce = deferred ? deferred.produce : null;
    const dConsume = deferred ? deferred.consume : null;

    // Le détail « d'où vient mon énergie » (rempli par BuildingSystem) est
    // recopié dans l'état pour que l'interface y ait accès.
    const energyRows = state.contributions.energy;
    energyRows.length = 0;
    const src = acc.contributions.energy;
    for (let i = 0; i < src.length; i++) energyRows.push(src[i]);

    /* --- Capacités de stockage ------------------------------------------ */
    const cap = state.capacity;
    cap.energy = (BALANCE.storage.energy + acc.capacity.energy) * tech.storageMultiplier.energy;
    cap.materials = (BALANCE.storage.materials + acc.capacity.materials) * tech.storageMultiplier.materials;
    cap.water = (BALANCE.storage.water + acc.capacity.water) * tech.storageMultiplier.water;

    /* --- Bilan électrique ------------------------------------------------ */
    const production = acc.produce.energy + (dProduce ? dProduce.energy : 0);
    const consumption = acc.consume.energy + (dConsume ? dConsume.energy : 0);
    state.power.production = production;
    state.power.consumption = consumption;

    // Les batteries comblent le déficit d'une journée.
    const stored = Math.max(0, res.energy);
    const supply = production + stored / Math.max(dt, 1);
    let target = consumption > 0 ? supply / consumption : 1;
    target = clamp(target, BALANCE.power.brownoutFloor, 1);

    if (dt > 0) {
      const s = state.power.satisfaction ?? 1;
      state.power.satisfaction = clamp(s + (target - s) * BALANCE.power.smoothing, BALANCE.power.brownoutFloor, 1);
    } else {
      // Tick d'initialisation : on veut la valeur dérivée immédiatement juste.
      state.power.satisfaction = target;
    }

    const ratio = consumption > 0 ? Math.min(1, supply / consumption) : 1;
    if (ratio < SHORTAGE_RATIO && dt > 0) {
      const day = state.time.day;
      if (day - this._lastShortage >= SHORTAGE_COOLDOWN_DAYS) {
        this._lastShortage = day;
        bus.emit('notify', {
          text: `Pénurie d'énergie : la production ne couvre que ${Math.round(ratio * 100)} % de la demande.`,
          kind: 'warn', icon: '⚡',
        });
      }
    }

    /* --- Application des flux -------------------------------------------- */
    const keys = this._keys;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const prod = acc.produce[key] + (dProduce ? dProduce[key] : 0);
      // Une consommation ne peut pas dépasser ce que le réseau a réellement
      // pu servir : la satisfaction module la consommation effective.
      const rawCons = acc.consume[key] + (dConsume ? dConsume[key] : 0);
      const cons = key === 'energy' ? rawCons * state.power.satisfaction : rawCons;
      const net = prod - cons;

      const before = res[key];
      let value = before + net * dt;
      let wasted = 0;

      if (value < 0) value = 0;                       // aucune ressource négative
      const limit = cap[key];
      if (limit != null && limit > 0 && value > limit) {
        wasted = (value - limit) / Math.max(dt, 1);   // surplus perdu (par jour)
        value = limit;
      }
      res[key] = value;

      // Flux affiché : le NET réellement encaissé, pour que « +2.4 /j » ne
      // mente pas quand les réservoirs sont pleins.
      state.flux[key] = dt > 0 ? (value - before) / dt : net;
      if (key === 'energy') state.power.wasted = wasted;
    }

    /* --- Notification de rafraîchissement, throttlée --------------------- */
    this._sinceChange += dt;
    if (this._sinceChange >= CHANGE_EVERY_DAYS || dt === 0) {
      this._sinceChange = 0;
      bus.emit('resources:changed', {});
    }

    /* --- Remise à zéro du canal différé --------------------------------- */
    // Les systèmes en aval le rempliront de nouveau pendant ce tick.
    if (deferred) {
      for (const key in deferred.produce) deferred.produce[key] = 0;
      for (const key in deferred.consume) deferred.consume[key] = 0;
    }
  }

  /**
   * Utilitaire partagé : dépose un taux (par jour) dans le canal différé.
   * Utilisé par PopulationSystem et ResearchSystem.
   */
  static defer(acc, kind, key, value) {
    let d = acc.deferred;
    if (!d) {
      d = acc.deferred = {
        produce: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
        consume: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
      };
    }
    d[kind][key] += value;
  }
}

export default ResourceSystem;

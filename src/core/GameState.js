/**
 * État de partie : objet simple, entièrement sérialisable.
 * Aucune méthode, aucune référence circulaire, aucun objet Three.js.
 */
import { BALANCE } from '../data/balance.js';

export const SAVE_VERSION = 1;

export function createInitialState({ seed, planetType = 'rocky' } = {}) {
  const g = BALANCE.start.globals;
  return {
    version: SAVE_VERSION,
    seed: seed >>> 0,
    planetType,
    createdAt: Date.now(),

    time: { day: 0, speed: 1 },

    resources: { ...BALANCE.start.resources },
    flux: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
    capacity: { energy: 0, materials: 0, water: 0 },
    power: { production: 0, consumption: 0, satisfaction: 1 },

    globals: {
      temperature: g.temperature,
      pressure: g.pressure,
      oxygen: g.oxygen,
      co2: g.co2,
      waterCoverage: g.waterCoverage,
      biomass: g.biomass,
      stability: g.stability,
      insolation: g.insolation,
      population: g.population,
      cloudCover: 0,
      iceCover: 0,
      habitability: 0,
      /** Dérivées annuelles, utilisées par l'UI et par le calcul de stabilité. */
      dTemperature: 0,
      dPressure: 0,
      dOxygen: 0,
      dBiomass: 0,
    },

    /** Journal explicatif : « pourquoi la température monte ? ». */
    contributions: {
      temperature: [], pressure: [], oxygen: [], stability: [], energy: [],
    },

    buildings: [],
    nextBuildingId: 1,

    tech: { unlocked: [], current: null, progress: 0 },

    explore: { probes: BALANCE.start.probes, scanning: [] },

    progress: { phase: 1, victory: false, victoryAt: null, sustained: 0, seenPhases: [1] },

    history: { day: [], temperature: [], pressure: [], oxygen: [], biomass: [], water: [] },

    log: [],
    stats: { built: 0, scanned: 0, events: 0, researched: 0 },
  };
}

/** Ajoute une entrée au journal de mission (borné). */
export function pushLog(state, text, kind = 'info', icon = '') {
  state.log.push({ day: Math.floor(state.time.day), text, kind, icon });
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
}

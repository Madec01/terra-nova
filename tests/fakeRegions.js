/**
 * Fabrique de RegionManager MINIMAL, conforme au contrat SoA de
 * docs/CONTRACTS.md, plus un banc d'essai qui rejoue exactement le pipeline de
 * Game (accumulateur + ordre des systèmes).
 *
 * But : tester la simulation sans dépendre de la génération de planète réelle
 * (travail de l'agent PLANÈTE) ni de Three.js.
 *
 * Topologie : une grille w × h enroulée en cylindre (voisinage à 4, wrap en
 * longitude, bords libres aux pôles). C'est suffisant pour tester diffusion,
 * ruissellement et essaimage.
 */
import { BALANCE } from '../src/data/balance.js';
import { EventBus } from '../src/core/EventBus.js';
import { createInitialState } from '../src/core/GameState.js';
import { computeTechEffects } from '../src/core/TechEffects.js';
import { Random } from '../src/utils/rng.js';
import { BUILDINGS } from '../src/data/buildings.js';

import { BuildingSystem } from '../src/sim/BuildingSystem.js';
import { ResourceSystem } from '../src/sim/ResourceSystem.js';
import { ClimateSystem } from '../src/sim/ClimateSystem.js';
import { BiomeSystem } from '../src/sim/BiomeSystem.js';
import { PopulationSystem } from '../src/sim/PopulationSystem.js';
import { ExplorationSystem } from '../src/sim/ExplorationSystem.js';
import { ResearchSystem } from '../src/sim/ResearchSystem.js';
import { EventSystem } from '../src/sim/EventSystem.js';
import { VictorySystem } from '../src/sim/VictorySystem.js';

/* ===================================================================== */
/*  RÉGIONS                                                              */
/* ===================================================================== */

export function makeFakeRegions({ w = 16, h = 8, seed = 7 } = {}) {
  const count = w * h;
  const rng = new Random(seed);

  // --- voisinage aplati (Int32Array + offsets), comme l'Icosphère réelle ---
  const list = [];
  const offsets = new Int32Array(count + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      offsets[i] = list.length;
      list.push(y * w + ((x + 1) % w));
      list.push(y * w + ((x - 1 + w) % w));
      if (y > 0) list.push((y - 1) * w + x);
      if (y < h - 1) list.push((y + 1) * w + x);
    }
  }
  offsets[count] = list.length;
  const flat = Int32Array.from(list);

  const R = {
    count,
    positions: new Float32Array(count * 3),
    latitude: new Float32Array(count),
    area: new Float32Array(count).fill(1),

    elevation: new Float32Array(count),
    minerals: new Float32Array(count),
    geothermal: new Float32Array(count),
    iceInit: new Float32Array(count),
    fertilityBase: new Float32Array(count),
    radiation: new Float32Array(count),
    anomaly: new Uint8Array(count),

    temperature: new Float32Array(count),
    moisture: new Float32Array(count),
    ice: new Float32Array(count),
    water: new Float32Array(count),
    vegetation: new Float32Array(count),
    pollution: new Float32Array(count),
    population: new Float32Array(count),
    biome: new Uint8Array(count),
    discovered: new Uint8Array(count),
    buildingCount: new Uint8Array(count),

    habitability: new Float32Array(count),
    energyPotential: new Float32Array(count),

    neighbors(i) { return flat.subarray(offsets[i], offsets[i + 1]); },
    cellCorners() { return new Float32Array(0); },
    getRegionView(i) {
      return {
        id: i, latitude: R.latitude[i], area: R.area[i], elevation: R.elevation[i],
        minerals: R.minerals[i], geothermal: R.geothermal[i], ice: R.ice[i],
        radiation: R.radiation[i], anomaly: R.anomaly[i], fertility: R.fertilityBase[i],
        temperature: R.temperature[i], moisture: R.moisture[i], water: R.water[i],
        vegetation: R.vegetation[i], pollution: R.pollution[i],
        habitability: R.habitability[i], population: R.population[i],
        biome: R.biome[i], discovered: R.discovered[i], buildingCount: R.buildingCount[i],
      };
    },
  };

  const seaLevel = BALANCE.planet.seaLevel;
  for (let y = 0; y < h; y++) {
    // -1 (pôle sud) .. 1 (pôle nord)
    const lat = h > 1 ? -1 + 2 * (y + 0.5) / h : 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      R.latitude[i] = lat;
      R.positions[i * 3 + 1] = lat;
      // Un tiers de bassins, deux tiers de terres.
      R.elevation[i] = (i % 3 === 0) ? seaLevel - 0.45 : seaLevel + 0.12;
      R.minerals[i] = 0.35 + rng.next() * 0.5;
      R.geothermal[i] = rng.next() * 0.5;
      R.fertilityBase[i] = 0.6 + rng.next() * 0.4;
      R.radiation[i] = rng.next() * 0.2;
      R.anomaly[i] = rng.next() < 0.05 ? 1 : 0;
      // Glace : abondante aux pôles.
      const ice = Math.min(1, 0.25 + Math.abs(lat) * 0.7);
      R.iceInit[i] = ice;
      R.ice[i] = ice;
      R.moisture[i] = 0.08;
      R.temperature[i] = BALANCE.start.globals.temperature;
      R.discovered[i] = 1;
    }
  }
  return R;
}

/* ===================================================================== */
/*  BANC D'ESSAI                                                         */
/* ===================================================================== */

/**
 * Reproduit fidèlement Game : même accumulateur, même ordre de systèmes.
 * @returns {{game, state, regions, ctx, run, addBuilding, systems, events}}
 */
export function createSimHarness(opts = {}) {
  const regions = opts.regions || makeFakeRegions(opts);
  const state = createInitialState({ seed: opts.seed ?? 7, planetType: 'rocky' });
  const bus = new EventBus();
  const rng = new Random(opts.seed ?? 7);

  const events = [];
  bus.on('notify', (p) => events.push({ type: 'notify', ...p }));
  bus.on('event:triggered', (p) => events.push({ type: 'event', ...p }));
  bus.on('victory', () => events.push({ type: 'victory' }));

  const game = {
    state, regions, bus, rng,
    dirty: new Set(), allDirty: false,
    markRegionDirty(id) { if (id == null) game.allDirty = true; else game.dirty.add(id); },
    markAllDirty() { game.allDirty = true; game.dirty.clear(); },
  };

  const systems = [
    new BuildingSystem(game), new ResourceSystem(game), new ClimateSystem(game),
    new BiomeSystem(game), new PopulationSystem(game), new ExplorationSystem(game),
    new ResearchSystem(game), new EventSystem(game), new VictorySystem(game),
  ];
  game.systems = systems;

  const acc = {
    produce: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
    consume: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
    global: { co2: 0, pressure: 0, oxygen: 0, temperature: 0, stability: 0, insolation: 0 },
    capacity: { energy: 0, materials: 0, water: 0 },
    dampening: 0,
    contributions: { energy: [] },
  };
  function resetAcc() {
    for (const k in acc.produce) acc.produce[k] = 0;
    for (const k in acc.consume) acc.consume[k] = 0;
    for (const k in acc.global) acc.global[k] = 0;
    for (const k in acc.capacity) acc.capacity[k] = 0;
    acc.dampening = 0;
    acc.contributions.energy.length = 0;
    return acc;
  }

  const ctx = {
    game, state, regions, bus, rng,
    dt: BALANCE.time.daysPerTick,
    tech: computeTechEffects(state.tech.unlocked),
    acc,
  };
  game.ctx = ctx;

  function refreshTech() { ctx.tech = computeTechEffects(state.tech.unlocked); }
  game.refreshTech = refreshTech;

  function runSystems(days) {
    ctx.dt = days;
    ctx.acc = resetAcc();
    for (const s of systems) s.tick(ctx);
  }

  if (opts.init) opts.init(regions, state);
  for (const s of systems) s.reset?.(ctx);
  runSystems(0);   // tick d'initialisation, exactement comme Game.newGame

  /** Fait avancer la simulation de `days` jours, un jour par tick. */
  function run(days, onTick) {
    const step = BALANCE.time.daysPerTick;
    for (let d = 0; d < days; d += step) {
      state.time.day += step;
      runSystems(step);
      if (onTick) onTick(state, d);
    }
  }

  /** Ajoute un bâtiment sans passer par les vérifications de Game.build. */
  function addBuilding(type, region, n = 1) {
    const def = BUILDINGS[type];
    for (let k = 0; k < n; k++) {
      state.buildings.push({
        id: state.nextBuildingId++, type, region, day: Math.floor(state.time.day),
        active: true, level: 1, downtime: 0,
        population: def && def.colony ? BALANCE.colony.seedPopulation : 0,
      });
      regions.buildingCount[region] = Math.min(255, regions.buildingCount[region] + 1);
    }
  }

  return { game, state, regions, ctx, systems, events, run, addBuilding, runSystems, refreshTech };
}

/** Vrai si toutes les valeurs de l'objet sont des nombres finis. */
export function allFinite(obj) {
  for (const k in obj) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isFinite(v)) return false;
  }
  return true;
}

export default { makeFakeRegions, createSimHarness, allFinite };

/**
 * Game — orchestrateur central.
 *
 * Responsabilités :
 *  - posséder l'état (`state`) et les régions (`regions`)
 *  - faire tourner la boucle de simulation à pas fixe
 *  - exposer une façade propre à l'interface (aucun système n'est appelé
 *    directement par l'UI)
 *
 * Ce fichier ne connaît NI Three.js NI le DOM.
 */
import { BALANCE } from '../data/balance.js';
import { BUILDINGS, BUILDING_LIST } from '../data/buildings.js';
import { TECHNOLOGIES } from '../data/technologies.js';
import { EventBus } from './EventBus.js';
import { TimeManager } from './TimeManager.js';
import { SaveManager } from './SaveManager.js';
import { createInitialState, pushLog } from './GameState.js';
import { computeTechEffects } from './TechEffects.js';
import { Random, randomSeed } from '../utils/rng.js';
import { clamp, clamp01 } from '../utils/math.js';

import { generatePlanet } from '../planet/PlanetGenerator.js';
import { RegionManager } from '../planet/RegionManager.js';

import { BuildingSystem } from '../sim/BuildingSystem.js';
import { ResourceSystem } from '../sim/ResourceSystem.js';
import { ClimateSystem } from '../sim/ClimateSystem.js';
import { BiomeSystem } from '../sim/BiomeSystem.js';
import { PopulationSystem } from '../sim/PopulationSystem.js';
import { ExplorationSystem } from '../sim/ExplorationSystem.js';
import { ResearchSystem } from '../sim/ResearchSystem.js';
import { EventSystem } from '../sim/EventSystem.js';
import { VictorySystem } from '../sim/VictorySystem.js';

export class Game {
  constructor() {
    this.bus = new EventBus();
    this.time = new TimeManager(this.bus);
    this.saves = new SaveManager(this);
    this.state = null;
    this.regions = null;
    this.selectedRegion = null;
    this.techEffects = computeTechEffects([]);
    this.rng = new Random(1);
    this.dirtyRegions = new Set();
    this.allDirty = false;
    this._daysSinceAutosave = 0;

    /** Contexte réutilisé chaque tick : zéro allocation en régime permanent. */
    this.ctx = {
      game: this, state: null, regions: null, bus: this.bus, rng: this.rng,
      dt: BALANCE.time.daysPerTick, tech: this.techEffects,
      acc: null,
    };

    this.systems = [
      new BuildingSystem(this),
      new ResourceSystem(this),
      new ClimateSystem(this),
      new BiomeSystem(this),
      new PopulationSystem(this),
      new ExplorationSystem(this),
      new ResearchSystem(this),
      new EventSystem(this),
      new VictorySystem(this),
    ];

    this.debug = this._makeDebugApi();
  }

  /* =================================================================== */
  /*  CYCLE DE VIE                                                       */
  /* =================================================================== */

  newGame({ seed = randomSeed(), planetType = 'rocky' } = {}) {
    this.state = createInitialState({ seed, planetType });
    this.regions = generatePlanet({
      seed, subdivisions: BALANCE.planet.subdivisions, planetType,
    });
    this.rng = new Random(seed ^ 0x5eed);
    this.ctx.rng = this.rng;
    this.selectedRegion = null;
    this._refreshTechEffects();
    this._bindContext();

    for (const s of this.systems) s.reset?.(this.ctx);

    // Un tick « à blanc » pour que tous les dérivés (biomes, habitabilité,
    // températures régionales) soient cohérents dès la première frame.
    this._runSystems(0);

    this.time.setSpeed(1);
    this.state.time.speed = 1;
    this.markAllDirty();
    pushLog(this.state, 'Sonde de commandement en orbite. Début de la mission.', 'info', '◉');
    this.bus.emit('game:new', { state: this.state });
    return this.state;
  }

  loadFromPayload(payload) {
    const ok = SaveManager.migrate(payload);
    if (!ok) return false;
    this.state = ok.state;
    // On regénère les propriétés statiques depuis la seed, puis on réapplique
    // les propriétés dynamiques sauvegardées.
    const generated = generatePlanet({
      seed: this.state.seed,
      subdivisions: ok.regions.subdivisions ?? BALANCE.planet.subdivisions,
      planetType: this.state.planetType,
    });
    this.regions = RegionManager.fromJSON(ok.regions, generated);
    this.rng = new Random(this.state.seed ^ 0x5eed);
    this.ctx.rng = this.rng;
    this.selectedRegion = null;
    this._refreshTechEffects();
    this._bindContext();
    for (const s of this.systems) s.reset?.(this.ctx);
    this._runSystems(0);
    this.time.setSpeed(this.state.time.speed ?? 1);
    this.markAllDirty();
    this.bus.emit('game:loaded', { state: this.state });
    return true;
  }

  save(slot = 0) {
    if (!this.state) return false;
    const ok = this.saves.save(slot);
    if (ok) this.bus.emit('notify', { text: `Partie sauvegardée (emplacement ${slot + 1}).`, kind: 'success', icon: '▣' });
    else this.bus.emit('notify', { text: 'Échec de la sauvegarde.', kind: 'danger', icon: '⚠' });
    return ok;
  }

  load(slot = 0) {
    const payload = this.saves.read(slot);
    if (!payload) return false;
    const ok = this.loadFromPayload(payload);
    if (ok) this.bus.emit('notify', { text: `Partie chargée (emplacement ${slot + 1}).`, kind: 'success', icon: '▣' });
    return ok;
  }

  deleteSave(slot = 0) { return this.saves.delete(slot); }
  listSaves() { return this.saves.list(); }

  _bindContext() {
    this.ctx.state = this.state;
    this.ctx.regions = this.regions;
    this.ctx.tech = this.techEffects;
  }

  _refreshTechEffects() {
    this.techEffects = computeTechEffects(this.state.tech.unlocked);
    this.ctx.tech = this.techEffects;
  }

  /* =================================================================== */
  /*  BOUCLE                                                             */
  /* =================================================================== */

  /** Appelée à chaque frame de rendu avec le delta réel en secondes. */
  update(dtReal) {
    if (!this.state) return 0;
    const ticks = this.time.advance(dtReal, (days, index) => this._tick(days, index));
    this.state.time.speed = this.time.speed;
    return ticks;
  }

  _tick(days, index) {
    const state = this.state;
    state.time.day += days;
    this._runSystems(days);
    this._sampleHistory();
    this._autosave(days);
    this.bus.emit('game:tick', { state, dt: days, tickIndex: index });
  }

  _runSystems(days) {
    const ctx = this.ctx;
    ctx.dt = days;
    ctx.acc = this._resetAccumulator();
    for (const s of this.systems) {
      try { s.tick(ctx); }
      catch (err) { console.error(`[${s.constructor.name}]`, err); }
    }
  }

  _resetAccumulator() {
    const a = this._acc || (this._acc = {
      produce: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
      consume: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
      global: { co2: 0, pressure: 0, oxygen: 0, temperature: 0, stability: 0, insolation: 0 },
      capacity: { energy: 0, materials: 0, water: 0 },
      dampening: 0,
      contributions: { energy: [] },
    });
    for (const k in a.produce) a.produce[k] = 0;
    for (const k in a.consume) a.consume[k] = 0;
    for (const k in a.global) a.global[k] = 0;
    for (const k in a.capacity) a.capacity[k] = 0;
    a.dampening = 0;
    a.contributions.energy.length = 0;
    return a;
  }

  _sampleHistory() {
    const s = this.state, h = s.history;
    const every = BALANCE.time.historyEveryDays;
    if (h.day.length && s.time.day - h.day[h.day.length - 1] < every) return;
    h.day.push(Math.floor(s.time.day));
    h.temperature.push(+s.globals.temperature.toFixed(2));
    h.pressure.push(+s.globals.pressure.toFixed(2));
    h.oxygen.push(+s.globals.oxygen.toFixed(3));
    h.biomass.push(+s.globals.biomass.toFixed(2));
    h.water.push(+(s.globals.waterCoverage * 100).toFixed(2));
    const max = BALANCE.time.historyMaxPoints;
    for (const k in h) if (h[k].length > max) h[k].splice(0, h[k].length - max);
  }

  _autosave(days) {
    this._daysSinceAutosave += days;
    if (this._daysSinceAutosave >= BALANCE.save.autosaveEveryDays) {
      this._daysSinceAutosave = 0;
      this.saves.save(0);
    }
  }

  /* =================================================================== */
  /*  MARQUAGE DES RÉGIONS À REDESSINER                                  */
  /* =================================================================== */

  markRegionDirty(id) {
    if (id == null) { this.markAllDirty(); return; }
    this.dirtyRegions.add(id);
  }
  markAllDirty() { this.allDirty = true; this.dirtyRegions.clear(); }
  consumeDirty() {
    if (this.allDirty) { this.allDirty = false; this.dirtyRegions.clear(); return null; }
    if (this.dirtyRegions.size === 0) return [];
    const arr = Array.from(this.dirtyRegions);
    this.dirtyRegions.clear();
    return arr;
  }

  /* =================================================================== */
  /*  FAÇADE — TEMPS & SÉLECTION                                         */
  /* =================================================================== */

  setSpeed(s) { this.time.setSpeed(s); this.state.time.speed = this.time.speed; }
  togglePause() { this.time.togglePause(); this.state.time.speed = this.time.speed; }

  selectRegion(id) {
    this.selectedRegion = (id == null || id < 0) ? null : id;
    this.bus.emit('region:selected', { regionId: this.selectedRegion });
  }

  /* =================================================================== */
  /*  FAÇADE — CONSTRUCTION                                              */
  /* =================================================================== */

  availableBuildings() {
    return BUILDING_LIST.filter((b) => !b.requires?.tech || this.state.tech.unlocked.includes(b.requires.tech));
  }

  buildingsIn(regionId) {
    return this.state.buildings.filter((b) => b.region === regionId);
  }

  canBuild(type, regionId) {
    const def = BUILDINGS[type];
    const s = this.state, R = this.regions;
    if (!def) return { ok: false, reason: 'Bâtiment inconnu.' };
    if (regionId == null || regionId < 0 || regionId >= R.count) return { ok: false, reason: 'Aucune région sélectionnée.' };
    if (!R.discovered[regionId]) return { ok: false, reason: 'Région non explorée. Lancez un scan orbital.' };

    const req = def.requires || {};
    if (req.tech && !s.tech.unlocked.includes(req.tech)) {
      return { ok: false, reason: `Technologie requise : ${TECHNOLOGIES[req.tech]?.name ?? req.tech}.` };
    }
    const inRegion = this.buildingsIn(regionId).filter((b) => b.type === type).length;
    if (inRegion >= (def.maxPerRegion ?? 99)) return { ok: false, reason: 'Limite atteinte dans cette région.' };
    if (def.maxTotal != null) {
      const total = s.buildings.filter((b) => b.type === type).length;
      if (total >= def.maxTotal) return { ok: false, reason: `Limite planétaire atteinte (${def.maxTotal}).` };
    }

    const minMinerals = this.techEffects.minMineralOverride != null && req.minerals != null
      ? Math.min(req.minerals, this.techEffects.minMineralOverride) : req.minerals;
    if (minMinerals != null && R.minerals[regionId] < minMinerals) {
      return { ok: false, reason: `Minerai insuffisant (${(R.minerals[regionId] * 100).toFixed(0)} % < ${(minMinerals * 100).toFixed(0)} %).` };
    }
    if (req.geothermal != null && R.geothermal[regionId] < req.geothermal) {
      return { ok: false, reason: `Activité géothermique insuffisante (${(R.geothermal[regionId] * 100).toFixed(0)} %).` };
    }
    if (req.ice != null && R.ice[regionId] < req.ice) {
      return { ok: false, reason: `Pas assez de glace ici (${(R.ice[regionId] * 100).toFixed(0)} %).` };
    }
    if (req.minTemp != null && R.temperature[regionId] < req.minTemp) {
      return { ok: false, reason: `Trop froid : ${R.temperature[regionId].toFixed(0)} °C < ${req.minTemp} °C.` };
    }
    if (req.maxTemp != null && R.temperature[regionId] > req.maxTemp) {
      return { ok: false, reason: `Trop chaud : ${R.temperature[regionId].toFixed(0)} °C > ${req.maxTemp} °C.` };
    }
    if (req.water != null && R.water[regionId] < req.water) {
      return { ok: false, reason: 'Pas assez d’eau de surface.' };
    }
    if (req.habitability != null && R.habitability[regionId] < req.habitability) {
      return { ok: false, reason: `Habitabilité ${(R.habitability[regionId] * 100).toFixed(0)} % < ${(req.habitability * 100).toFixed(0)} % requis.` };
    }

    const cost = def.cost || {};
    for (const k in cost) {
      if ((s.resources[k] ?? 0) < cost[k]) {
        return { ok: false, reason: `Ressources insuffisantes (${cost[k]} ${k}).` };
      }
    }
    return { ok: true };
  }

  build(type, regionId) {
    const check = this.canBuild(type, regionId);
    if (!check.ok) {
      this.bus.emit('notify', { text: check.reason, kind: 'warn', icon: '⚠' });
      return false;
    }
    const def = BUILDINGS[type];
    for (const k in (def.cost || {})) this.state.resources[k] -= def.cost[k];

    const building = {
      id: this.state.nextBuildingId++,
      type, region: regionId, day: Math.floor(this.state.time.day),
      active: true, level: 1, downtime: 0,
      population: def.colony ? BALANCE.colony.seedPopulation : 0,
    };
    this.state.buildings.push(building);
    this.regions.buildingCount[regionId] = Math.min(255, this.regions.buildingCount[regionId] + 1);
    this.state.stats.built++;
    this.markRegionDirty(regionId);
    this.bus.emit('building:placed', { building });
    this.bus.emit('notify', { text: `${def.name} construit.`, kind: 'success', icon: def.icon });
    return true;
  }

  demolish(buildingId) {
    const idx = this.state.buildings.findIndex((b) => b.id === buildingId);
    if (idx < 0) return false;
    const [b] = this.state.buildings.splice(idx, 1);
    const def = BUILDINGS[b.type];
    // 40 % des matériaux sont récupérés.
    if (def?.cost?.materials) this.state.resources.materials += def.cost.materials * 0.4;
    this.regions.buildingCount[b.region] = Math.max(0, this.regions.buildingCount[b.region] - 1);
    this.markRegionDirty(b.region);
    this.bus.emit('building:removed', { building: b });
    return true;
  }

  /* =================================================================== */
  /*  FAÇADE — RECHERCHE & EXPLORATION                                   */
  /* =================================================================== */

  /**
   * RECHERCHE PROGRESSIVE — `canResearch` ne regarde PLUS le stock de science :
   * on ne « paye » plus une technologie, on s'y engage. Ne restent donc que
   * deux refus possibles : les prérequis manquants et le laboratoire déjà
   * occupé (une seule recherche à la fois, c'est là qu'est l'arbitrage).
   */
  canResearch(techId) {
    const t = TECHNOLOGIES[techId];
    const s = this.state;
    if (!t) return { ok: false, reason: 'Technologie inconnue.' };
    if (s.tech.unlocked.includes(techId)) return { ok: false, reason: 'Déjà acquise.' };
    if (s.tech.current === techId) return { ok: false, reason: 'Recherche déjà en cours.' };
    if (s.tech.current) {
      const cur = TECHNOLOGIES[s.tech.current]?.name ?? s.tech.current;
      return { ok: false, reason: `Laboratoire occupé : ${cur}. Abandonnez la recherche en cours d’abord.` };
    }
    const missing = (t.requires || []).filter((r) => !s.tech.unlocked.includes(r));
    if (missing.length) {
      return { ok: false, reason: 'Prérequis : ' + missing.map((m) => TECHNOLOGIES[m]?.name ?? m).join(', ') };
    }
    return { ok: true };
  }

  /** Engage le laboratoire sur une technologie. La progression se fait au tick. */
  startResearch(techId) {
    const check = this.canResearch(techId);
    if (!check.ok) { this.bus.emit('notify', { text: check.reason, kind: 'warn', icon: '⚠' }); return false; }
    const t = TECHNOLOGIES[techId];
    this.state.tech.current = techId;
    this.state.tech.progress = 0;
    pushLog(this.state, `Recherche engagée : ${t.name}.`, 'info', '⌬');
    this.bus.emit('research:started', { techId });
    this.bus.emit('notify', { text: `Recherche engagée : ${t.name}`, kind: 'info', icon: '⌬' });
    return true;
  }

  /** Abandonne la recherche en cours. La moitié des points investis est rendue. */
  cancelResearch() {
    const s = this.state;
    const id = s.tech.current;
    if (!id) return false;
    const refund = (s.tech.progress || 0) * BALANCE.research.refund;
    s.resources.science += refund;
    s.tech.current = null;
    s.tech.progress = 0;
    const name = TECHNOLOGIES[id]?.name ?? id;
    pushLog(this.state, `Recherche abandonnée : ${name} (+${Math.round(refund)} science).`, 'warn', '⌬');
    this.bus.emit('notify', {
      text: `Recherche abandonnée : ${name}. ${Math.round(refund)} science récupérée.`,
      kind: 'warn', icon: '⌬',
    });
    return true;
  }

  /**
   * Jours restants estimés. Sans argument (ou pour la techno en cours) tient
   * compte des points déjà investis ; pour une autre techno, donne la durée
   * complète au débit actuel. `null` si le débit est nul (aucune science).
   */
  researchEta(techId = null) {
    const s = this.state;
    const id = techId ?? s.tech.current;
    const t = TECHNOLOGIES[id];
    if (!t) return null;
    if (s.tech.unlocked.includes(id)) return 0;
    const rate = this._researchSystem()?.rate() ?? 0;
    if (!(rate > 0)) return null;
    const done = (id === s.tech.current) ? (s.tech.progress || 0) : 0;
    const left = Math.max(0, t.cost * BALANCE.research.costScale - done);
    return left / rate;
  }

  _researchSystem() { return this.systems.find((x) => x instanceof ResearchSystem); }
  _exploreSystem() { return this.systems.find((x) => x instanceof ExplorationSystem); }

  /* ---- Exploration : file d'attente et pilotage automatique ------------ */

  /** Lance le scan, ou MET EN FILE si aucune sonde n'est libre. */
  scanRegion(regionId) {
    const sys = this._exploreSystem();
    return sys ? sys.startScan(this.ctx, regionId) : false;
  }

  /** Retire la région de la file, ou interrompt le scan en cours. */
  cancelScan(regionId) {
    const sys = this._exploreSystem();
    return sys ? sys.cancelScan(this.ctx, regionId) : false;
  }

  /** Active/désactive l'exploration automatique (empile la frontière connue). */
  setAutoExplore(v) {
    const on = !!v;
    if (!this.state) return on;
    this.state.explore.autoExplore = on;
    this.bus.emit('notify', {
      text: on ? 'Exploration automatique activée.' : 'Exploration automatique désactivée.',
      kind: 'info', icon: '⌖',
    });
    return on;
  }

  get autoExplore() { return !!(this.state && this.state.explore && this.state.explore.autoExplore); }

  /* =================================================================== */
  /*  FAÇADE — VICTOIRE                                                  */
  /* =================================================================== */

  victoryReport() {
    const sys = this.systems.find((s) => s instanceof VictorySystem);
    return sys ? sys.report(this.state) : [];
  }

  /** Phase courante, recalculée à la demande. */
  currentPhase() {
    return BALANCE.phases.find((p) => p.id === this.state.progress.phase) || BALANCE.phases[0];
  }

  /* =================================================================== */
  /*  OUTILS DE DÉVELOPPEMENT                                            */
  /* =================================================================== */

  _makeDebugApi() {
    const g = this;
    return {
      addResources(n = 1000) {
        g.state.resources.materials += n;
        g.state.resources.energy += n;
        g.state.resources.water += n;
        g.bus.emit('notify', { text: `[debug] +${n} ressources`, kind: 'info', icon: '⚙' });
      },
      addScience(n = 500) { g.state.resources.science += n; },
      heat(n = 5) { g.state.globals.temperature += n; g.markAllDirty(); },
      addWater(n = 0.05) {
        for (let i = 0; i < g.regions.count; i++) g.regions.moisture[i] = clamp01(g.regions.moisture[i] + n);
        g.markAllDirty();
      },
      addBiomass(n = 0.15) {
        for (let i = 0; i < g.regions.count; i++) {
          if (g.regions.elevation[i] > BALANCE.planet.seaLevel) {
            g.regions.vegetation[i] = clamp01(g.regions.vegetation[i] + n);
          }
        }
        g.markAllDirty();
      },
      addPressure(n = 10) { g.state.globals.pressure = clamp(g.state.globals.pressure + n, 0, BALANCE.atmosphere.maxPressure); },
      addOxygen(n = 3) { g.state.globals.oxygen = clamp(g.state.globals.oxygen + n, 0, 40); },
      revealAll() {
        for (let i = 0; i < g.regions.count; i++) g.regions.discovered[i] = 1;
        g.markAllDirty();
        g.bus.emit('notify', { text: '[debug] Planète entièrement révélée', kind: 'info', icon: '⚙' });
      },
      unlockAllTech() {
        for (const id in TECHNOLOGIES) if (!g.state.tech.unlocked.includes(id)) g.state.tech.unlocked.push(id);
        // La recherche en cours n'a plus d'objet une fois l'arbre entier acquis.
        g.state.tech.current = null;
        g.state.tech.progress = 0;
        g._refreshTechEffects();
        g.bus.emit('research:completed', { techId: null });
      },
      win() { g.state.progress.sustained = BALANCE.victory.sustainDays; },
    };
  }
}

export default Game;

/**
 * EventSystem — événements planétaires.
 *
 * Rythme : rien avant `graceDays`, puis au plus un événement tous les
 * `minInterval` jours, avec une probabilité journalière `dailyChance`
 * multipliée par l'instabilité de la planète (une planète qui part en vrille
 * attire les catastrophes).
 *
 * Un événement dont `apply` retourne `null` est INAPPLICABLE dans le contexte
 * courant (plus de bâtiment à casser, aucune région volcanique...). Dans ce
 * cas on ne consomme pas le cooldown : on retentera au tick suivant.
 */
import { BALANCE } from '../data/balance.js';
import { GAME_EVENTS } from '../data/events.js';
import { pushLog } from '../core/GameState.js';
import { clamp, clamp01 } from '../utils/math.js';

/** Bornes de sécurité des variables globales manipulées par les événements. */
const GLOBAL_BOUNDS = {
  temperature: [-300, 300],
  pressure: [BALANCE.atmosphere.minPressure, BALANCE.atmosphere.maxPressure],
  oxygen: [0, 100],
  co2: [0, 100],
  stability: [BALANCE.stability.min, BALANCE.stability.max],
  insolation: [0, 4],
  waterCoverage: [0, 1],
  biomass: [0, BALANCE.biosphere.globalScale],
};

export class EventSystem {
  constructor(game) {
    this.game = game;
    this._since = BALANCE.events.minInterval;   // pas de cooldown au démarrage
    this._pool = null;                          // tampon de sélection de région
    this._count = -1;

    // Contexte et helpers alloués UNE fois, mutés à chaque appel.
    this._ctx = { state: null, regions: null, rng: null, bus: null, helpers: null };
    this._helpers = this._makeHelpers();
    this._ctx.helpers = this._helpers;
  }

  reset(ctx) {
    this._since = BALANCE.events.minInterval;
    this._alloc(ctx.regions);
  }

  _alloc(regions) {
    if (!regions || regions.count === this._count) return;
    this._count = regions.count;
    this._pool = new Int32Array(regions.count);
  }

  _makeHelpers() {
    const self = this;
    return {
      /** Retourne l'id d'une région tirée au hasard parmi celles filtrées, ou -1. */
      randomRegion(filter) {
        const { regions, rng } = self._ctx;
        if (!regions) return -1;
        const pool = self._pool;
        let n = 0;
        for (let i = 0; i < regions.count; i++) {
          let ok = true;
          if (filter) { try { ok = !!filter(i); } catch { ok = false; } }
          if (ok) pool[n++] = i;
        }
        if (n === 0) return -1;
        return pool[Math.min(n - 1, Math.floor(rng.next() * n))];
      },
      /** Liste des régions découvertes (tableau neuf : usage rare). */
      discoveredRegions() {
        const { regions } = self._ctx;
        const out = [];
        if (!regions) return out;
        for (let i = 0; i < regions.count; i++) if (regions.discovered[i]) out.push(i);
        return out;
      },
      randomBuilding() {
        const { state, rng } = self._ctx;
        const list = state.buildings;
        if (!list || list.length === 0) return null;
        return list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))];
      },
      damageBuilding(days = 45) {
        const b = self._helpers.randomBuilding();
        if (!b) return null;
        b.downtime = Math.max(b.downtime || 0, days);
        b.active = false;
        return b;
      },
      addResource(key, value) {
        const res = self._ctx.state.resources;
        if (res[key] == null) return;
        res[key] = Math.max(0, res[key] + value);
      },
      addGlobal(key, value) {
        const g = self._ctx.state.globals;
        if (g[key] == null) return;
        const b = GLOBAL_BOUNDS[key];
        g[key] = b ? clamp(g[key] + value, b[0], b[1]) : g[key] + value;
      },
      reveal(i) {
        const { regions } = self._ctx;
        if (!regions || i < 0 || i >= regions.count) return;
        regions.discovered[i] = 1;
        self.game?.markRegionDirty?.(i);
        self._ctx.bus.emit('region:discovered', { regionId: i });
      },
      markRegion(i) {
        if (i == null || i < 0) self.game?.markAllDirty?.();
        else self.game?.markRegionDirty?.(i);
      },
      notify(text, kind = 'info', icon = '◈') {
        self._ctx.bus.emit('notify', { text, kind, icon });
      },
    };
  }

  /* =================================================================== */

  tick(ctx) {
    const { state, regions, rng, bus, dt } = ctx;
    if (dt <= 0 || !regions) return;
    this._alloc(regions);

    const E = BALANCE.events;
    this._since += dt;

    // Période de grâce en début de partie.
    if (state.time.day < E.graceDays) return;
    if (this._since < E.minInterval) return;

    // Une planète instable attire les ennuis.
    const instability = 1 - clamp01(state.globals.stability / BALANCE.stability.max);
    const chance = E.dailyChance * dt * (1 + (E.instabilityFactor - 1) * instability);
    if (rng.next() >= chance) return;

    const ectx = this._ctx;
    ectx.state = state; ectx.regions = regions; ectx.rng = rng; ectx.bus = bus;

    const picked = rng.weighted(GAME_EVENTS, (e) => {
      let w = 0;
      try { w = e.weight(ectx); } catch { w = 0; }
      return Number.isFinite(w) && w > 0 ? w : 0;
    });
    if (!picked) return;

    let result = null;
    try { result = picked.apply(ectx); }
    catch (err) { console.error('[EventSystem]', picked.id, err); result = null; }

    // Événement inapplicable : on retente au prochain tick.
    if (!result) return;

    this._since = 0;
    state.stats.events++;

    const kind = result.kind || 'info';
    const text = `${result.title} — ${result.text}`;
    pushLog(state, text, kind, result.icon || '◈');
    if (result.regionId != null) this.game?.markRegionDirty?.(result.regionId);

    bus.emit('event:triggered', { event: { id: picked.id, ...result } });
    bus.emit('notify', { text, kind, icon: result.icon || '◈' });
  }
}

export default EventSystem;

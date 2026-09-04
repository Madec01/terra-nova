/**
 * ResearchSystem — science passive, RECHERCHE PROGRESSIVE, progression de phase.
 *
 * ---------------------------------------------------------------------------
 *  INTENTION DE DESIGN
 * ---------------------------------------------------------------------------
 *  L'achat de technologie était instantané : on accumulait de la science puis
 *  on achetait tout, dans l'ordre imposé par les prérequis. L'arbre était une
 *  LISTE DE COURSES (19/19 dans toutes les parties mesurées), et les champs
 *  `state.tech.current` / `state.tech.progress` étaient morts.
 *
 *  Désormais le joueur ENGAGE son laboratoire sur UNE technologie
 *  (`Game.startResearch`). La science produite l'alimente jour après jour ;
 *  abandonner rend la moitié des points investis (`Game.cancelResearch`).
 *  Trois conséquences voulues :
 *   - l'ordre de recherche devient un choix de TEMPO (« j'accélère
 *     l'atmosphère ou la biologie ? ») avec un coût d'opportunité réel ;
 *   - on ne peut plus tout avoir : sur une partie de 30 ans, la moitié de
 *     l'arbre reste hors de portée si on se disperse ;
 *   - la station scientifique cesse d'être facultative.
 *
 *  MODÈLE : la recherche consomme le STOCK de science, à un débit plafonné par
 *  le REVENU de science × `BALANCE.research.focus`. La part restante du revenu
 *  (1 − focus) continue de s'accumuler pour payer les coûts en science des
 *  bâtiments : construire et chercher se disputent la même ressource, mais
 *  chercher ne bloque jamais totalement la construction.
 * ---------------------------------------------------------------------------
 *
 *  Comme il tourne après ResourceSystem, il utilise le canal différé
 *  (voir ResourceSystem.defer).
 */
import { BALANCE } from '../data/balance.js';
import { BUILDINGS } from '../data/buildings.js';
import { TECHNOLOGIES } from '../data/technologies.js';
import { pushLog } from '../core/GameState.js';
import { ResourceSystem } from './ResourceSystem.js';

export class ResearchSystem {
  constructor(game) {
    this.game = game;
    /** Dernier revenu de science mesuré (points/jour). Lu par Game.researchEta. */
    this._income = 0;
  }

  reset() { this._income = 0; }

  /** Coût total en science d'une technologie, échelle d'équilibrage comprise. */
  static costOf(techId) {
    const t = TECHNOLOGIES[techId];
    return t ? t.cost * BALANCE.research.costScale : 0;
  }

  /** Débit maximal de la recherche, en points/jour. */
  rate() { return Math.max(0, this._income * BALANCE.research.focus); }

  tick(ctx) {
    const { state, regions, acc, tech, bus } = ctx;

    /* --- Science passive ------------------------------------------------- */
    let science = BALANCE.research.baseScience;
    if (tech.flatScience) {
      let stations = 0;
      const buildings = state.buildings;
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (b.active === false) continue;
        const def = BUILDINGS[b.type];
        if (def && def.category === 'science') stations++;
      }
      science += tech.flatScience * stations;
    }
    acc.produce.science += science;
    ResourceSystem.defer(acc, 'produce', 'science', science);

    /* --- Revenu total de science ---------------------------------------
       `acc.produce.science` porte DÉJÀ toutes les sources : les stations
       (BuildingSystem), les colonies (PopulationSystem, qui alimente les deux
       canaux) et le passif qu'on vient d'ajouter. Le canal différé est un
       DOUBLON de ces mêmes montants, destiné à ResourceSystem : l'additionner
       ici compterait les colonies deux fois. */
    this._income = Math.max(0, acc.produce.science);

    /* --- Avancement de la recherche en cours ----------------------------- */
    this._advance(ctx);

    /* --- Phase de mission ------------------------------------------------ */
    this._updatePhase(state, regions, bus);
  }

  /**
   * Verse le débit du jour dans la technologie en cours, et la débloque
   * lorsque le coût est atteint. Le trop-plein retourne au stock : aucun
   * point de science n'est jamais perdu par le joueur.
   */
  _advance(ctx) {
    const { state, dt, bus } = ctx;
    if (dt <= 0) return;
    const id = state.tech.current;
    if (!id) return;

    const def = TECHNOLOGIES[id];
    if (!def || state.tech.unlocked.includes(id)) {
      // Sauvegarde incohérente ou technologie retirée du catalogue.
      state.tech.current = null;
      state.tech.progress = 0;
      return;
    }

    const cost = ResearchSystem.costOf(id);
    const draw = Math.min(state.resources.science, this.rate() * dt);
    if (draw > 0) {
      state.resources.science -= draw;
      state.tech.progress = (state.tech.progress || 0) + draw;
    }
    if (state.tech.progress < cost) return;

    state.resources.science += state.tech.progress - cost;
    state.tech.current = null;
    state.tech.progress = 0;
    state.tech.unlocked.push(id);
    state.stats.researched++;

    // Game expose `_refreshTechEffects` ; le banc d'essai des tests expose
    // `refreshTech`. Les deux recalculent `ctx.tech`.
    const g = this.game;
    if (g && typeof g._refreshTechEffects === 'function') g._refreshTechEffects();
    else if (g && typeof g.refreshTech === 'function') g.refreshTech();

    pushLog(state, `Technologie acquise : ${def.name}.`, 'success', '⌬');
    bus.emit('research:completed', { techId: id });
    bus.emit('notify', { text: `Recherche terminée : ${def.name}`, kind: 'success', icon: '⌬' });
  }

  /**
   * Évalue les objectifs de phase DANS L'ORDRE : la phase courante est la
   * dernière dont l'objectif est rempli. On ne redescend jamais de phase.
   */
  _updatePhase(state, regions, bus) {
    let discovered = 0;
    const count = regions ? regions.count : 0;
    if (regions) {
      for (let i = 0; i < count; i++) if (regions.discovered[i]) discovered++;
    }
    const info = { discoveredRatio: count > 0 ? discovered / count : 0 };

    let phase = 1;
    for (const p of BALANCE.phases) {
      let ok = false;
      try { ok = !!p.goal(state, info); } catch { ok = false; }
      if (!ok) break;
      // L'objectif de la phase p est atteint → on passe à la suivante.
      phase = Math.min(p.id + 1, BALANCE.phases.length);
    }

    const prog = state.progress;
    if (phase > prog.phase) prog.phase = phase;

    if (!prog.seenPhases) prog.seenPhases = [prog.phase];
    if (!prog.seenPhases.includes(prog.phase)) {
      prog.seenPhases.push(prog.phase);
      const def = BALANCE.phases.find((p) => p.id === prog.phase);
      if (def) {
        const text = `Phase ${def.id} — ${def.name} : ${def.desc}`;
        pushLog(state, text, 'success', '▶');
        bus.emit('notify', { text, kind: 'success', icon: '▶' });
      }
    }
  }
}

export default ResearchSystem;

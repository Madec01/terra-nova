/**
 * ResearchSystem — science passive et progression de phase.
 *
 * L'achat d'une technologie est INSTANTANÉ (Game.startResearch) : il n'y a
 * donc pas de file de recherche à faire avancer ici. Ce système ne s'occupe
 * que de la science produite « en fond » par le centre de commandement et par
 * les bonus technologiques attachés aux stations scientifiques, ainsi que du
 * suivi de la phase de mission.
 *
 * Comme il tourne après ResourceSystem, il utilise le canal différé
 * (voir ResourceSystem.defer).
 */
import { BALANCE } from '../data/balance.js';
import { BUILDINGS } from '../data/buildings.js';
import { pushLog } from '../core/GameState.js';
import { ResourceSystem } from './ResourceSystem.js';

export class ResearchSystem {
  constructor(game) {
    this.game = game;
  }

  reset() {}

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

    /* --- Phase de mission ------------------------------------------------ */
    this._updatePhase(state, regions, bus);
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

/**
 * VictorySystem — les sept conditions de fin de partie.
 *
 * `report(state)` est appelé par l'interface : il ne doit RIEN modifier et ne
 * doit rien allouer (les lignes sont créées une fois puis mutées).
 *
 * La victoire demande de tenir les sept conditions simultanément pendant
 * `sustainDays` jours : c'est la phase la plus tendue de la partie, d'où
 * l'avertissement quand on perd une condition à mi-parcours.
 */
import { BALANCE } from '../data/balance.js';
import { pushLog } from '../core/GameState.js';
import { clamp01 } from '../utils/math.js';

export class VictorySystem {
  constructor(game) {
    this.game = game;
    this._warned = false;

    /** Lignes réutilisées : {key,label,value,target,ok,format,progress}. */
    this._rows = [
      { key: 'temperature', label: 'Température moyenne', value: 0, target: 0, ok: false, format: '°C', progress: 0 },
      { key: 'pressure', label: 'Pression atmosphérique', value: 0, target: 0, ok: false, format: 'kPa', progress: 0 },
      { key: 'oxygen', label: 'Oxygène', value: 0, target: 0, ok: false, format: '%', progress: 0 },
      { key: 'waterCoverage', label: 'Surface en eau liquide', value: 0, target: 0, ok: false, format: '%', progress: 0 },
      { key: 'biomass', label: 'Biomasse', value: 0, target: 0, ok: false, format: '', progress: 0 },
      { key: 'population', label: 'Population', value: 0, target: 0, ok: false, format: 'hab.', progress: 0 },
      { key: 'stability', label: 'Stabilité climatique', value: 0, target: 0, ok: false, format: '%', progress: 0 },
    ];
  }

  reset() { this._warned = false; }

  /* =================================================================== */

  /** Rapport lisible des sept conditions. Fonction PURE (lecture seule). */
  report(state) {
    const V = BALANCE.victory;
    const g = state.globals;
    const r = this._rows;

    // 1. Température : fourchette (trop chaud est aussi un échec).
    const t = g.temperature;
    r[0].value = t;
    r[0].target = V.temperature.min;
    r[0].max = V.temperature.max;
    r[0].ok = t >= V.temperature.min && t <= V.temperature.max;
    r[0].label = `Température moyenne (${V.temperature.min} à ${V.temperature.max} °C)`;
    r[0].progress = t <= V.temperature.min
      ? clamp01((t - BALANCE.start.globals.temperature) / (V.temperature.min - BALANCE.start.globals.temperature))
      : (t <= V.temperature.max ? 1 : clamp01(1 - (t - V.temperature.max) / V.temperature.max));

    this._simple(r[1], g.pressure, V.pressure.min);
    this._simple(r[2], g.oxygen, V.oxygen.min);
    this._simple(r[3], g.waterCoverage * 100, V.waterCoverage.min * 100);
    this._simple(r[4], g.biomass, V.biomass.min);
    this._simple(r[5], g.population, V.population.min);
    this._simple(r[6], g.stability, V.stability.min);

    return r;
  }

  _simple(row, value, target) {
    const v = Number.isFinite(value) ? value : 0;
    row.value = v;
    row.target = target;
    row.ok = v >= target;
    row.progress = target > 0 ? clamp01(v / target) : 1;
  }

  /* =================================================================== */

  tick(ctx) {
    const { state, dt, bus } = ctx;
    const prog = state.progress;
    const rows = this.report(state);

    let all = true;
    for (let i = 0; i < rows.length; i++) if (!rows[i].ok) { all = false; break; }

    const need = BALANCE.victory.sustainDays;

    if (all) {
      if (dt > 0) prog.sustained += dt;
    } else if (prog.sustained > 0) {
      // Perdre une condition après la moitié du chemin mérite une alerte.
      if (prog.sustained >= need / 2 && !this._warned) {
        this._warned = true;
        const lost = rows.filter((x) => !x.ok).map((x) => x.key).join(', ');
        bus.emit('notify', {
          text: `Stabilisation interrompue : condition perdue (${lost}). Le compteur repart de zéro.`,
          kind: 'warn', icon: '⌛',
        });
      }
      prog.sustained = 0;
    }

    if (!prog.victory && prog.sustained >= need) {
      prog.victory = true;
      prog.victoryAt = Math.floor(state.time.day);
      pushLog(state, 'TERRA NOVA est viable. La planète est déclarée habitable.', 'success', '★');
      bus.emit('victory', { state });
      bus.emit('notify', { text: 'Victoire : la planète est stable et habitable !', kind: 'success', icon: '★' });
    }

    if (all) this._warned = false;
  }
}

export default VictorySystem;

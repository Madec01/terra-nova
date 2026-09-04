/**
 * Contrôles du temps (bas-centre) : pause / ×1 / ×2 / ×4,
 * date de mission, phase courante et compteur d'images par seconde.
 */
import { el, on } from './dom.js';
import { BALANCE } from '../data/balance.js';
import { TimeManager } from '../core/TimeManager.js';

const NB = '\u00A0';

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

const SPEEDS = [
  { value: 0, label: '⏸', aria: 'Pause', tip: 'Pause (Espace)' },
  { value: 1, label: '×1', aria: 'Vitesse normale', tip: 'Vitesse ×1 (touche 1)' },
  { value: 2, label: '×2', aria: 'Vitesse double', tip: 'Vitesse ×2 (touche 2)' },
  { value: 4, label: '×4', aria: 'Vitesse quadruple', tip: 'Vitesse ×4 (touche 3)' },
];

export class TimeBar {
  constructor(ctx) {
    this.game = ctx.game;
    this.scene = ctx.scene;
    this.tooltip = ctx.tooltip;
    this.node = null;
    this.buttons = [];
    this._offs = [];
    this._fpsAt = 0;
  }

  mount() {
    const group = el('div', { class: 'tn-speeds', role: 'group', 'aria-label': 'Vitesse de simulation' });
    for (const s of SPEEDS.filter((s) => BALANCE.time.speeds.includes(s.value))) {
      const btn = el('button', {
        class: 'tn-speed', type: 'button', 'aria-label': s.aria, 'aria-pressed': 'false',
        'data-tip': s.tip, text: s.label,
      });
      this._offs.push(on(btn, 'click', () => { if (this.game.state) this.game.setSpeed(s.value); }));
      this.buttons.push({ def: s, btn });
      group.appendChild(btn);
    }

    this.dateNode = el('span', { class: 'tn-date' });
    this.phaseNode = el('span', { class: 'tn-phase-tag' });
    this.fpsNode = el('span', { class: 'tn-fps', 'data-tip': 'Images par seconde' });

    this.node = el('div', { class: 'tn-timebar', role: 'region', 'aria-label': 'Contrôles du temps' },
      group,
      el('div', { class: 'tn-time-info' }, this.dateNode, this.phaseNode),
      this.fpsNode);
    return this.node;
  }

  update(state) {
    if (!this.node || !state) return;
    const speed = state.time?.speed ?? 0;
    for (const { def, btn } of this.buttons) {
      const active = def.value === speed;
      if (btn._a !== active) {
        btn._a = active;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    setText(this.dateNode, TimeManager.formatDay(state.time?.day ?? 0));

    const phase = this.game.currentPhase?.()
      || BALANCE.phases.find((p) => p.id === state.progress?.phase) || BALANCE.phases[0];
    setText(this.phaseNode, `Phase ${phase.id}${NB}· ${phase.name}`);

    const now = performance.now();
    if (now - this._fpsAt > 500) {
      this._fpsAt = now;
      const fps = this.scene?.stats?.fps;
      setText(this.fpsNode, Number.isFinite(fps) ? Math.round(fps) + NB + 'i/s' : '');
    }
  }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

export default TimeBar;

/**
 * Panneau de développement (F2). Volontairement distinct du reste de
 * l'interface : bordure orange et libellé « DEV ».
 */
import { el, on } from './dom.js';
import { makeSeedLabel } from '../utils/rng.js';
import { formatNumber } from '../utils/math.js';

const NB = '\u00A0';

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

const METRICS = [
  { key: 'fps', label: 'FPS' },
  { key: 'draws', label: 'Draw calls' },
  { key: 'tris', label: 'Triangles' },
  { key: 'seed', label: 'Seed' },
  { key: 'day', label: 'Jour' },
  { key: 'regions', label: 'Régions' },
  { key: 'discovered', label: 'Découvertes' },
  { key: 'buildings', label: 'Bâtiments' },
  { key: 'temperature', label: 'Température' },
  { key: 'pressure', label: 'Pression' },
  { key: 'oxygen', label: 'O₂' },
  { key: 'co2', label: 'CO₂' },
  { key: 'biomass', label: 'Biomasse' },
  { key: 'stability', label: 'Stabilité' },
];

const ACTIONS = [
  { label: '+1000 ressources', fn: (d) => d.addResources?.(1000) },
  { label: '+500 science', fn: (d) => d.addScience?.(500) },
  { label: '+5 °C', fn: (d) => d.heat?.(5) },
  { label: '+eau', fn: (d) => d.addWater?.(0.05) },
  { label: '+biomasse', fn: (d) => d.addBiomass?.(0.15) },
  { label: '+10 kPa', fn: (d) => d.addPressure?.(10) },
  { label: '+3 % O₂', fn: (d) => d.addOxygen?.(3) },
  { label: 'Révéler tout', fn: (d) => d.revealAll?.() },
  { label: 'Toutes les technos', fn: (d) => d.unlockAllTech?.() },
  { label: 'Gagner', fn: (d) => d.win?.() },
];

export class DebugPanel {
  constructor(ctx) {
    this.game = ctx.game;
    this.scene = ctx.scene;
    this.ui = ctx.ui;
    this.node = null;
    this.metrics = new Map();
    this._offs = [];
    this._at = 0;
  }

  mount() {
    const grid = el('div', { class: 'tn-debug-grid' });
    for (const m of METRICS) {
      const v = el('span', { class: 'tn-debug-value' });
      grid.appendChild(el('div', { class: 'tn-debug-cell' },
        el('span', { class: 'tn-debug-label', text: m.label }), v));
      this.metrics.set(m.key, v);
    }

    const actions = el('div', { class: 'tn-debug-actions' });
    for (const a of ACTIONS) {
      const btn = el('button', { class: 'tn-btn tn-btn--dev', type: 'button', text: a.label });
      this._offs.push(on(btn, 'click', () => {
        try { a.fn(this.game.debug || {}); } catch (err) { console.error('[debug]', err); }
      }));
      actions.appendChild(btn);
    }

    const close = el('button', { class: 'tn-icon-btn', type: 'button', 'aria-label': 'Fermer le panneau de développement', text: '×' });
    this._offs.push(on(close, 'click', () => this.toggle(false)));

    this.node = el('div', { class: 'tn-panel tn-debug', role: 'region', 'aria-label': 'Panneau de développement' },
      el('header', { class: 'tn-panel-head' },
        el('span', { class: 'tn-panel-title' }, el('b', { class: 'tn-dev-tag', text: 'DEV' }), ' Diagnostic'),
        close),
      el('div', { class: 'tn-panel-body' }, grid, actions,
        el('p', { class: 'tn-hint', text: 'F2 pour masquer ce panneau.' })));
    this.node.hidden = true;
    return this.node;
  }

  get visible() { return this.node && !this.node.hidden; }

  toggle(force) {
    if (!this.node) return;
    const show = force === undefined ? this.node.hidden : !!force;
    this.node.hidden = !show;
    if (show) this.update(this.game.state);
  }

  update(state) {
    if (!this.visible || !state) return;
    const now = performance.now();
    if (now - this._at < 250) return;
    this._at = now;

    const st = this.scene?.stats || {};
    const R = this.game.regions;
    let discovered = 0;
    if (R?.discovered) for (let i = 0; i < R.count; i++) discovered += R.discovered[i] ? 1 : 0;
    const g = state.globals || {};

    this._set('fps', Number.isFinite(st.fps) ? Math.round(st.fps) : '—');
    this._set('draws', Number.isFinite(st.drawCalls) ? String(st.drawCalls) : '—');
    this._set('tris', Number.isFinite(st.triangles) ? formatNumber(st.triangles, 0) : '—');
    this._set('seed', makeSeedLabel(state.seed ?? 0));
    this._set('day', Math.floor(state.time?.day ?? 0).toString());
    this._set('regions', String(R?.count ?? 0));
    this._set('discovered', `${discovered}${NB}(${R?.count ? (discovered / R.count * 100).toFixed(0) : 0}${NB}%)`);
    this._set('buildings', String(state.buildings?.length ?? 0));
    this._set('temperature', (g.temperature ?? 0).toFixed(2).replace('-', '−') + NB + '°C');
    this._set('pressure', (g.pressure ?? 0).toFixed(2) + NB + 'kPa');
    this._set('oxygen', (g.oxygen ?? 0).toFixed(3) + NB + '%');
    this._set('co2', (g.co2 ?? 0).toFixed(2) + NB + '%');
    this._set('biomass', (g.biomass ?? 0).toFixed(2));
    this._set('stability', (g.stability ?? 0).toFixed(1) + NB + '%');
  }

  _set(key, value) { setText(this.metrics.get(key), value); }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

export default DebugPanel;

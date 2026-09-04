/**
 * Bilan planétaire : conditions de victoire, historiques (sparklines SVG)
 * et phase de mission courante.
 */
import { el, clear, bar, on } from './dom.js';
import { BALANCE } from '../data/balance.js';
import { formatNumber, clamp01, invLerp } from '../utils/math.js';

const NB = '\u00A0';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Signe moins typographique (U+2212). */
const dec = (v, digits) => v.toFixed(digits).replace('-', '−');
const num = (v, digits) => formatNumber(v, digits).replace('-', '−');

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

const SPARKS = [
  { key: 'temperature', label: 'Température', unit: '°C', digits: 1 },
  { key: 'pressure', label: 'Pression', unit: 'kPa', digits: 1 },
  { key: 'oxygen', label: 'Oxygène', unit: '%', digits: 2 },
  { key: 'biomass', label: 'Biomasse', unit: '', digits: 1 },
];

export class PlanetStatusPanel {
  constructor(ctx) {
    this.game = ctx.game;
    this.ui = ctx.ui;
    this.tooltip = ctx.tooltip;
    this._offs = [];
    this.node = null;
    this.rows = new Map();
    this.sparks = new Map();
    this._lastSpark = 0;
    this._rowSig = '';
  }

  mount() {
    this.phaseName = el('div', { class: 'tn-phase-name' });
    this.phaseGoal = el('p', { class: 'tn-hint' });
    this.sustain = el('div', { class: 'tn-sustain' });
    this.sustainBar = bar(0, 1, 'tn-bar--accent');
    this.sustainText = el('span', { class: 'tn-row-value' });
    this.sustain.appendChild(el('span', { class: 'tn-row-label', text: 'Maintien' }));
    this.sustain.appendChild(this.sustainBar);
    this.sustain.appendChild(this.sustainText);

    this.list = el('div', { class: 'tn-rows tn-victory' });
    this.graphs = el('div', { class: 'tn-graphs' });
    for (const s of SPARKS) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 100 30');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('class', 'tn-spark');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'polyline');
      path.setAttribute('class', 'tn-spark-line');
      const area = document.createElementNS(SVG_NS, 'polygon');
      area.setAttribute('class', 'tn-spark-area');
      svg.appendChild(area); svg.appendChild(path);
      const value = el('span', { class: 'tn-graph-value' });
      const range = el('span', { class: 'tn-graph-range' });
      this.graphs.appendChild(el('div', { class: 'tn-graph' },
        el('div', { class: 'tn-graph-head' },
          el('span', { class: 'tn-graph-label', text: s.label }), value),
        svg, range));
      this.sparks.set(s.key, { def: s, svg, path, area, value, range });
    }

    /* --- exploration : sondes, file d'attente, automatismes ----------- */
    this.exploreLine = el('div', { class: 'tn-explore-line' });
    this.autoBtn = el('button', { class: 'tn-btn tn-btn--wide', type: 'button' },
      el('span', { text: 'Exploration automatique' }),
      el('small', { text: 'les sondes libres choisissent seules leur cible' }));
    this.scanBtn = el('button', { class: 'tn-btn tn-btn--wide', type: 'button' },
      el('span', { text: 'Mode scan continu' }),
      el('small', { text: 'chaque appui sur un secteur sombre met un scan en file' }));
    this._offs.push(on(this.autoBtn, 'click', () => {
      if (typeof this.game.setAutoExplore !== 'function') return;
      this.game.setAutoExplore(!this.game.autoExplore);
      this.update(this.game.state);
    }));
    this._offs.push(on(this.scanBtn, 'click', () => this.ui?.toggleScanMode?.()));
    this.explore = el('div', { class: 'tn-explore' },
      el('div', { class: 'tn-section-title', text: 'Exploration' }),
      this.exploreLine, this.scanBtn, this.autoBtn);

    this.node = el('div', { class: 'tn-dock-panel tn-planet' },
      el('div', { class: 'tn-section-title', text: 'Phase de mission' }),
      el('div', { class: 'tn-phase' }, this.phaseName, this.phaseGoal),
      this.explore,
      el('div', { class: 'tn-section-title', text: 'Conditions de terraformation' }),
      this.list, this.sustain,
      el('div', { class: 'tn-section-title', text: 'Historique' }),
      this.graphs);
    return this.node;
  }

  /* ------------------------------------------------------------------ */

  update(state) {
    if (!this.node || !state || this.node.hidden) return;

    const phase = (this.game.currentPhase?.() )
      || BALANCE.phases.find((p) => p.id === state.progress?.phase) || BALANCE.phases[0];
    setText(this.phaseName, `${phase.id}/${BALANCE.phases.length} · ${phase.name}`);
    setText(this.phaseGoal, phase.desc || '');

    // --- exploration ---------------------------------------------------
    const ex = state.explore || {};
    const total = Math.max(0, ex.probes ?? 0) * (BALANCE.exploration?.scansPerProbe || 1);
    const busy = ex.scanning?.length ?? 0;
    const free = Number.isFinite(ex.probesFree) ? ex.probesFree : Math.max(0, total - busy);
    const queue = Array.isArray(ex.queue) ? ex.queue.length : null;
    setText(this.exploreLine, `${free}${NB}sonde(s) libre(s) sur ${total} · ${busy}${NB}en cours`
      + (queue === null ? '' : ` · ${queue}${NB}en file`));
    const hasAuto = typeof this.game.setAutoExplore === 'function';
    this.autoBtn.hidden = !hasAuto;
    if (hasAuto) {
      const on_ = !!this.game.autoExplore;
      this.autoBtn.classList.toggle('is-active', on_);
      this.autoBtn.setAttribute('aria-pressed', on_ ? 'true' : 'false');
      setText(this.autoBtn.firstChild, on_ ? 'Exploration automatique : active' : 'Exploration automatique');
    }
    const scanning = this.ui?.scanMode === true;
    this.scanBtn.classList.toggle('is-active', scanning);
    this.scanBtn.setAttribute('aria-pressed', scanning ? 'true' : 'false');
    setText(this.scanBtn.firstChild, scanning ? 'Mode scan continu : actif' : 'Mode scan continu');

    let report = [];
    try { report = this.game.victoryReport() || []; } catch (err) { console.warn('[PlanetStatus]', err); }
    this._syncRows(report);
    for (const row of report) {
      const ref = this.rows.get(row.key);
      if (!ref) continue;
      setText(ref.value, formatValue(row));
      const r = progressRatio(row);
      ref.bar.setValue(r, 1);
      const mod = row.ok ? 'good' : r > 0.6 ? 'warn' : '';
      if (ref.bar._mod !== mod) {
        if (ref.bar._mod) ref.bar.classList.remove('is-' + ref.bar._mod);
        ref.bar._mod = mod;
        if (mod) ref.bar.classList.add('is-' + mod);
      }
      ref.node.classList.toggle('is-ok', !!row.ok);
      setText(ref.mark, row.ok ? '✓' : '·');
    }

    const need = BALANCE.victory.sustainDays || 1;
    const done = state.progress?.sustained ?? 0;
    this.sustainBar.setValue(done, need);
    setText(this.sustainText, `${Math.floor(done)}${NB}/${NB}${need}${NB}j`);

    const now = performance.now();
    if (now - this._lastSpark > 2000) { this._lastSpark = now; this._updateSparks(state); }
  }

  _syncRows(report) {
    const sig = report.map((r) => r.key).join('|');
    if (sig === this._rowSig) return;
    this._rowSig = sig;
    clear(this.list);
    this.rows.clear();
    for (const row of report) {
      const value = el('span', { class: 'tn-row-value' });
      const mark = el('span', { class: 'tn-row-mark', 'aria-hidden': 'true' });
      const b = bar(0, 1);
      const node = el('div', { class: 'tn-row tn-row--victory' },
        mark, el('span', { class: 'tn-row-label', text: row.label || row.key }), b, value);
      this.tooltip?.attach(node, () => `Objectif${NB}: ${targetText(row)}`);
      this.list.appendChild(node);
      this.rows.set(row.key, { node, value, bar: b, mark });
    }
  }

  _updateSparks(state) {
    const h = state.history || {};
    for (const [key, ref] of this.sparks) {
      const series = h[key];
      const def = ref.def;
      if (!Array.isArray(series) || series.length < 2) {
        ref.path.setAttribute('points', '');
        ref.area.setAttribute('points', '');
        setText(ref.value, dec(state.globals?.[key] ?? 0, def.digits) + (def.unit ? NB + def.unit : ''));
        setText(ref.range, 'Données insuffisantes');
        continue;
      }
      let min = Infinity, max = -Infinity;
      for (const v of series) { if (v < min) min = v; if (v > max) max = v; }
      if (max - min < 1e-6) { max = min + 1; }
      const n = series.length;
      let pts = '';
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 100;
        const y = 29 - clamp01(invLerp(min, max, series[i])) * 28;
        pts += `${x.toFixed(2)},${y.toFixed(2)} `;
      }
      ref.path.setAttribute('points', pts.trim());
      ref.area.setAttribute('points', `0,30 ${pts.trim()} 100,30`);
      setText(ref.value, dec(series[n - 1], def.digits) + (def.unit ? NB + def.unit : ''));
      setText(ref.range, `${num(min, def.digits)} → ${num(max, def.digits)}${def.unit ? NB + def.unit : ''}`);
    }
  }

  onShow() { this._lastSpark = 0; this.update(this.game.state); }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove(); this.node = null; this.rows.clear(); this.sparks.clear();
  }
}

/* -------------------------------------------------------------------- */

const UNITS = {
  percent: (v) => dec(v * 100, 1) + NB + '%',
  ratio: (v) => dec(v * 100, 1) + NB + '%',
  temperature: (v) => dec(v, 1) + NB + '°C',
  temp: (v) => dec(v, 1) + NB + '°C',
  pressure: (v) => dec(v, 1) + NB + 'kPa',
  kpa: (v) => dec(v, 1) + NB + 'kPa',
  integer: (v) => num(v, 0),
  int: (v) => num(v, 0),
  number: (v) => num(v, 1),
};

export function formatValue(row) {
  const v = Number(row.value) || 0;
  const f = row.format;
  if (typeof f === 'function') { try { return String(f(v)); } catch { return num(v, 1); } }
  if (typeof f === 'string') {
    const fn = UNITS[f.toLowerCase()];
    if (fn) return fn(v);
    return num(v, 1) + NB + f;   // `format` est alors une simple unité
  }
  return num(v, 1);
}

export function targetText(row) {
  const t = row.target;
  if (t == null) return '—';
  const unit = (val) => formatValue({ value: val, format: row.format });
  if (typeof t === 'number') return '≥' + NB + unit(t);
  if (typeof t === 'object') {
    if (t.min != null && t.max != null) return `${unit(t.min)} – ${unit(t.max)}`;
    if (t.min != null) return '≥' + NB + unit(t.min);
    if (t.max != null) return '≤' + NB + unit(t.max);
  }
  return String(t);
}

/** Progression 0..1 vers l'objectif, référencée sur l'état initial. */
export function progressRatio(row) {
  if (row.ok) return 1;
  const t = row.target;
  const goal = typeof t === 'number' ? t : (t && (t.min ?? t.max));
  if (goal == null) return 0;
  const start = BALANCE.start.globals?.[row.key];
  const from = (start == null || start === goal) ? 0 : start;
  return clamp01(invLerp(from, goal, Number(row.value) || 0));
}

export default PlanetStatusPanel;

/**
 * Menu de construction : cartes groupées par catégorie.
 * Un clic sur une carte fait passer l'interface en mode placement.
 */
import { el, clear, on } from './dom.js';
import { BUILDINGS, BUILDING_CATEGORIES } from '../data/buildings.js';
import { TECHNOLOGIES } from '../data/technologies.js';
import { BALANCE } from '../data/balance.js';
import { labelResource } from './RegionPanel.js';

const NB = '\u00A0';

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

const GLOBAL_LABELS = {
  co2: ['CO₂', '%'], pressure: ['Pression', 'kPa'], oxygen: ['Oxygène', '%'],
  temperature: ['Température', '°C'], stability: ['Stabilité', 'pt'],
  insolation: ['Ensoleillement', '×'],
};
const LOCAL_LABELS = {
  pollution: ['Pollution', 'pt'], heat: ['Chaleur locale', '°C'], vegetation: ['Végétation', 'pt'],
  water: ['Eau de surface', 'pt'], moisture: ['Humidité', 'pt'], ice: ['Glace', 'pt'],
};

export class BuildMenu {
  constructor(ctx) {
    this.game = ctx.game;
    this.ui = ctx.ui;
    this.tooltip = ctx.tooltip;
    this.node = null;
    this.cards = new Map();
    this._offs = [];
  }

  mount() {
    this.node = el('div', { class: 'tn-dock-panel tn-build' });
    this.build();
    return this.node;
  }

  build() {
    clear(this.node);
    this.cards.clear();
    this.node.appendChild(el('p', { class: 'tn-hint', text: 'Choisissez une installation, puis cliquez sur un secteur cartographié de la planète.' }));

    for (const cat of BUILDING_CATEGORIES) {
      const defs = Object.values(BUILDINGS).filter((b) => b.category === cat.id);
      if (!defs.length) continue;
      defs.sort((a, b) => (a.tier || 0) - (b.tier || 0));
      this.node.appendChild(el('div', { class: 'tn-section-title' },
        el('span', { 'aria-hidden': 'true', text: cat.icon + NB }), cat.name));
      const grid = el('div', { class: 'tn-cards' });
      for (const def of defs) grid.appendChild(this._card(def));
      this.node.appendChild(grid);
    }
  }

  _card(def) {
    const cost = el('div', { class: 'tn-card-cost' });
    for (const k in (def.cost || {})) {
      const v = el('span', { class: 'tn-cost' },
        el('b', { text: String(def.cost[k]) }), NB + labelResource(k));
      cost.appendChild(v);
      v._key = k;
    }
    const status = el('div', { class: 'tn-card-status' });

    // Bouton d'information : au doigt, il n'y a pas de survol. Il ouvre
    // EXACTEMENT le contenu que la souris obtient en survolant la carte.
    const info = el('button', {
      class: 'tn-icon-btn tn-card-info', type: 'button',
      'aria-label': `Détail de l’installation ${def.name}`, text: 'ⓘ',
    });
    this.tooltip?.attach(info, () => this._tip(def), { tap: 'always' });
    this._offs.push(on(info, 'click', (e) => e.stopPropagation()));

    // `div[role=button]` et non `<button>` : un bouton ne peut pas en contenir
    // un autre, et la carte a besoin de son bouton « ⓘ ».
    const card = el('div', {
      class: 'tn-card', role: 'button', tabindex: '0', dataset: { type: def.id },
    },
      el('div', { class: 'tn-card-head' },
        el('span', { class: 'tn-card-icon', 'aria-hidden': 'true', text: def.icon || '▢' }),
        el('span', { class: 'tn-card-name', text: def.name }),
        el('span', { class: 'tn-card-tier', text: 'T' + (def.tier || 1) }),
        info),
      cost,
      el('div', { class: 'tn-card-effects' }, effectLines(def)),
      status);

    this.tooltip?.attach(card, () => this._tip(def));
    const activate = () => {
      if (card.classList.contains('is-locked')) {
        // Un bouton qui ne répond pas est perçu comme cassé : on dit pourquoi.
        const techId = def.requires?.tech;
        this.game.bus?.emit('notify', {
          text: `${def.name} requiert la technologie « ${TECHNOLOGIES[techId]?.name ?? techId} ».`,
          kind: 'warn', icon: '⌬',
        });
        this.ui?.openPanel?.('research');
        return;
      }
      this.ui?.startPlacement?.(def.id);
    };
    this._offs.push(on(card, 'click', activate));
    this._offs.push(on(card, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    }));
    this.cards.set(def.id, { def, card, cost, status });
    return card;
  }

  _tip(def) {
    const wrap = el('div', { class: 'tn-tip' },
      el('div', { class: 'tn-tip-title' }, el('span', { text: def.name })),
      el('p', { class: 'tn-tip-note', text: def.desc || '' }));
    const req = requirementLines(def);
    if (req.length) {
      wrap.appendChild(el('div', { class: 'tn-tip-sep' }));
      for (const r of req) wrap.appendChild(el('div', { class: 'tn-tip-row' },
        el('span', { class: 'tn-tip-label', text: r })));
    }
    return wrap;
  }

  /* ------------------------------------------------------------------ */

  update(state) {
    if (!this.node || !state || this.node.hidden) return;
    const unlocked = state.tech?.unlocked || [];
    const regionId = this.game.selectedRegion;
    const placing = this.ui?.placingType;

    for (const [id, ref] of this.cards) {
      const def = ref.def;
      const techId = def.requires?.tech;
      const locked = !!techId && !unlocked.includes(techId);
      ref.card.classList.toggle('is-locked', locked);
      ref.card.classList.toggle('is-active', placing === id);
      ref.card.setAttribute('aria-pressed', placing === id ? 'true' : 'false');

      for (const node of ref.cost.children) {
        const need = def.cost?.[node._key] ?? 0;
        node.classList.toggle('is-missing', (state.resources?.[node._key] ?? 0) < need);
      }

      let msg = '';
      let mod = '';
      if (locked) {
        msg = `Requiert${NB}: ${TECHNOLOGIES[techId]?.name ?? techId}`;
        mod = 'locked';
      } else if (regionId != null) {
        const check = this.game.canBuild(id, regionId);
        if (!check.ok) { msg = check.reason || 'Placement impossible.'; mod = 'ko'; }
        else { msg = `Constructible sur le secteur ${regionId}`; mod = 'ok'; }
      } else {
        const missing = Object.keys(def.cost || {}).filter((k) => (state.resources?.[k] ?? 0) < def.cost[k]);
        if (missing.length) { msg = 'Ressources insuffisantes'; mod = 'ko'; }
      }
      setText(ref.status, msg);
      ref.status.hidden = !msg;
      if (ref.status._mod !== mod) {
        if (ref.status._mod) ref.status.classList.remove('is-' + ref.status._mod);
        ref.status._mod = mod;
        if (mod) ref.status.classList.add('is-' + mod);
      }
    }
  }

  /** Reconstruction (après une recherche terminée). */
  refresh() { this.build(); this.update(this.game.state); }

  onShow() { this.update(this.game.state); }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

/* -------------------------------------------------------------------- */
/*  Résumés lisibles                                                     */
/* -------------------------------------------------------------------- */

export function effectLines(def) {
  const out = [];
  const prod = Object.keys(def.produces || {}).filter((k) => def.produces[k]);
  if (prod.length) {
    out.push(line('Produit', prod.map((k) => `+${fmt(def.produces[k])}${NB}${labelResource(k)}`).join(' · ') + NB + '/j', 'up'));
  }
  const up = Object.keys(def.upkeep || {}).filter((k) => def.upkeep[k]);
  if (up.length) {
    out.push(line('Entretien', up.map((k) => `−${fmt(def.upkeep[k])}${NB}${labelResource(k)}`).join(' · ') + NB + '/j', 'down'));
  }
  for (const k in (def.local || {})) {
    const v = def.local[k];
    if (!v) continue;
    const [label, unit] = LOCAL_LABELS[k] || [k, ''];
    const scaled = unit === 'pt' ? v * 100 : v;
    out.push(line(label, sign(scaled) + NB + unit + NB + '/j', v > 0 ? 'up' : 'down'));
  }
  for (const k in (def.global || {})) {
    const v = def.global[k];
    if (!v) continue;
    const [label, unit] = GLOBAL_LABELS[k] || [k, ''];
    out.push(line('Planète · ' + label, sign(v * 365) + NB + unit + NB + '/an', v > 0 ? 'up' : 'down'));
  }
  if (def.storage) {
    const p = BALANCE.storage.perDepot;
    out.push(line('Stockage', `+${p.energy} én. · +${p.materials} mat. · +${p.water} eau`, 'up'));
  }
  if (def.neighborBonus) out.push(line('Voisinage', 'Améliore les mines alentour', 'up'));
  if (def.spread) out.push(line('Diffusion', 'Ensemence les secteurs voisins', 'up'));
  if (def.dampening) out.push(line('Amortissement', 'Lisse les variations climatiques', 'up'));
  if (def.colony) out.push(line('Colonie', 'Accueille une population permanente', 'up'));
  if (def.orbital) out.push(line('Orbital', 'Structure en orbite, sans emprise au sol', 'up'));
  return out;
}

export function requirementLines(def) {
  const r = def.requires || {};
  const out = [];
  if (r.tech) out.push(`Technologie${NB}: ${TECHNOLOGIES[r.tech]?.name ?? r.tech}`);
  if (r.minerals != null) out.push(`Minerais ≥ ${(r.minerals * 100).toFixed(0)}${NB}%`);
  if (r.geothermal != null) out.push(`Géothermie ≥ ${(r.geothermal * 100).toFixed(0)}${NB}%`);
  if (r.ice != null) out.push(`Glace ≥ ${(r.ice * 100).toFixed(0)}${NB}%`);
  if (r.water != null) out.push(`Eau de surface ≥ ${(r.water * 100).toFixed(0)}${NB}%`);
  if (r.habitability != null) out.push(`Habitabilité ≥ ${(r.habitability * 100).toFixed(0)}${NB}%`);
  if (r.minTemp != null) out.push(`Température ≥ ${r.minTemp}${NB}°C`);
  if (r.maxTemp != null) out.push(`Température ≤ ${r.maxTemp}${NB}°C`);
  if (def.maxPerRegion != null) out.push(`${def.maxPerRegion} par secteur au maximum`);
  if (def.maxTotal != null) out.push(`${def.maxTotal} au maximum sur la planète`);
  return out;
}

function line(label, value, mod) {
  return el('div', { class: 'tn-eff is-' + mod },
    el('span', { class: 'tn-eff-label', text: label }),
    el('span', { class: 'tn-eff-value', text: value }));
}

function fmt(v) {
  const a = Math.abs(v);
  return a >= 10 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toFixed(2);
}

function sign(v) {
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return s + fmt(Math.abs(v));
}

export default BuildMenu;

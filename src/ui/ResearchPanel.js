/**
 * Arbre technologique : une colonne par branche, technologies empilées dans
 * l'ordre des prérequis et reliées par des traits CSS.
 */
import { el, clear, on } from './dom.js';
import { TECHNOLOGIES, TECH_LIST, TECH_BRANCHES } from '../data/technologies.js';
import { BUILDINGS } from '../data/buildings.js';
import { BALANCE } from '../data/balance.js';
import { formatNumber, formatSigned } from '../utils/math.js';

const NB = '\u00A0';

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

/** Profondeur = longueur de la plus longue chaîne de prérequis. */
function depthOf(id, cache = new Map()) {
  if (cache.has(id)) return cache.get(id);
  const t = TECHNOLOGIES[id];
  if (!t) return 0;
  cache.set(id, 0); // garde-fou anti-cycle
  const reqs = t.requires || [];
  const d = reqs.length ? 1 + Math.max(...reqs.map((r) => depthOf(r, cache))) : 0;
  cache.set(id, d);
  return d;
}

export class ResearchPanel {
  constructor(ctx) {
    this.game = ctx.game;
    this.ui = ctx.ui;
    this.tooltip = ctx.tooltip;
    this.node = null;
    this.cards = new Map();
    this._offs = [];
  }

  mount() {
    this.scienceNode = el('b', { class: 'tn-research-science' });
    this.incomeNode = el('span', { class: 'tn-research-income' });
    this.tree = el('div', { class: 'tn-tree' });
    this.node = el('div', { class: 'tn-dock-panel tn-research' },
      el('div', { class: 'tn-research-head' },
        el('span', { class: 'tn-research-icon', 'aria-hidden': 'true', text: '⌬' }),
        this.scienceNode, this.incomeNode),
      this.tree);
    this.build();
    return this.node;
  }

  build() {
    clear(this.tree);
    this.cards.clear();
    const cache = new Map();
    for (const branch of TECH_BRANCHES) {
      const techs = TECH_LIST.filter((t) => t.branch === branch.id)
        .sort((a, b) => depthOf(a.id, cache) - depthOf(b.id, cache) || a.cost - b.cost);
      if (!techs.length) continue;
      const column = el('div', { class: 'tn-branch', style: { '--branch': branch.color } },
        el('div', { class: 'tn-branch-head' },
          el('span', { 'aria-hidden': 'true', text: branch.icon }),
          el('span', { text: branch.name })));
      techs.forEach((t, i) => column.appendChild(this._card(t, i > 0)));
      this.tree.appendChild(column);
    }
  }

  _card(tech, linked) {
    const cost = el('span', { class: 'tn-tech-cost' });
    const state = el('span', { class: 'tn-tech-state' });
    const card = el('button', {
      class: 'tn-tech' + (linked ? ' is-linked' : ''), type: 'button', dataset: { tech: tech.id },
    },
      el('div', { class: 'tn-tech-head' },
        el('span', { class: 'tn-tech-name', text: tech.name }), cost),
      el('p', { class: 'tn-tech-desc', text: tech.desc || '' }),
      this._unlockLine(tech),
      state);
    this.tooltip?.attach(card, () => this._tip(tech));
    this._offs.push(on(card, 'click', () => this._start(tech.id)));
    this.cards.set(tech.id, { tech, card, cost, state });
    return card;
  }

  _unlockLine(tech) {
    const parts = [];
    for (const u of (tech.unlocks || [])) parts.push(BUILDINGS[u]?.name || u);
    if (!parts.length) return null;
    return el('div', { class: 'tn-tech-unlock' },
      el('span', { class: 'tn-tech-unlock-label', text: 'Débloque' + NB + ': ' }),
      el('span', { text: parts.join(', ') }));
  }

  _tip(tech) {
    const s = this.game.state;
    const reqs = (tech.requires || []).map((r) => TECHNOLOGIES[r]?.name ?? r);
    const wrap = el('div', { class: 'tn-tip' },
      el('div', { class: 'tn-tip-title' },
        el('span', { text: tech.name }),
        el('b', { text: Math.round(tech.cost * BALANCE.research.costScale) + NB + 'science' })),
      el('p', { class: 'tn-tip-note', text: tech.desc || '' }));
    if (reqs.length) {
      wrap.appendChild(el('div', { class: 'tn-tip-sep' }));
      wrap.appendChild(el('div', { class: 'tn-tip-row' },
        el('span', { class: 'tn-tip-label', text: 'Prérequis' + NB + ': ' + reqs.join(', ') })));
    }
    if (s) {
      const check = this.game.canResearch(tech.id);
      if (!check.ok && check.reason) {
        wrap.appendChild(el('div', { class: 'tn-tip-sep' }));
        wrap.appendChild(el('div', { class: 'tn-tip-row is-down' },
          el('span', { class: 'tn-tip-label', text: check.reason })));
      }
    }
    return wrap;
  }

  _start(id) {
    if (this.game.startResearch(id)) this.refresh();
  }

  /* ------------------------------------------------------------------ */

  update(state) {
    if (!this.node || !state || this.node.hidden) return;
    const science = state.resources?.science ?? 0;
    setText(this.scienceNode, formatNumber(science, 0) + NB + 'science');
    setText(this.incomeNode, formatSigned(state.flux?.science ?? 0, 1) + NB + '/j');

    const unlocked = state.tech?.unlocked || [];
    for (const [id, ref] of this.cards) {
      const cost = Math.round(ref.tech.cost * BALANCE.research.costScale);
      setText(ref.cost, String(cost));
      let mod, label;
      if (unlocked.includes(id)) { mod = 'done'; label = 'Acquise'; }
      else {
        const missing = (ref.tech.requires || []).filter((r) => !unlocked.includes(r));
        if (missing.length) {
          mod = 'locked';
          label = 'Verrouillée' + NB + ': ' + missing.map((m) => TECHNOLOGIES[m]?.name ?? m).join(', ');
        } else if (science < cost) { mod = 'costly'; label = `Manque ${Math.ceil(cost - science)} science`; }
        else { mod = 'ready'; label = 'Disponible'; }
      }
      if (ref.card._mod !== mod) {
        if (ref.card._mod) ref.card.classList.remove('is-' + ref.card._mod);
        ref.card._mod = mod;
        ref.card.classList.add('is-' + mod);
        ref.card.disabled = mod === 'done' || mod === 'locked';
      }
      setText(ref.state, label);
      ref.cost.classList.toggle('is-missing', mod === 'costly');
    }
  }

  refresh() { this.build(); this.update(this.game.state); }
  onShow() { this.update(this.game.state); }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

export default ResearchPanel;

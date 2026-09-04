/**
 * Arbre technologique : une colonne par branche, technologies empilées dans
 * l'ordre des prérequis et reliées par des traits CSS.
 */
import { el, clear, on, bar } from './dom.js';
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

    // --- travaux en cours (recherche progressive) ---------------------
    this.currentName = el('div', { class: 'tn-current-name' });
    this.currentEta = el('span', { class: 'tn-current-eta' });
    this.currentBar = bar(0, 1, 'tn-bar--accent');
    this.cancelBtn = el('button', {
      class: 'tn-btn tn-btn--small', type: 'button', text: 'Abandonner',
    });
    this._offs.push(on(this.cancelBtn, 'click', () => {
      if (typeof this.game.cancelResearch === 'function') { this.game.cancelResearch(); this.refresh(); }
    }));
    this.current = el('div', { class: 'tn-current' },
      el('div', { class: 'tn-current-head' },
        el('span', { class: 'tn-section-title', text: 'Travaux en cours' }), this.currentEta),
      this.currentName, this.currentBar, this.cancelBtn);
    this.current.hidden = true;

    this.node = el('div', { class: 'tn-dock-panel tn-research' },
      el('div', { class: 'tn-research-head' },
        el('span', { class: 'tn-research-icon', 'aria-hidden': 'true', text: '⌬' }),
        this.scienceNode, this.incomeNode),
      this.current,
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
    const info = el('button', {
      class: 'tn-icon-btn tn-card-info', type: 'button',
      'aria-label': `Détail de la technologie ${tech.name}`, text: 'ⓘ',
    });
    this.tooltip?.attach(info, () => this._tip(tech), { tap: 'always' });
    this._offs.push(on(info, 'click', (e) => e.stopPropagation()));

    const card = el('div', {
      class: 'tn-tech' + (linked ? ' is-linked' : ''), role: 'button', tabindex: '0',
      dataset: { tech: tech.id },
    },
      el('div', { class: 'tn-tech-head' },
        el('span', { class: 'tn-tech-name', text: tech.name }), cost, info),
      el('p', { class: 'tn-tech-desc', text: tech.desc || '' }),
      this._unlockLine(tech),
      state);
    this.tooltip?.attach(card, () => this._tip(tech));
    const activate = () => this._start(tech.id);
    this._offs.push(on(card, 'click', activate));
    this._offs.push(on(card, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    }));
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
    const ref = this.cards.get(id);
    if (ref?.card.getAttribute('aria-disabled') === 'true') {
      const check = this.game.canResearch(id) || {};
      if (check.reason) this.game.bus?.emit('notify', { text: check.reason, kind: 'warn', icon: '⌬' });
      return;
    }
    if (this.game.startResearch(id)) this.refresh();
  }

  /* ------------------------------------------------------------------ */

  update(state) {
    if (!this.node || !state || this.node.hidden) return;
    const science = state.resources?.science ?? 0;
    setText(this.scienceNode, formatNumber(science, 0) + NB + 'science');
    setText(this.incomeNode, formatSigned(state.flux?.science ?? 0, 1) + NB + '/j');

    // Recherche en cours : nom, progression, temps restant, abandon.
    const cur = state.tech?.current || null;
    const curDef = cur ? TECHNOLOGIES[cur] : null;
    this.current.hidden = !curDef;
    if (curDef) {
      const total = Math.round(curDef.cost * BALANCE.research.costScale);
      const done = state.tech?.progress ?? 0;
      setText(this.currentName, curDef.name);
      this.currentBar.setValue(done, total);
      let eta = null;
      if (typeof this.game.researchEta === 'function') {
        try { eta = this.game.researchEta(cur); } catch { eta = null; }
      }
      setText(this.currentEta, Number.isFinite(eta) && eta > 0
        ? `${Math.ceil(eta)}${NB}j restants`
        : `${formatNumber(done, 0)}${NB}/${NB}${total}`);
      this.cancelBtn.hidden = typeof this.game.cancelResearch !== 'function';
    }

    const unlocked = state.tech?.unlocked || [];
    for (const [id, ref] of this.cards) {
      const cost = Math.round(ref.tech.cost * BALANCE.research.costScale);
      setText(ref.cost, String(cost));
      let mod, label;
      if (unlocked.includes(id)) { mod = 'done'; label = 'Acquise'; }
      else if (id === cur) {
        const total = Math.round(ref.tech.cost * BALANCE.research.costScale);
        const done = state.tech?.progress ?? 0;
        mod = 'current';
        label = `En cours · ${((done / Math.max(1, total)) * 100).toFixed(0)}${NB}%`;
      } else {
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
        const off = mod === 'done' || mod === 'locked' || mod === 'current';
        ref.card.setAttribute('aria-disabled', off ? 'true' : 'false');
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

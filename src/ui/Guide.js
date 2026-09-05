/**
 * Guide — le manuel de bord, consultable à tout moment.
 *
 * Il complète le tutoriel sans le remplacer : le tutoriel accompagne la
 * PREMIÈRE partie pas à pas, le guide répond aux questions qui se posent
 * ensuite (« comment rend-on une planète habitable ? », « que faut-il pour
 * gagner ? », « que fait vraiment ce bâtiment ? »).
 *
 * ---------------------------------------------------------------------------
 *  RÈGLES RESPECTÉES
 * ---------------------------------------------------------------------------
 *  1. AUCUNE chaîne de contenu ici : tout vient de `src/data/guide.js`, qui
 *     lit lui-même `balance.js`, `buildings.js` et `technologies.js`.
 *  2. Tout le DOM est créé au montage. `update()` n'écrit que des valeurs —
 *     elle ne crée jamais de nœud, conformément au contrat de `ui.update()`.
 *  3. Utilisable au doigt comme à la souris : sections repliables, cibles de
 *     44 px, défilement vertical uniquement (rien ne déborde en largeur).
 */
import { el, on } from './dom.js';
import { GUIDE_SECTIONS, victoryEntries, buildingEntries, techEntries, SUSTAIN_DAYS, NB } from '../data/guide.js';
import { formatNumber } from '../utils/math.js';

/** Signe moins typographique (U+2212). */
const dec = (v, d) => Number(v).toFixed(d).replace('-', '−');

/** Écriture paresseuse : on n'écrit dans le DOM que si la valeur a changé. */
function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

export class Guide {
  constructor(ctx) {
    this.game = ctx.game;
    this.ui = ctx.ui;
    this.node = null;
    this._offs = [];
    this.sections = new Map();     // id → { head, body, arrow }
    this.liveRows = [];            // lignes de victoire à rafraîchir
  }

  /* =================================================================== */
  /*  MONTAGE — tout le DOM est construit ici, une fois pour toutes.     */
  /* =================================================================== */

  mount() {
    this.toc = el('div', { class: 'tn-guide-toc' });
    this.body = el('div', { class: 'tn-guide-sections' });

    for (const sec of GUIDE_SECTIONS) {
      this.body.appendChild(this._buildSection(sec));
      this.toc.appendChild(this._buildTocChip(sec));
    }

    const expandAll = el('button', {
      class: 'tn-btn tn-btn--small', type: 'button', text: 'Tout déplier',
    });
    const collapseAll = el('button', {
      class: 'tn-btn tn-btn--small', type: 'button', text: 'Tout replier',
    });
    this._offs.push(on(expandAll, 'click', () => this._setAll(true)));
    this._offs.push(on(collapseAll, 'click', () => this._setAll(false)));

    this.node = el('div', { class: 'tn-dock-panel tn-guide' },
      el('p', { class: 'tn-hint', text: 'Manuel de bord. Consultable à tout moment, '
        + 'la simulation continue de tourner derrière.' }),
      this.toc,
      el('div', { class: 'tn-guide-tools' }, expandAll, collapseAll),
      this.body);
    return this.node;
  }

  /** Une pastille de sommaire : elle ouvre la section et l'amène à l'écran. */
  _buildTocChip(sec) {
    const btn = el('button', {
      class: 'tn-guide-chip', type: 'button', dataset: { goto: sec.id },
    },
      el('span', { class: 'tn-guide-chip-icon', 'aria-hidden': 'true', text: sec.icon }),
      el('span', { text: sec.title }));
    this._offs.push(on(btn, 'click', () => this.goTo(sec.id)));
    return btn;
  }

  _buildSection(sec) {
    const arrow = el('span', { class: 'tn-guide-arrow', 'aria-hidden': 'true', text: '▾' });
    const head = el('button', {
      class: 'tn-guide-head', type: 'button', 'aria-expanded': 'false',
      dataset: { section: sec.id },
    },
      el('span', { class: 'tn-guide-icon', 'aria-hidden': 'true', text: sec.icon }),
      el('span', { class: 'tn-guide-titles' },
        el('span', { class: 'tn-guide-title', text: sec.title }),
        el('span', { class: 'tn-guide-lead', text: sec.lead || '' })),
      arrow);

    const body = el('div', { class: 'tn-guide-body', dataset: { body: sec.id } });
    for (const block of sec.blocks) {
      const node = this._buildBlock(block);
      if (node) body.appendChild(node);
    }

    const wrap = el('section', { class: 'tn-guide-section', dataset: { id: sec.id } }, head, body);
    this._offs.push(on(head, 'click', () => this.toggle(sec.id)));
    this.sections.set(sec.id, { wrap, head, body, arrow });
    this.setOpen(sec.id, !!sec.open);
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /*  Blocs                                                             */
  /* ------------------------------------------------------------------ */

  _buildBlock(block) {
    switch (block.kind) {
      case 'p': return el('p', { class: 'tn-guide-p', text: block.text });
      case 'note': return el('p', { class: 'tn-guide-note', text: block.text });
      case 'steps': return this._buildSteps(block.items);
      case 'defs': return this._buildDefs(block.items);
      case 'keys': return this._buildKeys(block.groups);
      case 'victory': return this._buildVictory();
      case 'buildings': return this._buildBuildings();
      case 'tech': return this._buildTech();
      default: return null;
    }
  }

  _buildSteps(items) {
    const list = el('ol', { class: 'tn-guide-steps' });
    items.forEach((s, i) => {
      list.appendChild(el('li', { class: 'tn-guide-step' },
        el('span', { class: 'tn-guide-step-num', 'aria-hidden': 'true', text: String(i + 1).padStart(2, '0') }),
        el('div', { class: 'tn-guide-step-main' },
          el('h3', { class: 'tn-guide-step-title', text: s.title }),
          el('p', { class: 'tn-guide-why' },
            el('b', { text: 'Pourquoi' + NB + '· ' }), s.why),
          el('p', { class: 'tn-guide-how' },
            el('b', { text: 'Comment' + NB + '· ' }), s.how))));
    });
    return list;
  }

  _buildDefs(items) {
    const list = el('dl', { class: 'tn-guide-defs' });
    for (const d of items) {
      list.appendChild(el('div', { class: 'tn-guide-def' },
        el('dt', { class: 'tn-guide-term', text: d.term }),
        el('dd', { class: 'tn-guide-desc', text: d.text })));
    }
    return list;
  }

  _buildKeys(groups) {
    const wrap = el('div', { class: 'tn-guide-keys' });
    for (const g of groups) {
      wrap.appendChild(el('div', { class: 'tn-guide-keys-title', text: g.title }));
      for (const [action, mouse, touch] of g.rows) {
        wrap.appendChild(el('div', { class: 'tn-guide-key' },
          el('span', { class: 'tn-guide-key-action', text: action }),
          el('span', { class: 'tn-guide-key-how' },
            el('em', { text: 'souris' + NB + '· ' }), mouse),
          el('span', { class: 'tn-guide-key-how' },
            el('em', { text: 'tactile' + NB + '· ' }), touch)));
      }
    }
    return wrap;
  }

  /**
   * Les huit conditions de victoire.
   *
   * L'exigence affichée est GÉNÉRÉE depuis BALANCE.victory ; les nombres bruts
   * sont republiés dans `data-nums`, ce qui donne à `tools/guide-check.mjs` un
   * contrat vérifiable : si l'équilibrage change et que le guide ne suit pas,
   * la vérification échoue.
   */
  _buildVictory() {
    const wrap = el('div', { class: 'tn-guide-victory' });
    for (const v of victoryEntries()) {
      const value = el('span', { class: 'tn-guide-vc-now', text: '—' });
      const row = el('div', {
        class: 'tn-guide-vc', dataset: { key: v.key, nums: v.nums.join('|') },
      },
        el('div', { class: 'tn-guide-vc-head' },
          el('span', { class: 'tn-guide-vc-label', text: v.label }),
          el('span', { class: 'tn-guide-vc-target', text: v.target })),
        el('div', { class: 'tn-guide-vc-now-line' },
          el('span', { class: 'tn-guide-vc-now-label', text: 'Actuellement' + NB + '·' }), value),
        el('p', { class: 'tn-guide-vc-line is-up' },
          el('b', { text: 'Monte avec' + NB + '· ' }), v.raise),
        el('p', { class: 'tn-guide-vc-line is-down' },
          el('b', { text: 'Baisse avec' + NB + '· ' }), v.lower));
      wrap.appendChild(row);
      this.liveRows.push({ def: v, node: row, value });
    }
    wrap.appendChild(el('p', { class: 'tn-guide-note',
      text: `Les huit conditions doivent tenir ensemble pendant ${SUSTAIN_DAYS}${NB}jours consécutifs.` }));
    return wrap;
  }

  _buildBuildings() {
    const wrap = el('div', { class: 'tn-guide-table' });
    let category = null;
    for (const b of buildingEntries()) {
      if (b.category !== category) {
        category = b.category;
        wrap.appendChild(el('div', { class: 'tn-guide-group', text: b.categoryName }));
      }
      wrap.appendChild(el('article', { class: 'tn-guide-item', dataset: { building: b.id } },
        el('div', { class: 'tn-guide-item-head' },
          el('span', { class: 'tn-guide-item-icon', 'aria-hidden': 'true', text: b.icon }),
          el('span', { class: 'tn-guide-item-name', text: b.name }),
          el('span', { class: 'tn-guide-item-tier', text: 'T' + b.tier })),
        el('p', { class: 'tn-guide-item-desc', text: b.desc }),
        this._chips('Coût', b.cost.map((c) => c.text)),
        this._chips('Entretien', b.upkeep.map((c) => c.text)),
        this._chips('Production', b.produces.map((c) => c.text)),
        this._chips('Prérequis', b.requires),
        this._effects(b.effects),
        el('div', { class: 'tn-guide-limits', text: b.limits })));
    }
    return wrap;
  }

  _buildTech() {
    const wrap = el('div', { class: 'tn-guide-table' });
    let branch = null;
    for (const t of techEntries()) {
      if (t.branch !== branch) {
        branch = t.branch;
        wrap.appendChild(el('div', { class: 'tn-guide-group', text: t.branchIcon + NB + t.branchName }));
      }
      /* Le coût d'une technologie est long (« 2 400 points de science ») :
         mis dans l'en-tête, il écrasait le nom au point de le couper en deux
         sur un panneau de 300 px. Il prend donc sa propre ligne. */
      wrap.appendChild(el('article', { class: 'tn-guide-item', dataset: { tech: t.id } },
        el('div', { class: 'tn-guide-item-head' },
          el('span', { class: 'tn-guide-item-icon', 'aria-hidden': 'true', text: t.branchIcon }),
          el('span', { class: 'tn-guide-item-name', text: t.name })),
        el('p', { class: 'tn-guide-item-desc', text: t.desc }),
        this._chips('Coût', [t.cost]),
        this._chips('Prérequis', t.requires.length ? t.requires : ['aucun']),
        this._chips('Débloque', t.unlocks),
        this._chips('Effets', t.effects)));
    }
    return wrap;
  }

  /** Une ligne « libellé : pastilles ». Rien n'est créé si la liste est vide. */
  _chips(label, values) {
    if (!values || !values.length) return null;
    const row = el('div', { class: 'tn-guide-chips' },
      el('span', { class: 'tn-guide-chips-label', text: label }));
    for (const v of values) row.appendChild(el('span', { class: 'tn-guide-pill', text: v }));
    return row;
  }

  _effects(list) {
    if (!list || !list.length) return null;
    const row = el('div', { class: 'tn-guide-chips' },
      el('span', { class: 'tn-guide-chips-label', text: 'Effets' }));
    for (const e of list) {
      row.appendChild(el('span', { class: 'tn-guide-pill' + (e.up ? ' is-up' : ' is-down') },
        `${e.label}${NB}${e.value}`));
    }
    return row;
  }

  /* =================================================================== */
  /*  REPLI / DÉPLI                                                      */
  /* =================================================================== */

  setOpen(id, open) {
    const s = this.sections.get(id);
    if (!s) return;
    s.body.hidden = !open;
    s.head.setAttribute('aria-expanded', open ? 'true' : 'false');
    s.wrap.classList.toggle('is-open', open);
    s.arrow.textContent = open ? '▾' : '▸';
  }

  isOpen(id) {
    const s = this.sections.get(id);
    return !!s && !s.body.hidden;
  }

  toggle(id) { this.setOpen(id, !this.isOpen(id)); }

  _setAll(open) { for (const id of this.sections.keys()) this.setOpen(id, open); }

  /** Ouvre une section et l'amène sous les yeux. */
  goTo(id) {
    this.setOpen(id, true);
    const s = this.sections.get(id);
    if (!s) return;
    try { s.head.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    catch { s.head.scrollIntoView(); }
  }

  /* =================================================================== */
  /*  RAFRAÎCHISSEMENT — aucune création de DOM                          */
  /* =================================================================== */

  update(state) {
    if (!this.node || this.node.hidden) return;
    const g = state && state.globals;
    for (const row of this.liveRows) {
      if (!g) { setText(row.value, '—'); continue; }
      let v = 0;
      try { v = row.def.value(g); } catch { v = 0; }
      if (!Number.isFinite(v)) v = 0;
      const text = (Math.abs(v) >= 1000 ? formatNumber(v, 0) : dec(v, row.def.digits))
        + (row.def.unit ? NB + row.def.unit : '');
      setText(row.value, text);
    }
  }

  onShow() { this.update(this.game?.state); }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.sections.clear();
    this.liveRows.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

export default Guide;

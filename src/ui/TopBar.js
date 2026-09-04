/**
 * Barre supérieure : ressources (valeur, flux, remplissage) à gauche,
 * indicateurs planétaires compacts à droite.
 *
 * Chaque indicateur planétaire ouvre au survol une infobulle détaillée
 * construite depuis `state.contributions[...]` : c'est le point de
 * transparence des systèmes de simulation.
 */
import { el, bar } from './dom.js';
import { BALANCE } from '../data/balance.js';
import { formatNumber, formatSigned } from '../utils/math.js';

const NB = '\u00A0';

/** Signe moins typographique (U+2212), et non le trait d'union. */
const dec = (v, digits) => v.toFixed(digits).replace('-', '\u2212');

/** Écriture paresseuse : on n'écrit dans le DOM que si la valeur a changé. */
function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}
function setMod(node, mod, prefix) {
  if (!node || node._mod === mod) return;
  if (node._mod) node.classList.remove(prefix + node._mod);
  node._mod = mod;
  if (mod) node.classList.add(prefix + mod);
}

const RESOURCES = [
  { key: 'energy', name: 'Énergie', icon: '⚡', capped: true, digits: 0 },
  { key: 'materials', name: 'Matériaux', icon: '▤', capped: true, digits: 0 },
  { key: 'science', name: 'Science', icon: '⌬', capped: false, digits: 0 },
  { key: 'biomass', name: 'Biomasse', icon: '❋', capped: false, digits: 1 },
  { key: 'water', name: 'Eau', icon: '≋', capped: true, digits: 0 },
];

const INDICATORS = [
  {
    key: 'temperature', short: 'TMP', name: 'Température', unit: '°C', digits: 1,
    trend: 'dTemperature', trendDigits: 2, contrib: 'temperature', good: 'high',
    // Les lignes de contribution somment la température D'ÉQUILIBRE, que la
    // température réelle rejoint lentement : le total ne doit donc pas être
    // présenté comme la valeur affichée. Voir PLAYTEST I1.
    equilibrium: true,
    desc: 'Température moyenne de surface. Cible de mission : entre 0 et 30 °C.',
  },
  {
    key: 'pressure', short: 'PRS', name: 'Pression', unit: 'kPa', digits: 1,
    trend: 'dPressure', trendDigits: 2, contrib: 'pressure', good: 'high',
    desc: 'Pression atmosphérique totale. L’eau liquide exige plus de 6.1 kPa.',
  },
  {
    key: 'oxygen', short: 'O₂', name: 'Oxygène', unit: '%', digits: 2,
    trend: 'dOxygen', trendDigits: 3, contrib: 'oxygen', good: 'high',
    desc: 'Part d’oxygène dans l’atmosphère. Respirable au-delà de 16 %.',
  },
  {
    key: 'waterCoverage', short: 'H₂O', name: 'Eau libre', unit: '%', digits: 1, scale: 100,
    trendHistory: 'water', trendDigits: 2, contrib: 'water', good: 'high',
    desc: 'Fraction de la surface couverte d’eau liquide.',
  },
  {
    key: 'biomass', short: 'BIO', name: 'Biomasse', unit: '', digits: 1,
    trend: 'dBiomass', trendDigits: 2, contrib: 'biomass', good: 'high',
    desc: 'Indice global de biosphère, de 0 à 100.',
  },
  {
    key: 'stability', short: 'STB', name: 'Stabilité', unit: '%', digits: 0,
    trendLocal: true, trendDigits: 2, contrib: 'stability', good: 'high',
    desc: 'Résilience du système planétaire. Sous 45 %, les incidents se multiplient.',
  },
];

export class TopBar {
  constructor(ctx) {
    this.game = ctx.game;
    this.tooltip = ctx.tooltip;
    this.node = null;
    this.res = new Map();
    this.ind = new Map();
    this._stab = { day: -1, value: 0, rate: 0 };
  }

  mount() {
    const resWrap = el('div', { class: 'tn-res' });
    for (const r of RESOURCES) {
      const value = el('span', { class: 'tn-res-value' });
      const flux = el('span', { class: 'tn-res-flux' });
      const fill = r.capped ? bar(0, 1, 'tn-bar--thin') : null;
      const cell = el('div', { class: 'tn-res-cell' },
        el('span', { class: 'tn-res-icon', 'aria-hidden': 'true', text: r.icon }),
        el('div', { class: 'tn-res-main' },
          el('div', { class: 'tn-res-line' }, value, flux),
          fill),
        );
      cell.setAttribute('aria-label', r.name);
      this.res.set(r.key, { def: r, cell, value, flux, fill });
      this.tooltip?.attach(cell, () => this._resourceTip(r));
      resWrap.appendChild(cell);
    }

    const indWrap = el('div', { class: 'tn-ind' });
    for (const g of INDICATORS) {
      const value = el('span', { class: 'tn-ind-value' });
      const trend = el('span', { class: 'tn-ind-trend' });
      const cell = el('div', { class: 'tn-ind-cell', tabindex: '0' },
        el('span', { class: 'tn-ind-label', text: g.short }),
        el('div', { class: 'tn-ind-main' }, value, trend));
      cell.setAttribute('aria-label', g.name);
      this.ind.set(g.key, { def: g, cell, value, trend });
      this.tooltip?.attach(cell, () => this._indicatorTip(g));
      indWrap.appendChild(cell);
    }

    this.node = el('header', { class: 'tn-topbar', role: 'region', 'aria-label': 'Ressources et état planétaire' },
      resWrap, indWrap);
    return this.node;
  }

  /* ------------------------------------------------------------------ */
  /*  MISE À JOUR (~10 Hz) — aucune création de DOM ici                  */
  /* ------------------------------------------------------------------ */

  update(state) {
    if (!state) return;
    const capacity = state.capacity || {};
    for (const [key, ref] of this.res) {
      const v = state.resources?.[key] ?? 0;
      setText(ref.value, formatNumber(v, ref.def.digits));
      const f = state.flux?.[key] ?? 0;
      setText(ref.flux, formatSigned(f, 1) + NB + '/j');
      setMod(ref.flux, f > 0.01 ? 'up' : f < -0.01 ? 'down' : 'flat', 'is-');
      if (ref.fill) {
        const cap = capacity[key] ?? 0;
        const ratio = ref.fill.setValue(v, cap);
        setMod(ref.fill, cap > 0 && ratio > 0.985 ? 'full' : cap > 0 && ratio < 0.08 ? 'low' : '', 'is-');
      }
    }

    const g = state.globals || {};
    this._trackStability(state);
    for (const [key, ref] of this.ind) {
      const def = ref.def;
      const raw = g[key] ?? 0;
      const v = raw * (def.scale || 1);
      setText(ref.value, dec(v, def.digits) + (def.unit ? NB + def.unit : ''));
      const rate = this._rate(state, def);
      if (rate === null) setText(ref.trend, '');
      else {
        const arrow = rate > 1e-4 ? '▲' : rate < -1e-4 ? '▼' : '·';
        setText(ref.trend, arrow + NB + formatSigned(rate, def.trendDigits) + '/an');
        setMod(ref.trend, rate > 1e-4 ? 'up' : rate < -1e-4 ? 'down' : 'flat', 'is-');
      }
      setMod(ref.cell, this._alertLevel(def, raw), 'is-');
    }
  }

  /** Variation annuelle d'un indicateur. */
  _rate(state, def) {
    const g = state.globals || {};
    if (def.trend && Number.isFinite(g[def.trend])) return g[def.trend] * (def.scale || 1);
    if (def.trendLocal) return this._stab.rate;
    if (def.trendHistory) {
      const h = state.history || {};
      const days = h.day, series = h[def.trendHistory];
      if (days && series && days.length >= 2) {
        const n = days.length - 1;
        const dd = days[n] - days[Math.max(0, n - 3)];
        if (dd > 0) return (series[n] - series[Math.max(0, n - 3)]) / dd * 365;
      }
      return 0;
    }
    return null;
  }

  /** La stabilité n'a pas de dérivée fournie : on l'échantillonne ici. */
  _trackStability(state) {
    const day = state.time?.day ?? 0;
    const v = state.globals?.stability ?? 0;
    if (this._stab.day < 0 || day < this._stab.day) { this._stab = { day, value: v, rate: 0 }; return; }
    const dd = day - this._stab.day;
    if (dd >= 10) {
      this._stab.rate = (v - this._stab.value) / dd * 365;
      this._stab.day = day; this._stab.value = v;
    }
  }

  _alertLevel(def, value) {
    if (def.key === 'stability') {
      if (value < 25) return 'danger';
      if (value < 45) return 'warn';
    }
    if (def.key === 'temperature' && value > 45) return 'warn';
    return '';
  }

  /* ------------------------------------------------------------------ */
  /*  INFOBULLES                                                         */
  /* ------------------------------------------------------------------ */

  _resourceTip(def) {
    const state = this.game.state;
    if (!state) return null;
    const v = state.resources?.[def.key] ?? 0;
    const f = state.flux?.[def.key] ?? 0;
    const cap = state.capacity?.[def.key] ?? 0;
    const rows = [
      tipTitle(def.name, formatNumber(v, 2)),
      tipRow('Flux net', formatSigned(f, 2) + NB + '/j', f),
    ];
    if (def.capped) rows.push(tipRow('Capacité', cap > 0 ? formatNumber(cap, 0) : '—', 0));
    if (def.key === 'energy') {
      const p = state.power || {};
      rows.push(tipSep());
      rows.push(tipRow('Production', formatNumber(p.production ?? 0, 1) + NB + '/j', 1));
      rows.push(tipRow('Consommation', formatNumber(p.consumption ?? 0, 1) + NB + '/j', -1));
      rows.push(tipRow('Satisfaction du réseau', ((p.satisfaction ?? 1) * 100).toFixed(0) + NB + '%',
        (p.satisfaction ?? 1) >= 0.99 ? 1 : -1));
      const contrib = state.contributions?.energy;
      if (Array.isArray(contrib) && contrib.length) {
        rows.push(tipSep());
        for (const c of contrib.slice(0, 10)) {
          rows.push(tipRow(c.label, formatSigned(c.value, 1) + NB + (c.unit || '/j'), c.value));
        }
      }
    }
    if (cap > 0 && v >= cap * 0.999) {
      rows.push(tipNote('Stock plein : la production excédentaire est perdue.'));
    }
    return el('div', { class: 'tn-tip' }, rows);
  }

  _indicatorTip(def) {
    const state = this.game.state;
    if (!state) return null;
    const raw = state.globals?.[def.key] ?? 0;
    const v = raw * (def.scale || 1);
    // Le titre n'est pas mis en majuscules ici : la règle CSS `text-transform`
    // emportait aussi l'unité (« 1.5 KPA »). Voir PLAYTEST C11.
    const rows = [
      tipTitle(def.name, dec(v, def.digits) + (def.unit ? NB + def.unit : '')),
    ];
    const rate = this._rate(state, def);
    if (rate !== null) {
      rows.push(tipRow('Variation', formatSigned(rate, def.trendDigits) + NB + (def.unit || 'pt') + '/an', rate));
    }
    const contrib = def.contrib ? state.contributions?.[def.contrib] : null;
    if (Array.isArray(contrib) && contrib.length) {
      rows.push(tipSep());
      let total = 0;
      let unit = '';
      for (const c of contrib) {
        // L'unité de chaque ligne est portée par la simulation : sans elle, on
        // empile des °C, des kPa/an et des points sans le dire. Voir I1.
        const u = c.unit ? NB + c.unit : '';
        if (c.unit) unit = c.unit;
        rows.push(tipRow(c.label, formatSigned(c.value, 2) + u, c.value));
        total += c.value || 0;
      }
      rows.push(tipSep());
      const totalUnit = unit ? NB + unit : '';
      if (def.equilibrium) {
        rows.push(tipRow('Équilibre visé', formatSigned(total, 2) + totalUnit, total, 'is-total'));
        const gap = total - v;
        rows.push(tipRow('Écart à combler', formatSigned(gap, 2) + totalUnit, gap));
        const perYear = 1 - Math.pow(1 - (BALANCE.climate?.inertia ?? 0), 365);
        rows.push(tipRow('Vitesse de convergence', (perYear * 100).toFixed(0) + NB + '%' + NB + 'de l’écart/an', 0));
        rows.push(tipNote('La valeur affichée poursuit l’équilibre sans jamais l’atteindre d’un coup : agir déplace d’abord l’équilibre, la planète suit ensuite.'));
      } else {
        rows.push(tipRow('Total', formatSigned(total, 2) + totalUnit, total, 'is-total'));
      }
      if (def.key === 'oxygen') {
        rows.push(tipNote('Les lignes ci-dessus décrivent le réservoir d’O₂ en kPa/an ; la valeur en tête est sa part dans l’atmosphère.'));
      }
    } else if (def.contrib) {
      rows.push(tipSep());
      rows.push(tipRow('Décomposition', 'indisponible', 0));
    }
    rows.push(tipNote(def.desc));
    return el('div', { class: 'tn-tip' }, rows);
  }

  destroy() { this.node?.remove(); this.node = null; this.res.clear(); this.ind.clear(); }
}

/* -------------------------------------------------------------------- */
/*  Petits constructeurs de lignes d'infobulle                           */
/* -------------------------------------------------------------------- */

export function tipTitle(label, value) {
  return el('div', { class: 'tn-tip-title' },
    el('span', { text: label }), el('b', { text: value ?? '' }));
}

export function tipRow(label, value, sign = 0, extra = '') {
  const cls = 'tn-tip-row' + (extra ? ' ' + extra : '') +
    (sign > 0 ? ' is-up' : sign < 0 ? ' is-down' : '');
  return el('div', { class: cls },
    el('span', { class: 'tn-tip-label', text: label }),
    el('span', { class: 'tn-tip-value', text: value }));
}

export function tipSep() { return el('div', { class: 'tn-tip-sep' }); }

export function tipNote(text) { return text ? el('p', { class: 'tn-tip-note', text }) : null; }

export default TopBar;

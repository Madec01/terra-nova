/**
 * Panneau de droite : fiche complète du secteur sélectionné.
 * Lit exclusivement `game.regions.getRegionView(id)` et l'état de jeu.
 */
import { el, clear, bar, on } from './dom.js';
import { sheetDrag } from './sheet.js';
import { BALANCE } from '../data/balance.js';
import { BIOMES } from '../data/biomes.js';
import { BUILDINGS } from '../data/buildings.js';
import { formatNumber, formatSigned, formatLatLon, toLatLon, clamp } from '../utils/math.js';

const NB = '\u00A0';

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}
function setMod(node, mod, prefix = 'is-') {
  if (!node || node._mod === mod) return;
  if (node._mod) node.classList.remove(prefix + node._mod);
  node._mod = mod;
  if (mod) node.classList.add(prefix + mod);
}

/** Lignes 0..1 affichées sous forme de barre fine. */
const RATIO_ROWS = [
  { key: 'moisture', label: 'Humidité' },
  { key: 'ice', label: 'Glace' },
  { key: 'water', label: 'Eau libre' },
  { key: 'vegetation', label: 'Végétation' },
  { key: 'pollution', label: 'Pollution', invert: true },
  { key: 'minerals', label: 'Minerais' },
  { key: 'geothermal', label: 'Géothermie' },
  { key: 'radiation', label: 'Radiation', invert: true },
  { key: 'habitability', label: 'Habitabilité', strong: true },
];

export class RegionPanel {
  constructor(ctx) {
    this.game = ctx.game;
    this.scene = ctx.scene;
    this.ui = ctx.ui;
    this.tooltip = ctx.tooltip;
    this.node = null;
    this.body = null;
    this.regionId = null;
    this.refs = null;
    this._signature = '';
    this._confirmId = null;
    this._confirmTimer = 0;
    this.expanded = true;      // sur téléphone, la feuille s'ouvre « réduite »
    this._suppressed = false;  // masquée au profit d'une autre feuille
    this._offs = [];
  }

  mount() {
    this.titleNode = el('span', { class: 'tn-panel-title' });
    this.coordNode = el('span', { class: 'tn-region-coords' });
    this.body = el('div', { class: 'tn-panel-body' });

    const focusBtn = el('button', {
      class: 'tn-icon-btn', type: 'button', 'aria-label': 'Centrer la caméra sur ce secteur',
      'data-tip': 'Centrer la caméra', text: '◎',
    });
    const closeBtn = el('button', {
      class: 'tn-icon-btn', type: 'button', 'aria-label': 'Fermer la fiche du secteur', text: '×',
    });
    const collapseBtn = el('button', {
      class: 'tn-icon-btn tn-collapse', type: 'button', 'aria-label': 'Replier le panneau', text: '▾',
    });

    this._offs.push(on(focusBtn, 'click', () => {
      if (this.regionId != null) this.scene?.focusRegion?.(this.regionId);
    }));
    this._offs.push(on(closeBtn, 'click', () => this.game.selectRegion(null)));
    this.collapseBtn = collapseBtn;
    this._offs.push(on(collapseBtn, 'click', () => this.toggleExpanded()));

    this.grab = el('button', {
      class: 'tn-sheet-grab', type: 'button',
      'aria-label': 'Déplier, replier ou fermer la fiche du secteur',
    }, el('i', { 'aria-hidden': 'true' }));
    this._offs.push(on(this.grab, 'click', () => this.toggleExpanded()));

    this.node = el('aside', {
      class: 'tn-panel tn-region', role: 'region', 'aria-label': 'Secteur sélectionné',
    },
      this.grab,
      el('header', { class: 'tn-panel-head' },
        el('div', { class: 'tn-panel-head-main' }, this.titleNode, this.coordNode),
        el('div', { class: 'tn-panel-head-tools' }, focusBtn, collapseBtn, closeBtn)),
      this.body);
    this.node.hidden = true;

    // Glisser vers le bas replie puis ferme ; glisser vers le haut déplie.
    this._offs.push(sheetDrag(this.node, this.grab, {
      enabled: () => this.ui?.isPhone === true,
      expanded: () => this.expanded,
      onExpand: () => this.setExpanded(true),
      onCollapse: () => this.setExpanded(false),
      onClose: () => this.game.selectRegion(null),
    }));
    return this.node;
  }

  /* ------------------------------------------------------------------ */
  /*  SÉLECTION                                                          */
  /* ------------------------------------------------------------------ */

  setRegion(id) {
    this.regionId = (id == null || id < 0) ? null : id;
    this._signature = '';
    this._confirmId = null;
    // Sur téléphone la fiche s'ouvre réduite : la planète reste visible.
    this.expanded = !this.ui?.isPhone;
    this.rebuild();
  }

  /**
   * Masque la fiche sans perdre la sélection : sur téléphone une seule
   * feuille est ouverte à la fois.
   */
  suppress(on_) {
    const v = !!on_;
    if (this._suppressed === v) return;
    this._suppressed = v;
    this._applyVisibility();
  }

  setExpanded(v) {
    this.expanded = !!v;
    this._applyState();
  }

  toggleExpanded() { this.setExpanded(!this.expanded); }

  _applyState() {
    if (!this.node) return;
    // Le repli existe aussi à la souris : le chevron de l'en-tête doit agir
    // partout, pas seulement sur téléphone.
    this.node.classList.toggle('is-peek', !this.expanded);
    if (this.collapseBtn) {
      this.collapseBtn.textContent = this.expanded ? '▾' : '▴';
      this.collapseBtn.setAttribute('aria-label', this.expanded ? 'Réduire la fiche' : 'Déplier la fiche');
    }
  }

  _applyVisibility() {
    if (!this.node) return;
    const none = this.regionId == null || !this.game.regions || this.regionId >= this.game.regions.count;
    this.node.hidden = none || this._suppressed;
    this.node.classList.toggle('has-region', !none);
  }

  /** Reconstruction complète du corps du panneau (rare). */
  rebuild() {
    if (!this.node) return;
    const id = this.regionId;
    const regions = this.game.regions;
    if (id == null || !regions || id >= regions.count) {
      this._applyVisibility();
      this.refs = null;
      clear(this.body);
      return;
    }
    this._applyVisibility();
    this._applyState();

    const view = this._view(id);
    setText(this.titleNode, 'Secteur ' + String(id).padStart(3, '0'));
    setText(this.coordNode, this._coords(id, view));

    clear(this.body);
    this.refs = { rows: new Map(), buildings: new Map() };

    if (!view.discovered) { this._buildUndiscovered(view); return; }
    this._buildDiscovered(view);
    this.update(this.game.state);
  }

  _view(id) {
    try {
      const v = this.game.regions.getRegionView(id);
      if (v && typeof v === 'object') return v;
    } catch (err) { console.warn('[RegionPanel] getRegionView', err); }
    return { id, discovered: 0 };
  }

  _coords(id, view) {
    const R = this.game.regions;
    let x = null, y = null, z = null;
    if (Array.isArray(view.position) && view.position.length >= 3) [x, y, z] = view.position;
    else if (Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.z)) { x = view.x; y = view.y; z = view.z; }
    else if (R?.positions && R.positions.length >= (id + 1) * 3) {
      x = R.positions[id * 3]; y = R.positions[id * 3 + 1]; z = R.positions[id * 3 + 2];
    }
    if (x !== null) {
      const { lat, lon } = toLatLon(x, y, z);
      return formatLatLon(lat, lon);
    }
    const s = Number.isFinite(view.latitude) ? view.latitude : 0;
    const lat = Math.asin(clamp(s, -1, 1)) * 180 / Math.PI;
    return `${Math.abs(lat).toFixed(1)}°${NB}${lat >= 0 ? 'N' : 'S'}`;
  }

  /* ------------------------------------------------------------------ */
  /*  SECTEUR NON CARTOGRAPHIÉ                                           */
  /* ------------------------------------------------------------------ */

  _buildUndiscovered(view) {
    const days = Math.round(BALANCE.exploration.scanDays / (this.game.techEffects?.scanSpeed || 1));
    const cost = BALANCE.exploration.scanCost || {};
    const costText = Object.keys(cost).map((k) => `${cost[k]}${NB}${labelResource(k)}`).join(', ') || 'gratuit';

    const btn = el('button', {
      class: 'tn-btn tn-btn--primary tn-btn--wide', type: 'button', dataset: { action: 'scan' },
    },
      el('span', { text: 'Lancer un scan orbital' }),
      el('small', { text: `${costText} · ${days}${NB}j` }));
    const chain = el('button', { class: 'tn-btn tn-btn--wide', type: 'button' },
      el('span', { text: 'Enchaîner les scans' }),
      el('small', { text: 'chaque appui sur un secteur sombre met un scan en file' }));
    const cancel = el('button', { class: 'tn-btn tn-btn--wide', type: 'button', text: 'Annuler ce scan' });
    cancel.hidden = true;

    const hint = el('p', { class: 'tn-hint' });
    const fleet = el('p', { class: 'tn-hint tn-scan-fleet' });
    const status = el('div', { class: 'tn-scan-state' });
    const progWrap = el('div', { class: 'tn-scan' },
      el('div', { class: 'tn-row-label', text: 'Scan en cours' }),
      el('span', { class: 'tn-scan-eta' }));
    const progBar = bar(0, 1, 'tn-bar--accent');
    progWrap.insertBefore(progBar, progWrap.lastChild);
    progWrap.hidden = true;

    this._offs.push(on(btn, 'click', () => {
      if (this.regionId == null) return;
      this.game.scanRegion(this.regionId);
      this.rebuild();
    }));
    this._offs.push(on(chain, 'click', () => this.ui?.toggleScanMode?.()));
    this._offs.push(on(cancel, 'click', () => {
      if (this.regionId == null) return;
      if (typeof this.game.cancelScan === 'function') this.game.cancelScan(this.regionId);
      this.rebuild();
    }));

    this.body.appendChild(el('div', { class: 'tn-region-summary tn-unknown' },
      el('div', { class: 'tn-unknown-title', text: 'Secteur non cartographié' }),
      el('p', { class: 'tn-hint', text: 'Aucune donnée orbitale. Un scan révèle son relief, ses ressources, son climat — et souvent ses voisins.' }),
      status, progWrap, btn, cancel, chain, hint, fleet));

    this.refs.scan = {
      btn, chain, cancel, hint, fleet, status, progWrap, progBar,
      eta: progWrap.querySelector('.tn-scan-eta'),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  SECTEUR CARTOGRAPHIÉ                                               */
  /* ------------------------------------------------------------------ */

  _buildDiscovered(view) {
    const refs = this.refs;

    // --- bandeau de placement -----------------------------------------
    refs.placeStrip = el('div', { class: 'tn-place-strip' });
    refs.placeStrip.hidden = true;
    this.body.appendChild(refs.placeStrip);

    /* --- L'ESSENTIEL -------------------------------------------------
       Ce bloc reste visible même quand la feuille est réduite sur
       téléphone : biome, température, habitabilité, action principale. */
    refs.biome = el('span', { class: 'tn-badge' });
    refs.anomaly = el('span', { class: 'tn-badge tn-badge--anomaly', text: 'Anomalie' });
    refs.anomaly.hidden = true;
    refs.landing = el('span', { class: 'tn-badge tn-badge--landing', text: 'Site d’atterrissage' });
    refs.landing.hidden = true;

    const mini = el('div', { class: 'tn-kv tn-kv--mini' });
    refs.temperature = this._kv(mini, 'Température');
    refs.habitability = this._kv(mini, 'Habitabilité');
    refs.buildCount = this._kv(mini, 'Installations');

    const buildBtn = el('button', {
      class: 'tn-btn tn-btn--primary tn-btn--wide', type: 'button',
      dataset: { action: 'build' }, text: 'Construire ici',
    });
    this._offs.push(on(buildBtn, 'click', () => this.ui?.openBuildMenuFor?.(this.regionId)));

    this.body.appendChild(el('div', { class: 'tn-region-summary' },
      el('div', { class: 'tn-badges' }, refs.biome, refs.anomaly, refs.landing),
      mini, buildBtn));

    // --- LE DÉTAIL (replié sur téléphone) ------------------------------
    const details = el('div', { class: 'tn-region-details' });

    const grid = el('div', { class: 'tn-kv' });
    refs.elevation = this._kv(grid, 'Altitude');
    refs.population = this._kv(grid, 'Population');
    details.appendChild(grid);

    details.appendChild(el('div', { class: 'tn-section-title', text: 'Relevés de surface' }));
    const list = el('div', { class: 'tn-rows' });
    for (const row of RATIO_ROWS) {
      const value = el('span', { class: 'tn-row-value' });
      const b = bar(0, 1, row.strong ? 'tn-bar--accent' : '');
      const node = el('div', { class: 'tn-row' + (row.invert ? ' tn-row--invert' : '') },
        el('span', { class: 'tn-row-label', text: row.label }), b, value);
      list.appendChild(node);
      refs.rows.set(row.key, { def: row, value, bar: b });
    }
    details.appendChild(list);

    refs.buildTitle = el('div', { class: 'tn-section-title', text: 'Installations' });
    refs.buildList = el('div', { class: 'tn-blist' });
    details.appendChild(refs.buildTitle);
    details.appendChild(refs.buildList);

    this.body.appendChild(details);
  }

  _kv(parent, label) {
    const v = el('span', { class: 'tn-kv-value' });
    parent.appendChild(el('div', { class: 'tn-kv-cell' },
      el('span', { class: 'tn-kv-label', text: label }), v));
    return v;
  }

  /* ------------------------------------------------------------------ */
  /*  MISE À JOUR                                                        */
  /* ------------------------------------------------------------------ */

  update(state) {
    if (!this.node || this.node.hidden || this.regionId == null || !state) return;
    const id = this.regionId;
    const regions = this.game.regions;
    if (!regions || id >= regions.count) return;
    const view = this._view(id);
    const refs = this.refs;
    if (!refs) return;

    // Le secteur vient d'être découvert : on reconstruit.
    if (!!view.discovered !== !!refs.rows.size && !refs.scan) { this.rebuild(); return; }
    if (refs.scan && view.discovered) { this.rebuild(); return; }

    if (refs.scan) { this._updateScan(state, refs.scan); return; }

    setText(refs.biome, biomeName(view.biome));
    refs.anomaly.hidden = !view.anomaly;
    refs.landing.hidden = !(view.isLandingSite || this.game.regions?.landingSite === this.regionId);

    setText(refs.temperature, (view.temperature ?? 0).toFixed(1).replace('-', '−') + NB + '°C');
    setText(refs.habitability, ((view.habitability ?? 0) * 100).toFixed(0) + NB + '%');
    setText(refs.elevation, elevationLabel(view.elevation ?? 0));
    const pop = view.population ?? 0;
    setText(refs.population, pop >= 1 ? formatNumber(pop, 0) + NB + 'hab.' : '—');
    setText(refs.buildCount, String(view.buildingCount ?? 0));

    for (const [key, ref] of refs.rows) {
      const v = Math.max(0, Math.min(1, view[key] ?? 0));
      ref.bar.setValue(v, 1);
      setText(ref.value, (v * 100).toFixed(0) + NB + '%');
      if (ref.def.invert) setMod(ref.bar, v > 0.6 ? 'danger' : v > 0.3 ? 'warn' : '');
      else if (ref.def.strong) setMod(ref.bar, v > 0.45 ? 'good' : '');
    }

    this._updateBuildings(state, view);
    this._updatePlacement(state);
  }

  _updateScan(state, scan) {
    const id = this.regionId;
    const ex = state.explore || {};
    const running = (ex.scanning || []).find((s) => s.region === id);
    const queue = Array.isArray(ex.queue) ? ex.queue : null;
    const qIndex = queue ? queue.findIndex((q) => (q?.region ?? q) === id) : -1;

    // Flotte : sondes libres et file d'attente, quand l'API les expose.
    const total = Math.max(0, ex.probes ?? 0) * (BALANCE.exploration.scansPerProbe || 1);
    const busy = ex.scanning?.length ?? 0;
    const free = Number.isFinite(ex.probesFree) ? ex.probesFree : Math.max(0, total - busy);
    const parts = [`${free}${NB}sonde${free > 1 ? 's' : ''} libre${free > 1 ? 's' : ''} sur ${total}`];
    if (queue) parts.push(`${queue.length}${NB}en file`);
    setText(scan.fleet, parts.join(' · '));

    const chaining = this.ui?.scanMode === true;
    setText(scan.chain.firstChild, chaining ? 'Arrêter l’enchaînement' : 'Enchaîner les scans');
    scan.chain.classList.toggle('is-active', chaining);

    if (running) {
      scan.progWrap.hidden = false;
      const totalDays = running.total || BALANCE.exploration.scanDays;
      const done = Math.max(0, totalDays - (running.remaining ?? 0));
      scan.progBar.setValue(done, totalDays);
      setText(scan.eta, `${Math.ceil(running.remaining ?? 0)}${NB}j restants`);
      setText(scan.status, 'Sonde en approche');
      scan.status.hidden = false;
      scan.btn.hidden = true;
      scan.cancel.hidden = typeof this.game.cancelScan !== 'function';
      setText(scan.hint, '');
      return;
    }

    scan.progWrap.hidden = true;
    if (qIndex >= 0) {
      setText(scan.status, `En file d’attente · position ${qIndex + 1}`);
      scan.status.hidden = false;
      scan.btn.hidden = true;
      scan.cancel.hidden = typeof this.game.cancelScan !== 'function';
      setText(scan.hint, 'Une sonde s’en chargera dès qu’elle se libère.');
      return;
    }

    scan.status.hidden = true;
    scan.cancel.hidden = true;
    scan.btn.hidden = false;
    const reason = this._scanBlockReason(state);
    scan.btn.disabled = !!reason;
    setText(scan.hint, reason || '');
  }

  _scanBlockReason(state) {
    const ex = state.explore || {};
    const cost = BALANCE.exploration.scanCost || {};
    for (const k in cost) {
      if ((state.resources?.[k] ?? 0) < cost[k]) {
        return `${labelResource(k)}${NB}: ${cost[k]} requis, ${Math.floor(state.resources?.[k] ?? 0)} disponibles.`;
      }
    }
    // Avec une file d'attente, une sonde occupée n'empêche plus de demander un
    // scan : la demande est simplement empilée.
    if (Array.isArray(ex.queue)) return '';
    const slots = Math.max(0, (ex.probes ?? 0)) * (BALANCE.exploration.scansPerProbe || 1);
    if (slots > 0 && (ex.scanning?.length ?? 0) >= slots) {
      return `Toutes les sondes sont occupées (${ex.scanning.length}/${slots}).`;
    }
    return '';
  }

  _updateBuildings(state, view) {
    const refs = this.refs;
    const list = (state.buildings || []).filter((b) => b.region === this.regionId);
    const sig = list.map((b) => `${b.id}:${b.type}:${b.active ? 1 : 0}`).join('|') + '#' + (this._confirmId ?? '');
    if (sig !== this._signature) {
      this._signature = sig;
      clear(refs.buildList);
      refs.buildings.clear();
      refs.buildTitle.hidden = list.length === 0;
      refs.buildList.hidden = list.length === 0;
      for (const b of list) refs.buildList.appendChild(this._buildingCard(b, state, view));
    }
    // Valeurs de production, rafraîchies à chaque passage.
    for (const [bid, ref] of refs.buildings) {
      const b = list.find((x) => x.id === bid);
      if (!b) continue;
      setText(ref.output, this._outputText(b, state, view));
      setMod(ref.card, b.active === false ? 'off' : '');
    }
  }

  _buildingCard(b, state, view) {
    const def = BUILDINGS[b.type] || { name: b.type, icon: '▢' };
    const output = el('div', { class: 'tn-bcard-out' });
    const confirming = this._confirmId === b.id;
    const del = el('button', {
      class: 'tn-icon-btn tn-danger' + (confirming ? ' is-armed' : ''), type: 'button',
      'aria-label': confirming ? 'Confirmer la démolition' : 'Démolir cette installation',
      text: confirming ? '✓' : '⨯',
    });
    this._offs.push(on(del, 'click', () => this._askDemolish(b.id)));

    const card = el('div', { class: 'tn-bcard' },
      el('span', { class: 'tn-bcard-icon', 'aria-hidden': 'true', text: def.icon || '▢' }),
      el('div', { class: 'tn-bcard-main' },
        el('div', { class: 'tn-bcard-name', text: def.name }),
        output,
        confirming ? el('div', { class: 'tn-bcard-confirm', text: 'Démolir ? 40 % des matériaux sont récupérés.' }) : null),
      del);
    this.refs.buildings.set(b.id, { card, output });
    return card;
  }

  _askDemolish(id) {
    clearTimeout(this._confirmTimer);
    if (this._confirmId === id) {
      this._confirmId = null;
      this.game.demolish(id);
      this._signature = '';
      return;
    }
    this._confirmId = id;
    this._signature = '';
    this._confirmTimer = setTimeout(() => {
      if (this._confirmId === id) { this._confirmId = null; this._signature = ''; this.update(this.game.state); }
    }, 4000);
    this.update(this.game.state);
  }

  /** Production réelle estimée d'un bâtiment (par jour). */
  _outputText(b, state, view) {
    const def = BUILDINGS[b.type];
    if (!def) return '';
    if (b.active === false) return 'Hors service — approvisionnement insuffisant';
    const parts = [];
    const scale = safeScale(def, view, state);
    const mult = this.game.techEffects?.productionMultiplier || {};
    for (const k in (def.produces || {})) {
      const v = def.produces[k] * scale * (mult[k] ?? 1);
      if (Math.abs(v) < 1e-4) continue;
      parts.push(`+${v.toFixed(1)}${NB}${labelResource(k)}`);
    }
    for (const k in (def.upkeep || {})) {
      const v = def.upkeep[k];
      if (!v) continue;
      parts.push(`−${v.toFixed(1)}${NB}${labelResource(k)}`);
    }
    if (def.colony && b.population) parts.push(`${formatNumber(b.population, 0)}${NB}hab.`);
    return parts.length ? parts.join('  ') + NB + '/j' : 'Effet planétaire continu';
  }

  /* ------------------------------------------------------------------ */
  /*  MODE PLACEMENT                                                     */
  /* ------------------------------------------------------------------ */

  _updatePlacement(state) {
    const strip = this.refs?.placeStrip;
    if (!strip) return;
    const type = this.ui?.placingType;
    if (!type) { strip.hidden = true; return; }
    const def = BUILDINGS[type];
    const check = this.game.canBuild(type, this.regionId) || { ok: false };
    strip.hidden = false;
    setMod(strip, check.ok ? 'ok' : 'ko');
    const text = check.ok
      ? `Placement possible${NB}: ${def?.name ?? type}`
      : (check.reason || 'Placement impossible ici.');
    if (strip._t !== text) {
      strip._t = text;
      clear(strip);
      strip.appendChild(el('span', { class: 'tn-place-icon', 'aria-hidden': 'true', text: check.ok ? '✓' : '⚠' }));
      strip.appendChild(el('span', { text }));
    }
  }

  destroy() {
    clearTimeout(this._confirmTimer);
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

/* -------------------------------------------------------------------- */

export function safeScale(def, view, state) {
  if (typeof def.outputScale !== 'function') return 1;
  try {
    const v = def.outputScale(view, state);
    return Number.isFinite(v) ? v : 1;
  } catch { return 1; }
}

export function labelResource(key) {
  return ({
    energy: 'énergie', materials: 'matériaux', science: 'science',
    biomass: 'biomasse', water: 'eau',
  })[key] || key;
}

function biomeName(index) {
  const b = BIOMES[index ?? 0];
  return b ? b.name : 'Inconnu';
}

function elevationLabel(e) {
  const sea = BALANCE.planet.seaLevel;
  const rel = e - sea;
  const tag = rel < 0 ? 'bassin' : rel > 0.45 ? 'sommet' : 'plateau';
  return `${formatSigned(e, 2)} · ${tag}`;
}

export default RegionPanel;

/**
 * UIManager — assemble et pilote toute l'interface.
 *
 *   new UIManager(root, game, scene) ; ui.mount() ; ui.update(state) ; ui.destroy()
 *
 * Règles :
 *  - l'état n'est JAMAIS modifié directement : tout passe par `game`
 *  - `update()` est appelée ~10 fois par seconde : elle ne crée pas de DOM,
 *    elle n'écrit que les valeurs qui ont changé
 */
import { el, clear, on } from './dom.js';
import { BUILDINGS } from '../data/buildings.js';
import { TECH_LIST } from '../data/technologies.js';
import { makeSeedLabel } from '../utils/rng.js';
import { formatNumber } from '../utils/math.js';
import { TimeManager } from '../core/TimeManager.js';

import { sheetDrag } from './sheet.js';
import { Tooltip } from './Tooltip.js';
import { Notifications } from './Notifications.js';
import { TopBar } from './TopBar.js';
import { RegionPanel } from './RegionPanel.js';
import { BuildMenu } from './BuildMenu.js';
import { LayersPanel } from './LayersPanel.js';
import { ResearchPanel } from './ResearchPanel.js';
import { PlanetStatusPanel } from './PlanetStatusPanel.js';
import { TimeBar } from './TimeBar.js';
import { DebugPanel } from './DebugPanel.js';
import { MainMenu } from './MainMenu.js';

const NB = '\u00A0';

const TOOLS = [
  { id: 'build', icon: '⌂', label: 'Construire', key: 'B' },
  { id: 'layers', icon: '◈', label: 'Couches', key: 'L' },
  { id: 'research', icon: '⌬', label: 'Recherche', key: 'R' },
  { id: 'planet', icon: '◉', label: 'Planète', key: '' },
  { id: 'log', icon: '≡', label: 'Journal', key: '' },
  { id: 'saves', icon: '▣', label: 'Sauvegardes', key: 'Échap' },
];

/**
 * Onglets du bas, à portée du pouce. Icône ET libellé : sans survol, une
 * icône seule ne se devine pas.
 */
const TABS = [
  { id: 'build', icon: '⌂', label: 'Construire' },
  { id: 'layers', icon: '◈', label: 'Couches' },
  { id: 'research', icon: '⌬', label: 'Recherche' },
  { id: 'planet', icon: '◉', label: 'Planète' },
  { id: 'log', icon: '≡', label: 'Menu' },
];

/**
 * Bascule vers la grammaire « application mobile ».
 * Deux conditions, et non une simple largeur : une fenêtre étroite sur
 * ordinateur garde le survol et la disposition de bureau.
 */
const PHONE_MAX = 560;

export class UIManager {
  constructor(root, game, scene) {
    this.root = root;
    this.game = game;
    this.scene = scene;
    this.bus = game?.bus || null;

    this.placingType = null;
    this.scanMode = false;
    this.activePanel = null;
    this.isPhone = false;
    this.isTouch = false;
    this.feed = [];            // notifications routées vers le journal
    this._discovered = 0;      // découvertes en attente de regroupement
    this._discoverTimer = 0;
    this.panels = {};
    this.tools = new Map();
    this._subs = [];
    this._offs = [];
    this._mounted = false;
    this._lastDay = -1;
  }

  /* =================================================================== */
  /*  MONTAGE                                                            */
  /* =================================================================== */

  mount() {
    if (this._mounted) return this;
    this._mounted = true;
    this.root.classList.add('tn-ui');

    const ctx = { game: this.game, scene: this.scene, ui: this, tooltip: null };
    this.tooltip = new Tooltip(this.root);
    ctx.tooltip = this.tooltip;

    this.topBar = new TopBar(ctx);
    this.regionPanel = new RegionPanel(ctx);
    this.timeBar = new TimeBar(ctx);
    this.notifications = new Notifications(this.root, this.scene, this.game);
    this.debugPanel = new DebugPanel(ctx);
    this.mainMenu = new MainMenu(ctx);

    this.panels.build = new BuildMenu(ctx);
    this.panels.layers = new LayersPanel(ctx);
    this.panels.research = new ResearchPanel(ctx);
    this.panels.planet = new PlanetStatusPanel(ctx);
    this.panels.log = new LogPanel(ctx);

    // --- structure ----------------------------------------------------
    this.root.appendChild(this.topBar.mount());
    this.root.appendChild(this._buildScrim());
    this.root.appendChild(this._buildLeft());
    this.root.appendChild(this.regionPanel.mount());
    this.root.appendChild(this._buildBottom());
    this.root.appendChild(this._buildBanner());
    this.notifications.mount();
    this.root.appendChild(this.debugPanel.mount());
    this.root.appendChild(this.mainMenu.mount());
    this.tooltip.mount();

    this._bindBus();
    this._bindKeys();
    this._bindViewport();

    this.mainMenu.open(this.game?.state ? 'system' : 'start');
    this.update(this.game?.state);
    return this;
  }

  _buildLeft() {
    const nav = el('nav', { class: 'tn-toolbar', role: 'toolbar', 'aria-label': 'Outils' });
    for (const t of TOOLS) {
      const btn = el('button', {
        class: 'tn-tool', type: 'button', 'aria-label': t.label, 'aria-pressed': 'false',
        dataset: { tool: t.id },
      },
        el('span', { class: 'tn-tool-icon', 'aria-hidden': 'true', text: t.icon }),
        el('span', { class: 'tn-tool-label', text: t.label }));
      this.tooltip.attach(btn, () => t.key ? `${t.label}${NB}(${t.key})` : t.label);
      this._offs.push(on(btn, 'click', () => {
        if (t.id === 'saves') { this.openMenu('system'); return; }
        this.togglePanel(t.id);
      }));
      this.tools.set(t.id, btn);
      nav.appendChild(btn);
    }

    this.dockTitle = el('span', { class: 'tn-panel-title' });
    const closeBtn = el('button', { class: 'tn-icon-btn', type: 'button', 'aria-label': 'Fermer le panneau', text: '×' });
    this._offs.push(on(closeBtn, 'click', () => this.closePanel()));

    this.dockBody = el('div', { class: 'tn-dock-body' });
    for (const id in this.panels) {
      const node = this.panels[id].mount();
      node.hidden = true;
      this.dockBody.appendChild(node);
    }

    this.dockGrab = el('button', {
      class: 'tn-sheet-grab', type: 'button', 'aria-label': 'Fermer le panneau',
    }, el('i', { 'aria-hidden': 'true' }));
    this._offs.push(on(this.dockGrab, 'click', () => this.closePanel()));

    this.dock = el('div', { class: 'tn-panel tn-dock', role: 'region', 'aria-label': 'Panneau latéral' },
      this.dockGrab,
      el('header', { class: 'tn-panel-head' }, this.dockTitle, closeBtn),
      this.dockBody);
    this.dock.hidden = true;
    this._offs.push(sheetDrag(this.dock, this.dockGrab, {
      enabled: () => this.isPhone,
      expanded: () => true,
      onClose: () => this.closePanel(),
    }));

    return el('div', { class: 'tn-left' }, nav, this.dock);
  }

  /** Voile d'arrière-plan : un appui hors de la feuille la referme. */
  _buildScrim() {
    this.scrim = el('div', { class: 'tn-scrim', 'aria-hidden': 'true' });
    this.scrim.hidden = true;
    this._offs.push(on(this.scrim, 'pointerdown', (e) => { e.preventDefault(); this.closePanel(); }));
    return this.scrim;
  }

  /**
   * Bas de l'écran : contrôles du temps et, sur téléphone, barre d'onglets.
   * Un seul conteneur pour les deux dispositions : rien n'est déplacé dans le
   * DOM quand l'orientation change.
   */
  _buildBottom() {
    const tabs = el('nav', { class: 'tn-tabbar', role: 'tablist', 'aria-label': 'Navigation principale' });
    this.tabs = new Map();
    for (const t of TABS) {
      const btn = el('button', {
        class: 'tn-tab', type: 'button', role: 'tab', 'aria-selected': 'false',
        dataset: { tab: t.id },
      },
        el('span', { class: 'tn-tab-icon', 'aria-hidden': 'true', text: t.icon }),
        el('span', { class: 'tn-tab-label', text: t.label }));
      this._offs.push(on(btn, 'click', () => this.togglePanel(t.id)));
      this.tabs.set(t.id, btn);
      tabs.appendChild(btn);
    }
    return el('div', { class: 'tn-bottom' }, this.timeBar.mount(), tabs);
  }

  _buildBanner() {
    this.bannerText = el('span', { class: 'tn-banner-text' });
    const cancel = el('button', { class: 'tn-btn tn-btn--small', type: 'button', text: 'Annuler' });
    this._offs.push(on(cancel, 'click', () => { this.cancelPlacement(); this.setScanMode(false); }));
    this.banner = el('div', { class: 'tn-banner', role: 'status' },
      el('span', { class: 'tn-banner-icon', 'aria-hidden': 'true', text: '⌖' }),
      this.bannerText, cancel);
    this.banner.hidden = true;

    // Amorce des premières minutes : que faire, maintenant, tout de suite.
    this.hintText = el('span', { class: 'tn-hint-text' });
    const hintClose = el('button', {
      class: 'tn-icon-btn', type: 'button', 'aria-label': 'Masquer le conseil', text: '×',
    });
    this._offs.push(on(hintClose, 'click', () => { this._hintDone = true; this.hintBar.hidden = true; }));
    this.hintBar = el('div', { class: 'tn-hintbar', role: 'status' },
      el('span', { class: 'tn-hintbar-icon', 'aria-hidden': 'true', text: '◈' }),
      this.hintText, hintClose);
    this.hintBar.hidden = true;

    this.flash = el('div', { class: 'tn-flash', role: 'status', 'aria-live': 'polite' });
    this.flash.hidden = true;

    return el('div', { class: 'tn-center-stack' }, this.hintBar, this.banner, this.flash);
  }

  /* =================================================================== */
  /*  MODE D'AFFICHAGE (ordinateur / téléphone)                          */
  /* =================================================================== */

  _bindViewport() {
    const apply = () => this._applyMode();
    this._offs.push(on(window, 'resize', apply));
    this._offs.push(on(window, 'orientationchange', apply));
    try {
      const mq = window.matchMedia('(pointer: coarse)');
      const h = () => this._applyMode();
      mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h);
      this._offs.push(() => {
        mq.removeEventListener ? mq.removeEventListener('change', h) : mq.removeListener(h);
      });
    } catch { /* matchMedia absent : on s'en tient au redimensionnement */ }
    this._applyMode();
  }

  /**
   * Deux critères conjoints, comme demandé : la taille NE SUFFIT PAS.
   * Une fenêtre étroite sur ordinateur conserve le survol et la disposition
   * de bureau ; un téléphone, même large en paysage, passe en mode tactile.
   */
  _applyMode() {
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
    const w = window.innerWidth, h = window.innerHeight;
    const phone = coarse && Math.min(w, h) <= PHONE_MAX;
    const landscape = w > h;

    const changed = phone !== this.isPhone || coarse !== this.isTouch;
    this.isPhone = phone;
    this.isTouch = coarse;

    const root = document.documentElement;
    root.classList.toggle('tn-touch', coarse);
    root.classList.toggle('tn-phone', phone);
    root.classList.toggle('tn-phone-land', phone && landscape);
    this.root.classList.toggle('is-phone', phone);

    if (changed) {
      this.tooltip?.hide();
      this.regionPanel?.setExpanded(!phone);
      this._syncSheets();
    }
  }

  /** Une seule feuille ouverte à la fois sur téléphone. */
  _syncSheets() {
    const hideRegion = this.isPhone && (!!this.activePanel || !!this.placingType || this.scanMode);
    this.regionPanel?.suppress(hideRegion);
    if (this.scrim) this.scrim.hidden = !(this.isPhone && this.activePanel);
    this.root.classList.toggle('has-panel', !!this.activePanel);
    this.root.classList.toggle('has-region', !!this.regionPanel?.node && !this.regionPanel.node.hidden);
  }

  /* =================================================================== */
  /*  BUS                                                                */
  /* =================================================================== */

  _bindBus() {
    if (!this.bus) return;
    const sub = (name, fn) => this._subs.push(this.bus.on(name, fn));

    sub('notify', (p) => this._notify(p || {}));

    sub('region:selected', ({ regionId } = {}) => {
      if (this.scanMode && regionId != null) this._tryScan(regionId);
      this.regionPanel.setRegion(regionId ?? null);
      if (this.placingType && regionId != null) this._tryPlace(regionId);
      this.panels.build?.update?.(this.game.state);
      this._syncSheets();
    });

    // Une seule bulle pour une salve de découvertes : un scan en révèle
    // souvent plusieurs, et 626 bulles noyaient les vraies alertes (I9).
    sub('region:discovered', ({ regionId } = {}) => {
      this._discovered++;
      clearTimeout(this._discoverTimer);
      this._discoverTimer = setTimeout(() => this._flushDiscoveries(), 900);
      if (this.regionPanel.regionId === regionId) this.regionPanel.rebuild();
    });

    sub('research:started', () => this.panels.research?.refresh?.());
    sub('scan:started', () => this.regionPanel.update(this.game.state));

    sub('building:placed', () => {
      this.regionPanel.update(this.game.state);
      this.panels.build?.update?.(this.game.state);
    });
    sub('building:removed', () => this.regionPanel.update(this.game.state));

    sub('research:completed', () => {
      this.panels.research?.refresh?.();
      this.panels.build?.refresh?.();
    });

    sub('event:triggered', ({ event } = {}) => {
      if (!event) return;
      this.notifications.push({
        title: event.title, text: event.text, kind: event.kind || 'info',
        icon: event.icon, regionId: event.regionId,
      });
    });

    sub('victory', ({ state } = {}) => this.showVictory(state || this.game.state));

    sub('game:new', () => this._onNewState());
    sub('game:loaded', () => this._onNewState());
  }

  /**
   * Filtre des notifications : seules les alertes et les événements méritent
   * une bulle. Le reste alimente le journal, qui était sous-utilisé (I9).
   */
  _notify(n) {
    if (!n.text) return;
    const kind = n.kind || 'info';
    this.feed.push({
      day: Math.floor(this.game.state?.time?.day ?? 0),
      text: n.title ? `${n.title} — ${n.text}` : n.text,
      kind, icon: n.icon,
    });
    if (this.feed.length > 400) this.feed.splice(0, this.feed.length - 400);
    this.panels.log?.reset?.();
    if (kind === 'warn' || kind === 'danger' || n.title) this.notifications.push(n);
  }

  _flushDiscoveries() {
    const n = this._discovered;
    this._discovered = 0;
    if (!n) return;
    this._flash(n === 1 ? 'Secteur cartographié' : `${n} secteurs cartographiés`);
  }

  _onNewState() {
    this.cancelPlacement();
    this.setScanMode(false);
    this.regionPanel.setRegion(null);
    this.notifications.clearAll();
    this._victoryShown = false;
    this._hideVictory();
    this.panels.build?.refresh?.();
    this.panels.research?.refresh?.();
    this.panels.log?.reset?.();
    if (this.mainMenu.visible) this.mainMenu.close();
    this.feed.length = 0;
    this._hintDone = false;
    this._showOnboarding();
    this._applyMode();
    this.update(this.game.state);
  }

  /** Première consigne : le joueur sait quoi faire dans les dix secondes. */
  _showOnboarding() {
    if (!this.hintBar) return;
    const verb = this.isTouch ? 'Appuyez' : 'Cliquez';
    this.hintText.textContent = 'Objectif : cartographier trois secteurs. '
      + verb + ' sur un secteur sombre, puis sur « Lancer un scan orbital ».';
    this.hintBar.hidden = false;
  }

  /* =================================================================== */
  /*  PANNEAUX                                                           */
  /* =================================================================== */

  togglePanel(id) {
    if (this.activePanel === id) this.closePanel();
    else this.openPanel(id);
  }

  openPanel(id) {
    const panel = this.panels[id];
    if (!panel) return;
    for (const key in this.panels) this.panels[key].node.hidden = key !== id;
    this.activePanel = id;
    this.dock.hidden = false;
    this.dockTitle.textContent = TABS.find((t) => t.id === id)?.label
      || TOOLS.find((t) => t.id === id)?.label || '';
    for (const [key, btn] of this.tools) {
      const active = key === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    for (const [key, btn] of this.tabs) {
      const active = key === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    this.tooltip?.hide();
    panel.onShow?.();
    panel.update?.(this.game.state);
    this._syncSheets();
  }

  closePanel() {
    this.activePanel = null;
    this.dock.hidden = true;
    for (const key in this.panels) this.panels[key].node.hidden = true;
    for (const [, btn] of this.tools) {
      btn.classList.remove('is-active');
      btn.setAttribute('aria-pressed', 'false');
    }
    for (const [, btn] of this.tabs) {
      btn.classList.remove('is-active');
      btn.setAttribute('aria-selected', 'false');
    }
    this.tooltip?.hide();
    this._syncSheets();
  }

  openBuildMenuFor(regionId) {
    if (regionId != null && this.game.selectedRegion !== regionId) this.game.selectRegion(regionId);
    this.openPanel('build');
  }

  openMenu(mode = 'system') { this.mainMenu.open(mode); }
  onMenuClosed() { this.update(this.game.state); }

  /* =================================================================== */
  /*  MODE CONSTRUCTION                                                  */
  /* =================================================================== */

  startPlacement(type) {
    if (!BUILDINGS[type]) return;
    if (this.placingType === type) { this.cancelPlacement(); return; }
    this.setScanMode(false);
    this.placingType = type;
    this.root.classList.add('is-placing');
    this.banner.hidden = false;
    this.bannerText.textContent = this.isPhone
      ? `Placer${NB}: ${BUILDINGS[type].name} — appuyez sur un secteur`
      : `Placer${NB}: ${BUILDINGS[type].name} — Échap pour annuler`;
    // Sur téléphone la feuille laisse la place à la planète : on choisit dans
    // la feuille, on pose sur le globe.
    if (this.isPhone) this.closePanel();
    this.panels.build?.update?.(this.game.state);
    this.regionPanel.update(this.game.state);
    this._syncSheets();
  }

  cancelPlacement() {
    if (!this.placingType) return;
    this.placingType = null;
    this.root.classList.remove('is-placing');
    if (this.banner) this.banner.hidden = true;
    this.panels.build?.update?.(this.game.state);
    this.regionPanel.update(this.game.state);
    this._syncSheets();
  }

  _tryPlace(regionId) {
    const type = this.placingType;
    if (!type) return;
    const check = this.game.canBuild(type, regionId);
    if (!check.ok) {
      // `build()` notifierait de toute façon : on garde une seule alerte.
      this.notifications.push({ text: check.reason || 'Placement impossible.', kind: 'warn', icon: '⚠', regionId });
      return;
    }
    this.game.build(type, regionId);
    this._flash(BUILDINGS[type].name + NB + '· secteur ' + regionId);
    this.panels.build?.update?.(this.game.state);
  }

  /* =================================================================== */
  /*  MODE SCAN PERSISTANT                                               */
  /* =================================================================== */

  toggleScanMode() { this.setScanMode(!this.scanMode); }

  setScanMode(on_) {
    const v = !!on_;
    if (v === this.scanMode) return;
    if (v) this.cancelPlacement();
    this.scanMode = v;
    this.root.classList.toggle('is-scanning', v);
    if (v) {
      this.banner.hidden = false;
      this.bannerText.textContent = 'Mode scan' + NB + ': appuyez sur les secteurs sombres à cartographier';
      if (this.isPhone) this.closePanel();
    } else if (!this.placingType && this.banner) {
      this.banner.hidden = true;
    }
    this.panels.planet?.update?.(this.game.state);
    this.regionPanel.update(this.game.state);
    this._syncSheets();
  }

  /** @returns {boolean} vrai si le secteur a été pris en charge par le mode scan. */
  _tryScan(regionId) {
    const R = this.game.regions;
    if (!R || regionId == null || R.discovered?.[regionId]) return false;
    const ok = this.game.scanRegion(regionId);
    if (!ok) {
      this.notifications.push({ text: 'Scan impossible : ressources insuffisantes.', kind: 'warn', icon: '⚠' });
      return true;
    }
    this._flash('Scan demandé' + NB + '· secteur ' + regionId);
    this.regionPanel.update(this.game.state);
    return true;
  }

  /* =================================================================== */
  /*  RACCOURCIS CLAVIER                                                 */
  /* =================================================================== */

  _bindKeys() {
    this._offs.push(on(window, 'keydown', (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Le menu principal capte tout sauf Échap.
      if (this.mainMenu.visible && e.key !== 'Escape') return;
      // Sans partie en cours, seuls Échap et F2 ont un sens.
      if (!this.game.state && e.key !== 'Escape' && e.key !== 'F2') return;

      switch (e.key) {
        case ' ': case 'Spacebar':
          e.preventDefault();
          this.game.togglePause ? this.game.togglePause()
            : this.game.setSpeed((this.game.state?.time?.speed ?? 1) === 0 ? 1 : 0);
          this._flash((this.game.state?.time?.speed ?? 0) === 0 ? 'Simulation en pause' : 'Simulation reprise');
          break;
        case '1': this.game.setSpeed(1); this._flash('Vitesse ×1'); break;
        case '2': this.game.setSpeed(2); this._flash('Vitesse ×2'); break;
        case '3': this.game.setSpeed(4); this._flash('Vitesse ×4'); break;
        case 'b': case 'B': this.togglePanel('build'); break;
        case 'l': case 'L': this.togglePanel('layers'); break;
        case 'r': case 'R': this.togglePanel('research'); break;
        case 's': case 'S': this.toggleScanMode(); break;
        case 'c': case 'C': {
          // Le cycle des couches quitte Tab, rendu à la navigation clavier (I8).
          const layer = this.panels.layers.cycle(e.shiftKey ? -1 : 1);
          this._flash('Couche' + NB + ': ' + layer.name);
          break;
        }
        case 'F2': e.preventDefault(); this.debugPanel.toggle(); break;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
          if (this._moveSelection(e.key)) e.preventDefault();
          break;
        case 'Enter': if (this._primaryAction()) e.preventDefault(); break;
        case 'Escape': this._escape(); break;
        default: return;
      }
    }));
  }

  /* ------------------------------------------------------------------ */
  /*  SÉLECTION AU CLAVIER                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Déplace la sélection vers le secteur voisin le plus proche de la
   * direction demandée. Le repère est géographique (nord/sud, est/ouest) et
   * non écran : il reste valable quelle que soit la rotation du globe, et il
   * n'exige rien du moteur de rendu.
   */
  _moveSelection(key) {
    const R = this.game.regions;
    if (!R) return false;
    let id = this.game.selectedRegion;
    if (id == null) {
      id = Number.isInteger(R.landingSite) && R.landingSite >= 0 ? R.landingSite : 0;
      this.game.selectRegion(id);
      return true;
    }
    let list;
    try { list = R.neighbors(id); } catch { return false; }
    if (!list || !list.length) return false;

    const P = R.positions;
    const at = (i) => ({ x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] });
    const a = at(id);
    const lonA = Math.atan2(a.z, a.x);
    let best = -1, score = -Infinity;
    for (const n of list) {
      if (n < 0 || n >= R.count) continue;
      const b = at(n);
      const dLat = b.y - a.y;
      let dLon = Math.atan2(b.z, b.x) - lonA;
      while (dLon > Math.PI) dLon -= 2 * Math.PI;
      while (dLon < -Math.PI) dLon += 2 * Math.PI;
      const v = key === 'ArrowUp' ? dLat
        : key === 'ArrowDown' ? -dLat
        : key === 'ArrowRight' ? dLon : -dLon;
      if (v > score) { score = v; best = n; }
    }
    if (best < 0) return false;
    this.game.selectRegion(best);
    this.scene?.focusRegion?.(best);
    return true;
  }

  /** Entrée : action principale du secteur sélectionné. */
  _primaryAction() {
    const id = this.game.selectedRegion;
    if (id == null) return false;
    const a = document.activeElement;
    if (a && a !== document.body && this.root.contains(a)) return false;
    if (this.placingType) { this._tryPlace(id); return true; }
    if (!this.game.regions?.discovered?.[id]) {
      if (this.game.scanRegion(id)) this._flash('Scan demandé' + NB + '· secteur ' + id);
      this.regionPanel.update(this.game.state);
      return true;
    }
    this.openBuildMenuFor(id);
    return true;
  }

  _escape() {
    if (this.scanMode) { this.setScanMode(false); return; }
    if (this.mainMenu.visible) {
      if (this.game.state) this.mainMenu.close();
      return;
    }
    if (this._victoryNode && !this._victoryNode.hidden) { this._hideVictory(); return; }
    if (this.placingType) { this.cancelPlacement(); return; }
    if (this.activePanel) { this.closePanel(); return; }
    if (this.game.selectedRegion != null) { this.game.selectRegion(null); return; }
    this.openMenu('system');
  }

  _flash(text) {
    if (!this.flash) return;
    this.flash.textContent = text;
    this.flash.hidden = false;
    this.flash.classList.add('is-in');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      this.flash.classList.remove('is-in');
      this._flashTimer = setTimeout(() => { this.flash.hidden = true; }, 200);
    }, 1400);
  }

  /* =================================================================== */
  /*  BOUCLE D'AFFICHAGE (~10 Hz)                                        */
  /* =================================================================== */

  update(state) {
    const s = state || this.game?.state;
    if (!this._mounted) return;
    this.root.classList.toggle('is-empty', !s);
    if (!s) return;

    if (!this._hintDone && this.hintBar && !this.hintBar.hidden) {
      const scanned = (s.stats?.scanned ?? 0) + (s.explore?.scanning?.length ?? 0);
      if (scanned > 0) { this._hintDone = true; this.hintBar.hidden = true; }
    }
    this.topBar.update(s);
    this.timeBar.update(s);
    this.regionPanel.update(s);
    if (this.activePanel) this.panels[this.activePanel]?.update?.(s);
    this.debugPanel.update(s);
    this._lastDay = s.time?.day ?? 0;
  }

  /* =================================================================== */
  /*  VICTOIRE                                                           */
  /* =================================================================== */

  showVictory(state) {
    if (this._victoryShown || !state) return;
    this._victoryShown = true;
    if (!this._victoryNode) {
      this._victoryBody = el('div', { class: 'tn-victory-body' });
      const cont = el('button', { class: 'tn-btn tn-btn--primary tn-btn--wide', type: 'button', text: 'Continuer à jouer' });
      this._offs.push(on(cont, 'click', () => this._hideVictory()));
      this._victoryNode = el('div', { class: 'tn-overlay tn-victory-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Mission accomplie' },
        el('div', { class: 'tn-menu-panel' },
          el('div', { class: 'tn-menu-brand' },
            el('h1', { class: 'tn-menu-title', text: 'MISSION ACCOMPLIE' }),
            el('div', { class: 'tn-menu-sub', text: 'La planète est devenue viable' })),
          el('p', { class: 'tn-menu-lore', text: 'Les sept indicateurs se sont maintenus dans les tolérances de mission. Un monde neuf respire désormais sans assistance. Vous pouvez poursuivre la partie librement.' }),
          this._victoryBody, cont));
      this.root.appendChild(this._victoryNode);
    }

    const day = state.time?.day ?? 0;
    const rows = [
      ['Durée de mission', `${TimeManager.formatDay(day)} (${formatNumber(day, 0)} jours)`],
      ['Seed', makeSeedLabel(state.seed ?? 0)],
      ['Installations', `${state.buildings?.length ?? 0} en service · ${state.stats?.built ?? 0} construites`],
      ['Technologies', `${state.tech?.unlocked?.length ?? 0} / ${TECH_LIST.length}`],
      ['Secteurs scannés', String(state.stats?.scanned ?? 0)],
      ['Population', formatNumber(state.globals?.population ?? 0, 0) + NB + 'habitants'],
      ['Température finale', (state.globals?.temperature ?? 0).toFixed(1).replace('-', '−') + NB + '°C'],
      ['Biomasse', (state.globals?.biomass ?? 0).toFixed(1)],
    ];
    clear(this._victoryBody);
    for (const [k, v] of rows) {
      this._victoryBody.appendChild(el('div', { class: 'tn-kv-cell' },
        el('span', { class: 'tn-kv-label', text: k }),
        el('span', { class: 'tn-kv-value', text: v })));
    }
    this._victoryNode.hidden = false;
    requestAnimationFrame(() => this._victoryNode.classList.add('is-in'));
  }

  _hideVictory() {
    if (!this._victoryNode) return;
    this._victoryNode.classList.remove('is-in');
    this._victoryNode.hidden = true;
  }

  /* =================================================================== */

  destroy() {
    for (const off of this._subs) { try { off(); } catch { /* ignore */ } }
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._subs.length = 0;
    this._offs.length = 0;
    clearTimeout(this._flashTimer);
    clearTimeout(this._discoverTimer);
    document.documentElement.classList.remove('tn-touch', 'tn-phone', 'tn-phone-land');

    for (const id in this.panels) this.panels[id].destroy?.();
    this.topBar?.destroy();
    this.regionPanel?.destroy();
    this.timeBar?.destroy();
    this.notifications?.destroy();
    this.debugPanel?.destroy();
    this.mainMenu?.destroy();
    this.tooltip?.destroy();
    this._victoryNode?.remove();
    this._victoryNode = null;

    clear(this.root);
    this.root.classList.remove('tn-ui', 'is-placing', 'is-empty');
    this._mounted = false;
  }
}

/* ===================================================================== */
/*  Journal de mission (panneau latéral simple)                          */
/* ===================================================================== */

class LogPanel {
  constructor(ctx) {
    this.game = ctx.game;
    this.ui = ctx.ui;
    this.node = null;
    this._count = -1;
    this._offs = [];
  }

  mount() {
    this.list = el('div', { class: 'tn-log' });
    const saves = el('button', { class: 'tn-btn tn-btn--wide tn-phone-only', type: 'button' },
      el('span', { text: 'Sauvegardes et options' }),
      el('small', { text: 'nouvelle partie, chargement, seed' }));
    this._offs.push(on(saves, 'click', () => this.ui?.openMenu?.('system')));

    this.node = el('div', { class: 'tn-dock-panel tn-log-panel' },
      saves,
      el('p', { class: 'tn-hint', text: 'Historique de la mission, du plus récent au plus ancien.' }),
      this.list);
    return this.node;
  }

  reset() { this._count = -1; }

  /**
   * Le journal réunit ce que la simulation consigne et ce que l'interface a
   * écarté des bulles : constructions et scans y retrouvent une trace (C12).
   */
  _entries(state) {
    const a = state.log || [];
    const b = this.ui?.feed || [];
    if (!b.length) return a;
    return a.concat(b).sort((x, y) => (x.day ?? 0) - (y.day ?? 0));
  }

  update(state) {
    if (!state || this.node.hidden) return;
    const log = this._entries(state);
    if (log.length === this._count) return;
    this._count = log.length;
    clear(this.list);
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      this.list.appendChild(el('div', { class: 'tn-log-entry is-' + (e.kind || 'info') },
        el('span', { class: 'tn-log-day', text: 'J' + String(e.day ?? 0).padStart(4, '0') }),
        el('span', { class: 'tn-log-icon', 'aria-hidden': 'true', text: e.icon || '·' }),
        el('span', { class: 'tn-log-text', text: e.text })));
    }
    if (!log.length) this.list.appendChild(el('p', { class: 'tn-hint', text: 'Aucune entrée pour le moment.' }));
  }

  onShow() { this.reset(); this.update(this.game.state); }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove(); this.node = null;
  }
}

export default UIManager;

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

export class UIManager {
  constructor(root, game, scene) {
    this.root = root;
    this.game = game;
    this.scene = scene;
    this.bus = game?.bus || null;

    this.placingType = null;
    this.activePanel = null;
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
    this.root.appendChild(this._buildLeft());
    this.root.appendChild(this.regionPanel.mount());
    this.root.appendChild(this.timeBar.mount());
    this.root.appendChild(this._buildBanner());
    this.notifications.mount();
    this.root.appendChild(this.debugPanel.mount());
    this.root.appendChild(this.mainMenu.mount());
    this.tooltip.mount();

    this._bindBus();
    this._bindKeys();

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

    this.dock = el('div', { class: 'tn-panel tn-dock', role: 'region', 'aria-label': 'Panneau latéral' },
      el('header', { class: 'tn-panel-head' }, this.dockTitle, closeBtn),
      this.dockBody);
    this.dock.hidden = true;

    return el('div', { class: 'tn-left' }, nav, this.dock);
  }

  _buildBanner() {
    this.bannerText = el('span', { class: 'tn-banner-text' });
    const cancel = el('button', { class: 'tn-btn tn-btn--small', type: 'button', text: 'Annuler' });
    this._offs.push(on(cancel, 'click', () => this.cancelPlacement()));
    this.banner = el('div', { class: 'tn-banner', role: 'status' },
      el('span', { class: 'tn-banner-icon', 'aria-hidden': 'true', text: '⌖' }),
      this.bannerText, cancel);
    this.banner.hidden = true;

    this.flash = el('div', { class: 'tn-flash', role: 'status', 'aria-live': 'polite' });
    this.flash.hidden = true;

    return el('div', { class: 'tn-center-stack' }, this.banner, this.flash);
  }

  /* =================================================================== */
  /*  BUS                                                                */
  /* =================================================================== */

  _bindBus() {
    if (!this.bus) return;
    const sub = (name, fn) => this._subs.push(this.bus.on(name, fn));

    sub('notify', (p) => this.notifications.push(p || {}));

    sub('region:selected', ({ regionId } = {}) => {
      this.regionPanel.setRegion(regionId ?? null);
      if (this.placingType && regionId != null) this._tryPlace(regionId);
      this.panels.build?.update?.(this.game.state);
    });

    sub('region:discovered', ({ regionId } = {}) => {
      this.notifications.push({
        text: `Secteur ${regionId} cartographié.`, kind: 'success', icon: '◎', regionId,
      });
      if (this.regionPanel.regionId === regionId) this.regionPanel.rebuild();
    });

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

  _onNewState() {
    this.cancelPlacement();
    this.regionPanel.setRegion(null);
    this.notifications.clearAll();
    this._victoryShown = false;
    this._hideVictory();
    this.panels.build?.refresh?.();
    this.panels.research?.refresh?.();
    this.panels.log?.reset?.();
    if (this.mainMenu.visible) this.mainMenu.close();
    this.update(this.game.state);
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
    this.dockTitle.textContent = TOOLS.find((t) => t.id === id)?.label || '';
    for (const [key, btn] of this.tools) {
      const active = key === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    panel.onShow?.();
    panel.update?.(this.game.state);
  }

  closePanel() {
    this.activePanel = null;
    this.dock.hidden = true;
    for (const key in this.panels) this.panels[key].node.hidden = true;
    for (const [, btn] of this.tools) {
      btn.classList.remove('is-active');
      btn.setAttribute('aria-pressed', 'false');
    }
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
    this.placingType = type;
    this.root.classList.add('is-placing');
    this.banner.hidden = false;
    this.bannerText.textContent = `Placer${NB}: ${BUILDINGS[type].name} — Échap pour annuler`;
    this.panels.build?.update?.(this.game.state);
    this.regionPanel.update(this.game.state);
  }

  cancelPlacement() {
    if (!this.placingType) return;
    this.placingType = null;
    this.root.classList.remove('is-placing');
    if (this.banner) this.banner.hidden = true;
    this.panels.build?.update?.(this.game.state);
    this.regionPanel.update(this.game.state);
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
    this.panels.build?.update?.(this.game.state);
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
        case 'F2': e.preventDefault(); this.debugPanel.toggle(); break;
        case 'Tab': {
          // On ne détourne Tab que si le focus n'est pas déjà dans l'interface :
          // la navigation au clavier reste possible une fois entré dans un panneau.
          const a = document.activeElement;
          if (a && a !== document.body && this.root.contains(a)) return;
          e.preventDefault();
          const layer = this.panels.layers.cycle(e.shiftKey ? -1 : 1);
          this._flash('Couche' + NB + ': ' + layer.name);
          break;
        }
        case 'Escape': this._escape(); break;
        default: return;
      }
    }));
  }

  _escape() {
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
    this.node = null;
    this._count = -1;
  }

  mount() {
    this.list = el('div', { class: 'tn-log' });
    this.node = el('div', { class: 'tn-dock-panel tn-log-panel' },
      el('p', { class: 'tn-hint', text: 'Historique des événements de la mission, du plus récent au plus ancien.' }),
      this.list);
    return this.node;
  }

  reset() { this._count = -1; }

  update(state) {
    if (!state || this.node.hidden) return;
    const log = state.log || [];
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
  destroy() { this.node?.remove(); this.node = null; }
}

export default UIManager;

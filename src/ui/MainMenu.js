/**
 * Écran d'accueil et menu système.
 *  - mode « start »  : au démarrage (seed, type de planète, emplacements)
 *  - mode « system » : en cours de partie (reprendre, sauvegarder, charger…)
 */
import { el, clear, on } from './dom.js';
import { BALANCE } from '../data/balance.js';
import { hashString, randomSeed, makeSeedLabel } from '../utils/rng.js';

const NB = '\u00A0';

/** Types de planète : exposés par le générateur si possible, sinon repli. */
const FALLBACK_PRESETS = [{ id: 'rocky', name: 'Rocheuse', desc: 'Monde tellurique nu, riche en minerais. Le scénario de référence.' }];

function readPresets(game) {
  const raw = game?.planetPresets || game?.constructor?.PLANET_PRESETS
    || globalThis.TERRA_NOVA_PLANET_PRESETS || null;
  if (!raw) return FALLBACK_PRESETS;
  const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...(v || {}) }));
  const out = list
    .filter((p) => p && (p.id || p.key))
    .map((p) => ({ id: p.id || p.key, name: p.name || p.label || p.id, desc: p.desc || p.description || '' }));
  return out.length ? out : FALLBACK_PRESETS;
}

export class MainMenu {
  constructor(ctx) {
    this.game = ctx.game;
    this.ui = ctx.ui;
    this.node = null;
    this.mode = 'start';
    this.planetType = 'rocky';
    this._offs = [];
  }

  mount() {
    this.seedInput = el('input', {
      class: 'tn-input', type: 'text', id: 'tn-seed', autocomplete: 'off',
      spellcheck: 'false', maxlength: '24', value: makeSeedLabel(randomSeed()),
    });
    const diceBtn = el('button', {
      class: 'tn-icon-btn', type: 'button', 'aria-label': 'Seed aléatoire', 'data-tip': 'Seed aléatoire', text: '⟳',
    });
    this._offs.push(on(diceBtn, 'click', () => { this.seedInput.value = makeSeedLabel(randomSeed()); }));

    this.typeWrap = el('div', { class: 'tn-choices', role: 'radiogroup', 'aria-label': 'Type de planète' });

    this.slots = el('div', { class: 'tn-slots' });

    this.newBtn = el('button', { class: 'tn-btn tn-btn--primary tn-btn--wide', type: 'button', text: 'Nouvelle partie' });
    this.resumeBtn = el('button', { class: 'tn-btn tn-btn--wide', type: 'button', text: 'Reprendre la mission' });
    this._offs.push(on(this.newBtn, 'click', () => this._newGame()));
    this._offs.push(on(this.resumeBtn, 'click', () => this.close()));

    // Le tutoriel ne se montre qu'à la première partie : sans cette entrée,
    // un joueur qui l'a fermé n'aurait aucun moyen de le retrouver.
    this.tutorialBtn = el('button', {
      class: 'tn-btn tn-btn--wide', type: 'button', dataset: { action: 'tutorial' },
    },
      el('span', { text: 'Revoir le tutoriel' }),
      el('small', { text: 'accompagnement pas à pas de la première partie' }));
    this._offs.push(on(this.tutorialBtn, 'click', () => {
      this.close();
      this.ui?.restartTutorial?.();
    }));

    this.node = el('div', { class: 'tn-overlay tn-menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu principal' },
      el('div', { class: 'tn-menu-panel' },
        el('div', { class: 'tn-menu-brand' },
          el('h1', { class: 'tn-menu-title', text: 'TERRA NOVA' }),
          el('div', { class: 'tn-menu-sub', text: 'Programme de terraformation · Direction des mondes nouveaux' })),
        el('p', { class: 'tn-menu-lore', text: 'Une planète morte tourne sous votre sonde de commandement. Cartographiez sa surface, épaississez son atmosphère, réchauffez sa croûte, faites couler l’eau, puis semez la vie. La mission est réussie lorsque sept indicateurs planétaires se maintiennent ensemble pendant 180 jours.' }),

        this.resumeBtn,
        this.tutorialBtn,

        el('div', { class: 'tn-section-title', text: 'Genèse' }),
        el('div', { class: 'tn-field' },
          el('label', { class: 'tn-field-label', for: 'tn-seed', text: 'Seed' }),
          el('div', { class: 'tn-field-row' }, this.seedInput, diceBtn)),
        el('div', { class: 'tn-field' },
          el('span', { class: 'tn-field-label', text: 'Type de planète' }),
          this.typeWrap),
        this.newBtn,

        el('div', { class: 'tn-section-title', text: 'Emplacements de sauvegarde' }),
        this.slots,
        el('p', { class: 'tn-hint', text: 'L’emplacement 1 reçoit également la sauvegarde automatique (une fois par année de mission).' })));

    this.node.hidden = true;
    return this.node;
  }

  /* ------------------------------------------------------------------ */

  open(mode = 'start') {
    this.mode = mode;
    this._renderTypes();
    this._renderSlots();
    this.node.hidden = false;
    this.node.classList.toggle('is-system', mode === 'system');
    this.resumeBtn.hidden = !(mode === 'system' && this.game.state);
    // Sans partie en cours, il n'y a rien à accompagner : on cache l'entrée.
    this.tutorialBtn.hidden = !this.game.state;
    this.newBtn.textContent = mode === 'system' ? 'Redémarrer une partie' : 'Nouvelle partie';
    requestAnimationFrame(() => this.node.classList.add('is-in'));
  }

  close() {
    if (!this.node) return;
    this.node.classList.remove('is-in');
    this.node.hidden = true;
    this.ui?.onMenuClosed?.();
  }

  get visible() { return this.node && !this.node.hidden; }

  /* ------------------------------------------------------------------ */

  _renderTypes() {
    clear(this.typeWrap);
    const presets = readPresets(this.game);
    if (!presets.some((p) => p.id === this.planetType)) this.planetType = presets[0].id;
    for (const p of presets) {
      const btn = el('button', {
        class: 'tn-choice', type: 'button', role: 'radio',
        'aria-checked': p.id === this.planetType ? 'true' : 'false',
      },
        el('span', { class: 'tn-choice-name', text: p.name }),
        p.desc ? el('span', { class: 'tn-choice-desc', text: p.desc }) : null);
      btn.classList.toggle('is-active', p.id === this.planetType);
      this._offs.push(on(btn, 'click', () => { this.planetType = p.id; this._renderTypes(); }));
      this.typeWrap.appendChild(btn);
    }
  }

  _renderSlots() {
    clear(this.slots);
    let list = [];
    try { list = this.game.listSaves() || []; } catch (err) { console.warn('[MainMenu] listSaves', err); }
    if (!list.length) {
      for (let i = 0; i < (BALANCE.save.maxSlots || 3); i++) list.push({ slot: i, empty: true });
    }
    for (const s of list) {
      const info = s.empty
        ? el('span', { class: 'tn-slot-empty', text: 'Emplacement vide' })
        : el('div', { class: 'tn-slot-info' },
          el('span', { class: 'tn-slot-line', text: `${makeSeedLabel(s.seed ?? 0)} · An ${Math.floor((s.day ?? 0) / 365)} · J${String(Math.floor((s.day ?? 0) % 365)).padStart(3, '0')}` }),
          el('span', { class: 'tn-slot-line tn-dim', text: `${(s.temperature ?? 0).toFixed(1).replace('-', '−')}${NB}°C · ${s.buildings ?? 0} installations${s.victory ? ' · mission réussie' : ''}` }),
          el('span', { class: 'tn-slot-line tn-dim', text: s.savedAt ? new Date(s.savedAt).toLocaleString('fr-FR') : '' }));

      const actions = el('div', { class: 'tn-slot-actions' });
      if (this.game.state) {
        const saveBtn = el('button', { class: 'tn-btn tn-btn--small', type: 'button', text: 'Sauvegarder' });
        this._offs.push(on(saveBtn, 'click', () => { this.game.save(s.slot); this._renderSlots(); }));
        actions.appendChild(saveBtn);
      }
      if (!s.empty) {
        const loadBtn = el('button', { class: 'tn-btn tn-btn--small tn-btn--primary', type: 'button', text: 'Charger' });
        const delBtn = el('button', {
          class: 'tn-icon-btn tn-danger', type: 'button', text: '⨯',
          'aria-label': `Supprimer l’emplacement ${s.slot + 1}`, 'data-tip': 'Supprimer',
        });
        this._offs.push(on(loadBtn, 'click', () => { if (this.game.load(s.slot)) this.close(); }));
        this._offs.push(on(delBtn, 'click', () => {
          if (delBtn.classList.contains('is-armed')) { this.game.deleteSave(s.slot); this._renderSlots(); return; }
          delBtn.classList.add('is-armed');
          delBtn.textContent = '✓';
          setTimeout(() => { delBtn.classList.remove('is-armed'); delBtn.textContent = '⨯'; }, 3500);
        }));
        actions.appendChild(loadBtn);
        actions.appendChild(delBtn);
      }

      this.slots.appendChild(el('div', { class: 'tn-slot' + (s.empty ? ' is-empty' : '') },
        el('span', { class: 'tn-slot-num', text: String(s.slot + 1) }), info, actions));
    }
  }

  _newGame() {
    const raw = (this.seedInput.value || '').trim();
    let seed;
    if (/^\d+$/.test(raw)) seed = Number(raw) >>> 0;
    else if (raw) seed = hashString(raw);
    else seed = randomSeed();
    try {
      this.game.newGame({ seed, planetType: this.planetType });
      this.close();
    } catch (err) {
      console.error('[MainMenu] newGame', err);
    }
  }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

export default MainMenu;

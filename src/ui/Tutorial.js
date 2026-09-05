/**
 * Tutorial — accompagnement contextuel de la première partie.
 *
 *   const tut = new Tutorial(ctx); root.appendChild(tut.mount());
 *   tut.onNewGame();      // au démarrage d'une partie
 *   tut.update(state);    // ~10 Hz, depuis UIManager.update
 *
 * ---------------------------------------------------------------------------
 *  CE QU'IL FAIT, ET CE QU'IL NE FAIT PAS
 * ---------------------------------------------------------------------------
 *  - Il affiche UNE étape à la fois dans un encart discret, refermable, qui
 *    dit quoi faire et pourquoi (contenu : `src/data/tutorial.js`).
 *  - Il met en évidence l'élément dont il parle par un halo posé PAR-DESSUS,
 *    en `pointer-events: none` : le bouton reste cliquable.
 *  - Il valide chaque étape en OBSERVANT l'état et le bus. Il n'agit jamais
 *    sur le jeu : il n'appelle aucune méthode de `game` qui modifie l'état.
 *  - Il ne bloque rien, ne prend jamais le focus, ne pose aucun voile modal.
 *    Le joueur peut passer une étape, replier l'encart ou quitter.
 *  - Il ne se déclenche qu'à la PREMIÈRE partie : la mémoire est dans
 *    `localStorage`, et le menu principal permet de le relancer.
 */
import { el, clear, frag, on } from './dom.js';
import { TUTORIAL_STEPS, TUTORIAL_STORAGE_KEY } from '../data/tutorial.js';

/** Marge du halo autour de la cible, en pixels. */
const RING_PAD = 5;
/** Déplacement minimal du pointeur comptant comme « le globe a tourné ». */
const DRAG_PX = 24;

function setText(node, value) {
  if (node && node._v !== value) { node._v = value; node.textContent = value; }
}

/**
 * Un élément est utilisable s'il occupe une surface : un panneau fermé donne
 * une boîte vide, une carte simplement défilée hors du cadre en donne une
 * pleine — et `_setTargetEl` la ramène à l'écran. Tester l'appartenance au
 * viewport désignerait à tort l'onglet d'un panneau DÉJÀ ouvert, dont l'appui
 * le refermerait.
 */
function visible(node) {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(node);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export class Tutorial {
  constructor(ctx) {
    this.game = ctx.game;
    this.scene = ctx.scene;
    this.ui = ctx.ui;
    this.bus = ctx.game?.bus || null;

    this.steps = TUTORIAL_STEPS;
    this.index = -1;
    this.active = false;
    this.folded = false;
    this.spot = null;          // 'globe' quand la cible est la planète
    this.targetEl = null;
    this.snap = null;

    this._rotated = false;
    this._layer = 'normal';
    this._compact = false;
    this._lastH = -1;
    this._offs = [];
    this._subs = [];
  }

  /* =================================================================== */
  /*  MONTAGE                                                            */
  /* =================================================================== */

  mount() {
    this.ring = el('div', { class: 'tn-tut-ring', 'aria-hidden': 'true' });
    this.ring.hidden = true;

    this.counter = el('span', { class: 'tn-tut-count' });
    this.dots = el('span', { class: 'tn-tut-dots', 'aria-hidden': 'true' });
    this._dotNodes = this.steps.map(() => el('i'));
    for (const d of this._dotNodes) this.dots.appendChild(d);

    this.foldBtn = el('button', {
      class: 'tn-icon-btn', type: 'button', 'aria-label': 'Réduire le tutoriel', text: '▾',
    });
    this._offs.push(on(this.foldBtn, 'click', () => this.setFolded(!this.folded)));

    const quitBtn = el('button', {
      class: 'tn-icon-btn', type: 'button', 'aria-label': 'Quitter le tutoriel', text: '×',
    });
    this._offs.push(on(quitBtn, 'click', () => this.quit()));

    this.title = el('h2', { class: 'tn-tut-title' });
    this.text = el('div', { class: 'tn-tut-text' });
    this.actionText = el('span', { class: 'tn-tut-action-text' });
    this.action = el('p', { class: 'tn-tut-action' },
      el('span', { class: 'tn-tut-action-icon', 'aria-hidden': 'true', text: '▸' }),
      this.actionText);

    // `aria-live` annonce le changement d'étape sans jamais déplacer le focus :
    // le joueur qui est en train de viser un secteur n'est pas interrompu.
    this.body = el('div', { class: 'tn-tut-body', 'aria-live': 'polite' }, this.text, this.action);

    this.skipBtn = el('button', { class: 'tn-btn tn-btn--small', type: 'button', text: 'Passer' });
    this._offs.push(on(this.skipBtn, 'click', () => this.next()));
    this.endBtn = el('button', {
      class: 'tn-btn tn-btn--small tn-btn--primary', type: 'button', text: 'Terminer',
    });
    this._offs.push(on(this.endBtn, 'click', () => this.finish()));
    // Les pastilles de progression vont en pied : dans l'en-tête, elles
    // écrasaient le titre sur un écran de 360 px.
    this.foot = el('div', { class: 'tn-tut-foot' }, this.dots, this.skipBtn, this.endBtn);

    const head = el('header', { class: 'tn-tut-head' },
      el('span', { class: 'tn-tut-mark', 'aria-hidden': 'true', text: '⌖' }),
      this.counter, this.title, this.foldBtn, quitBtn);
    // Replier/déplier par l'en-tête : au doigt, la zone est large et évidente.
    this._offs.push(on(head, 'click', (e) => {
      if (e.target.closest('button')) return;
      this.setFolded(!this.folded);
    }));

    this.node = el('section', {
      class: 'tn-tut', role: 'region', 'aria-label': 'Tutoriel',
    }, head, this.body, this.foot);
    this.node.hidden = true;

    this._bind();
    return frag(this.ring, this.node);
  }

  /* =================================================================== */
  /*  OBSERVATION                                                        */
  /* =================================================================== */

  _bind() {
    if (this.bus) {
      this._subs.push(this.bus.on('layer:changed', ({ layer } = {}) => {
        if (layer) this._layer = layer;
      }));
    }
    // Rotation du globe : écouteurs PASSIFS sur la fenêtre. On observe, on
    // n'intercepte rien — aucun `preventDefault`, aucune capture de clic.
    let down = null;
    const isCanvas = (t) => t instanceof HTMLElement && t.tagName === 'CANVAS';
    this._offs.push(on(window, 'pointerdown', (e) => {
      down = isCanvas(e.target) ? { x: e.clientX, y: e.clientY } : null;
    }, { passive: true }));
    this._offs.push(on(window, 'pointermove', (e) => {
      if (!down || this._rotated) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) >= DRAG_PX) this._rotated = true;
    }, { passive: true }));
    this._offs.push(on(window, 'pointerup', () => { down = null; }, { passive: true }));
    this._offs.push(on(window, 'wheel', (e) => {
      if (isCanvas(e.target)) this._rotated = true;
    }, { passive: true }));
  }

  /** Contexte transmis aux conditions de `src/data/tutorial.js`. */
  _ctx(state) {
    return {
      game: this.game,
      state: state || this.game.state,
      regions: this.game.regions,
      ui: this.ui,
      flags: {
        rotated: this._rotated,
        layer: this._layer,
        panel: this.ui?.activePanel ?? null,
        placing: this.ui?.placingType ?? null,
      },
    };
  }

  /* =================================================================== */
  /*  MÉMOIRE (localStorage)                                             */
  /* =================================================================== */

  static read() {
    try {
      const raw = localStorage.getItem(TUTORIAL_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  static write(value) {
    try {
      if (value === null) localStorage.removeItem(TUTORIAL_STORAGE_KEY);
      else localStorage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(value));
    } catch { /* navigation privée : le tutoriel se contentera de la session */ }
  }

  /** Vrai si le joueur l'a déjà vu (terminé ou abandonné). */
  static seen() { return !!Tutorial.read(); }

  /* =================================================================== */
  /*  CYCLE DE VIE                                                       */
  /* =================================================================== */

  /** Nouvelle partie : on ne démarre qu'à la toute première. */
  onNewGame() {
    this._rotated = false;
    this._layer = this.ui?.panels?.layers?.current || 'normal';
    if (Tutorial.seen()) { this.stop(); return; }
    this.start();
  }

  /** Partie chargée : le tutoriel n'a plus rien à raconter. */
  onLoadedGame() { this.stop(); }

  /** Démarre (ou redémarre) le tutoriel. Appelé par le menu principal. */
  start() {
    if (!this.node) return;
    Tutorial.write(null);
    this._rotated = false;
    this._layer = this.ui?.panels?.layers?.current || 'normal';
    this.active = true;
    this.setFolded(false);
    this.node.hidden = false;
    this._go(0);
  }

  /** Arrête l'affichage sans rien mémoriser (changement de partie). */
  stop() {
    this.active = false;
    this.index = -1;
    if (this.node) this.node.hidden = true;
    this._clearTarget();
    this._syncRoot(true);
  }

  /** Abandon explicite du joueur. */
  quit() {
    Tutorial.write({ status: 'quit', step: this.currentStep()?.id || null, at: Date.now() });
    this.stop();
  }

  /** Dernière étape validée. */
  finish() {
    Tutorial.write({ status: 'done', step: this.currentStep()?.id || null, at: Date.now() });
    this.stop();
  }

  currentStep() { return this.index >= 0 ? this.steps[this.index] : null; }

  /** Étape suivante (validée, ou passée par le joueur). */
  next() {
    if (!this.active) return;
    if (this.index >= this.steps.length - 1) { this.finish(); return; }
    this._go(this.index + 1);
  }

  _go(i) {
    this.index = i;
    const step = this.steps[i];
    if (!step) { this.finish(); return; }

    // Instantané d'entrée : l'étape demande une action NOUVELLE.
    this.snap = {};
    try { this.snap = step.enter ? (step.enter(this._ctx()) || {}) : {}; }
    catch (err) { console.warn('[Tutorial] enter', step.id, err); }

    this._forceCompact = false;
    this._compact = false;
    this.node.classList.remove('is-compact');
    this._render(step);
    this._syncRoot(true);
    // Une étape déjà satisfaite à l'entrée ne doit pas rester affichée.
    this.update(this.game.state);
  }

  /* =================================================================== */
  /*  RENDU (uniquement au changement d'étape)                           */
  /* =================================================================== */

  _render(step) {
    setText(this.counter, `${this.index + 1}/${this.steps.length}`);
    setText(this.title, step.title);
    setText(this.actionText, step.action || '');
    this.action.hidden = !step.action;

    clear(this.text);
    for (const p of step.body || []) this.text.appendChild(el('p', { text: p }));

    for (let i = 0; i < this._dotNodes.length; i++) {
      const d = this._dotNodes[i];
      d.className = i < this.index ? 'is-done' : i === this.index ? 'is-current' : '';
    }

    this.endBtn.hidden = !step.final;
    this.skipBtn.hidden = !!step.final;
    this.node.dataset.tutStep = step.id;
    this.node.classList.toggle('is-final', !!step.final);
  }

  setFolded(v) {
    this.folded = !!v;
    if (!this.node) return;
    this.node.classList.toggle('is-folded', this.folded);
    this.body.hidden = this.folded;
    this.foot.hidden = this.folded;
    this.foldBtn.textContent = this.folded ? '▴' : '▾';
    this.foldBtn.setAttribute('aria-label', this.folded ? 'Déplier le tutoriel' : 'Réduire le tutoriel');
    this._syncRoot(true);
  }

  /* =================================================================== */
  /*  BOUCLE (~10 Hz) — aucune création de DOM ici                       */
  /* =================================================================== */

  update(state) {
    if (!this.active || !this.node || this.node.hidden) return;
    const step = this.currentStep();
    if (!step) return;

    let done = false;
    try { done = !!step.done?.(this._ctx(state), this.snap); }
    catch (err) { console.warn('[Tutorial] done', step.id, err); }
    if (done) { this.next(); return; }

    this._syncTarget(step);
    this._syncRoot();
  }

  /** Hauteur insuffisante pour afficher l'encart complet sans masquer le globe. */
  _ecranCourt() {
    try { return (window.innerHeight || 0) < 520; } catch { return false; }
  }

  /**
   * Quand une étape demande de POSER un bâtiment, amène devant le joueur un
   * secteur où c'est réellement possible.
   *
   * Sans cela, le tutoriel disait « construisez » sans dire où : le secteur
   * valide pouvait se trouver sur la face cachée, et il fallait tourner la
   * planète à l'aveugle pour le trouver. Mesuré sur un contrôle automatisé :
   * 140 gestes sur un écran Android et trois étapes abandonnées en paysage,
   * contre 24 gestes sur un écran où la cible tombait par chance en vue.
   */
  _suggestPlacement() {
    const type = this.ui?.placingType;
    if (!type) { this._focusedFor = null; return; }
    if (this._focusedFor === type) return;      // une seule fois par étape
    this._focusedFor = type;

    const game = this.game;
    const R = game?.regions;
    if (!R || !this.scene?.focusRegion) return;

    // Meilleur candidat : constructible, et le plus « évident » possible.
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < R.count; i++) {
      if (!R.discovered[i]) continue;
      let ok = false;
      try { ok = game.canBuild(type, i).ok; } catch { ok = false; }
      if (!ok) continue;
      // On privilégie les secteurs riches pour la ressource concernée, et on
      // évite les pôles, moins lisibles à l'écran.
      const score = (R.minerals?.[i] ?? 0) + (R.geothermal?.[i] ?? 0) + (R.ice?.[i] ?? 0)
        - Math.abs(R.latitude?.[i] ?? 0) * 0.5;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) {
      try { this.scene.focusRegion(best); } catch { /* le tutoriel ne doit jamais casser le jeu */ }
    }
  }

  /** Résout la cible de l'étape et déplace le halo. */
  _syncTarget(step) {
    let want = null;
    try { want = typeof step.target === 'function' ? step.target(this._ctx()) : step.target; }
    catch (err) { console.warn('[Tutorial] target', step.id, err); }

    if (want === 'globe') {
      this.spot = 'globe';
      this._setTargetEl(null);
      this.node.classList.add('is-globe');
      this._hideRing();
      /* Viser la planète demande de la place : l'encart se réduit alors à son
         titre et à sa consigne, sans quoi il occupe le centre de l'écran —
         exactement là où se trouve le globe.
         Le critère n'est pas « téléphone » mais « écran court » : en paysage
         (844×390) l'encart couvrait à lui seul les deux tiers de la hauteur,
         et trois étapes de construction étaient infranchissables autrement
         qu'en les passant. */
      this._setCompact(this.ui?.isPhone === true || this._ecranCourt());
      this._suggestPlacement();
      return;
    }
    this.spot = null;
    this.node.classList.remove('is-globe');
    this._setCompact(false);

    let found = null;
    if (Array.isArray(want)) {
      for (const sel of want) {
        const node = document.querySelector(sel);
        if (visible(node)) { found = node; break; }
      }
    }
    this._setTargetEl(found);
    if (!found) { this._hideRing(); return; }

    const r = found.getBoundingClientRect();
    this._moveRing(r);
    this._avoid(r);
  }

  _setTargetEl(node) {
    if (this.targetEl === node) return;
    this.targetEl?.classList.remove('tn-tut-target');
    this.targetEl = node;
    this.targetEl?.classList.add('tn-tut-target');
    if (this.node) this.node.dataset.tutTarget = node ? '1' : '';
    // Une carte au fond d'un panneau défilant : le halo ne sert à rien si la
    // carte est hors de vue. On l'amène à l'écran — sans lui donner le focus,
    // et une seule fois, au moment où elle devient la cible.
    if (node) {
      try { node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      catch { /* navigateur sans options : sans importance */ }
    }
  }

  _clearTarget() {
    this._setTargetEl(null);
    this._hideRing();
  }

  _hideRing() {
    if (this.ring && !this.ring.hidden) this.ring.hidden = true;
  }

  _moveRing(r) {
    const box = {
      left: Math.round(r.left - RING_PAD), top: Math.round(r.top - RING_PAD),
      w: Math.round(r.width + RING_PAD * 2), h: Math.round(r.height + RING_PAD * 2),
    };
    const key = `${box.left},${box.top},${box.w},${box.h}`;
    if (this.ring._k !== key) {
      this.ring._k = key;
      this.ring.style.transform = `translate(${box.left}px, ${box.top}px)`;
      this.ring.style.width = box.w + 'px';
      this.ring.style.height = box.h + 'px';
    }
    if (this.ring.hidden) this.ring.hidden = false;
  }

  /**
   * Un encart qui recouvre le bouton dont il parle est pire que pas d'encart
   * du tout. La mise en page l'évite déjà ; si un cas limite subsiste (petit
   * écran, feuille très haute), l'encart se réduit à son titre et sa consigne.
   * Sans retour en arrière dans l'étape : pas d'oscillation.
   */
  _avoid(targetRect) {
    if (this._forceCompact || this.folded) return;
    const own = this.node.getBoundingClientRect();
    if (!overlaps(own, targetRect)) return;
    this._forceCompact = true;   // sans retour en arrière dans l'étape
    this._setCompact(true);
  }

  /** Forme réduite : le titre et la consigne, sans l'explication. */
  _setCompact(v) {
    const want = !!v || !!this._forceCompact;
    if (this._compact === want) return;
    this._compact = want;
    this.node.classList.toggle('is-compact', want);
  }

  /**
   * Publie la présence et la hauteur de l'encart : sur téléphone, les feuilles
   * et les bulles s'en servent pour ne pas passer dessous.
   */
  _syncRoot(force = false) {
    const visibleNow = this.active && this.node && !this.node.hidden;
    this.ui?.root?.classList.toggle('has-tutorial', !!visibleNow);
    // Mesurer force un calcul de mise en page : quatre fois par seconde suffit.
    const now = performance.now();
    if (!force && now - (this._measuredAt || 0) < 250) return;
    this._measuredAt = now;
    const h = visibleNow ? Math.round(this.node.getBoundingClientRect().height) : 0;
    if (h !== this._lastH) {
      this._lastH = h;
      document.documentElement.style.setProperty('--tn-tut-h', h + 'px');
    }
    if (!visibleNow && this.node) this.node.classList.remove('is-compact');
  }

  /* =================================================================== */

  destroy() {
    for (const off of this._subs) { try { off(); } catch { /* ignore */ } }
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._subs.length = 0;
    this._offs.length = 0;
    this._clearTarget();
    this.ui?.root?.classList.remove('has-tutorial');
    document.documentElement.style.removeProperty('--tn-tut-h');
    this.ring?.remove();
    this.node?.remove();
    this.ring = null;
    this.node = null;
  }
}

export default Tutorial;

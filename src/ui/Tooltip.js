/**
 * Infobulle unique, réutilisée pour toute l'interface.
 *
 * Deux présentations pour un seul contenu :
 *  - POINTEUR FIN (souris) : survol, apparition après ~200 ms, aucun clic
 *    nécessaire, ne sort jamais de l'écran. Comportement historique inchangé.
 *  - POINTEUR GROSSIER (doigt) : le survol n'existe pas. Un APPUI ouvre le
 *    même contenu dans un panneau lisible, refermable (croix, appui à côté,
 *    Échap). Sans cela, toute l'information des infobulles — au premier chef
 *    la décomposition des indicateurs planétaires — serait inaccessible.
 *
 * Le contenu est produit par la même fonction dans les deux cas : il n'existe
 * qu'UNE source d'information, pas une version « mobile » appauvrie.
 */
import { el, clear, on } from './dom.js';

const DELAY = 200;
const MARGIN = 10;

export class Tooltip {
  constructor(root) {
    this.root = root;
    this.node = null;
    this.card = null;
    this.body = null;
    this.anchor = null;
    this.timer = 0;
    this.mode = 'hover';      // 'hover' | 'tap'
    this._subs = [];
    this._attached = new WeakMap();
  }

  /** Vrai si le pointeur principal est un doigt : l'appui remplace le survol. */
  get tapEnabled() {
    try { return window.matchMedia('(pointer: coarse)').matches; }
    catch { return false; }
  }

  mount() {
    this.body = el('div', { class: 'tn-tip-body' });
    this.closeBtn = el('button', {
      class: 'tn-icon-btn tn-tip-close', type: 'button',
      'aria-label': 'Fermer le détail', text: '×',
    });
    this._subs.push(on(this.closeBtn, 'click', (e) => { e.stopPropagation(); this.hide(); }));

    this.node = el('div', {
      class: 'tn-tooltip', role: 'tooltip', 'aria-hidden': 'true',
    }, this.closeBtn, this.body);
    this.node.hidden = true;
    this.root.appendChild(this.node);

    // Prise en charge globale de l'attribut `data-tip` (texte simple) :
    // survol à la souris, appui au doigt — les deux passent par ici.
    this._subs.push(on(this.root, 'mouseover', (e) => {
      if (this.tapEnabled) return;
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (!t || this._attached.has(t)) return;
      this.schedule(t, () => t.getAttribute('data-tip'));
    }, true));
    this._subs.push(on(this.root, 'mouseout', (e) => {
      if (this.mode === 'tap') return;
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (t && t === this.anchor) this.hide();
    }, true));
    this._subs.push(on(this.root, 'click', (e) => {
      if (!this.tapEnabled) return;
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      // Une commande garde son action : son infobulle ne fait que la nommer,
      // et son nom accessible est déjà porté par `aria-label`.
      if (!t || this._attached.has(t) || isControl(t)) return;
      this.toggleTap(t, () => t.getAttribute('data-tip'));
    }));

    // Fermeture : appui hors du panneau, perte de focus, Échap.
    this._subs.push(on(document, 'pointerdown', (e) => {
      if (this.mode !== 'tap' || this.node.hidden) return;
      const t = e.target;
      if (t instanceof Node && (this.node.contains(t) || (this.anchor && this.anchor.contains(t)))) return;
      this.hide();
    }, true));
    this._subs.push(on(window, 'blur', () => this.hide()));
    this._subs.push(on(window, 'resize', () => this.hide()));
    this._subs.push(on(document, 'keydown', (e) => { if (e.key === 'Escape') this.hide(); }, true));
    return this.node;
  }

  /**
   * Attache une infobulle riche à un nœud.
   *
   * `opts.tap` :
   *  - 'auto' (défaut) : l'appui ouvre le panneau, SAUF si le nœud est déjà une
   *    commande (bouton, lien…) — sinon l'appui déclencherait deux choses à la
   *    fois. Ces commandes reçoivent à la place un bouton « ⓘ » dédié.
   *  - 'always' : l'appui ouvre toujours le panneau (bouton « ⓘ »).
   *
   * @param {Element} node
   * @param {Function|string|Node} contentFn
   * @param {{tap?: 'auto'|'always'}} [opts]
   * @returns {() => void} détachement
   */
  attach(node, contentFn, opts = {}) {
    if (!node) return () => {};
    this._attached.set(node, contentFn);
    const tappable = opts.tap === 'always' || !isControl(node);
    // Marqueur lisible par l'audit : ce nœud délivre son information à l'appui.
    if (tappable) node.dataset.tapInfo = '1';
    if (tappable && !node.hasAttribute('tabindex') && !FOCUSABLE.includes(node.tagName)) {
      node.setAttribute('tabindex', '0');
    }
    if (tappable) node.setAttribute('aria-haspopup', 'dialog');

    const offEnter = on(node, 'mouseenter', () => { if (!this.tapEnabled) this.schedule(node, contentFn); });
    const offLeave = on(node, 'mouseleave', () => { if (this.mode !== 'tap' && this.anchor === node) this.hide(); });
    const offFocus = on(node, 'focus', () => { if (!this.tapEnabled) this.show(node, contentFn); });
    const offBlur = on(node, 'blur', () => { if (this.mode !== 'tap' && this.anchor === node) this.hide(); });
    const offDown = on(node, 'mousedown', () => { if (!this.tapEnabled) this.hide(); });
    const offTap = on(node, 'click', (e) => {
      if (!tappable || !this.tapEnabled) return;
      e.stopPropagation();
      this.toggleTap(node, contentFn);
    });
    const offKey = on(node, 'keydown', (e) => {
      if (!tappable || !this.tapEnabled) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleTap(node, contentFn); }
    });
    const detach = () => {
      offEnter(); offLeave(); offFocus(); offBlur(); offDown(); offTap(); offKey();
      this._attached.delete(node);
      delete node.dataset.tapInfo;
      if (this.anchor === node) this.hide();
    };
    this._subs.push(detach);
    return detach;
  }

  /** Appui : ouvre le panneau, ou le referme s'il portait déjà cette ancre. */
  toggleTap(node, contentFn) {
    if (this.anchor === node && !this.node.hidden) { this.hide(); return; }
    this.show(node, contentFn, 'tap');
  }

  schedule(node, contentFn) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(node, contentFn), DELAY);
  }

  show(node, contentFn, mode = 'hover') {
    if (!this.node || !node || !node.isConnected) return;
    let content = contentFn;
    if (typeof contentFn === 'function') {
      try { content = contentFn(node); } catch { content = null; }
    }
    if (content === null || content === undefined || content === '') { this.hide(); return; }

    clear(this.body);
    if (content instanceof Node) this.body.appendChild(content);
    else this.body.appendChild(document.createTextNode(String(content)));

    this.mode = mode;
    this.anchor = node;
    this.node.hidden = false;
    this.node.classList.toggle('is-tap', mode === 'tap');
    this.node.setAttribute('role', mode === 'tap' ? 'dialog' : 'tooltip');
    this.closeBtn.hidden = mode !== 'tap';
    this.node.setAttribute('aria-hidden', 'false');
    this.node.classList.add('is-visible');
    if (mode === 'tap') this.node.style.transform = '';
    else this.place(node);
  }

  place(node) {
    const a = node.getBoundingClientRect();
    const t = this.node.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;

    // Par défaut sous l'ancre, aligné à gauche.
    let top = a.bottom + 8;
    let left = a.left;

    if (top + t.height > vh - MARGIN) {
      const above = a.top - t.height - 8;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - t.height - MARGIN);
    }
    if (left + t.width > vw - MARGIN) left = a.right - t.width;
    if (left < MARGIN) left = MARGIN;
    if (left + t.width > vw - MARGIN) left = Math.max(MARGIN, vw - t.width - MARGIN);
    if (top < MARGIN) top = MARGIN;

    this.node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide() {
    clearTimeout(this.timer);
    this.anchor = null;
    this.mode = 'hover';
    if (!this.node) return;
    this.node.classList.remove('is-visible', 'is-tap');
    this.node.hidden = true;
    this.node.setAttribute('aria-hidden', 'true');
  }

  destroy() {
    clearTimeout(this.timer);
    for (const off of this._subs) { try { off(); } catch { /* ignore */ } }
    this._subs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

const FOCUSABLE = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'];

/** Un nœud qui a déjà une action propre : l'appui ne doit pas la voler. */
function isControl(node) {
  try { return node.matches('button, a, input, select, textarea, [role="button"], [role="radio"], [role="tab"]'); }
  catch { return false; }
}

export default Tooltip;

/**
 * Infobulle unique, réutilisée pour toute l'interface.
 * - contenu : chaîne, Node, ou fonction retournant l'un des deux
 * - positionnement : ne sort jamais de l'écran
 * - délai d'apparition ~200 ms
 */
import { el, clear, on } from './dom.js';

const DELAY = 200;
const MARGIN = 10;

export class Tooltip {
  constructor(root) {
    this.root = root;
    this.node = null;
    this.anchor = null;
    this.timer = 0;
    this._subs = [];
    this._attached = new WeakMap();
  }

  mount() {
    this.node = el('div', {
      class: 'tn-tooltip', role: 'tooltip', 'aria-hidden': 'true',
    });
    this.node.hidden = true;
    this.root.appendChild(this.node);

    // Prise en charge globale de l'attribut `data-tip` (texte simple).
    this._subs.push(on(this.root, 'mouseover', (e) => {
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (!t || this._attached.has(t)) return;
      this.schedule(t, () => t.getAttribute('data-tip'));
    }, true));
    this._subs.push(on(this.root, 'mouseout', (e) => {
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (t && t === this.anchor) this.hide();
    }, true));
    this._subs.push(on(window, 'blur', () => this.hide()));
    this._subs.push(on(window, 'resize', () => this.hide()));
    this._subs.push(on(document, 'keydown', (e) => { if (e.key === 'Escape') this.hide(); }, true));
    return this.node;
  }

  /**
   * Attache une infobulle riche à un nœud.
   * @param {Element} node
   * @param {Function|string|Node} contentFn
   * @returns {() => void} détachement
   */
  attach(node, contentFn) {
    if (!node) return () => {};
    this._attached.set(node, contentFn);
    const offEnter = on(node, 'mouseenter', () => this.schedule(node, contentFn));
    const offLeave = on(node, 'mouseleave', () => { if (this.anchor === node) this.hide(); });
    const offFocus = on(node, 'focus', () => this.show(node, contentFn));
    const offBlur = on(node, 'blur', () => { if (this.anchor === node) this.hide(); });
    const offDown = on(node, 'mousedown', () => this.hide());
    const detach = () => {
      offEnter(); offLeave(); offFocus(); offBlur(); offDown();
      this._attached.delete(node);
      if (this.anchor === node) this.hide();
    };
    this._subs.push(detach);
    return detach;
  }

  schedule(node, contentFn) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(node, contentFn), DELAY);
  }

  show(node, contentFn) {
    if (!this.node || !node || !node.isConnected) return;
    let content = contentFn;
    if (typeof contentFn === 'function') {
      try { content = contentFn(node); } catch { content = null; }
    }
    if (content === null || content === undefined || content === '') { this.hide(); return; }

    clear(this.node);
    if (content instanceof Node) this.node.appendChild(content);
    else this.node.appendChild(document.createTextNode(String(content)));

    this.anchor = node;
    this.node.hidden = false;
    this.node.setAttribute('aria-hidden', 'false');
    this.node.classList.add('is-visible');
    this.place(node);
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
    if (!this.node) return;
    this.node.classList.remove('is-visible');
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

export default Tooltip;

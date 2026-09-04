/**
 * Pile de notifications, en bas à droite.
 * - types : info / success / warn / danger (liseré coloré à gauche)
 * - disparition automatique (~6 s), 5 visibles au maximum
 * - clic : centre la caméra sur la région concernée si `regionId` est fourni
 */
import { el, on } from './dom.js';

const LIFETIME = 6000;
const MAX_VISIBLE = 5;
const DEFAULT_ICON = { info: '›', success: '✓', warn: '⚠', danger: '⚠' };

export class Notifications {
  constructor(root, scene, game) {
    this.root = root;
    this.scene = scene;
    this.game = game;
    this.node = null;
    this.items = [];
  }

  mount() {
    this.node = el('div', {
      class: 'tn-notifs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Notifications',
    });
    this.root.appendChild(this.node);
    return this.node;
  }

  /**
   * @param {{text:string, kind?:string, icon?:string, title?:string, regionId?:number}} n
   */
  push(n) {
    if (!this.node || !n || !n.text) return;
    const kind = ['info', 'success', 'warn', 'danger'].includes(n.kind) ? n.kind : 'info';
    const hasRegion = Number.isInteger(n.regionId) && n.regionId >= 0;

    const card = el('div', {
      class: `tn-notif tn-notif--${kind}` + (hasRegion ? ' is-clickable' : ''),
      role: hasRegion ? 'button' : null,
      tabindex: hasRegion ? '0' : null,
    },
      el('span', { class: 'tn-notif-icon', 'aria-hidden': 'true', text: n.icon || DEFAULT_ICON[kind] }),
      el('div', { class: 'tn-notif-body' },
        n.title ? el('div', { class: 'tn-notif-title', text: n.title }) : null,
        el('div', { class: 'tn-notif-text', text: n.text }),
        hasRegion ? el('div', { class: 'tn-notif-hint', text: `Secteur ${n.regionId} — cliquer pour centrer` }) : null),
      el('button', {
        class: 'tn-notif-close', type: 'button', 'aria-label': 'Fermer la notification', text: '×',
      }));

    const item = { card, timer: 0, offs: [] };
    const close = () => this.remove(item);

    item.offs.push(on(card.querySelector('.tn-notif-close'), 'click', (e) => { e.stopPropagation(); close(); }));
    if (hasRegion) {
      const focus = () => {
        try { this.scene?.focusRegion?.(n.regionId); } catch { /* ignore */ }
        try { this.game?.selectRegion?.(n.regionId); } catch { /* ignore */ }
        close();
      };
      item.offs.push(on(card, 'click', focus));
      item.offs.push(on(card, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focus(); }
      }));
    }
    item.offs.push(on(card, 'mouseenter', () => { clearTimeout(item.timer); }));
    item.offs.push(on(card, 'mouseleave', () => { item.timer = setTimeout(close, 2000); }));

    this.node.appendChild(card);
    this.items.push(item);
    item.timer = setTimeout(close, LIFETIME);

    while (this.items.length > MAX_VISIBLE) this.remove(this.items[0], true);

    // Animation d'entrée (double rAF pour laisser le style initial s'appliquer).
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('is-in')));
  }

  remove(item, immediate = false) {
    const i = this.items.indexOf(item);
    if (i < 0) return;
    this.items.splice(i, 1);
    clearTimeout(item.timer);
    for (const off of item.offs) { try { off(); } catch { /* ignore */ } }
    item.offs.length = 0;
    if (immediate) { item.card.remove(); return; }
    item.card.classList.remove('is-in');
    item.card.classList.add('is-out');
    setTimeout(() => item.card.remove(), 200);
  }

  clearAll() {
    for (const item of this.items.slice()) this.remove(item, true);
  }

  destroy() {
    this.clearAll();
    this.node?.remove();
    this.node = null;
  }
}

export default Notifications;

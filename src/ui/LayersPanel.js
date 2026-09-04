/**
 * Sélecteur de couche de visualisation + légende de la couche active.
 * Appelle `scene.setLayer(id)` puis émet `layer:changed`.
 */
import { el, clear, on } from './dom.js';
import { LAYERS, DEFAULT_LAYER } from '../data/layers.js';

export class LayersPanel {
  constructor(ctx) {
    this.game = ctx.game;
    this.scene = ctx.scene;
    this.tooltip = ctx.tooltip;
    this.node = null;
    this.buttons = new Map();
    this.current = DEFAULT_LAYER;
    this._offs = [];
  }

  mount() {
    const list = el('div', { class: 'tn-layers', role: 'radiogroup', 'aria-label': 'Couches de visualisation' });
    for (const layer of LAYERS) {
      const btn = el('button', {
        class: 'tn-layer', type: 'button', role: 'radio', 'aria-checked': 'false',
        dataset: { layer: layer.id },
      },
        el('span', { class: 'tn-layer-icon', 'aria-hidden': 'true', text: layer.icon }),
        el('span', { class: 'tn-layer-name', text: layer.name }));
      this.tooltip?.attach(btn, () => layer.desc || layer.name);
      this._offs.push(on(btn, 'click', () => this.select(layer.id)));
      this.buttons.set(layer.id, btn);
      list.appendChild(btn);
    }

    this.legend = el('div', { class: 'tn-legend' });
    this.desc = el('p', { class: 'tn-hint' });

    this.node = el('div', { class: 'tn-dock-panel tn-layers-panel' },
      list,
      el('div', { class: 'tn-section-title', text: 'Légende' }),
      this.legend, this.desc);

    this.select(this.current, true);
    return this.node;
  }

  /** Couche suivante (raccourci Tab). */
  cycle(dir = 1) {
    const i = LAYERS.findIndex((l) => l.id === this.current);
    const next = LAYERS[(i + dir + LAYERS.length) % LAYERS.length];
    this.select(next.id);
    return next;
  }

  select(id, silent = false) {
    const layer = LAYERS.find((l) => l.id === id) || LAYERS[0];
    this.current = layer.id;
    for (const [key, btn] of this.buttons) {
      const on_ = key === layer.id;
      btn.classList.toggle('is-active', on_);
      btn.setAttribute('aria-checked', on_ ? 'true' : 'false');
    }
    try { this.scene?.setLayer?.(layer.id); } catch (err) { console.warn('[LayersPanel] setLayer', err); }
    if (!silent) this.game.bus.emit('layer:changed', { layer: layer.id });
    this._renderLegend(layer);
    return layer;
  }

  _renderLegend(layer) {
    clear(this.legend);
    this.desc.textContent = layer.desc || '';
    const scale = layer.scale;
    if (!Array.isArray(scale) || !scale.length) {
      this.legend.appendChild(el('div', { class: 'tn-hint', text: 'Aucune échelle pour cette couche.' }));
      return;
    }
    const gradient = scale.map((s, i) => `${s.color} ${(i / (scale.length - 1) * 100).toFixed(0)}%`).join(', ');
    this.legend.appendChild(el('div', {
      class: 'tn-legend-ramp', style: { background: `linear-gradient(90deg, ${gradient})` },
      'aria-hidden': 'true',
    }));
    this.legend.appendChild(el('div', { class: 'tn-legend-labels' },
      scale.map((s) => el('span', { class: 'tn-legend-label', text: s.label }))));
  }

  update() { /* rien de dynamique */ }
  onShow() { }

  destroy() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this.node?.remove();
    this.node = null;
  }
}

export default LayersPanel;

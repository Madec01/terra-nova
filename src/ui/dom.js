/**
 * Mini-helpers de création DOM. Aucun framework, aucun virtual DOM :
 * on crée les nœuds une fois, puis on n'écrit que les valeurs qui changent.
 */

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) { for (const c of child) appendChild(parent, c); return; }
  if (child instanceof Node) { parent.appendChild(child); return; }
  parent.appendChild(document.createTextNode(String(child)));
}

/**
 * Crée un élément.
 * @param {string} tag
 * @param {object|null} props  class/text/html/style/dataset/aria, on* pour les
 *                             écouteurs, tout le reste devient un attribut.
 * @param {...any} children    Node, chaîne, tableau, null (ignoré)
 */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const key in props) {
      const v = props[key];
      if (v === null || v === undefined || v === false) continue;
      if (key === 'class' || key === 'className') node.className = v;
      else if (key === 'text') node.textContent = v;
      else if (key === 'html') node.innerHTML = v;
      else if (key === 'style') {
        if (typeof v === 'string') node.setAttribute('style', v);
        else for (const k in v) node.style.setProperty(k, v[k]);
      } else if (key === 'dataset') {
        for (const k in v) node.dataset[k] = v[k];
      } else if (key === 'value') node.value = v;
      else if (key === 'disabled' || key === 'checked' || key === 'selected') node[key] = !!v;
      else if (key.length > 2 && key.startsWith('on') && typeof v === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), v);
      } else node.setAttribute(key, v === true ? '' : v);
    }
  }
  appendChild(node, children);
  return node;
}

/** Fragment, optionnellement rempli. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChild(f, children);
  return f;
}

/** Vide un nœud (rapide, sans innerHTML). */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Écouteur d'événement. Retourne la fonction de désinscription.
 * @returns {() => void}
 */
export function on(node, ev, fn, opts) {
  if (!node) return () => {};
  node.addEventListener(ev, fn, opts);
  return () => node.removeEventListener(ev, fn, opts);
}

/**
 * Barre de remplissage horizontale.
 * Le nœud retourné porte une méthode `setValue(v, max)` qui n'écrit dans le
 * style que si le remplissage a réellement changé.
 */
export function bar(value = 0, max = 1, className = '') {
  const fill = el('i', { class: 'tn-bar-fill' });
  const node = el('div', {
    class: 'tn-bar' + (className ? ' ' + className : ''),
    role: 'progressbar', 'aria-valuemin': '0',
  }, fill);
  node.setValue = (v, m = max) => {
    const ratio = m > 0 ? Math.max(0, Math.min(1, v / m)) : 0;
    const pct = (ratio * 100).toFixed(1) + '%';
    if (node._pct !== pct) {
      node._pct = pct;
      fill.style.width = pct;
      node.setAttribute('aria-valuenow', (ratio * 100).toFixed(0));
    }
    return ratio;
  };
  node.setValue(value, max);
  return node;
}

export default { el, frag, clear, on, bar };

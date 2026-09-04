/**
 * Gestes des « feuilles » glissant depuis le bas (mobile).
 *
 * Une feuille se ferme par glissement vers le bas, se déplie par glissement
 * vers le haut. Le geste est capté sur une poignée (barre grise en haut de la
 * feuille) et non sur tout le panneau : le contenu reste défilable au doigt.
 *
 * Aucune dépendance : `pointerdown/move/up` couvrent souris, stylet et doigt.
 */

const CLOSE_PX = 84;     // glissement vers le bas au-delà duquel on ferme
const STEP_PX = 34;      // glissement minimal pour replier / déplier
const MAX_PULL = 24;     // résistance élastique vers le haut

/**
 * @param {HTMLElement} sheet   la feuille (translatée pendant le geste)
 * @param {HTMLElement} handle  la poignée qui capte le geste
 * @param {{ onClose?:Function, onCollapse?:Function, onExpand?:Function,
 *           enabled?:() => boolean, expanded?:() => boolean }} opts
 * @returns {() => void} désinscription
 */
export function sheetDrag(sheet, handle, opts = {}) {
  if (!sheet || !handle) return () => {};
  const enabled = opts.enabled || (() => true);
  const isExpanded = opts.expanded || (() => true);
  let startY = 0;
  let dy = 0;
  let active = false;

  const reset = () => {
    sheet.style.transform = '';
    sheet.classList.remove('is-dragging');
    active = false;
    dy = 0;
  };

  const onDown = (e) => {
    if (!enabled() || active || (e.button !== undefined && e.button > 0)) return;
    active = true;
    startY = e.clientY;
    dy = 0;
    sheet.classList.add('is-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onMove = (e) => {
    if (!active) return;
    dy = e.clientY - startY;
    const shown = dy >= 0 ? dy : -Math.min(MAX_PULL, -dy);
    sheet.style.transform = `translateY(${shown.toFixed(1)}px)`;
    e.preventDefault();
  };

  const onUp = () => {
    if (!active) return;
    const delta = dy;
    reset();
    if (delta > CLOSE_PX) { opts.onClose?.(); return; }
    if (delta > STEP_PX) {
      if (isExpanded() && opts.onCollapse) opts.onCollapse();
      else opts.onClose?.();
      return;
    }
    if (delta < -STEP_PX && !isExpanded()) opts.onExpand?.();
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', () => { reset(); });

  return () => {
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    reset();
  };
}

export default sheetDrag;

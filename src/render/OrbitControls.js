/**
 * ============================================================================
 *  TERRA NOVA — Contrôles orbitaux (implémentation maison)
 * ============================================================================
 *  Volontairement indépendant de `three/examples` : on a besoin d'un
 *  comportement précis (distinction clic / glisser fiable au toucher, inertie,
 *  auto-rotation, transition animée vers une région) et d'un contrôle total sur
 *  les listeners pour ne rien laisser fuir à la destruction.
 *
 *  Un seul chemin de code souris + tactile grâce aux Pointer Events.
 *
 *  Modèle : coordonnées sphériques (theta, phi, distance) autour de l'origine.
 *    theta : azimut, libre.
 *    phi   : angle depuis le pôle nord, borné pour ne jamais se retourner.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { clamp, damp } from '../utils/math.js';

const CLICK_MAX_DISTANCE = 5;      // px
const CLICK_MAX_DURATION = 350;    // ms
const PHI_MIN = 0.12;
const PHI_MAX = Math.PI - 0.12;
const IDLE_BEFORE_AUTOROTATE = 4.0; // secondes

export class OrbitControls {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLCanvasElement} domElement
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.enabled = true;
    this.autoRotate = true;

    const R = BALANCE.render;
    this.minDistance = R.cameraMinDistance;
    this.maxDistance = R.cameraMaxDistance;
    this.rotationSpeed = R.rotationSpeed;
    this.zoomSpeed = R.zoomSpeed;
    this.damping = R.rotationDamping;
    this.autoRotateSpeed = R.autoRotateSpeed;

    // État courant et cible (le lissage se fait vers la cible).
    this.theta = 0.6;
    this.phi = Math.PI * 0.44;
    this.distance = R.cameraStartDistance;
    this.targetDistance = this.distance;
    this.target = new THREE.Vector3(0, 0, 0);

    // Vitesse angulaire résiduelle (inertie).
    this.vTheta = 0;
    this.vPhi = 0;

    this.idleTime = 0;

    /** Callbacks : (clientX, clientY) => void */
    this.onClick = null;
    this.onHover = null;

    /* --- état du geste ------------------------------------------------- */
    this._pointers = new Map();      // pointerId -> {x, y}
    this._dragging = false;
    this._downX = 0; this._downY = 0; this._downTime = 0;
    this._moved = 0;
    this._pinchDist = 0;
    this._primaryId = null;

    /* --- transition animée (focus) ------------------------------------- */
    this._focus = null;

    /* --- scratch réutilisés : aucune allocation par frame --------------- */
    this._v = new THREE.Vector3();
    this._offset = new THREE.Vector3();

    this._bind();
    this._applyCamera();
  }

  /* ==================================================================== */
  /*  Listeners                                                           */
  /* ==================================================================== */

  _bind() {
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onPointerCancel = (e) => this._pointerCancel(e);
    this._onWheel = (e) => this._wheel(e);
    this._onContextMenu = (e) => e.preventDefault();

    const d = this.dom;
    d.addEventListener('pointerdown', this._onPointerDown);
    d.addEventListener('pointermove', this._onPointerMove);
    d.addEventListener('pointerup', this._onPointerUp);
    d.addEventListener('pointercancel', this._onPointerCancel);
    d.addEventListener('pointerleave', this._onPointerCancel);
    // passive:false : on doit pouvoir bloquer le scroll de la page.
    d.addEventListener('wheel', this._onWheel, { passive: false });
    d.addEventListener('contextmenu', this._onContextMenu);
    // Empêche le navigateur de s'approprier le geste tactile.
    d.style.touchAction = 'none';
  }

  _pointerDown(e) {
    if (!this.enabled) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.idleTime = 0;
    this._cancelFocus();

    if (this._pointers.size === 1) {
      this._primaryId = e.pointerId;
      this._dragging = true;
      this._downX = e.clientX; this._downY = e.clientY;
      this._downTime = performance.now();
      this._moved = 0;
      this.vTheta = 0; this.vPhi = 0;
      try { this.dom.setPointerCapture(e.pointerId); } catch (_) { /* ignoré */ }
    } else if (this._pointers.size === 2) {
      // Passage en pincement : on annule le glisser en cours.
      this._dragging = false;
      this._pinchDist = this._pinchDistance();
    }
  }

  _pointerMove(e) {
    if (!this.enabled) return;
    const p = this._pointers.get(e.pointerId);

    if (p === undefined) {
      // Simple survol (souris sans bouton enfoncée).
      if (this.onHover && e.pointerType === 'mouse') this.onHover(e.clientX, e.clientY);
      return;
    }

    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (this._pointers.size >= 2) {
      const d = this._pinchDistance();
      if (this._pinchDist > 0 && d > 0) {
        // Un pincement qui écarte les doigts rapproche la caméra.
        this.targetDistance = clamp(
          this.targetDistance * (this._pinchDist / d),
          this.minDistance, this.maxDistance);
      }
      this._pinchDist = d;
      this.idleTime = 0;
      return;
    }

    if (!this._dragging || e.pointerId !== this._primaryId) return;

    this._moved += Math.abs(dx) + Math.abs(dy);
    // Vitesse proportionnelle à la distance : de près on veut aller moins vite.
    const k = this.rotationSpeed * (0.55 + 0.45 * (this.distance / this.maxDistance));
    this.vTheta = -dx * k;
    this.vPhi = -dy * k;
    this.theta += this.vTheta;
    this.phi = clamp(this.phi + this.vPhi, PHI_MIN, PHI_MAX);
    this.idleTime = 0;
  }

  _pointerUp(e) {
    if (!this._pointers.has(e.pointerId)) return;
    const wasPrimary = e.pointerId === this._primaryId;
    this._pointers.delete(e.pointerId);
    try { this.dom.releasePointerCapture(e.pointerId); } catch (_) { /* ignoré */ }

    if (this._pointers.size < 2) this._pinchDist = 0;

    if (wasPrimary && this._dragging) {
      this._dragging = false;
      this._primaryId = null;
      const dt = performance.now() - this._downTime;
      const dist = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
      // CLIC : peu de déplacement ET geste court. Vrai aussi au toucher.
      if (dist < CLICK_MAX_DISTANCE && dt < CLICK_MAX_DURATION) {
        this.vTheta = 0; this.vPhi = 0;
        if (this.onClick) this.onClick(e.clientX, e.clientY);
      }
    }
    this.idleTime = 0;
  }

  _pointerCancel(e) {
    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.delete(e.pointerId);
    if (e.pointerId === this._primaryId) { this._dragging = false; this._primaryId = null; }
    if (this._pointers.size < 2) this._pinchDist = 0;
    try { this.dom.releasePointerCapture(e.pointerId); } catch (_) { /* ignoré */ }
  }

  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this._cancelFocus();
    // deltaMode 1 = lignes, 2 = pages : on normalise en pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const delta = e.deltaY * unit;
    // Zoom multiplicatif : le ressenti est constant à toutes les distances.
    this.targetDistance = clamp(
      this.targetDistance * Math.exp(delta * this.zoomSpeed),
      this.minDistance, this.maxDistance);
    this.idleTime = 0;
  }

  _pinchDistance() {
    const it = this._pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /* ==================================================================== */
  /*  Transition animée vers une région                                   */
  /* ==================================================================== */

  /**
   * @param {THREE.Vector3} targetPosition point à amener face à la caméra
   * @param {number} [distance] distance finale souhaitée
   * @param {number} [duration] secondes
   */
  focus(targetPosition, distance, duration = 0.85) {
    const v = this._v.copy(targetPosition);
    const len = v.length();
    if (len < 1e-6) return;
    v.divideScalar(len);

    // Coordonnées sphériques visées (la caméra se place SUR l'axe du point).
    const phi = Math.acos(clamp(v.y, -1, 1));
    const theta = Math.atan2(v.x, v.z);

    // On prend le chemin le plus court en azimut.
    let dTheta = theta - this.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    this._focus = {
      t: 0,
      duration: Math.max(0.05, duration),
      theta0: this.theta,
      dTheta,
      phi0: this.phi,
      phi1: clamp(phi, PHI_MIN, PHI_MAX),
      dist0: this.targetDistance,
      dist1: clamp(distance ?? this.minDistance * 1.45, this.minDistance, this.maxDistance),
    };
    this.vTheta = 0; this.vPhi = 0;
    this.idleTime = 0;
  }

  _cancelFocus() { this._focus = null; }

  /* ==================================================================== */
  /*  Boucle                                                              */
  /* ==================================================================== */

  update(dt) {
    const d = Math.min(dt, 0.1);   // protection contre les gros pas (onglet caché)

    if (this._focus) {
      const f = this._focus;
      f.t += d;
      let t = Math.min(1, f.t / f.duration);
      // Ease in-out cubique : départ et arrivée sans à-coup.
      t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.theta = f.theta0 + f.dTheta * t;
      this.phi = f.phi0 + (f.phi1 - f.phi0) * t;
      this.targetDistance = f.dist0 + (f.dist1 - f.dist0) * t;
      this.distance = this.targetDistance;
      if (f.t >= f.duration) this._focus = null;
      this._applyCamera();
      return;
    }

    if (!this._dragging && this._pointers.size === 0) {
      this.idleTime += d;
      // Inertie : amortissement exponentiel indépendant du framerate.
      const decay = Math.pow(this.damping, d * 60);
      this.theta += this.vTheta;
      this.phi = clamp(this.phi + this.vPhi, PHI_MIN, PHI_MAX);
      this.vTheta *= decay;
      this.vPhi *= decay;
      if (Math.abs(this.vTheta) < 1e-6) this.vTheta = 0;
      if (Math.abs(this.vPhi) < 1e-6) this.vPhi = 0;

      // Auto-rotation quand plus rien ne bouge depuis quelques secondes.
      if (this.autoRotate && this.idleTime > IDLE_BEFORE_AUTOROTATE && this.vTheta === 0) {
        const ramp = Math.min(1, (this.idleTime - IDLE_BEFORE_AUTOROTATE) / 2);
        this.theta += this.autoRotateSpeed * d * ramp;
      }
    } else {
      this.idleTime = 0;
    }

    // Lissage du zoom.
    this.distance = damp(this.distance, this.targetDistance, 9, d);
    this._applyCamera();
  }

  _applyCamera() {
    const sp = Math.sin(this.phi);
    this._offset.set(
      sp * Math.sin(this.theta),
      Math.cos(this.phi),
      sp * Math.cos(this.theta),
    ).multiplyScalar(this.distance);
    this.camera.position.copy(this.target).add(this._offset);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
  }

  dispose() {
    const d = this.dom;
    d.removeEventListener('pointerdown', this._onPointerDown);
    d.removeEventListener('pointermove', this._onPointerMove);
    d.removeEventListener('pointerup', this._onPointerUp);
    d.removeEventListener('pointercancel', this._onPointerCancel);
    d.removeEventListener('pointerleave', this._onPointerCancel);
    d.removeEventListener('wheel', this._onWheel);
    d.removeEventListener('contextmenu', this._onContextMenu);
    this._pointers.clear();
    this.onClick = null;
    this.onHover = null;
    this._focus = null;
  }
}

export default OrbitControls;

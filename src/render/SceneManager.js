/**
 * ============================================================================
 *  TERRA NOVA — Façade de rendu (docs/CONTRACTS.md §5)
 * ============================================================================
 *  SceneManager ne possède PAS la boucle d'animation : c'est main.js qui
 *  appelle `update(dtReal, state)`. Cela garantit un seul requestAnimationFrame
 *  pour tout le jeu et un ordre déterministe simulation → rendu.
 *
 *  Responsabilités :
 *   - construire et détruire la scène ;
 *   - lisser dans le temps les grandeurs globales (température, pression…)
 *     pour que le visuel ne « saute » jamais d'un tick à l'autre ;
 *   - limiter le rafraîchissement des attributs de la planète à
 *     BALANCE.render.dataRefreshHz ;
 *   - animer les transitions de couche ;
 *   - fournir le picking et les statistiques.
 *
 *  Événements écoutés sur le bus (tous facultatifs) : region:changed,
 *  region:discovered, building:placed, building:removed, layer:changed,
 *  scan:started. Événements émis (courtoisie, hors contrat) : render:pick,
 *  render:hover — pour que main.js n'ait pas à brancher de callback s'il
 *  préfère le bus.
 * ============================================================================
 */

import * as THREE from 'three';
import { BALANCE } from '../data/balance.js';
import { LAYERS, LAYER_INDEX } from '../data/layers.js';
import { clamp, clamp01, damp } from '../utils/math.js';

import { PlanetMesh } from './PlanetMesh.js';
import { AtmosphereMesh } from './AtmosphereMesh.js';
import { CloudMesh } from './CloudMesh.js';
import { StarField } from './StarField.js';
import { StructureLayer } from './StructureLayer.js';
import { SelectionOverlay } from './SelectionOverlay.js';
import { OrbitControls } from './OrbitControls.js';

/** Durée du fondu entre deux couches de visualisation (secondes). */
const LAYER_FADE = 0.55;
/** Filet de sécurité : rafraîchissement complet des données à cette période. */
const FULL_REFRESH_PERIOD = 1.0;
/** Constante de lissage des grandeurs globales. */
const GLOBAL_LAMBDA = 1.8;

export class SceneManager {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{on:Function,emit:Function}} [bus]
   */
  constructor(canvas, bus) {
    if (!canvas) throw new Error('SceneManager : aucun canvas fourni.');
    this.canvas = canvas;
    this.bus = bus || null;

    /* --- renderer : la seule chose qui peut réellement échouer ---------- */
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
      });
    } catch (err) {
      throw new Error(
        'WebGL n’est pas disponible sur cet appareil ou est désactivé dans le navigateur. '
        + 'TERRA NOVA a besoin de WebGL pour afficher la planète.');
    }
    if (!this.renderer || !this.renderer.getContext()) {
      throw new Error('WebGL n’a pas pu être initialisé : contexte graphique indisponible.');
    }

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, BALANCE.render.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x03040a, 1);
    this.renderer.autoClear = true;

    /* --- scène et caméra ---------------------------------------------- */
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
    this.camera.position.set(0, 1.2, BALANCE.render.cameraStartDistance);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.onClick = (x, y) => this._handleClick(x, y);
    this.controls.onHover = (x, y) => this._handleHover(x, y);

    /* --- uniforms globaux partagés par tous les shaders ---------------- */
    this.shared = {
      uSunDirection: { value: new THREE.Vector3(0.82, 0.34, 0.46).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.955, 0.90) },
      uNightAmbient: { value: new THREE.Color(0.052, 0.072, 0.125) },
      uInsolation: { value: 1 },
      uTime: { value: 0 },
    };

    this.sky = new StarField(this.renderer.getPixelRatio());
    this.scene.add(this.sky.object3D);

    this.atmosphere = new AtmosphereMesh(this.shared);
    this.scene.add(this.atmosphere.object3D);

    this.clouds = new CloudMesh(this.shared);
    this.scene.add(this.clouds.object3D);

    this.structures = new StructureLayer(this.shared);
    this.scene.add(this.structures.object3D);

    this.planet = null;
    this.overlay = null;
    this.regions = null;

    /* --- état de rendu ------------------------------------------------- */
    this.layerId = 'normal';
    this._layerAnim = 0;         // 0 = pas de transition en cours
    this.selected = null;
    this.hovered = null;

    this._dirty = new Set();
    this._dirtyAll = false;
    this._refreshAccum = 0;
    this._fullAccum = 0;
    this._buildingsDirty = false;

    /** Grandeurs globales lissées : c'est ce que voient les shaders. */
    this.smoothed = {
      temperature: BALANCE.start.globals.temperature,
      pressure: BALANCE.start.globals.pressure,
      oxygen: BALANCE.start.globals.oxygen,
      cloudCover: 0,
      waterCoverage: BALANCE.start.globals.waterCoverage,
      insolation: BALANCE.start.globals.insolation,
      stability: BALANCE.start.globals.stability,
    };
    this._smoothInit = false;

    /* --- statistiques -------------------------------------------------- */
    this._fpsSamples = new Float32Array(40);
    this._fpsIndex = 0;
    this._fpsFilled = 0;
    this._stats = { fps: 0, drawCalls: 0, triangles: 0, regions: 0 };

    /* --- scratch : aucune allocation dans update() --------------------- */
    this._ndc = new THREE.Vector2();
    this._ray = new THREE.Raycaster();
    this._vec = new THREE.Vector3();

    /* --- callbacks publics --------------------------------------------- */
    this.onRegionClick = null;
    this.onRegionHover = null;

    this._contextLost = false;
    this._disposed = false;
    this._bindContextEvents();
    this._bindBus();

    this.resize();
  }

  /* ==================================================================== */
  /*  Contexte WebGL                                                      */
  /* ==================================================================== */

  _bindContextEvents() {
    this._onContextLost = (e) => {
      e.preventDefault();          // sans ça, le contexte n'est jamais restauré
      this._contextLost = true;
      if (this.bus) this.bus.emit('notify', {
        text: 'Contexte graphique perdu — restauration en cours…', kind: 'warn', icon: '⚠',
      });
    };
    this._onContextRestored = () => {
      this._contextLost = false;
      // Three réenvoie automatiquement géométries et programmes ; on force
      // simplement un renvoi complet des attributs dynamiques.
      this._dirtyAll = true;
      if (this.bus) this.bus.emit('notify', {
        text: 'Contexte graphique restauré.', kind: 'success', icon: '✓',
      });
    };
    this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
  }

  _bindBus() {
    this._unsubs = [];
    if (!this.bus || typeof this.bus.on !== 'function') return;
    const on = (name, fn) => {
      const off = this.bus.on(name, fn);
      if (typeof off === 'function') this._unsubs.push(off);
      else this._unsubs.push(() => this.bus.off && this.bus.off(name, fn));
    };

    on('region:changed', (p) => { if (p && p.regionId !== undefined) this.markRegionsDirty([p.regionId]); });
    on('region:discovered', (p) => { if (p && p.regionId !== undefined) this.markRegionsDirty([p.regionId]); });
    on('building:placed', () => { this._buildingsDirty = true; });
    on('building:removed', () => { this._buildingsDirty = true; });
    on('layer:changed', (p) => { if (p && p.layer) this.setLayer(p.layer); });
    on('scan:started', (p) => {
      if (!p || p.regionId === undefined) return;
      // `duration` est en JOURS de jeu : on le convertit en secondes réelles.
      const days = p.duration ?? BALANCE.exploration.scanDays;
      const secs = days * BALANCE.time.tickSeconds / Math.max(1e-6, BALANCE.time.daysPerTick);
      this.scanWave(p.regionId, secs);
    });
  }

  /* ==================================================================== */
  /*  Planète                                                             */
  /* ==================================================================== */

  /** (Re)construit la planète. Peut être appelé plusieurs fois (nouvelle partie). */
  setPlanet(regions, state) {
    if (!regions || !regions.count) throw new Error('SceneManager.setPlanet : RegionManager invalide.');

    if (this.planet) {
      this.scene.remove(this.planet.object3D);
      this.planet.dispose();
      this.planet = null;
    }
    if (this.overlay) {
      this.scene.remove(this.overlay.object3D);
      this.overlay.dispose();
      this.overlay = null;
    }
    this.structures.clear();

    this.regions = regions;
    // Les uniforms globaux (soleil, temps, insolation) sont partagés avec
    // l'atmosphère, les nuages et les bâtiments : une seule source de vérité.
    this.planet = new PlanetMesh(regions, state, this.shared);
    this.scene.add(this.planet.object3D);

    this.overlay = new SelectionOverlay(this.planet);
    this.scene.add(this.overlay.object3D);

    this.structures.setPlanet(this.planet);

    this.selected = null;
    this.hovered = null;
    this._dirty.clear();
    this._dirtyAll = true;
    this._smoothInit = false;
    this._stats.regions = regions.count;

    // Applique immédiatement la couche et l'état courants.
    const idx = LAYER_INDEX[this.layerId] ?? 0;
    this.planet.uniforms.uLayerFrom.value = idx;
    this.planet.uniforms.uLayerTo.value = idx;
    this.planet.uniforms.uLayerBlend.value = 1;

    if (state) {
      this._syncGlobals(state, 1);
      this.syncBuildings(state);
    }
  }

  /** @param {string} layerId identifiant de LAYERS ('normal', 'temperature'…) */
  setLayer(layerId) {
    const id = LAYER_INDEX[layerId] !== undefined ? layerId : 'normal';
    if (id === this.layerId) return;
    this.layerId = id;
    if (!this.planet) return;
    const u = this.planet.uniforms;
    // On repart de ce qui est RÉELLEMENT affiché pour éviter tout saut.
    u.uLayerFrom.value = u.uLayerBlend.value >= 0.5 ? u.uLayerTo.value : u.uLayerFrom.value;
    u.uLayerTo.value = LAYER_INDEX[id];
    u.uLayerBlend.value = 0;
    this._layerAnim = 1;
  }

  /** Liste des couches disponibles (pratique pour l'UI). */
  get layers() { return LAYERS; }

  setSelected(regionId) {
    const id = (regionId === null || regionId === undefined) ? null : (regionId | 0);
    this.selected = id;
    if (this.overlay) this.overlay.setSelected(id);
    if (this.planet) this.planet.uniforms.uSelected.value = id === null ? -1 : id;
  }

  setHovered(regionId) {
    const id = (regionId === null || regionId === undefined) ? null : (regionId | 0);
    if (id === this.hovered) return;
    this.hovered = id;
    if (this.overlay) this.overlay.setHovered(id);
    if (this.planet) this.planet.uniforms.uHovered.value = id === null ? -1 : id;
  }

  /** @param {number[]|Set<number>|null} idsOrNull null = toute la planète */
  markRegionsDirty(idsOrNull) {
    if (idsOrNull === null || idsOrNull === undefined) { this._dirtyAll = true; return; }
    if (typeof idsOrNull === 'number') { this._dirty.add(idsOrNull | 0); return; }
    for (const id of idsOrNull) this._dirty.add(id | 0);
  }

  syncBuildings(state) {
    if (!this.planet || !this.regions) return;
    this.structures.sync(state, this.regions);
    this._buildingsDirty = false;
  }

  pulse(regionId) { if (this.overlay) this.overlay.pulse(regionId); }

  scanWave(regionId, duration) { if (this.overlay) this.overlay.scanWave(regionId, duration); }

  /* ==================================================================== */
  /*  Picking                                                             */
  /* ==================================================================== */

  /** @returns {number|null} id de région sous le curseur, null pour l'espace */
  pick(clientX, clientY) {
    if (!this.planet) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._ray.setFromCamera(this._ndc, this.camera);
    return this.planet.raycastRegion(this._ray);
  }

  _handleClick(x, y) {
    const id = this.pick(x, y);
    if (id !== null) this.pulse(id);
    if (this.onRegionClick) this.onRegionClick(id);
    if (this.bus) this.bus.emit('render:pick', { regionId: id });
  }

  _handleHover(x, y) {
    const id = this.pick(x, y);
    if (id === this.hovered) return;
    this.setHovered(id);
    if (this.onRegionHover) this.onRegionHover(id);
    if (this.bus) this.bus.emit('render:hover', { regionId: id });
  }

  /** Transition animée de la caméra vers une région. */
  focusRegion(regionId) {
    if (!this.planet || !this.regions) return;
    if (regionId === null || regionId === undefined) return;
    this.planet.getRegionPosition(this.regions, regionId | 0, this._vec);
    const dist = clamp(BALANCE.render.cameraMinDistance * 1.35,
      BALANCE.render.cameraMinDistance, BALANCE.render.cameraMaxDistance);
    this.controls.focus(this._vec, dist);
  }

  /* ==================================================================== */
  /*  Boucle                                                              */
  /* ==================================================================== */

  /**
   * @param {number} dtReal secondes réelles écoulées depuis la frame précédente
   * @param {object} state  état de jeu
   */
  update(dtReal, state) {
    if (this._disposed) return;
    const dt = Math.min(Math.max(dtReal || 0, 0), 0.1);

    this._sampleFps(dtReal);
    this.shared.uTime.value += dt;

    this.controls.update(dt);
    this.sky.follow(this.camera);
    this.sky.update(dt);
    this.clouds.update(dt);
    this.structures.update(dt);
    if (this.overlay) this.overlay.update(dt);

    if (state) this._syncGlobals(state, dt);

    // Transition de couche.
    if (this._layerAnim > 0 && this.planet) {
      const u = this.planet.uniforms;
      u.uLayerBlend.value = Math.min(1, u.uLayerBlend.value + dt / LAYER_FADE);
      if (u.uLayerBlend.value >= 1) {
        u.uLayerFrom.value = u.uLayerTo.value;
        u.uLayerBlend.value = 1;
        this._layerAnim = 0;
      }
    }

    if (this.planet && this.regions) {
      this.planet.update(dt, this.regions);
      this._flushDirty(dt, state);
    }

    if (this._buildingsDirty && state) this.syncBuildings(state);

    if (this._contextLost) return;
    this.renderer.render(this.scene, this.camera);

    const info = this.renderer.info;
    this._stats.drawCalls = info.render.calls;
    this._stats.triangles = info.render.triangles;
  }

  /** Lissage temporel : aucun paramètre visuel ne change brutalement. */
  _syncGlobals(state, dt) {
    const g = state.globals || {};
    const s = this.smoothed;
    const k = this._smoothInit ? dt : 1e9;   // premier appel : on colle à l'état

    const cloudTarget = g.cloudCover !== undefined
      ? clamp01(g.cloudCover)
      // Repli si la simulation n'expose pas encore cloudCover : l'humidité
      // disponible dépend surtout de l'eau libre et de la température.
      : clamp01((g.waterCoverage || 0) * 1.7 + (g.biomass || 0) / 400);

    s.temperature = damp(s.temperature, g.temperature ?? s.temperature, GLOBAL_LAMBDA, k);
    s.pressure = damp(s.pressure, g.pressure ?? s.pressure, GLOBAL_LAMBDA, k);
    s.oxygen = damp(s.oxygen, g.oxygen ?? s.oxygen, GLOBAL_LAMBDA, k);
    s.cloudCover = damp(s.cloudCover, cloudTarget, GLOBAL_LAMBDA, k);
    s.waterCoverage = damp(s.waterCoverage, g.waterCoverage ?? s.waterCoverage, GLOBAL_LAMBDA, k);
    s.insolation = damp(s.insolation, g.insolation ?? 1, GLOBAL_LAMBDA, k);
    s.stability = damp(s.stability, g.stability ?? s.stability, GLOBAL_LAMBDA, k);
    this._smoothInit = true;

    this.shared.uInsolation.value = clamp(s.insolation, 0.2, 3);
    // Une étoile mieux exploitée (miroirs) éclaire plus blanc.
    const warm = clamp01((s.insolation - 1) * 0.6);
    this.shared.uSunColor.value.setRGB(1.0, 0.955 + warm * 0.03, 0.90 + warm * 0.08);

    this.atmosphere.setState(s.pressure, s.oxygen);
    // Nuages chargés quand le climat se dégrade.
    this.clouds.setCoverage(s.cloudCover, clamp01(1 - s.stability / 100) * 0.8);
    if (this.planet) this.planet.setWaterCoverage(s.waterCoverage);
  }

  /** Applique le throttling de BALANCE.render.dataRefreshHz. */
  _flushDirty(dt, state) {
    const period = 1 / Math.max(1, BALANCE.render.dataRefreshHz);
    this._refreshAccum += dt;
    this._fullAccum += dt;

    // Filet de sécurité : même sans event region:changed, tout est resynchronisé
    // une fois par seconde. Coût négligeable devant un rendu à 60 FPS.
    if (this._fullAccum >= FULL_REFRESH_PERIOD) {
      this._fullAccum = 0;
      this._dirtyAll = true;
    }

    if (this._refreshAccum < period) return;
    this._refreshAccum = 0;

    if (this._dirtyAll) {
      this.planet.updateRegions(this.regions, state, null);
      this._dirtyAll = false;
      this._dirty.clear();
      return;
    }
    if (this._dirty.size === 0) return;
    this.planet.updateRegions(this.regions, state, this._dirty);
    this._dirty.clear();
  }

  _sampleFps(dtReal) {
    if (!dtReal || dtReal <= 0) return;
    this._fpsSamples[this._fpsIndex] = 1 / dtReal;
    this._fpsIndex = (this._fpsIndex + 1) % this._fpsSamples.length;
    if (this._fpsFilled < this._fpsSamples.length) this._fpsFilled++;
    let sum = 0;
    for (let i = 0; i < this._fpsFilled; i++) sum += this._fpsSamples[i];
    this._stats.fps = this._fpsFilled ? sum / this._fpsFilled : 0;
  }

  /* ==================================================================== */

  resize() {
    if (this._disposed) return;
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    const pr = Math.min(window.devicePixelRatio || 1, BALANCE.render.maxPixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.sky.setPixelRatio(this.renderer.getPixelRatio());
  }

  /** @returns {{fps:number, drawCalls:number, triangles:number, regions:number}} */
  get stats() { return this._stats; }

  /** Direction de l'étoile (lecture seule utile aux tests visuels). */
  get sunDirection() { return this.shared.uSunDirection.value; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this._unsubs) for (const off of this._unsubs) { try { off(); } catch (_) { /* ignoré */ } }
    this._unsubs = null;

    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);

    this.controls.dispose();

    if (this.planet) { this.scene.remove(this.planet.object3D); this.planet.dispose(); this.planet = null; }
    if (this.overlay) { this.scene.remove(this.overlay.object3D); this.overlay.dispose(); this.overlay = null; }
    this.scene.remove(this.structures.object3D); this.structures.dispose();
    this.scene.remove(this.clouds.object3D); this.clouds.dispose();
    this.scene.remove(this.atmosphere.object3D); this.atmosphere.dispose();
    this.scene.remove(this.sky.object3D); this.sky.dispose();

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.regions = null;
    this.onRegionClick = null;
    this.onRegionHover = null;
  }
}

export default SceneManager;

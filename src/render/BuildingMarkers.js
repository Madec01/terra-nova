/**
 * ============================================================================
 *  TERRA NOVA — Marqueurs de bâtiments (billboards, UN SEUL draw call)
 * ============================================================================
 *  LE PROBLÈME QUE CE FICHIER RÈGLE
 *  --------------------------------
 *  À la distance de jeu réelle, les petits modèles — mine, station
 *  scientifique, dépôt, ensemenceur — convergeaient tous vers « une tache
 *  sombre avec un mât ». On ne savait pas ce qu'on avait construit sans zoomer.
 *  Un pictogramme flotte donc au-dessus de chaque installation : il porte la
 *  forme, la couleur et le dessin de son type (voir tools/sprite-gen.mjs).
 *  Il COMPLÈTE le modèle 3D, il ne le remplace pas.
 *
 *  COMMENT
 *  -------
 *  Une seule `THREE.Mesh` sur une `InstancedBufferGeometry` : un quad, autant
 *  d'instances que de bâtiments, UN draw call quel qu'en soit le nombre. Le
 *  billboard est fait dans le shader de sommet — le quad est déplié dans
 *  l'espace de la VUE, il fait donc toujours face à la caméra sans qu'une
 *  seule matrice soit recalculée côté CPU.
 *
 *  Aucune allocation par frame : les attributs sont écrits UNIQUEMENT quand la
 *  liste des bâtiments change, et rien d'autre ne bouge ensuite.
 *
 *  TAILLE À L'ÉCRAN
 *  ----------------
 *  `uSizeK` est calibré pour qu'un marqueur mesure MARQUEUR_PX pixels CSS,
 *  quelle que soit la distance : la taille monde vaut `uSizeK × distance`.
 *  Passé SHRINK_NEAR, on rabote cette distance effective — le marqueur
 *  rapetisse alors doucement au lieu de rester une pastille pleine taille sur
 *  une planète devenue petite.
 *
 *  DEUX EFFACEMENTS, calculés eux aussi dans le shader :
 *   · en DISTANCE, sur la même fenêtre que les bâtiments (StructureLayer :
 *     FADE_NEAR / FADE_FAR) mais décalée d'un cheveu vers le lointain, pour que
 *     le marqueur survive juste assez longtemps à son modèle pour le nommer ;
 *   · en FACE CACHÉE : `facing` est le cosinus entre la verticale locale de la
 *     cellule et la direction de la caméra. Sans ce test, les marqueurs de
 *     l'autre hémisphère — qui flottent AU-DESSUS du sol, donc hors du disque —
 *     débordaient de la silhouette de la planète.
 * ============================================================================
 */

import * as THREE from 'three';
import { BUILDINGS } from '../data/buildings.js';
import { markerRadius } from './StructureLayer.js';
import { SPRITE_CELL, SPRITE_GRID, SPRITE_FRAMES, SPRITE_ATLAS_URI } from './SpriteAtlas.js';

/**
 * Fenêtre d'effacement en distance CAMÉRA → MARQUEUR. Les bâtiments
 * disparaissent entre 1,75 et 2,05 ; on décale de 0,06 pour que le
 * pictogramme soit la DERNIÈRE chose à s'éteindre — c'est lui qui porte
 * l'information — sans pour autant survivre au cadrage plein-planète, où la
 * cellule la plus proche est à 2,06.
 */
const FADE_NEAR = 1.81;
const FADE_FAR = 2.11;

/** Effacement de face cachée, en cosinus d'angle avec la verticale locale. */
const HIDE_IN = 0.16;
const HIDE_OUT = 0.34;

/** Distances entre lesquelles le marqueur cesse de garder sa taille écran. */
const SHRINK_NEAR = 1.35;
const SHRINK_FAR = 2.11;
/** Fraction de taille conservée au-delà de SHRINK_FAR. */
const SHRINK_KEEP = 0.62;

/**
 * Taille visée du QUAD, en pixels CSS. Le pictogramme lui-même occupe la case
 * moins sa marge (voir tools/sprite-gen.mjs) : il apparaît donc à ~80 % de
 * cette valeur, soit une quarantaine de pixels — assez pour se lire, trop peu
 * pour masquer le bâtiment qu'il désigne.
 */
const MARQUEUR_PX = 50;
/** Bornes de la taille relative, pour les écrans très petits ou très grands. */
const TAILLE_MIN = 0.030;
const TAILLE_MAX = 0.095;

/**
 * Décalage vertical du quad, en fraction de sa propre taille. L'ancrage est
 * déjà au sommet du bâtiment : ce décalage-ci ne fait que dégager le
 * pictogramme du toit, à l'écran. Trop grand, le marqueur se détache de son
 * bâtiment et on ne sait plus lequel il désigne.
 */
const OFFSET_Y = 0.38;

/** Capacité initiale : au-delà, les attributs sont réalloués (rare). */
const CAPACITE_INITIALE = 64;

/* -------------------------------------------------------------------------- */
/*  Shaders                                                                   */
/* -------------------------------------------------------------------------- */

const markerVertex = /* glsl */ `
attribute vec3 aAnchor;     // point d'ancrage monde (au-dessus du bâtiment)
attribute vec2 aFrame;      // coin haut-gauche de la case, en UV
attribute float aState;     // 1 = actif, 0 = inactif

uniform vec2 uCell;         // taille d'une case, en UV
uniform float uSizeK;       // taille monde = uSizeK × distance
uniform float uFade;        // atténuation globale (0 → marqueurs éteints)

varying vec2 vUv;
varying float vAlpha;
varying float vState;

const float FADE_NEAR = ${FADE_NEAR.toFixed(3)};
const float FADE_FAR  = ${FADE_FAR.toFixed(3)};
const float HIDE_IN   = ${HIDE_IN.toFixed(3)};
const float HIDE_OUT  = ${HIDE_OUT.toFixed(3)};
const float SHRINK_NEAR = ${SHRINK_NEAR.toFixed(3)};
const float SHRINK_FAR  = ${SHRINK_FAR.toFixed(3)};
const float SHRINK_KEEP = ${SHRINK_KEEP.toFixed(3)};
const float OFFSET_Y = ${OFFSET_Y.toFixed(3)};

void main() {
  vec3 anchor = (modelMatrix * vec4(aAnchor, 1.0)).xyz;
  vec3 radial = normalize(anchor);
  vec3 toCam = cameraPosition - anchor;
  float camDist = max(1e-4, length(toCam));
  float facing = dot(radial, toCam / camDist);

  // --- effacement en distance, puis en face cachée ---------------------
  float loin = 1.0 - smoothstep(FADE_NEAR, FADE_FAR, camDist);
  float face = smoothstep(HIDE_IN, HIDE_OUT, facing);
  vAlpha = loin * face * uFade;
  vState = aState;
  // aFrame désigne le coin HAUT-GAUCHE de la case, en coordonnées d'IMAGE
  // (origine en haut). L'axe V d'une texture part du bas : d'où le
  // retournement. Sans lui, la planche est lue à l'envers ligne par ligne et
  // chaque bâtiment porte le pictogramme d'une autre rangée.
  vUv = vec2(aFrame.x + uv.x * uCell.x,
             1.0 - aFrame.y - (1.0 - uv.y) * uCell.y);

  vec4 mv = viewMatrix * vec4(anchor, 1.0);
  float d = max(0.05, -mv.z);
  // Au-delà de SHRINK_NEAR, la distance effective est rabotée : le marqueur
  // rapetisse à l'écran au lieu de rester une pastille pleine taille.
  float rabot = mix(1.0, SHRINK_KEEP, smoothstep(SHRINK_NEAR, SHRINK_FAR, d));
  float size = uSizeK * d * rabot;

  // Billboard : le quad est déplié dans l'espace de la vue, donc toujours de
  // face, sans matrice à reconstruire.
  mv.xy += (position.xy + vec2(0.0, OFFSET_Y)) * size;
  gl_Position = projectionMatrix * mv;

  // Marqueur éteint : on le sort du frustum plutôt que de le rastériser pour
  // rien. Sur une planète pleine, c'est la moitié des instances.
  if (vAlpha <= 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const markerFragment = /* glsl */ `
uniform sampler2D uAtlas;

varying vec2 vUv;
varying float vAlpha;
varying float vState;

void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < 0.004) discard;

  // Bâtiment inactif : le pictogramme est désaturé et assombri, exactement
  // comme StructureLayer grise le modèle. On reste lisible, on n'attire plus
  // l'œil.
  float gris = dot(t.rgb, vec3(0.299, 0.587, 0.114));
  vec3 couleur = mix(vec3(gris) * 0.72, t.rgb, clamp(vState, 0.0, 1.0));

  gl_FragColor = vec4(couleur, t.a * vAlpha);
  // PAS de tonemapping_fragment ici, volontairement : la planche est dessinée
  // dans la palette de l'INTERFACE, et un pictogramme n'est pas une surface
  // éclairée. Passer par ACES le délaverait et il ne parlerait plus la même
  // langue que les panneaux. Seule la conversion d'espace colorimétrique est
  // appliquée, ce qui restitue la couleur d'origine au pixel près.
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */

export class BuildingMarkers {
  /**
   * @param {object} [shared] uniforms partagés (non utilisés aujourd'hui,
   *   acceptés pour rester homogène avec les autres couches de rendu)
   */
  constructor(shared) {
    this.shared = shared || null;
    this.object3D = new THREE.Group();
    this.object3D.name = 'building-markers';
    // Après les opaques : les marqueurs sont translucides et ne s'écrivent pas
    // dans le tampon de profondeur.
    this.object3D.renderOrder = 12;

    /** Vrai dès que la planche est décodée. */
    this.ready = false;
    /** Nombre d'instances actuellement soumises. */
    this.count = 0;

    this._planet = null;
    this._capacity = CAPACITE_INITIALE;
    this._signature = 0;
    /** Ancrages, en monde : relus par countVisible(), jamais par frame. */
    this._anchors = new Float32Array(CAPACITE_INITIALE * 3);

    this._texture = this._loadAtlas();
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this._texture },
        uCell: { value: new THREE.Vector2(SPRITE_CELL / SPRITE_GRID.width, SPRITE_CELL / SPRITE_GRID.height) },
        uSizeK: { value: 0.035 },
        uFade: { value: 1 },
      },
      vertexShader: markerVertex,
      fragmentShader: markerFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this._geometry = this._makeGeometry(this._capacity);
    this._mesh = new THREE.Mesh(this._geometry, this._material);
    this._mesh.frustumCulled = false;      // le tri est fait dans le shader
    this._mesh.name = 'building-markers-mesh';
    this.object3D.add(this._mesh);
  }

  /* ==================================================================== */
  /*  Ressources                                                          */
  /* ==================================================================== */

  /**
   * La planche est un data URI : aucune requête réseau, donc rien qui puisse
   * échouer en 404 selon le mode de publication (source brute ou build).
   */
  _loadAtlas() {
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.premultiplyAlpha = false;

    if (typeof Image === 'undefined') return tex;   // contexte sans DOM
    const img = new Image();
    img.onload = () => {
      tex.image = img;
      tex.needsUpdate = true;
      this.ready = true;
    };
    img.onerror = () => { this.ready = false; };
    img.src = SPRITE_ATLAS_URI;
    return tex;
  }

  _makeGeometry(capacity) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
      .setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFrame', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
      .setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aState', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
      .setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = 0;
    // Le tri de visibilité étant fait dans le shader, la sphère englobante ne
    // sert à rien : on la neutralise pour que Three ne la recalcule jamais.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    quad.dispose();
    return geo;
  }

  _grow(needed) {
    if (needed <= this._capacity) return;
    const capacity = 1 << Math.ceil(Math.log2(needed));
    this.object3D.remove(this._mesh);
    this._geometry.dispose();
    this._capacity = capacity;
    this._anchors = new Float32Array(capacity * 3);
    this._geometry = this._makeGeometry(capacity);
    this._mesh = new THREE.Mesh(this._geometry, this._material);
    this._mesh.frustumCulled = false;
    this._mesh.name = 'building-markers-mesh';
    this.object3D.add(this._mesh);
  }

  /* ==================================================================== */
  /*  Réglages                                                            */
  /* ==================================================================== */

  /** PlanetMesh : donne le relief et la taille réelle des cellules. */
  setPlanet(planetMesh) { this._planet = planetMesh; }

  /**
   * Calibre la taille écran. À appeler au redimensionnement — jamais par frame.
   * @param {number} hauteurCss hauteur du canvas en pixels CSS
   * @param {number} fovDeg     ouverture verticale de la caméra
   */
  setViewport(hauteurCss, fovDeg) {
    const h = Math.max(1, hauteurCss || 1);
    // Taille voulue, en fraction de la hauteur de l'image.
    const frac = Math.min(TAILLE_MAX, Math.max(TAILLE_MIN, MARQUEUR_PX / h));
    // Un objet de taille S à la distance d occupe S / (2 d tan(fov/2)) de
    // l'image : on inverse.
    const demiFov = ((fovDeg || 45) * Math.PI / 180) * 0.5;
    this._material.uniforms.uSizeK.value = 2 * Math.tan(demiFov) * frac;
  }

  /** Atténuation globale (1 = normal, 0 = éteint). */
  setFade(v) { this._material.uniforms.uFade.value = Math.max(0, Math.min(1, v)); }

  /** Affiche ou masque tous les marqueurs. */
  setVisible(v) { this.object3D.visible = !!v; }

  /** @returns {boolean} */
  get visible() { return this.object3D.visible; }

  /* ==================================================================== */
  /*  Synchronisation                                                     */
  /* ==================================================================== */

  /**
   * Reconstruit les attributs si — et seulement si — la liste des bâtiments a
   * changé. Même signature que StructureLayer.sync().
   * @param {object} state
   * @param {object} regions RegionManager
   */
  sync(state, regions) {
    const list = (state && state.buildings) || [];
    if (!regions || !this._planet) { this._setCount(0); return; }

    let sig = list.length * 2654435761;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      sig = (sig ^ BuildingMarkers._hash(b.type)) * 16777619 >>> 0;
      sig = (sig + (b.region | 0) * 2246822519 + (b.active === false ? 7 : 3)) >>> 0;
    }
    if (sig === this._signature) return;
    this._signature = sig;

    this._grow(Math.max(1, list.length));

    const anchors = this._geometry.getAttribute('aAnchor');
    const frames = this._geometry.getAttribute('aFrame');
    const states = this._geometry.getAttribute('aState');
    const cellU = SPRITE_CELL / SPRITE_GRID.width;
    const cellV = SPRITE_CELL / SPRITE_GRID.height;
    const p = regions.positions;

    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const frame = SPRITE_FRAMES[b.type];
      // Un type sans pictogramme ne doit pas faire tomber le rendu : il n'a
      // simplement pas de marqueur.
      if (!frame || !BUILDINGS[b.type]) continue;

      const region = b.region | 0;
      if (region < 0 || region >= regions.count) continue;

      const nx = p[region * 3], ny = p[region * 3 + 1], nz = p[region * 3 + 2];
      const cr = this._planet.cellRadius[region];
      const dia = 2 * this._planet.cellSize[region];
      const r = markerRadius(b.type, cr, dia);

      anchors.array[n * 3] = nx * r;
      anchors.array[n * 3 + 1] = ny * r;
      anchors.array[n * 3 + 2] = nz * r;
      this._anchors[n * 3] = nx * r;
      this._anchors[n * 3 + 1] = ny * r;
      this._anchors[n * 3 + 2] = nz * r;

      // Coin HAUT-gauche de la case : l'axe V des textures est inversé par
      // rapport à l'axe Y de l'image, d'où le retournement dans le shader.
      frames.array[n * 2] = frame.col * cellU;
      frames.array[n * 2 + 1] = frame.row * cellV;

      states.array[n] = b.active === false ? 0 : 1;
      n++;
    }

    anchors.needsUpdate = true;
    frames.needsUpdate = true;
    states.needsUpdate = true;
    this._setCount(n);
  }

  _setCount(n) {
    this.count = n;
    this._geometry.instanceCount = n;
  }

  /** Vide les marqueurs sans détruire les ressources (nouvelle partie). */
  clear() {
    this._signature = 0;
    this._setCount(0);
  }

  /* ==================================================================== */
  /*  Instrumentation                                                     */
  /* ==================================================================== */

  /**
   * Nombre de marqueurs RÉELLEMENT visibles pour cette caméra : le même calcul
   * que le shader, refait sur le CPU. Sert aux outils de vérification
   * (tools/sprite-check.mjs) ; n'est jamais appelé par la boucle de rendu.
   *
   * @param {THREE.Camera} camera
   * @returns {number}
   */
  countVisible(camera) {
    if (!camera || !this.object3D.visible) return 0;
    const c = camera.position;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const ax = this._anchors[i * 3], ay = this._anchors[i * 3 + 1], az = this._anchors[i * 3 + 2];
      const ar = Math.hypot(ax, ay, az) || 1;
      const dx = c.x - ax, dy = c.y - ay, dz = c.z - az;
      const d = Math.hypot(dx, dy, dz) || 1e-4;
      const facing = (ax * dx + ay * dy + az * dz) / (ar * d);
      const loin = 1 - BuildingMarkers._smoothstep(FADE_NEAR, FADE_FAR, d);
      const face = BuildingMarkers._smoothstep(HIDE_IN, HIDE_OUT, facing);
      if (loin * face * this._material.uniforms.uFade.value > 0.05) n++;
    }
    return n;
  }

  static _smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  static _hash(s) {
    let h = 2166136261;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* ==================================================================== */

  dispose() {
    this.object3D.remove(this._mesh);
    this._geometry.dispose();
    this._material.dispose();
    this._texture.dispose();
    this.object3D.clear();
    this._planet = null;
    this.count = 0;
  }
}

export default BuildingMarkers;

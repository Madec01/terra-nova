/**
 * TOUTES les valeurs de la couche audio.
 *
 * Règle : aucun nombre magique dans `AudioEngine`, `Sfx` ni `Music`. Le moteur
 * ne fait qu'interpréter les descriptions ci-dessous. On peut donc retoucher
 * entièrement la palette sonore du jeu sans ouvrir une seule ligne de moteur.
 *
 * Aucun fichier audio : tout est synthétisé. Cela impose une discipline —
 * une onde carrée brute sonne « numérique » — d'où les principes suivants,
 * appliqués partout :
 *   - jamais d'attaque instantanée (6 ms minimum, souvent bien plus) ;
 *   - ondes sinus/triangle empilées en harmoniques choisies plutôt que
 *     scie ou carré ;
 *   - filtre passe-bas systématique ;
 *   - un envoi vers la réverbération dosé par son ;
 *   - une variation aléatoire discrète pour qu'un son répété ne soit jamais
 *     strictement identique.
 */

/* ------------------------------------------------------------------------ */
/*  1. CHAÎNE MAÎTRE                                                        */
/* ------------------------------------------------------------------------ */

export const AUDIO_CONFIG = {
  /** Volumes par défaut des trois étages (0..1). */
  volumes: { master: 0.85, music: 0.42, sfx: 0.85 },

  /** Compresseur doux sur le maître : garde-fou anti-écrêtage, pas un effet. */
  compressor: { threshold: -14, knee: 16, ratio: 2.6, attack: 0.012, release: 0.28 },

  /** Gain de sortie après compression (marge de sécurité sur la crête). */
  outputGain: 0.9,

  /**
   * Réponse impulsionnelle générée : bruit à décroissance exponentielle,
   * amorti progressivement dans l'aigu (plus le son est vieux, plus il est
   * sourd — c'est ce qui distingue une vraie salle d'un simple écho).
   */
  reverb: {
    duration: 2.6,        // longueur de la queue, en secondes
    preDelay: 0.018,      // silence initial : sépare la source de la salle
    decay: 3.1,           // exposant de décroissance
    dampStart: 0.42,      // coefficient du passe-bas à un pôle au début
    dampEnd: 0.06,        // ... et à la fin (plus petit = plus sourd)
    diffusion: 0.55,      // proportion de réflexions denses vs. bruit pur
    targetGain: 0.62,     // gain moyen de la salle (normalisation par l'énergie)
    returnLowpass: 2600,  // le retour de salle ne doit jamais briller
    returnHighpass: 180,  // ... ni empâter le bas du spectre
    returnQ: 0.6,
  },

  /** Filtrage global du bus effets : le garde-fou anti-agressivité. */
  sfxBus: { lowpass: 6000, lowpassQ: 0.6, lowpass2: 8500, highpass: 35 },

  /** Filtrage global du bus musique : nappes chaudes, jamais brillantes. */
  musicBus: { lowpass: 3200, lowpassQ: 0.5, lowpass2: 5000, highpass: 28 },

  /**
   * Bruit blanc réutilisable (transitoires percussifs, souffles). Il est lu
   * EN BOUCLE par le souffle des morceaux : trop court, on entendrait la
   * boucle se répéter.
   */
  noiseBuffer: { duration: 6.0 },

  /** Voix simultanées maximales sur le bus effets (protection processeur). */
  maxSfxVoices: 24,
};

/* ------------------------------------------------------------------------ */
/*  2. EFFETS                                                               */
/* ------------------------------------------------------------------------ */
/**
 * Format d'une voix :
 *   ratio    multiplicateur de la fondamentale `base` (ou `freq` absolue)
 *   type     'sine' | 'triangle'  (jamais 'square'/'sawtooth')
 *   gain     poids relatif dans le mélange
 *   detune   désaccord en cents : évite le côté « bip » parfaitement juste
 *   start    décalage d'attaque en secondes (arpèges, épaisseur)
 *   attack / hold / release   enveloppe, en secondes (attack ≥ 0,006)
 *   sweep    { to, time, curve }  glissando, `to` en multiple de la fréquence
 *   lp / lpEnv / lpQ   passe-bas, statique ou en points [temps, fréquence]
 *
 * `noise` : transitoire de bruit filtré, double passe-bas (24 dB/octave) pour
 * donner de la matière sans un gramme d'agressivité.
 */
export const SFX = {
  /* --- Interface : discret, feutré, jamais fatigant même répété 200 fois -- */
  ui_click: {
    base: 460,
    gain: 0.44,
    reverb: 0.22,
    jitter: { freq: 0.02, cutoff: 0.08, gain: 0.07 },
    voices: [
      { ratio: 1,    type: 'sine', gain: 1.00, detune: 0,  start: 0,     attack: 0.010, hold: 0.022, release: 0.19, lp: 2200, lpQ: 0.7 },
      { ratio: 2.01, type: 'sine', gain: 0.26, detune: 5,  start: 0.005, attack: 0.012, hold: 0.014, release: 0.13, lp: 3000, lpQ: 0.7 },
      { ratio: 4.02, type: 'sine', gain: 0.07, detune: -6, start: 0.005, attack: 0.014, hold: 0.008, release: 0.09, lp: 4200, lpQ: 0.7 },
    ],
    noise: { gain: 0.12, start: 0, attack: 0.008, hold: 0.006, release: 0.06, lp: 2000, lpQ: 0.6 },
  },

  ui_select: {
    base: 523,
    gain: 0.46,
    reverb: 0.28,
    jitter: { freq: 0.018, cutoff: 0.08, gain: 0.06 },
    voices: [
      { ratio: 1,    type: 'sine',     gain: 0.85, detune: -4, start: 0,     attack: 0.012, hold: 0.030, release: 0.22, lp: 2400, lpQ: 0.7 },
      { ratio: 1.5,  type: 'sine',     gain: 0.60, detune: 6,  start: 0.055, attack: 0.014, hold: 0.030, release: 0.28, lp: 2800, lpQ: 0.7 },
      { ratio: 3.02, type: 'triangle', gain: 0.12, detune: 0,  start: 0.055, attack: 0.020, hold: 0.010, release: 0.18, lp: 3600, lpQ: 0.7 },
    ],
    noise: { gain: 0.09, start: 0, attack: 0.009, hold: 0.004, release: 0.05, lp: 2400, lpQ: 0.6 },
  },

  /* --- Sélection d'un secteur : petit carillon, arrondi mais présent ----- */
  region: {
    base: 349,
    gain: 0.46,
    reverb: 0.36,
    jitter: { freq: 0.022, cutoff: 0.10, gain: 0.07 },
    voices: [
      { ratio: 1,    type: 'sine', gain: 0.90, detune: -5, start: 0,     attack: 0.014, hold: 0.040, release: 0.42, lp: 1900, lpQ: 0.7 },
      { ratio: 2,    type: 'sine', gain: 0.34, detune: 7,  start: 0.008, attack: 0.016, hold: 0.030, release: 0.32, lp: 2600, lpQ: 0.7 },
      { ratio: 3.01, type: 'sine', gain: 0.14, detune: 0,  start: 0.012, attack: 0.020, hold: 0.020, release: 0.24, lp: 3200, lpQ: 0.7 },
      { ratio: 5.03, type: 'sine', gain: 0.05, detune: 9,  start: 0.012, attack: 0.024, hold: 0.010, release: 0.16, lp: 4000, lpQ: 0.7 },
    ],
    noise: { gain: 0.09, start: 0, attack: 0.010, hold: 0.005, release: 0.07, lp: 1700, lpQ: 0.6 },
  },

  /* --- Construction : impact chaud, « quelque chose s'est posé » ---------
   * La fondamentale reste au-dessus de 130 Hz : plus bas, un haut-parleur de
   * portable ne restitue rien et le retour du placement disparaît.          */
  build: {
    base: 146,
    gain: 0.68,
    reverb: 0.30,
    jitter: { freq: 0.03, cutoff: 0.10, gain: 0.08 },
    voices: [
      { ratio: 1,    type: 'sine',     gain: 1.00, detune: 0,  start: 0,     attack: 0.008, hold: 0.050, release: 0.40, lp: 900, lpQ: 0.8,
        sweep: { to: 0.78, time: 0.22, curve: 'exp' } },
      { ratio: 2,    type: 'sine',     gain: 0.42, detune: -6, start: 0.006, attack: 0.010, hold: 0.045, release: 0.34, lp: 1300, lpQ: 0.7,
        sweep: { to: 0.82, time: 0.20, curve: 'exp' } },
      { ratio: 4.02, type: 'triangle', gain: 0.28, detune: 8,  start: 0.010, attack: 0.014, hold: 0.040, release: 0.30, lp: 2400, lpQ: 0.7 },
      { ratio: 6.01, type: 'sine',     gain: 0.09, detune: -4, start: 0.010, attack: 0.018, hold: 0.020, release: 0.24, lp: 2800, lpQ: 0.7 },
    ],
    noise: [
      { gain: 0.20, start: 0, attack: 0.010, hold: 0.010, release: 0.14, lp: 1400, lpQ: 0.7, lpEnd: 400 },
      { gain: 0.24, start: 0, attack: 0.010, hold: 0.016, release: 0.20, hp: 520, lp: 2300, lpQ: 0.7 },
    ],
  },

  /* --- Balayage : un mouvement de filtre qui monte puis retombe ---------- */
  scan: {
    base: 196,
    gain: 0.44,
    reverb: 0.42,
    jitter: { freq: 0.02, cutoff: 0.08, gain: 0.06 },
    voices: [
      { ratio: 1,     type: 'triangle', gain: 0.62, detune: -6, start: 0,    attack: 0.055, hold: 0.55, release: 0.40,
        lpEnv: [[0, 320], [0.42, 2400], [0.85, 520]], lpQ: 2.4 },
      { ratio: 1.505, type: 'sine',     gain: 0.40, detune: 7,  start: 0.09, attack: 0.070, hold: 0.46, release: 0.40,
        lpEnv: [[0, 380], [0.40, 2050], [0.82, 470]], lpQ: 1.8 },
    ],
    noise: { gain: 0.13, start: 0.02, attack: 0.090, hold: 0.44, release: 0.30,
             lpEnv: [[0, 460], [0.44, 2300], [0.86, 520]], lpQ: 1.6 },
  },

  /* --- Recherche : petit arpège cristallin mais adouci ------------------- */
  research: {
    base: 349,
    gain: 0.44,
    reverb: 0.48,
    jitter: { freq: 0.015, cutoff: 0.07, gain: 0.06 },
    voices: [
      { ratio: 1,     type: 'sine', gain: 0.70, detune: -4, start: 0,     attack: 0.016, hold: 0.050, release: 0.45, lp: 2100, lpQ: 0.7 },
      { ratio: 1.5,   type: 'sine', gain: 0.60, detune: 5,  start: 0.085, attack: 0.018, hold: 0.050, release: 0.50, lp: 2400, lpQ: 0.7 },
      { ratio: 2,     type: 'sine', gain: 0.48, detune: -3, start: 0.170, attack: 0.020, hold: 0.060, release: 0.60, lp: 2700, lpQ: 0.7 },
      { ratio: 3.005, type: 'sine', gain: 0.16, detune: 6,  start: 0.170, attack: 0.026, hold: 0.040, release: 0.45, lp: 3400, lpQ: 0.7 },
    ],
    noise: { gain: 0.06, start: 0, attack: 0.012, hold: 0.004, release: 0.06, lp: 2000, lpQ: 0.6 },
  },

  /* --- Découverte : accord ouvert, l'espace se déplie -------------------- */
  discovery: {
    base: 233,
    gain: 0.46,
    reverb: 0.58,
    jitter: { freq: 0.014, cutoff: 0.07, gain: 0.06 },
    voices: [
      { ratio: 1,    type: 'sine',     gain: 0.72, detune: -5, start: 0,     attack: 0.024, hold: 0.16, release: 0.85, lp: 1300, lpQ: 0.7 },
      { ratio: 1.5,  type: 'sine',     gain: 0.56, detune: 6,  start: 0.070, attack: 0.028, hold: 0.16, release: 0.90, lp: 1700, lpQ: 0.7 },
      { ratio: 2.25, type: 'sine',     gain: 0.40, detune: -4, start: 0.150, attack: 0.032, hold: 0.16, release: 0.95, lp: 2100, lpQ: 0.7 },
      { ratio: 3.01, type: 'triangle', gain: 0.18, detune: 8,  start: 0.230, attack: 0.040, hold: 0.14, release: 0.80, lp: 2600, lpQ: 0.7 },
      { ratio: 4.51, type: 'sine',     gain: 0.08, detune: -7, start: 0.230, attack: 0.050, hold: 0.10, release: 0.60, lp: 3200, lpQ: 0.7 },
    ],
    noise: { gain: 0.06, start: 0, attack: 0.018, hold: 0.006, release: 0.10, lp: 1500, lpQ: 0.6 },
  },

  /* --- Événement : grave, ample, on lève la tête sans sursauter ---------- */
  event: {
    base: 165,
    gain: 0.50,
    reverb: 0.46,
    jitter: { freq: 0.016, cutoff: 0.08, gain: 0.06 },
    voices: [
      { ratio: 1,     type: 'sine',     gain: 0.90, detune: -7, start: 0,     attack: 0.030, hold: 0.22, release: 0.70, lp: 900,  lpQ: 0.8 },
      { ratio: 1.5,   type: 'sine',     gain: 0.44, detune: 8,  start: 0.120, attack: 0.045, hold: 0.20, release: 0.70, lp: 1200, lpQ: 0.8 },
      { ratio: 2.995, type: 'triangle', gain: 0.24, detune: -5, start: 0.120, attack: 0.060, hold: 0.20, release: 0.70, lp: 2200, lpQ: 0.7 },
      { ratio: 4.505, type: 'sine',     gain: 0.09, detune: 9,  start: 0.180, attack: 0.080, hold: 0.16, release: 0.60, lp: 2500, lpQ: 0.7 },
      { ratio: 6.01,  type: 'sine',     gain: 0.05, detune: -6, start: 0.180, attack: 0.090, hold: 0.12, release: 0.45, lp: 2800, lpQ: 0.7 },
    ],
    noise: [
      { gain: 0.10, start: 0, attack: 0.030, hold: 0.020, release: 0.22, lp: 800, lpQ: 0.7, lpEnd: 300 },
      // Le grondement médium : c'est lui qui porte l'alerte sur un téléphone.
      { gain: 0.11, start: 0.02, attack: 0.070, hold: 0.14, release: 0.55, hp: 560, lp: 2300, lpQ: 0.8 },
    ],
  },

  /* --- Erreur : DISSUASIF. Intervalle bas et trouble, sans agression ----- */
  error: {
    base: 185,
    gain: 0.56,
    reverb: 0.24,
    jitter: { freq: 0.012, cutoff: 0.05, gain: 0.05 },
    voices: [
      { ratio: 1,     type: 'sine',     gain: 0.90, detune: -9, start: 0,     attack: 0.016, hold: 0.10, release: 0.34, lp: 820, lpQ: 0.9,
        sweep: { to: 0.90, time: 0.30, curve: 'exp' } },
      // Le triton (1,414) est ce qui rend le son « refusé » — mais joué doux.
      { ratio: 1.414, type: 'sine',     gain: 0.62, detune: 11, start: 0.010, attack: 0.018, hold: 0.10, release: 0.30, lp: 1000, lpQ: 0.9,
        sweep: { to: 0.90, time: 0.30, curve: 'exp' } },
      { ratio: 2.02,  type: 'triangle', gain: 0.38, detune: 0,  start: 0.010, attack: 0.024, hold: 0.09, release: 0.32, lp: 1900, lpQ: 0.8 },
      { ratio: 2.83,  type: 'sine',     gain: 0.15, detune: 13, start: 0.014, attack: 0.026, hold: 0.08, release: 0.28, lp: 2300, lpQ: 0.8 },
      { ratio: 4.04,  type: 'sine',     gain: 0.07, detune: -7, start: 0.014, attack: 0.030, hold: 0.05, release: 0.22, lp: 2700, lpQ: 0.8 },
    ],
    noise: [
      { gain: 0.08, start: 0, attack: 0.014, hold: 0.010, release: 0.09, lp: 900, lpQ: 0.7 },
      // Frappe médium sèche : le « non » se voit refuser, il ne s'évapore pas.
      { gain: 0.22, start: 0, attack: 0.014, hold: 0.020, release: 0.26, hp: 680, lp: 2500, lpQ: 0.8 },
    ],
  },

  /* --- Victoire : LUMINEUX. Arpège majeur large, filtre qui s'ouvre ------ */
  victory: {
    base: 220,
    gain: 0.40,
    reverb: 0.62,
    jitter: { freq: 0.008, cutoff: 0.05, gain: 0.04 },
    voices: [
      { ratio: 1,    type: 'sine',     gain: 0.70, detune: -4, start: 0,     attack: 0.030, hold: 0.55, release: 1.10,
        lpEnv: [[0, 700], [0.55, 2100], [1.4, 1250]], lpQ: 0.8 },
      { ratio: 1.25, type: 'sine',     gain: 0.56, detune: 5,  start: 0.110, attack: 0.030, hold: 0.48, release: 1.10,
        lpEnv: [[0, 780], [0.55, 2400], [1.4, 1330]], lpQ: 0.8 },
      { ratio: 1.5,  type: 'sine',     gain: 0.50, detune: -6, start: 0.220, attack: 0.032, hold: 0.42, release: 1.10,
        lpEnv: [[0, 870], [0.50, 2520], [1.3, 1400]], lpQ: 0.8 },
      { ratio: 2,    type: 'sine',     gain: 0.40, detune: 4,  start: 0.330, attack: 0.034, hold: 0.36, release: 1.05,
        lpEnv: [[0, 980], [0.45, 2660], [1.2, 1400]], lpQ: 0.8 },
      { ratio: 2.5,  type: 'sine',     gain: 0.28, detune: -3, start: 0.440, attack: 0.036, hold: 0.30, release: 1.00, lp: 2800, lpQ: 0.7 },
      { ratio: 3.01, type: 'triangle', gain: 0.16, detune: 7,  start: 0.550, attack: 0.045, hold: 0.26, release: 0.95, lp: 3100, lpQ: 0.7 },
    ],
    noise: { gain: 0.06, start: 0, attack: 0.030, hold: 0.010, release: 0.16, lp: 1600, lpQ: 0.6 },
  },
};

export const SFX_KEYS = Object.keys(SFX);

/* ------------------------------------------------------------------------ */
/*  3. MUSIQUE                                                              */
/* ------------------------------------------------------------------------ */

/** Réglages communs au moteur génératif. */
export const MUSIC_CONFIG = {
  /**
   * Horizon de programmation : tout est écrit à l'avance sur l'horloge de
   * l'AudioContext. C'est ce qui permet au moteur de fonctionner dans un
   * OfflineAudioContext — un `setTimeout` n'y produirait strictement rien.
   */
  scheduleHorizon: 34,
  /** Le « pompage » (navigateur seulement) rallonge l'horizon régulièrement. */
  pumpInterval: 4,
  /** Fondu d'entrée d'un morceau : jamais d'irruption. */
  fadeIn: 2.6,
  /** Fondu enchaîné lors d'un changement de morceau. */
  crossfade: 5.0,
  /** Durée d'un morceau avant enchaînement automatique. */
  trackDuration: 210,
  /** Voix de nappe simultanées, par morceau. */
  maxPadVoices: 8,
  /** Marge de sécurité avant de couper une voix terminée. */
  releaseMargin: 0.35,
};

/**
 * Cinq morceaux, cinq personnalités. Chacun a sa fondamentale, sa gamme, son
 * timbre, sa densité — de quoi les distinguer à l'oreille comme à la mesure.
 *
 *   root      fondamentale en Hz
 *   scale     degrés en demi-tons
 *   drone     bourdon continu (le lit du morceau)
 *   air       souffle de bruit filtré : l'atmosphère de la planète. Elle
 *             s'épaissit de morceau en morceau — et c'est aussi ce qui rend
 *             la musique audible sur un haut-parleur de téléphone, qui ne
 *             restitue quasiment rien sous 400 Hz.
 *   pad       nappes tenues qui se croisent
 *   bell      textures éparses
 *   reverb    dosage d'envoi vers la salle
 */
export const MUSIC_TRACKS = [
  {
    id: 'poussiere_froide',
    name: 'Poussière froide',
    mood: 'Planète morte — vide, minéral, presque immobile',
    seed: 0x5eed1001,
    root: 55.00,                // La1  (départ)
    scale: [0, 3, 5, 7, 10],   // pentatonique mineure
    gain: 0.56,
    reverb: 0.62,
    drone: {
      // Bourdon volontairement léger : un haut-parleur de téléphone ne rend
      // presque rien sous 400 Hz, donc plus le grave pèse dans le mélange,
      // plus le morceau y est faible. L'alléger rend « Poussière froide »
      // audible sur mobile — et plus vide, ce qui est la direction voulue.
      partials: [
        { ratio: 1,    type: 'sine',     gain: 1.00, detune: -6 },
        { ratio: 1.5,  type: 'sine',     gain: 0.30, detune: 7 },
        { ratio: 2.01, type: 'triangle', gain: 0.10, detune: -3 },
      ],
      lp: 250, lpQ: 0.7,
      lpLfo: { rate: 0.031, depth: 130 },   // mouvement de filtre très lent
      ampLfo: { rate: 0.047, depth: 0.42 }, // respiration de la nappe
      gain: 0.40,   // bourdon allégé : voir la note sur le téléphone
    },
    pad: {
      interval: [6.5, 13.0],
      octaves: [0],
      partials: [
        { ratio: 1,     type: 'sine', gain: 1.00, detune: -5 },
        { ratio: 2.002, type: 'sine', gain: 0.22, detune: 6 },
      ],
      attack: [3.4, 5.6], hold: [3.0, 6.0], release: [4.5, 7.5],
      lp: [290, 520], lpQ: 0.7, lpDrift: 0.55,
      gain: 0.34,
    },
    air: {
      // Un vent ténu sur une planète morte : à peine audible, jamais chaud.
      gain: 0.115, rates: [0.83, 1.19], hp: 450, lp: 740, q: 0.8, lpSlope: 1.6,
      lpLfo: { rate: 0.023, depth: 260 },
      ampLfo: { rate: 0.017, depth: 0.72 },
      attack: 7.0,
    },
    bell: {
      // Rares et lointaines : une toutes les quinze secondes environ.
      interval: [11.0, 19.0],
      octaves: [3],
      partials: [
        { ratio: 1,    type: 'sine', gain: 1.00, detune: 0 },
        { ratio: 2.01, type: 'sine', gain: 0.26, detune: 5 },
      ],
      attack: 0.11, decay: [3.5, 6.0],
      lp: [650, 900], lpQ: 0.8,
      gain: 0.10,
    },
  },

  {
    id: 'veines_de_fer',
    name: 'Veines de fer',
    mood: 'Industrialisation — tendu, métallique, sous pression',
    seed: 0x5eed2002,
    root: 73.42,                // Ré2  (quarte au-dessus)
    scale: [0, 1, 5, 7, 8],     // couleur phrygienne, inquiète
    gain: 0.54,
    reverb: 0.48,
    drone: {
      partials: [
        { ratio: 1,     type: 'sine',     gain: 1.00, detune: 5 },
        { ratio: 2,     type: 'sine',     gain: 0.34, detune: -8 },
        { ratio: 2.995, type: 'triangle', gain: 0.14, detune: 6 },
      ],
      lp: 430, lpQ: 1.4,
      lpLfo: { rate: 0.073, depth: 270 },
      ampLfo: { rate: 0.089, depth: 0.36 },
      gain: 0.50,
    },
    pad: {
      interval: [4.5, 9.0],
      octaves: [0, 1, 2],
      partials: [
        { ratio: 1,     type: 'triangle', gain: 0.80, detune: -7 },
        { ratio: 1.499, type: 'sine',     gain: 0.34, detune: 8 },
      ],
      attack: [2.4, 4.2], hold: [2.5, 5.0], release: [3.5, 6.0],
      lp: [340, 640], lpQ: 1.1, lpDrift: 0.8,
      gain: 0.30,
    },
    air: {
      gain: 0.060, rates: [0.79, 1.23], hp: 560, lp: 1500, q: 0.9, lpSlope: 1.6,
      lpLfo: { rate: 0.037, depth: 520 },
      ampLfo: { rate: 0.029, depth: 0.62 },
      attack: 6.0,
    },
    bell: {
      interval: [5.0, 10.0],
      octaves: [2, 3],
      // Rapports inharmoniques : c'est ce qui fait « métal » — mais filtrés bas.
      partials: [
        { ratio: 1,    type: 'sine', gain: 1.00, detune: 0 },
        { ratio: 2.76, type: 'sine', gain: 0.30, detune: 9 },
        { ratio: 4.10, type: 'sine', gain: 0.10, detune: -6 },
      ],
      attack: 0.05, decay: [1.6, 3.2],
      lp: [900, 1250], lpQ: 1.0,
      gain: 0.25,
    },
  },

  {
    id: 'premier_souffle',
    name: 'Premier souffle',
    mood: 'Terraformation — ça s\'ouvre, ça respire enfin',
    seed: 0x5eed3003,
    root: 92.50,                // Fa#2 (tierce majeure au-dessus)
    scale: [0, 2, 4, 7, 9],     // pentatonique majeure
    gain: 0.50,
    reverb: 0.66,
    drone: {
      partials: [
        { ratio: 1,    type: 'sine',     gain: 1.00, detune: -4 },
        { ratio: 1.5,  type: 'sine',     gain: 0.40, detune: 6 },
        { ratio: 2.01, type: 'triangle', gain: 0.16, detune: -7 },
      ],
      lp: 620, lpQ: 0.8,
      lpLfo: { rate: 0.041, depth: 340 },
      ampLfo: { rate: 0.059, depth: 0.30 },
      gain: 0.54,
    },
    pad: {
      interval: [4.0, 8.5],
      octaves: [0, 1, 2],
      partials: [
        { ratio: 1,     type: 'sine',     gain: 0.90, detune: -6 },
        { ratio: 2.004, type: 'sine',     gain: 0.30, detune: 7 },
        { ratio: 3.01,  type: 'triangle', gain: 0.09, detune: 0 },
      ],
      attack: [2.6, 4.6], hold: [3.0, 6.0], release: [4.0, 7.0],
      lp: [540, 1150], lpQ: 0.8, lpDrift: 0.7,
      gain: 0.32,
    },
    air: {
      gain: 0.054, rates: [0.87, 1.14], hp: 520, lp: 1950, q: 0.8, lpSlope: 1.6,
      lpLfo: { rate: 0.019, depth: 640 },
      ampLfo: { rate: 0.023, depth: 0.55 },
      attack: 5.5,
    },
    bell: {
      interval: [4.0, 8.0],
      octaves: [2, 3],
      partials: [
        { ratio: 1,    type: 'sine', gain: 1.00, detune: 0 },
        { ratio: 2.01, type: 'sine', gain: 0.34, detune: 5 },
        { ratio: 3.02, type: 'sine', gain: 0.11, detune: -4 },
      ],
      attack: 0.07, decay: [2.2, 4.2],
      lp: [950, 1450], lpQ: 0.8,
      gain: 0.21,
    },
  },

  {
    id: 'maree_verte',
    name: 'Marée verte',
    mood: 'Biosphère — organique, chaud, ça pousse',
    seed: 0x5eed4004,
    root: 123.47,                // Si2  (quarte au-dessus)
    scale: [0, 2, 4, 6, 9, 11],  // couleur lydienne, ouverte
    gain: 0.48,
    reverb: 0.60,
    drone: {
      partials: [
        { ratio: 1,     type: 'triangle', gain: 0.90, detune: -5 },
        { ratio: 1.5,   type: 'sine',     gain: 0.44, detune: 8 },
        { ratio: 2.005, type: 'sine',     gain: 0.22, detune: -6 },
      ],
      lp: 560, lpQ: 0.9,
      lpLfo: { rate: 0.053, depth: 300 },
      ampLfo: { rate: 0.037, depth: 0.34 },
      gain: 0.62,
    },
    pad: {
      interval: [3.6, 7.5],
      octaves: [0, 1, 2],
      partials: [
        { ratio: 1,     type: 'triangle', gain: 0.78, detune: -6 },
        { ratio: 2.003, type: 'sine',     gain: 0.34, detune: 9 },
        { ratio: 4.02,  type: 'sine',     gain: 0.10, detune: -4 },
      ],
      attack: [2.2, 4.0], hold: [2.6, 5.5], release: [3.6, 6.5],
      lp: [520, 1050], lpQ: 0.9, lpDrift: 0.75,
      gain: 0.32,
    },
    air: {
      gain: 0.074, rates: [0.91, 1.11], hp: 500, lp: 2950, q: 0.8, lpSlope: 1.6,
      lpLfo: { rate: 0.031, depth: 700 },
      ampLfo: { rate: 0.019, depth: 0.48 },
      attack: 5.0,
    },
    bell: {
      interval: [3.4, 7.0],
      octaves: [2, 3],
      partials: [
        { ratio: 1,    type: 'sine',     gain: 1.00, detune: 0 },
        { ratio: 2.01, type: 'triangle', gain: 0.30, detune: 6 },
        { ratio: 3.98, type: 'sine',     gain: 0.12, detune: -5 },
      ],
      attack: 0.06, decay: [2.0, 3.8],
      lp: [1050, 1500], lpQ: 0.9,
      gain: 0.15,
    },
  },

  {
    id: 'lanternes',
    name: 'Lanternes',
    mood: 'Colonisation — habité, presque lumineux',
    seed: 0x5eed5005,
    root: 155.56,                 // Ré#3 (tierce mineure au-dessus)
    scale: [0, 2, 4, 7, 11, 14],  // majeur ouvert avec septième
    gain: 0.44,
    reverb: 0.56,
    drone: {
      partials: [
        { ratio: 1,    type: 'sine',     gain: 0.86, detune: -4 },
        { ratio: 1.5,  type: 'sine',     gain: 0.48, detune: 7 },
        { ratio: 2.01, type: 'triangle', gain: 0.26, detune: -8 },
        { ratio: 3.01, type: 'sine',     gain: 0.10, detune: 5 },
      ],
      lp: 1250, lpQ: 0.9,
      lpLfo: { rate: 0.067, depth: 520 },
      ampLfo: { rate: 0.043, depth: 0.28 },
      gain: 0.26,
    },
    pad: {
      interval: [3.2, 6.8],
      octaves: [0, 1, 2],
      partials: [
        { ratio: 1,     type: 'sine',     gain: 0.82, detune: -5 },
        { ratio: 2.002, type: 'triangle', gain: 0.36, detune: 8 },
        { ratio: 3.005, type: 'sine',     gain: 0.14, detune: -6 },
      ],
      attack: [2.0, 3.8], hold: [2.4, 5.0], release: [3.4, 6.0],
      lp: [1050, 2050], lpQ: 0.9, lpDrift: 0.8,
      gain: 0.42,
    },
    air: {
      gain: 0.072, rates: [0.93, 1.09], hp: 480, lp: 3000, q: 0.8, lpSlope: 1.6,
      lpLfo: { rate: 0.041, depth: 760 },
      ampLfo: { rate: 0.027, depth: 0.42 },
      attack: 4.5,
    },
    bell: {
      interval: [2.8, 6.0],
      octaves: [2, 3],
      partials: [
        { ratio: 1,    type: 'sine', gain: 1.00, detune: 0 },
        { ratio: 2.01, type: 'sine', gain: 0.36, detune: 6 },
        { ratio: 3.01, type: 'sine', gain: 0.16, detune: -5 },
      ],
      attack: 0.05, decay: [1.8, 3.4],
      lp: [1800, 2400], lpQ: 0.9,
      gain: 0.46,
    },
  },
];

/**
 * La musique suit l'état de la planète : chaque phase de progression amène son
 * morceau. C'est une récompense de plus, au même titre que la transformation
 * visuelle du monde.
 */
export const MUSIC_BY_PHASE = {
  1: 'poussiere_froide',
  2: 'veines_de_fer',
  3: 'premier_souffle',
  4: 'maree_verte',
  5: 'lanternes',
};

export default { AUDIO_CONFIG, SFX, SFX_KEYS, MUSIC_CONFIG, MUSIC_TRACKS, MUSIC_BY_PHASE };

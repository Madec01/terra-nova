/**
 * AudioEngine — la chaîne de traitement.
 *
 *   source → enveloppe → filtre → [envoi réverb] → bus (musique | effets)
 *          → maître → compresseur → sortie
 *
 * Deux points de conception méritent d'être explicités :
 *
 * 1. La réverbération est une RÉPONSE IMPULSIONNELLE GÉNÉRÉE (bruit à
 *    décroissance exponentielle, amorti progressivement dans l'aigu). C'est
 *    elle qui retire l'essentiel du caractère « synthétique sec » des sons.
 *    Aucun fichier à télécharger, et l'IR est construite de façon SYNCHRONE :
 *    le moteur est utilisable dès la fin du constructeur.
 *
 * 2. Le moteur ne touche NI au DOM NI à `window`. Il accepte n'importe quel
 *    BaseAudioContext, y compris un OfflineAudioContext — c'est ce qui rend la
 *    couche audio mesurable hors ligne par `tools/audio-check.mjs`.
 */
import { AUDIO_CONFIG, MUSIC_CONFIG } from '../data/audio.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';

export class AudioEngine {
  /**
   * @param {object}   opts
   * @param {BaseAudioContext} [opts.ctx]         contexte fourni (offline compris)
   * @param {AudioNode}        [opts.destination] destination (défaut : ctx.destination)
   * @param {object}           [opts.config]      surcharge de AUDIO_CONFIG
   */
  constructor({ ctx = null, destination = null, config = AUDIO_CONFIG } = {}) {
    this.ready = false;
    this.config = config;
    this.ctx = null;
    this.music = null;
    this.sfx = null;
    this._ownsCtx = false;
    this._pump = null;

    try {
      this.ctx = ctx || AudioEngine._createContext();
      if (!this.ctx) return;
      this._ownsCtx = !ctx;
      this._build(destination || this.ctx.destination);
      this.ready = true;
    } catch {
      // Le jeu doit rester jouable sans son : on échoue en silence.
      this.ready = false;
    }
  }

  /** Crée un AudioContext du navigateur, ou null s'il n'y en a pas. */
  static _createContext() {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    const AC = g && (g.AudioContext || g.webkitAudioContext);
    return AC ? new AC() : null;
  }

  /**
   * Le moteur tourne-t-il hors ligne (rendu) plutôt qu'en temps réel ?
   * Seul un OfflineAudioContext expose `startRendering`. La distinction
   * compte : hors ligne aucun minuteur ne tourne, donc rien ne doit en dépendre.
   */
  get offline() {
    return !!this.ctx && typeof this.ctx.startRendering === 'function';
  }

  /* ------------------------------------------------------------------ */
  /*  Construction de la chaîne                                          */
  /* ------------------------------------------------------------------ */

  _build(destination) {
    const ctx = this.ctx;
    const C = this.config;
    const vol = C.volumes;

    // --- Sortie : compresseur doux puis gain de sécurité ---------------
    this.output = ctx.createGain();
    this.output.gain.value = C.outputGain;
    this.output.connect(destination);

    this.compressor = ctx.createDynamicsCompressor();
    const cp = C.compressor;
    this.compressor.threshold.value = cp.threshold;
    this.compressor.knee.value = cp.knee;
    this.compressor.ratio.value = cp.ratio;
    this.compressor.attack.value = cp.attack;
    this.compressor.release.value = cp.release;
    this.compressor.connect(this.output);

    this.master = ctx.createGain();
    this.master.gain.value = vol.master;
    this.master.connect(this.compressor);

    // --- Bus effets et bus musique, filtrés séparément ------------------
    this.sfxBus = this._makeBus(C.sfxBus, vol.sfx);
    this.musicBus = this._makeBus(C.musicBus, vol.music);

    // --- Salle partagée : une seule convolution pour tout le jeu --------
    this.reverb = ctx.createConvolver();
    this.reverb.normalize = false;
    this.reverb.buffer = this._makeImpulse();

    const rv = C.reverb;
    this.reverbHp = ctx.createBiquadFilter();
    this.reverbHp.type = 'highpass';
    this.reverbHp.frequency.value = rv.returnHighpass;
    this.reverbHp.Q.value = rv.returnQ;

    this.reverbLp = ctx.createBiquadFilter();
    this.reverbLp.type = 'lowpass';
    this.reverbLp.frequency.value = rv.returnLowpass;
    this.reverbLp.Q.value = rv.returnQ;

    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 1;

    this.reverb.connect(this.reverbHp);
    this.reverbHp.connect(this.reverbLp);
    this.reverbLp.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    // --- Bruit blanc réutilisable (transitoires percussifs) -------------
    this.noiseBuffer = this._makeNoise(C.noiseBuffer.duration);

    // --- Générateurs ----------------------------------------------------
    this.sfx = new Sfx(this);
    this.music = new Music(this);
  }

  /** Un bus = gain + passe-haut + deux passe-bas (12 puis 24 dB/octave). */
  _makeBus(def, volume) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = 1;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = def.highpass;
    hp.Q.value = 0.6;

    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = def.lowpass;
    lp1.Q.value = def.lowpassQ;

    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = def.lowpass2;
    lp2.Q.value = def.lowpassQ;

    const out = ctx.createGain();
    out.gain.value = volume;

    input.connect(hp); hp.connect(lp1); lp1.connect(lp2); lp2.connect(out);
    out.connect(this.master);
    return { input, out, hp, lp1, lp2 };
  }

  /* ------------------------------------------------------------------ */
  /*  Réponse impulsionnelle générée                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Bruit stéréo décorrélé, décroissance exponentielle, amorti par un
   * passe-bas à un pôle dont le coefficient diminue avec le temps : les
   * réflexions tardives deviennent de plus en plus sourdes, comme dans une
   * vraie salle. Un pré-délai sépare la source de sa réverbération.
   */
  _makeImpulse() {
    const ctx = this.ctx;
    const rv = this.config.reverb;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * rv.duration));
    const pre = Math.floor(sr * rv.preDelay);
    const buf = ctx.createBuffer(2, len, sr);
    let seed = 0x1a2b3c4d;
    const rnd = () => {
      // Générateur déterministe : la salle est toujours la même.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000 * 2 - 1;
    };

    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let y = 0;
      let rms = 0;
      for (let i = 0; i < len; i++) {
        if (i < pre) { d[i] = 0; continue; }
        const t = (i - pre) / (len - pre);
        // Décroissance exponentielle + montée des premières réflexions.
        const env = Math.pow(1 - t, rv.decay) * Math.min(1, (i - pre) / (sr * 0.006));
        // Densité : au début les réflexions sont éparses, ensuite continues.
        const dense = rv.diffusion + (1 - rv.diffusion) * t;
        const x = rnd() * env * dense;
        // Amortissement progressif de l'aigu.
        const k = rv.dampStart + (rv.dampEnd - rv.dampStart) * t;
        y += (x - y) * k;
        d[i] = y;
        rms += y * y;   // énergie cumulée de l'IR
      }
      // Normalisation par l'ÉNERGIE, pas par la valeur efficace : le gain
      // d'une convolution croît comme la racine de la longueur de l'IR.
      // Normaliser « au RMS » donnerait ici un retour de salle 30 fois trop
      // fort — et un écrêtage garanti dès qu'un envoi dépasse quelques pour
      // cent. Avec Σh² = g², la réponse en fréquence vaut g en moyenne.
      const norm = rv.targetGain / Math.sqrt(rms || 1);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
    return buf;
  }

  /** Bruit blanc mono réutilisé par toutes les voix percussives. */
  _makeNoise(duration) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 0x100000000) * 2 - 1;
    }
    return buf;
  }

  /* ------------------------------------------------------------------ */
  /*  API publique                                                       */
  /* ------------------------------------------------------------------ */

  /** Joue un effet. `when` est un temps ABSOLU du contexte (défaut : maintenant). */
  playSfx(key, opts = {}) {
    if (!this.ready) return;
    try { this.sfx.play(key, opts); } catch { /* jamais bloquant */ }
  }

  /** Liste des clés d'effets disponibles. */
  keys() {
    return this.sfx ? this.sfx.keys() : [];
  }

  setVolumes({ master, music, sfx } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const set = (param, v) => {
      const x = Math.max(0, Math.min(1, v));
      try { param.setTargetAtTime(x, t, 0.05); } catch { param.value = x; }
    };
    if (Number.isFinite(master)) set(this.master.gain, master);
    if (Number.isFinite(music)) set(this.musicBus.out.gain, music);
    if (Number.isFinite(sfx)) set(this.sfxBus.out.gain, sfx);
  }

  /**
   * Entretien périodique : rallonge l'horizon de programmation musicale et
   * enchaîne les morceaux. Appelé par un intervalle en temps réel — jamais
   * nécessaire hors ligne, où tout l'horizon est écrit d'un coup.
   */
  update() {
    if (!this.ready) return;
    try { this.music.update(); } catch { /* ignore */ }
  }

  /** Démarre le pompage temps réel (navigateur uniquement). */
  startPump() {
    if (!this.ready || this._pump || this.offline) return;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!g || typeof g.setInterval !== 'function') return;
    this._pump = g.setInterval(() => this.update(), MUSIC_CONFIG.pumpInterval * 1000);
  }

  stopPump() {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (this._pump && g && typeof g.clearInterval === 'function') g.clearInterval(this._pump);
    this._pump = null;
  }

  dispose() {
    this.stopPump();
    try { this.music?.stop(0); } catch { /* ignore */ }
    try { this.sfx?.dispose(); } catch { /* ignore */ }
    try { this.output?.disconnect(); } catch { /* ignore */ }
    if (this._ownsCtx) { try { this.ctx.close(); } catch { /* ignore */ } }
    this.ready = false;
  }
}

export default AudioEngine;

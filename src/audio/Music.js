/**
 * Music — musique d'ambiance spatiale, générative.
 *
 * Un morceau n'est pas une boucle : c'est un bourdon continu (le lit), des
 * nappes tenues qui se croisent, et des textures éparses par-dessus. Rien ne
 * se répète à l'identique, rien ne reste figé — deux défauts opposés qui
 * fatiguent également.
 *
 * POINT CRUCIAL : toute la programmation musicale se fait sur l'horloge de
 * l'AudioContext (`ctx.currentTime` + paramètres programmés à l'avance), et
 * JAMAIS avec `setTimeout`. C'est la seule façon de fonctionner dans un
 * OfflineAudioContext, où aucun minuteur ne tourne pendant le rendu : un
 * moteur bâti sur `setTimeout` y produirait le silence absolu.
 *
 * En temps réel, un « pompage » périodique (AudioEngine.startPump) se contente
 * de RALLONGER l'horizon déjà écrit et d'enchaîner les morceaux ; il ne place
 * jamais une note à l'instant présent.
 */
import { MUSIC_CONFIG, MUSIC_TRACKS, MUSIC_BY_PHASE } from '../data/audio.js';

/** Générateur pseudo-aléatoire déterministe : un morceau est reproductible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Music {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.cfg = MUSIC_CONFIG;
    this.tracks = MUSIC_TRACKS;
    this.instances = [];
    this.current = null;
  }

  /** Identifiants disponibles. */
  ids() { return this.tracks.map((t) => t.id); }

  /**
   * Résolution d'un identifiant. Sans argument on RESTE sur le morceau en
   * cours : `startAmbient()` appelé deux fois ne doit pas ramener le joueur
   * au premier morceau alors que sa planète en est à la biosphère.
   */
  _def(id) {
    const key = id || this.current;
    if (!key) return this.tracks[0];
    return this.tracks.find((t) => t.id === key) || this.tracks[0];
  }

  /* ------------------------------------------------------------------ */
  /*  Contrôle                                                           */
  /* ------------------------------------------------------------------ */

  /** Démarre un morceau, en fondu enchaîné avec celui qui joue déjà. */
  start(trackId = null) {
    if (!this.engine.ready) return;
    const def = this._def(trackId);
    if (this.current === def.id && this.instances.some((i) => !i.stopping)) return;
    const t0 = this.ctx.currentTime;
    // Le morceau sortant s'efface pendant que le nouveau s'installe.
    for (const inst of this.instances) this._fadeOut(inst, this.cfg.crossfade);
    const inst = this._spawn(def, t0);
    if (inst) { this.instances.push(inst); this.current = def.id; }
  }

  /** Morceau suivant dans l'ordre du tableau. */
  next() {
    const i = this.tracks.findIndex((t) => t.id === this.current);
    this.start(this.tracks[(i + 1) % this.tracks.length].id);
  }

  /**
   * La musique suit l'état de la planète : à chaque phase son morceau.
   * Appelée depuis `main.js` sur `game:tick` ; sans effet si rien ne change.
   */
  setMood(phase) {
    const id = MUSIC_BY_PHASE[phase] || MUSIC_BY_PHASE[1];
    if (!id || id === this.current) return;
    this.start(id);
  }

  /**
   * Éteint la musique. `current` n'est PAS remis à zéro : c'est le morceau
   * choisi, pas le morceau audible (voir `playing`). Ainsi, couper puis
   * rétablir le son reprend là où l'on en était, et non au premier morceau.
   */
  stop(fade = null) {
    const f = fade == null ? this.cfg.crossfade : fade;
    for (const inst of this.instances) this._fadeOut(inst, f);
  }

  get playing() { return this.instances.some((i) => !i.stopping); }

  /* ------------------------------------------------------------------ */
  /*  Entretien (temps réel uniquement)                                  */
  /* ------------------------------------------------------------------ */

  update() {
    const now = this.ctx.currentTime;
    // Purge des morceaux éteints.
    this.instances = this.instances.filter((inst) => {
      if (inst.stopping && now > inst.deadAt) { this._kill(inst); return false; }
      return true;
    });
    for (const inst of this.instances) {
      if (inst.stopping) continue;
      // On rallonge l'horizon bien avant de l'atteindre.
      if (inst.until - now < this.cfg.scheduleHorizon * 0.5) {
        this._schedule(inst, now + this.cfg.scheduleHorizon);
      }
      // Enchaînement automatique quand le morceau a assez duré.
      if (now - inst.startedAt > this.cfg.trackDuration) { this.next(); break; }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Fabrication d'un morceau                                           */
  /* ------------------------------------------------------------------ */

  _spawn(def, t0) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    // Fondu d'entrée : au moins une seconde, jamais d'irruption.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(def.gain, t0 + this.cfg.fadeIn);
    gain.connect(this.engine.musicBus.input);

    const send = ctx.createGain();
    send.gain.value = def.reverb;
    gain.connect(send);
    send.connect(this.engine.reverb);

    const inst = {
      def, gain, send,
      rng: mulberry32(def.seed),
      startedAt: t0,
      until: t0,
      nextPad: t0 + 0.4,
      nextBell: t0 + 2.0,
      padEnds: [],
      drone: null,
      air: null,
      nodes: new Set(),
      stopping: false,
      deadAt: Infinity,
    };

    this._drone(inst, t0);
    this._air(inst, t0);
    this._schedule(inst, t0 + this.cfg.scheduleHorizon);
    return inst;
  }

  /**
   * Le bourdon : quelques partiels désaccordés, un passe-bas balayé par un
   * oscillateur très lent, et une respiration d'amplitude. C'est ce qui donne
   * au morceau son mouvement continu sans qu'aucune note ne soit jouée.
   */
  _drone(inst, t0) {
    const ctx = this.ctx;
    const d = inst.def.drone;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(d.lp, t0);
    lp.Q.setValueAtTime(d.lpQ ?? 0.7, t0);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(d.gain, t0);
    lp.connect(amp);
    amp.connect(inst.gain);

    const oscs = [];
    for (const p of d.partials) {
      const o = ctx.createOscillator();
      o.type = p.type || 'sine';
      o.frequency.setValueAtTime(inst.def.root * p.ratio, t0);
      if (p.detune) o.detune.setValueAtTime(p.detune, t0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(p.gain, t0);
      o.connect(g); g.connect(lp);
      o.start(t0);
      oscs.push({ o, g });
    }

    // Deux oscillateurs sous-audio pilotent filtre et amplitude.
    const mk = (rate, depth, target) => {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(rate, t0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(depth, t0);
      lfo.connect(g); g.connect(target);
      lfo.start(t0);
      return { o: lfo, g };
    };
    const lfos = [];
    if (d.lpLfo) lfos.push(mk(d.lpLfo.rate, d.lpLfo.depth, lp.frequency));
    if (d.ampLfo) lfos.push(mk(d.ampLfo.rate, d.gain * d.ampLfo.depth, amp.gain));

    inst.drone = { lp, amp, oscs, lfos };
  }

  /**
   * Le souffle : du bruit filtré en bande médium, très lent, très discret.
   *
   * Il joue deux rôles. Le premier est musical — c'est l'air de la planète,
   * ténu et froid au début, plus plein quand l'atmosphère s'épaissit. Le
   * second est pratique : un haut-parleur de téléphone ne restitue presque
   * rien sous 400 Hz, si bien qu'un morceau bâti sur un bourdon grave y est
   * SILENCIEUX. Une texture large bande, à peine audible au casque, suffit à
   * rendre le morceau présent sur mobile sans l'éclaircir ni l'alourdir —
   * c'est le moyen le moins coûteux d'exister dans la bande utile.
   *
   * Deux lectures du même bruit à des vitesses différentes : la périodicité
   * de la boucle devient inaudible.
   */
  _air(inst, t0) {
    const a = inst.def.air;
    if (!a) return;
    const ctx = this.ctx;
    const rng = inst.rng;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(a.hp, t0);
    hp.Q.setValueAtTime(a.q ?? 0.7, t0);

    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.setValueAtTime(a.lp, t0);
    lp1.Q.setValueAtTime(a.q ?? 0.7, t0);

    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.setValueAtTime(a.lp * (a.lpSlope ?? 1.6), t0);
    lp2.Q.setValueAtTime(0.6, t0);

    const amp = ctx.createGain();
    // Le souffle s'installe encore plus lentement que le reste : on ne doit
    // jamais l'entendre « arriver ».
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(a.gain, t0 + (a.attack ?? this.cfg.fadeIn));

    hp.connect(lp1); lp1.connect(lp2); lp2.connect(amp); amp.connect(inst.gain);

    const buf = this.engine.noiseBuffer;
    const srcs = [];
    for (const rate of a.rates) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.setValueAtTime(rate, t0);
      src.connect(hp);
      src.start(t0, rng() * buf.duration);
      srcs.push(src);
    }

    const lfos = [];
    const mk = (rate, depth, target) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(rate, t0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(depth, t0);
      o.connect(g); g.connect(target);
      o.start(t0);
      lfos.push({ o, g });
    };
    if (a.lpLfo) mk(a.lpLfo.rate, a.lpLfo.depth, lp1.frequency);
    if (a.ampLfo) mk(a.ampLfo.rate, a.gain * a.ampLfo.depth, amp.gain);

    inst.air = { hp, lp1, lp2, amp, srcs, lfos };
  }

  /** Écrit nappes et textures jusqu'à `until` — d'un seul tenant. */
  _schedule(inst, until) {
    const def = inst.def;
    const rng = inst.rng;
    const pick = (r) => r[0] + rng() * (r[1] - r[0]);

    while (inst.nextPad < until) {
      const t = inst.nextPad;
      inst.padEnds = inst.padEnds.filter((e) => e > t);
      if (inst.padEnds.length < this.cfg.maxPadVoices) {
        inst.padEnds.push(this._pad(inst, t, pick));
      }
      inst.nextPad = t + pick(def.pad.interval);
    }
    while (inst.nextBell < until) {
      this._bell(inst, inst.nextBell, pick);
      inst.nextBell += pick(def.bell.interval);
    }
    inst.until = Math.max(inst.until, until);
  }

  /** Une note de la gamme, tirée au sort dans les octaves autorisées. */
  _note(inst, octaves, rng) {
    const def = inst.def;
    const oct = octaves[Math.floor(rng() * octaves.length) % octaves.length];
    const deg = def.scale[Math.floor(rng() * def.scale.length) % def.scale.length];
    return def.root * Math.pow(2, oct) * Math.pow(2, deg / 12);
  }

  /** Nappe tenue : attaque très longue, croisement avec les voisines. */
  _pad(inst, t, pick) {
    const ctx = this.ctx;
    const p = inst.def.pad;
    const rng = inst.rng;
    const freq = this._note(inst, p.octaves, rng);
    const a = pick(p.attack), h = pick(p.hold), r = pick(p.release);
    const cut = pick(p.lp);
    // Chaque nappe dérive vers une autre couleur pendant qu'elle tient.
    const drift = cut * (1 + (rng() * 2 - 1) * (p.lpDrift || 0.5));

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cut, t);
    lp.frequency.linearRampToValueAtTime(Math.max(80, drift), t + a + h + r);
    lp.Q.setValueAtTime(p.lpQ ?? 0.8, t);

    const env = ctx.createGain();
    const stop = this._env(env.gain, t, a, h, r, p.gain);
    lp.connect(env); env.connect(inst.gain);

    for (const part of p.partials) {
      const o = ctx.createOscillator();
      o.type = part.type || 'sine';
      o.frequency.setValueAtTime(freq * part.ratio, t);
      if (part.detune) o.detune.setValueAtTime(part.detune + (rng() * 8 - 4), t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(part.gain, t);
      o.connect(g); g.connect(lp);
      o.start(t);
      o.stop(stop);
      o.onended = () => {
        inst.nodes.delete(o);
        try { o.disconnect(); g.disconnect(); } catch { /* ignore */ }
      };
      inst.nodes.add(o);
    }
    // Libération du filtre et de l'enveloppe avec la dernière voix.
    this._cleanupAfter(inst, stop, [lp, env]);
    return stop;
  }

  /** Texture éparse : cloche douce à décroissance longue. */
  _bell(inst, t, pick) {
    const ctx = this.ctx;
    const b = inst.def.bell;
    const rng = inst.rng;
    const freq = this._note(inst, b.octaves, rng);
    const dec = pick(b.decay);
    const cut = pick(b.lp);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cut, t);
    lp.frequency.linearRampToValueAtTime(Math.max(120, cut * 0.55), t + dec);
    lp.Q.setValueAtTime(b.lpQ ?? 0.8, t);

    const env = ctx.createGain();
    const stop = this._env(env.gain, t, b.attack, 0, dec, b.gain * (0.6 + rng() * 0.5));
    lp.connect(env); env.connect(inst.gain);

    for (const part of b.partials) {
      const o = ctx.createOscillator();
      o.type = part.type || 'sine';
      o.frequency.setValueAtTime(freq * part.ratio, t);
      if (part.detune) o.detune.setValueAtTime(part.detune + (rng() * 6 - 3), t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(part.gain, t);
      o.connect(g); g.connect(lp);
      o.start(t);
      o.stop(stop);
      o.onended = () => {
        inst.nodes.delete(o);
        try { o.disconnect(); g.disconnect(); } catch { /* ignore */ }
      };
      inst.nodes.add(o);
    }
    this._cleanupAfter(inst, stop, [lp, env]);
    return stop;
  }

  /* ------------------------------------------------------------------ */

  /** Enveloppe douce commune aux nappes et aux cloches. */
  _env(param, t, attack, hold, release, peak) {
    const a = Math.max(0.03, attack || 0.03);
    const h = Math.max(0, hold || 0);
    const r = Math.max(0.1, release || 0.5);
    const p = Math.max(0.0001, peak);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(p, t + a);
    param.setValueAtTime(p, t + a + h);
    param.exponentialRampToValueAtTime(p * 0.0006, t + a + h + r);
    param.linearRampToValueAtTime(0, t + a + h + r + 0.02);
    return t + a + h + r + this.cfg.releaseMargin;
  }

  /**
   * Débranchement des nœuds sans source (filtres, gains) une fois la voix
   * terminée. En temps réel un minuteur suffit ; hors ligne il n'y a rien à
   * libérer, le contexte entier disparaît après le rendu.
   */
  _cleanupAfter(inst, at, nodes) {
    if (this.engine.offline) return;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!g || typeof g.setTimeout !== 'function') return;
    const delay = Math.max(0, (at - this.ctx.currentTime) * 1000) + 200;
    g.setTimeout(() => { for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } } }, delay);
  }

  /** Fondu de sortie puis arrêt programmé des oscillateurs perpétuels. */
  _fadeOut(inst, fade) {
    if (inst.stopping) return;
    const t = this.ctx.currentTime;
    const end = t + Math.max(0.05, fade);
    try {
      inst.gain.gain.cancelScheduledValues(t);
      inst.gain.gain.setValueAtTime(Math.max(0.0001, inst.gain.gain.value), t);
      inst.gain.gain.exponentialRampToValueAtTime(0.0001, end);
      inst.gain.gain.linearRampToValueAtTime(0, end + 0.02);
    } catch { /* ignore */ }
    // Le bourdon tourne en continu : c'est ici, et seulement ici, qu'il s'arrête.
    if (inst.drone) {
      for (const { o } of inst.drone.oscs) { try { o.stop(end + 0.05); } catch { /* ignore */ } }
      for (const { o } of inst.drone.lfos) { try { o.stop(end + 0.05); } catch { /* ignore */ } }
    }
    if (inst.air) {
      for (const src of inst.air.srcs) { try { src.stop(end + 0.05); } catch { /* ignore */ } }
      for (const { o } of inst.air.lfos) { try { o.stop(end + 0.05); } catch { /* ignore */ } }
    }
    // Un morceau porte jusqu'à une demi-minute de notes DÉJÀ programmées. Sans
    // cela elles continueraient de tourner dans le vide bien après le fondu.
    // Avancer `stop` avant le `start` d'une note à venir l'annule purement.
    for (const o of inst.nodes) { try { o.stop(end + 0.05); } catch { /* ignore */ } }
    inst.stopping = true;
    inst.deadAt = end + 0.2;
  }

  _kill(inst) {
    try { inst.gain.disconnect(); inst.send.disconnect(); } catch { /* ignore */ }
    if (inst.drone) {
      try { inst.drone.lp.disconnect(); inst.drone.amp.disconnect(); } catch { /* ignore */ }
    }
    if (inst.air) {
      try { inst.air.hp.disconnect(); inst.air.lp1.disconnect(); inst.air.lp2.disconnect(); inst.air.amp.disconnect(); } catch { /* ignore */ }
    }
    inst.nodes.clear();
  }
}

export default Music;

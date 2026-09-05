/**
 * Sfx — synthèse des effets ponctuels.
 *
 * Le moteur n'invente rien : il interprète les descriptions de `src/data/audio.js`.
 * Trois principes y sont imposés par construction et expliquent à eux seuls la
 * différence avec l'ancienne version « numérique » :
 *
 *   - toute voix passe par une enveloppe à attaque non nulle (jamais de
 *     discontinuité, donc jamais de « clic ») ;
 *   - toute voix passe par un passe-bas, et le bruit par DEUX passes-bas
 *     (24 dB/octave) : un transitoire de bruit donne de la matière sans
 *     projeter d'aigu agressif ;
 *   - chaque déclenchement est légèrement dérivé (hauteur, coupure, niveau),
 *     ce qui évite l'effet « machine » d'un son strictement identique répété.
 */
import { SFX, SFX_KEYS } from '../data/audio.js';

export class Sfx {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.defs = SFX;
    this.voices = 0;
  }

  keys() {
    return SFX_KEYS.slice();
  }

  /**
   * @param {string} key
   * @param {object} opts
   * @param {number} [opts.volume=1] atténuation ponctuelle
   * @param {number} [opts.rate=1]   transposition (multiplie les fréquences)
   * @param {number} [opts.when]     temps ABSOLU du contexte
   */
  play(key, { volume = 1, rate = 1, when = null } = {}) {
    const def = this.defs[key];
    if (!def) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = when == null ? now : Math.max(when, now);
    const C = this.engine.config;
    if (this.voices >= C.maxSfxVoices) return;

    const j = def.jitter || {};
    const r = (amount) => 1 + (Math.random() * 2 - 1) * (amount || 0);
    const jf = r(j.freq);
    const jc = r(j.cutoff);
    const jg = r(j.gain);

    // Point de mélange de l'effet : un seul envoi vers la salle par son.
    const bus = ctx.createGain();
    bus.gain.value = Math.max(0, def.gain * volume * jg);
    bus.connect(this.engine.sfxBus.input);

    if (def.reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = def.reverb;
      bus.connect(send);
      send.connect(this.engine.reverb);
    }

    let end = t0;
    const base = def.base * rate * jf;

    for (const v of def.voices || []) {
      end = Math.max(end, this._voice(v, base, t0, jc, bus));
    }
    // `noise` peut être un objet ou une liste : un même son porte souvent un
    // socle grave ET un transitoire médium — c'est ce dernier qui le rend
    // audible sur un haut-parleur de téléphone.
    const noises = Array.isArray(def.noise) ? def.noise : (def.noise ? [def.noise] : []);
    for (const n of noises) {
      end = Math.max(end, this._noise(n, t0, jc, bus));
    }

    // Libération : on débranche le point de mélange une fois la queue passée.
    this.voices++;
    this._release(bus, end + 0.05);
  }

  /* ------------------------------------------------------------------ */

  /** Une voix : oscillateur → passe-bas → enveloppe → mélange. */
  _voice(v, base, t0, jc, bus) {
    const ctx = this.ctx;
    const start = t0 + (v.start || 0);
    const freq = (v.freq != null ? v.freq : base * (v.ratio ?? 1));

    const osc = ctx.createOscillator();
    osc.type = v.type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (v.detune) osc.detune.setValueAtTime(v.detune, start);
    if (v.sweep) {
      const target = Math.max(20, freq * v.sweep.to);
      const at = start + Math.max(0.01, v.sweep.time);
      if (v.sweep.curve === 'linear') osc.frequency.linearRampToValueAtTime(target, at);
      else osc.frequency.exponentialRampToValueAtTime(target, at);
    }

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.setValueAtTime(v.lpQ ?? 0.7, start);
    this._cutoff(lp.frequency, v, start, jc);

    const env = ctx.createGain();
    const stop = this._envelope(env.gain, start, v.attack, v.hold, v.release, v.gain ?? 1);

    osc.connect(lp); lp.connect(env); env.connect(bus);
    osc.start(start);
    osc.stop(stop);
    osc.onended = () => { try { osc.disconnect(); lp.disconnect(); env.disconnect(); } catch { /* ignore */ } };
    return stop;
  }

  /** Transitoire de bruit : double passe-bas, donc jamais sifflant. */
  _noise(n, t0, jc, bus) {
    const ctx = this.ctx;
    const start = t0 + (n.start || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer;
    // Position de lecture aléatoire : deux transitoires ne sont jamais égaux.
    const offset = Math.random() * Math.max(0.001, src.buffer.duration - 1);

    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.Q.setValueAtTime(n.lpQ ?? 0.6, start);
    this._cutoff(lp1.frequency, n, start, jc);

    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.Q.setValueAtTime(0.6, start);
    this._cutoff(lp2.frequency, n, start, jc);

    // Passe-haut optionnel : sans lui, un transitoire de bruit ne peut être
    // qu'un « boum » grave. Avec, on obtient une frappe médium — la matière
    // qui rend un son grave présent sans le rendre aigu.
    let head = lp1;
    if (n.hp) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(n.hp, start);
      hp.Q.setValueAtTime(n.hpQ ?? 0.7, start);
      hp.connect(lp1);
      head = hp;
    }

    const env = ctx.createGain();
    const stop = this._envelope(env.gain, start, n.attack, n.hold, n.release, n.gain ?? 0.1);

    src.connect(head); lp1.connect(lp2); lp2.connect(env); env.connect(bus);
    src.start(start, offset);
    src.stop(stop);
    src.onended = () => { try { src.disconnect(); head.disconnect(); lp1.disconnect(); lp2.disconnect(); env.disconnect(); } catch { /* ignore */ } };
    return stop;
  }

  /**
   * Coupure du passe-bas : soit fixe (`lp`), soit une trajectoire (`lpEnv`,
   * points [temps, fréquence]), soit une descente vers `lpEnd`.
   */
  _cutoff(param, def, start, jc) {
    const clamp = (f) => Math.max(60, Math.min(18000, f * jc));
    if (Array.isArray(def.lpEnv) && def.lpEnv.length) {
      param.setValueAtTime(clamp(def.lpEnv[0][1]), start);
      for (let i = 1; i < def.lpEnv.length; i++) {
        param.linearRampToValueAtTime(clamp(def.lpEnv[i][1]), start + def.lpEnv[i][0]);
      }
      return;
    }
    param.setValueAtTime(clamp(def.lp ?? 2000), start);
    if (def.lpEnd != null) {
      const span = (def.attack || 0) + (def.hold || 0) + (def.release || 0);
      param.linearRampToValueAtTime(clamp(def.lpEnd), start + Math.max(0.02, span));
    }
  }

  /**
   * Enveloppe attaque / maintien / relâchement.
   * L'attaque est bornée à 6 ms minimum : c'est LA cause du « clic » numérique.
   * Retourne l'instant où la voix peut être arrêtée.
   */
  _envelope(param, start, attack, hold, release, peak) {
    const a = Math.max(0.006, attack || 0.006);
    const h = Math.max(0, hold || 0);
    const rel = Math.max(0.02, release || 0.05);
    const p = Math.max(0.0001, peak);
    param.setValueAtTime(0.0001, start);
    param.linearRampToValueAtTime(p, start + a);
    param.setValueAtTime(p, start + a + h);
    param.exponentialRampToValueAtTime(p * 0.0006, start + a + h + rel);
    param.linearRampToValueAtTime(0, start + a + h + rel + 0.01);
    return start + a + h + rel + 0.02;
  }

  /** Débranchement différé du point de mélange (libère les nœuds). */
  _release(node, at) {
    const ctx = this.ctx;
    const done = () => {
      this.voices = Math.max(0, this.voices - 1);
      try { node.disconnect(); } catch { /* ignore */ }
    };
    // Hors ligne, aucun minuteur ne tourne : on se contente de laisser le
    // ramasse-miettes faire son travail une fois le rendu terminé.
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (this.engine.offline || !g || typeof g.setTimeout !== 'function') { this.voices = Math.max(0, this.voices - 1); return; }
    g.setTimeout(done, Math.max(0, (at - ctx.currentTime) * 1000) + 120);
  }

  dispose() {
    this.voices = 0;
  }
}

export default Sfx;

/**
 * Architecture audio.
 *
 * Le jeu doit fonctionner SANS aucun fichier son : si un fichier est absent,
 * on retombe silencieusement sur une synthèse WebAudio minimaliste (bips
 * discrets) ou sur le silence total. Aucune erreur ne doit remonter.
 */

const SOUNDS = {
  ui_click:   { file: 'ui_click.mp3',   synth: { freq: 660, dur: 0.045, type: 'square', gain: 0.05 } },
  ui_select:  { file: 'ui_select.mp3',  synth: { freq: 880, dur: 0.07,  type: 'sine',   gain: 0.06 } },
  region:     { file: 'region.mp3',     synth: { freq: 520, dur: 0.09,  type: 'triangle', gain: 0.07 } },
  build:      { file: 'build.mp3',      synth: { freq: 300, dur: 0.18,  type: 'sawtooth', gain: 0.07, sweep: 180 } },
  scan:       { file: 'scan.mp3',       synth: { freq: 420, dur: 0.35,  type: 'sine',   gain: 0.05, sweep: 640 } },
  research:   { file: 'research.mp3',   synth: { freq: 740, dur: 0.22,  type: 'sine',   gain: 0.07, sweep: 1100 } },
  discovery:  { file: 'discovery.mp3',  synth: { freq: 590, dur: 0.25,  type: 'triangle', gain: 0.07, sweep: 890 } },
  event:      { file: 'event.mp3',      synth: { freq: 220, dur: 0.30,  type: 'sawtooth', gain: 0.07, sweep: 120 } },
  error:      { file: 'error.mp3',      synth: { freq: 180, dur: 0.14,  type: 'square', gain: 0.06 } },
  victory:    { file: 'victory.mp3',    synth: { freq: 440, dur: 0.6,   type: 'sine',   gain: 0.09, sweep: 880 } },
};

export class AudioManager {
  constructor({ basePath = 'audio/', enabled = true } = {}) {
    this.basePath = basePath;
    this.enabled = enabled;
    this.volume = 0.6;
    this.musicVolume = 0.35;
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.ambient = null;
    this._unlocked = false;
    this._failed = new Set();
  }

  /** Doit être appelé depuis un geste utilisateur (politique d'autoplay). */
  unlock() {
    if (this._unlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this._unlocked = true;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this._preload();
    } catch {
      this.enabled = false;
    }
  }

  async _preload() {
    for (const key in SOUNDS) this._load(key).catch(() => {});
  }

  async _load(key) {
    if (this.buffers.has(key) || this._failed.has(key) || !this.ctx) return null;
    const def = SOUNDS[key];
    try {
      const res = await fetch(this.basePath + def.file);
      if (!res.ok) throw new Error('404');
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(key, buf);
      return buf;
    } catch {
      // Fichier absent : on utilisera la synthèse. C'est un cas NORMAL.
      this._failed.add(key);
      return null;
    }
  }

  play(key, { volume = 1, rate = 1 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const buf = this.buffers.get(key);
    try {
      if (buf) {
        const src = this.ctx.createBufferSource();
        const g = this.ctx.createGain();
        g.gain.value = volume;
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(g).connect(this.master);
        src.start();
      } else {
        this._synth(SOUNDS[key]?.synth, volume);
      }
    } catch { /* jamais bloquant */ }
  }

  /** Repli : petit bip synthétisé, suffisant pour le retour haptique sonore. */
  _synth(def, volume = 1) {
    if (!def || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = def.type || 'sine';
    osc.frequency.setValueAtTime(def.freq, t);
    if (def.sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(30, def.sweep), t + def.dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime((def.gain ?? 0.05) * volume, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + def.dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + def.dur + 0.02);
  }

  /** Nappe spatiale continue, synthétisée si aucune musique n'est fournie. */
  startAmbient() {
    if (!this.enabled || !this.ctx || this.ambient) return;
    try {
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(this.musicVolume * 0.12, this.ctx.currentTime + 4);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      const oscs = [55, 82.4, 110].map((f, i) => {
        const o = this.ctx.createOscillator();
        o.type = i === 2 ? 'triangle' : 'sine';
        o.frequency.value = f;
        // Léger désaccord pour un battement lent, très spatial.
        o.detune.value = (i - 1) * 6;
        o.connect(filter);
        o.start();
        return o;
      });
      filter.connect(g).connect(this.master);
      this.ambient = { g, oscs, filter };
    } catch { /* ignore */ }
  }

  stopAmbient() {
    if (!this.ambient) return;
    try {
      this.ambient.g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.2);
      const { oscs } = this.ambient;
      setTimeout(() => oscs.forEach((o) => { try { o.stop(); } catch {} }), 1400);
    } catch {}
    this.ambient = null;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
    if (!this.enabled) this.stopAmbient();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }
}

export default AudioManager;

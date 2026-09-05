/**
 * AudioManager — façade historique.
 *
 * Le jeu n'appelle QUE cet objet, et son API publique n'a pas bougé :
 * `unlock`, `play`, `startAmbient`, `stopAmbient`, `setEnabled`, `setVolume`.
 * Tout le travail réel est fait par `AudioEngine` (chaîne + réverbération),
 * `Sfx` (effets) et `Music` (musique générative).
 *
 * Deux règles de survie, inchangées depuis l'origine :
 *   - AUCUN fichier audio n'est nécessaire : tout est synthétisé, il n'y a
 *     donc plus rien à télécharger ni à décoder (le paramètre `basePath` est
 *     conservé par compatibilité mais n'est plus utilisé) ;
 *   - AUCUNE erreur ne doit remonter au jeu si WebAudio est indisponible.
 *
 * Politique d'autoplay : rien n'existe avant `unlock()`, qui doit être appelé
 * depuis un geste utilisateur.
 */
import { AudioEngine } from './AudioEngine.js';
import { SFX_KEYS, AUDIO_CONFIG, MUSIC_TRACKS } from '../data/audio.js';

export class AudioManager {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.volume = AUDIO_CONFIG.volumes.master;
    this.musicVolume = AUDIO_CONFIG.volumes.music;
    this.sfxVolume = AUDIO_CONFIG.volumes.sfx;
    this.engine = null;
    this.ambient = false;
    this._wantAmbient = false;   // le joueur veut-il de la musique ?
    this._unlocked = false;
  }

  /** Clés d'effets disponibles (utilisé aussi par l'outil de mesure). */
  keys() {
    return this.engine?.ready ? this.engine.keys() : SFX_KEYS.slice();
  }

  /** Morceaux disponibles, pour l'affichage ou le débogage. */
  tracks() {
    return MUSIC_TRACKS.map((t) => ({ id: t.id, name: t.name, mood: t.mood }));
  }

  /** Doit être appelé depuis un geste utilisateur (politique d'autoplay). */
  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    try {
      const engine = new AudioEngine({});
      if (!engine.ready) { this.engine = null; return; }
      this.engine = engine;
      engine.setVolumes({
        master: this.enabled ? this.volume : 0,
        music: this.musicVolume,
        sfx: this.sfxVolume,
      });
      engine.startPump();
      const ctx = engine.ctx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
    } catch {
      this.engine = null;
    }
  }

  play(key, opts = {}) {
    if (!this.enabled || !this.engine) return;
    this.engine.playSfx(key, opts);
  }

  /** Démarre la musique d'ambiance (premier morceau, ou celui demandé). */
  startAmbient(trackId = null) {
    if (!this.enabled || !this.engine) return;
    this._wantAmbient = true;
    try { this.engine.music.start(trackId); this.ambient = true; } catch { /* ignore */ }
  }

  stopAmbient({ keepIntent = false } = {}) {
    this.ambient = false;
    if (!keepIntent) this._wantAmbient = false;
    if (!this.engine) return;
    try { this.engine.music.stop(); } catch { /* ignore */ }
  }

  /** Passe au morceau suivant, en fondu enchaîné. */
  nextTrack() {
    if (!this.enabled || !this.engine || !this.ambient) return;
    try { this.engine.music.next(); } catch { /* ignore */ }
  }

  /**
   * Fait suivre à la musique l'état de la planète : chaque phase de
   * progression amène son morceau. Sans effet si la phase n'a pas changé.
   */
  setMood(phase) {
    if (!this.enabled || !this.engine || !this.ambient) return;
    try { this.engine.music.setMood(phase); } catch { /* ignore */ }
  }

  /** Identifiant du morceau en cours, ou null. */
  get currentTrack() {
    return this.engine?.music?.current ?? null;
  }

  setEnabled(v) {
    const want = this._wantAmbient;
    this.enabled = !!v;
    if (!this.engine) return;
    this.engine.setVolumes({ master: this.enabled ? this.volume : 0 });
    // Couper puis rétablir le son ne doit pas faire disparaître la musique
    // pour le reste de la partie : on retient l'intention du joueur.
    if (!this.enabled) this.stopAmbient({ keepIntent: true });
    else if (want) this.startAmbient();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.engine) this.engine.setVolumes({ master: this.enabled ? this.volume : 0 });
  }

  /** Volume de la musique seule. */
  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.engine) this.engine.setVolumes({ music: this.musicVolume });
  }

  /** Volume des effets seuls. */
  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.engine) this.engine.setVolumes({ sfx: this.sfxVolume });
  }

  dispose() {
    try { this.engine?.dispose(); } catch { /* ignore */ }
    this.engine = null;
  }
}

export default AudioManager;

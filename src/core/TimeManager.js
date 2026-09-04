/**
 * Découple la boucle de rendu (variable, 60 Hz) de la boucle de simulation
 * (pas fixe). Garantit un comportement identique quelle que soit la machine.
 */
import { BALANCE } from '../data/balance.js';

export class TimeManager {
  constructor(bus) {
    this.bus = bus;
    this.speed = 1;
    this.accumulator = 0;
    this.tickIndex = 0;
    this.speeds = BALANCE.time.speeds;
  }

  setSpeed(speed) {
    if (!this.speeds.includes(speed)) return;
    if (this.speed === speed) return;
    this.speed = speed;
    this.accumulator = 0;
    this.bus.emit('time:speed', { speed });
  }

  togglePause() {
    this.setSpeed(this.speed === 0 ? (this._last || 1) : (this._last = this.speed, 0));
  }

  get paused() { return this.speed === 0; }

  /**
   * @param {number} dtReal secondes réelles écoulées
   * @param {(days:number, index:number)=>void} onTick
   */
  advance(dtReal, onTick) {
    if (this.speed === 0) return 0;
    const step = BALANCE.time.tickSeconds;
    this.accumulator += Math.min(dtReal, 0.5) * this.speed;
    let ticks = 0;
    // Tolérance : sans elle, l'accumulation de deltas flottants (ex. 100 frames
    // de 0,025 s) reste infinitésimalement sous le seuil et perd un tick.
    const epsilon = step * 1e-9;
    while (this.accumulator >= step - epsilon && ticks < BALANCE.time.maxCatchUpTicks) {
      this.accumulator -= step;
      onTick(BALANCE.time.daysPerTick, this.tickIndex++);
      ticks++;
    }
    // Si on n'arrive pas à suivre, on jette le retard plutôt que de spiraler.
    if (this.accumulator > step * BALANCE.time.maxCatchUpTicks) this.accumulator = 0;
    return ticks;
  }

  /** Formate un nombre de jours en date de mission. */
  static formatDay(day) {
    const year = Math.floor(day / 365);
    const d = Math.floor(day % 365);
    return `An ${year} · J${String(d).padStart(3, '0')}`;
  }
}

export default TimeManager;

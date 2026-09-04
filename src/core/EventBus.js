/** Bus d'événements minimal, synchrone, sans dépendance. */
export class EventBus {
  constructor() { this._map = new Map(); }

  on(name, fn) {
    let set = this._map.get(name);
    if (!set) { set = new Set(); this._map.set(name, set); }
    set.add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }

  off(name, fn) {
    const set = this._map.get(name);
    if (set) set.delete(fn);
  }

  emit(name, payload) {
    const set = this._map.get(name);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); }
      catch (err) { console.error(`[EventBus] ${name}`, err); }
    }
  }

  clear() { this._map.clear(); }
}

export default EventBus;

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32) + utilitaires de seed.
 * Même seed => même planète, même partie.
 */

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RNG orienté objet, pratique pour les systèmes de jeu. */
export class Random {
  constructor(seed = 1) {
    this.seed = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  next() { return this._next(); }
  range(min, max) { return min + this._next() * (max - min); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  bool(p = 0.5) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  /** Sélection pondérée : items = [{weight}] */
  weighted(items, weightFn = (o) => o.weight ?? 1) {
    let total = 0;
    for (const it of items) total += weightFn(it);
    if (total <= 0) return null;
    let r = this._next() * total;
    for (const it of items) {
      r -= weightFn(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }
  gaussian(mean = 0, dev = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this._next();
    while (v === 0) v = this._next();
    return mean + dev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Sous-générateur indépendant mais déterministe. */
  fork(salt = 0) { return new Random((this.seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0); }
}

/** Génère une seed lisible de type "TN-4F2A9C". */
export function makeSeedLabel(seed) {
  return 'TN-' + (seed >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(-6);
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Fonctions mathématiques génériques, sans dépendance. */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (a, b, v) => { const t = clamp01(invLerp(a, b, v)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, v) => { const t = clamp01(invLerp(a, b, v)); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Interpolation exponentielle indépendante du pas de temps. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Courbe en cloche centrée sur `center`, largeur `width`, retourne 0..1. */
export function bell(v, center, width) {
  const x = (v - center) / width;
  return Math.exp(-x * x);
}

export function sum(arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; }
export function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }

/** Moyenne pondérée d'un Float32Array par un tableau de poids. */
export function weightedMean(values, weights, count = values.length) {
  let s = 0, w = 0;
  for (let i = 0; i < count; i++) { s += values[i] * weights[i]; w += weights[i]; }
  return w > 0 ? s / w : 0;
}

export function formatNumber(v, digits = 1) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + ' Md';
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + ' M';
  if (a >= 1e4) return (v / 1e3).toFixed(digits) + ' k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(digits > 1 ? 1 : digits);
  return v.toFixed(digits);
}

export function formatSigned(v, digits = 2, unit = '') {
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return s + Math.abs(v).toFixed(digits) + unit;
}

/** Convertit une position sur sphère unité en {lat, lon} degrés. */
export function toLatLon(x, y, z) {
  return {
    lat: Math.asin(clamp(y, -1, 1)) * 180 / Math.PI,
    lon: Math.atan2(z, x) * 180 / Math.PI,
  };
}

export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'O';
  return `${Math.abs(lat).toFixed(1)}° ${ns} ${Math.abs(lon).toFixed(1)}° ${ew}`;
}

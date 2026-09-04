/**
 * Sauvegarde locale (localStorage).
 *
 * Stratégie : les propriétés STATIQUES des régions sont regénérées depuis la
 * seed au chargement ; seules les propriétés DYNAMIQUES sont écrites, encodées
 * en base64 depuis leurs Float32Array/Uint8Array. Une sauvegarde reste ainsi
 * légère (~30 ko pour 642 régions) tout en étant exacte.
 */
import { BALANCE } from '../data/balance.js';
import { SAVE_VERSION } from './GameState.js';

const KEY = BALANCE.save.storageKey;

/* ------------------------------------------------------------------ */
/*  Encodage binaire                                                   */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeFloat32(arr) {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}
export function decodeFloat32(b64, expected) {
  const bytes = base64ToBytes(b64);
  const out = new Float32Array(expected);
  out.set(new Float32Array(bytes.buffer, 0, Math.min(expected, bytes.byteLength / 4)));
  return out;
}
export function encodeUint8(arr) { return bytesToBase64(arr); }
export function decodeUint8(b64, expected) {
  const bytes = base64ToBytes(b64);
  const out = new Uint8Array(expected);
  out.set(bytes.subarray(0, Math.min(expected, bytes.length)));
  return out;
}

/* ------------------------------------------------------------------ */
/*  Gestion des emplacements                                           */
/* ------------------------------------------------------------------ */

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn('[SaveManager] lecture impossible', err);
    return {};
  }
}

function writeAll(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
    return true;
  } catch (err) {
    console.error('[SaveManager] écriture impossible (quota ?)', err);
    return false;
  }
}

export class SaveManager {
  constructor(game) { this.game = game; }

  static available() {
    try {
      const k = '__tn_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch { return false; }
  }

  list() {
    const all = readAll();
    const out = [];
    for (let i = 0; i < BALANCE.save.maxSlots; i++) {
      const s = all['slot' + i];
      out.push(s ? {
        slot: i, empty: false, seed: s.state.seed, day: s.state.time.day,
        savedAt: s.savedAt, label: s.label,
        temperature: s.state.globals.temperature,
        buildings: s.state.buildings.length,
        victory: s.state.progress.victory,
      } : { slot: i, empty: true });
    }
    return out;
  }

  serialize() {
    const { state, regions } = this.game;
    return {
      savedAt: Date.now(),
      label: `An ${Math.floor(state.time.day / 365)} · ${state.globals.temperature.toFixed(1)} °C`,
      version: SAVE_VERSION,
      state: JSON.parse(JSON.stringify(state)),
      regions: regions.toJSON(),
    };
  }

  save(slot = 0) {
    const all = readAll();
    all['slot' + slot] = this.serialize();
    return writeAll(all);
  }

  read(slot = 0) {
    const all = readAll();
    return all['slot' + slot] || null;
  }

  delete(slot = 0) {
    const all = readAll();
    delete all['slot' + slot];
    return writeAll(all);
  }

  static migrate(payload) {
    if (!payload || !payload.state) return null;
    if (payload.version !== SAVE_VERSION) {
      // Pas encore de migration nécessaire : on refuse proprement.
      console.warn('[SaveManager] version de sauvegarde incompatible', payload.version);
      return null;
    }
    return payload;
  }
}

export default SaveManager;

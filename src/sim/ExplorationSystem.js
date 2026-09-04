/**
 * ExplorationSystem — scans orbitaux.
 *
 * Une sonde = un scan simultané. Le scan est une file d'attente stockée dans
 * `state.explore.scanning` (donc sauvegardée), décrémentée en jours. À son
 * terme, la région est révélée, rapporte de la science, et « éclabousse » ses
 * voisins : c'est ce qui donne l'impression d'une carte qui se déplie.
 */
import { BALANCE } from '../data/balance.js';
import { pushLog } from '../core/GameState.js';

export class ExplorationSystem {
  constructor(game) {
    this.game = game;
  }

  reset() {}

  /* =================================================================== */
  /*  DÉMARRAGE D'UN SCAN (appelé par Game.scanRegion)                   */
  /* =================================================================== */

  startScan(ctx, regionId) {
    const { state, regions, bus, tech } = ctx;
    const E = BALANCE.exploration;
    const refuse = (text) => {
      bus.emit('notify', { text, kind: 'warn', icon: '⌖' });
      return false;
    };

    if (!regions || regionId == null || regionId < 0 || regionId >= regions.count) {
      return refuse('Aucune région ciblée pour le scan.');
    }
    if (regions.discovered[regionId]) return refuse('Cette région est déjà cartographiée.');

    const scanning = state.explore.scanning;
    for (let i = 0; i < scanning.length; i++) {
      if (scanning[i].region === regionId) return refuse('Un scan est déjà en cours sur cette région.');
    }

    const probes = (state.explore.probes ?? BALANCE.start.probes) + (tech.probes || 0);
    const slots = probes * E.scansPerProbe;
    if (scanning.length >= slots) {
      return refuse(`Toutes les sondes sont occupées (${scanning.length}/${slots}).`);
    }

    const cost = E.scanCost || {};
    for (const key in cost) {
      if ((state.resources[key] ?? 0) < cost[key]) {
        return refuse(`Énergie insuffisante pour le scan (${cost[key]} ${key}).`);
      }
    }
    for (const key in cost) state.resources[key] -= cost[key];

    const duration = E.scanDays;
    scanning.push({ region: regionId, remaining: duration, total: duration });
    bus.emit('scan:started', { regionId, duration });
    bus.emit('notify', { text: `Scan orbital lancé sur le secteur ${regionId}.`, kind: 'info', icon: '⌖' });
    return true;
  }

  /* =================================================================== */

  tick(ctx) {
    const { state, dt, tech } = ctx;
    const scanning = state.explore.scanning;
    if (!scanning || scanning.length === 0 || dt <= 0) return;

    const speed = tech.scanSpeed || 1;
    for (let i = scanning.length - 1; i >= 0; i--) {
      const scan = scanning[i];
      scan.remaining -= dt * speed;
      if (scan.remaining <= 0) {
        scanning.splice(i, 1);
        this._reveal(ctx, scan.region);
      }
    }
  }

  _reveal(ctx, regionId) {
    const { state, regions, bus, rng } = ctx;
    const E = BALANCE.exploration;
    if (!regions || regionId < 0 || regionId >= regions.count) return;

    regions.discovered[regionId] = 1;
    state.stats.scanned++;

    let science = E.sciencePerScan;
    const anomaly = regions.anomaly && regions.anomaly[regionId];
    if (anomaly) science += E.anomalyScienceBonus;
    state.resources.science += science;

    // Révélation partielle du voisinage : la carte se déplie naturellement.
    const neigh = regions.neighbors(regionId);
    let revealed = 0;
    for (let j = 0; j < neigh.length; j++) {
      const n = neigh[j];
      if (regions.discovered[n]) continue;
      if (rng.next() < E.neighborRevealChance) {
        regions.discovered[n] = 1;
        revealed++;
        this.game?.markRegionDirty?.(n);
      }
    }

    this.game?.markRegionDirty?.(regionId);
    bus.emit('region:discovered', { regionId });

    const text = anomaly
      ? `Secteur ${regionId} cartographié : anomalie exploitable ! +${Math.round(science)} science.`
      : `Secteur ${regionId} cartographié. +${Math.round(science)} science${revealed ? `, ${revealed} secteur(s) voisin(s) entrevu(s)` : ''}.`;
    pushLog(state, text, anomaly ? 'success' : 'info', '⌖');
    bus.emit('notify', { text, kind: anomaly ? 'success' : 'info', icon: '⌖' });
  }
}

export default ExplorationSystem;

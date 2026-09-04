/**
 * ExplorationSystem — scans orbitaux.
 *
 * ---------------------------------------------------------------------------
 *  INTENTION DE DESIGN
 * ---------------------------------------------------------------------------
 *  L'exploration était la corvée du jeu : 313 scans, ~630 clics, zéro décision.
 *  Trois leviers la transforment en activité de reconnaissance :
 *
 *   1. UN SCAN RÉVÈLE UNE ZONE, pas une cellule. La cible, tout son premier
 *      anneau de voisins, et une partie du second (BALANCE.exploration.zoneRings).
 *      Le nombre de gestes est divisé par six sans toucher au rythme.
 *
 *   2. UNE FILE D'ATTENTE. Le joueur désigne des cibles ; les sondes s'y
 *      servent toutes seules dès qu'elles se libèrent ET que le coût est
 *      payable. Plus besoin de revenir toutes les seize journées.
 *
 *   3. UNE EXPLORATION AUTOMATIQUE optionnelle, qui empile la région inconnue
 *      la plus « accrochée » au territoire connu. Elle déblaie la routine —
 *      mais elle est BÊTE : elle ignore anomalies et richesses. Viser
 *      soi-même une anomalie ou un massif minéralisé reste payant.
 *
 *  Ce qui ne change PAS : les sondes restent rares (3, +1 avec la cartographie
 *  orbitale) et le scan coûte de l'énergie ET des matériaux — il se dispute
 *  donc les mêmes ressources que la construction. Explorer n'est jamais gratuit.
 * ---------------------------------------------------------------------------
 *
 *  État (sauvegardé, cf. docs/CONTRACTS.md) :
 *    state.explore.scanning     [{ region, remaining, total }]
 *    state.explore.queue        [regionId] en attente, dans l'ordre
 *    state.explore.probesFree   int, dérivé et tenu à jour à chaque tick
 *    state.explore.autoExplore   booléen
 */
import { BALANCE } from '../data/balance.js';
import { pushLog } from '../core/GameState.js';

export class ExplorationSystem {
  constructor(game) {
    this.game = game;
  }

  /**
   * `GameState.createInitialState` ne connaît pas les champs introduits ici
   * (file, exploration automatique, sondes libres) : on les installe au reset,
   * ce qui couvre à la fois la nouvelle partie et les anciennes sauvegardes.
   */
  reset(ctx) {
    const state = ctx && ctx.state;
    if (!state) return;
    const ex = state.explore;
    if (!Array.isArray(ex.scanning)) ex.scanning = [];
    if (!Array.isArray(ex.queue)) ex.queue = [];
    if (typeof ex.autoExplore !== 'boolean') ex.autoExplore = false;
    ex.probesFree = Math.max(0, this._slots(ctx) - ex.scanning.length);
    if (state.stats && typeof state.stats.scansLaunched !== 'number') {
      state.stats.scansLaunched = 0;
    }
  }

  /* =================================================================== */
  /*  SONDES                                                             */
  /* =================================================================== */

  /** Nombre de scans simultanés possibles (sondes × scans par sonde). */
  _slots(ctx) {
    const base = ctx.state.explore.probes ?? BALANCE.start.probes;
    const bonus = (ctx.tech && ctx.tech.probes) || 0;
    return Math.max(0, Math.round((base + bonus) * BALANCE.exploration.scansPerProbe));
  }

  /** Le coût d'un scan est-il payable maintenant ? */
  _afford(ctx) {
    const cost = BALANCE.exploration.scanCost || {};
    for (const key in cost) {
      if ((ctx.state.resources[key] ?? 0) < cost[key]) return false;
    }
    return true;
  }

  _isPending(state, regionId) {
    const ex = state.explore;
    for (let i = 0; i < ex.scanning.length; i++) if (ex.scanning[i].region === regionId) return true;
    return ex.queue.indexOf(regionId) >= 0;
  }

  /* =================================================================== */
  /*  DEMANDE DE SCAN (appelé par Game.scanRegion)                       */
  /* =================================================================== */

  /**
   * Demande le scan d'une région. Si une sonde est libre ET le coût payable,
   * le scan part immédiatement ; sinon la région est MISE EN FILE.
   * @param {boolean} silent  n'émet aucune notification (exploration auto)
   * @returns {boolean} vrai si le scan est lancé OU mis en file
   */
  startScan(ctx, regionId, silent = false) {
    const { state, regions, bus } = ctx;
    const E = BALANCE.exploration;
    const refuse = (text) => {
      if (!silent) bus.emit('notify', { text, kind: 'warn', icon: '⌖' });
      return false;
    };

    if (!regions || regionId == null || regionId < 0 || regionId >= regions.count) {
      return refuse('Aucune région ciblée pour le scan.');
    }
    if (regions.discovered[regionId]) return refuse('Cette région est déjà cartographiée.');
    if (this._isPending(state, regionId)) return refuse('Un scan est déjà prévu sur cette région.');

    const ex = state.explore;
    // Départ immédiat si une sonde est libre et que le coût est payable.
    if (ex.scanning.length < this._slots(ctx) && this._afford(ctx)) {
      this._launch(ctx, regionId, silent);
      return true;
    }

    if (ex.queue.length >= E.maxQueue) {
      return refuse(`File de scans pleine (${E.maxQueue}). Annulez une cible avant d'en ajouter.`);
    }
    ex.queue.push(regionId);
    ex.probesFree = Math.max(0, this._slots(ctx) - ex.scanning.length);
    if (!silent) {
      bus.emit('notify', {
        text: `Secteur ${regionId} mis en file (${ex.queue.length} en attente).`,
        kind: 'info', icon: '⌖',
      });
    }
    return true;
  }

  /** Retire une cible de la file, ou annule le scan en cours sur cette région. */
  cancelScan(ctx, regionId) {
    const { state, bus } = ctx;
    const ex = state.explore;

    const q = ex.queue.indexOf(regionId);
    if (q >= 0) {
      ex.queue.splice(q, 1);
      bus.emit('notify', { text: `Secteur ${regionId} retiré de la file.`, kind: 'info', icon: '⌖' });
      return true;
    }
    for (let i = 0; i < ex.scanning.length; i++) {
      if (ex.scanning[i].region !== regionId) continue;
      ex.scanning.splice(i, 1);
      // Rappeler une sonde en vol ne rend qu'une partie du carburant.
      const cost = BALANCE.exploration.scanCost || {};
      for (const key in cost) {
        state.resources[key] = (state.resources[key] ?? 0) + cost[key] * BALANCE.exploration.cancelRefund;
      }
      ex.probesFree = Math.max(0, this._slots(ctx) - ex.scanning.length);
      bus.emit('notify', { text: `Scan du secteur ${regionId} interrompu.`, kind: 'warn', icon: '⌖' });
      return true;
    }
    return false;
  }

  /** Paye et lance réellement le scan. Le coût est prélevé au DÉPART, pas à la mise en file. */
  _launch(ctx, regionId, silent = false) {
    const { state, bus } = ctx;
    const E = BALANCE.exploration;
    const cost = E.scanCost || {};
    for (const key in cost) state.resources[key] -= cost[key];

    const duration = E.scanDays;
    state.explore.scanning.push({ region: regionId, remaining: duration, total: duration });
    state.stats.scansLaunched = (state.stats.scansLaunched || 0) + 1;
    state.explore.probesFree = Math.max(0, this._slots(ctx) - state.explore.scanning.length);
    bus.emit('scan:started', { regionId, duration });
    if (!silent) {
      bus.emit('notify', { text: `Scan orbital lancé sur le secteur ${regionId}.`, kind: 'info', icon: '⌖' });
    }
    return true;
  }

  /* =================================================================== */

  tick(ctx) {
    const { state, dt, tech } = ctx;
    const ex = state.explore;
    if (!ex) return;
    if (!Array.isArray(ex.queue)) this.reset(ctx);

    const scanning = ex.scanning;
    if (dt > 0 && scanning.length) {
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

    if (dt > 0) this._autoEnqueue(ctx);
    this._pump(ctx);
  }

  /**
   * Les sondes libres piochent dans la file. Une cible devenue inutile (déjà
   * révélée par la zone d'un scan voisin) est simplement jetée : la file ne
   * fait jamais perdre de ressources au joueur.
   */
  _pump(ctx) {
    const { state, regions } = ctx;
    const ex = state.explore;
    let free = this._slots(ctx) - ex.scanning.length;

    while (free > 0 && ex.queue.length > 0) {
      const id = ex.queue[0];
      if (!regions || regions.discovered[id]) { ex.queue.shift(); continue; }
      if (!this._afford(ctx)) break;      // on garde la cible pour plus tard
      ex.queue.shift();
      this._launch(ctx, id, true);
      free--;
    }
    ex.probesFree = Math.max(0, this._slots(ctx) - ex.scanning.length);
  }

  /**
   * Exploration automatique : entretient une file courte en visant la région
   * inconnue la plus accrochée au territoire connu. Volontairement myope —
   * elle ne sait rien des anomalies ni des richesses, elle ne fait que
   * supprimer la corvée.
   */
  _autoEnqueue(ctx) {
    const ex = ctx.state.explore;
    if (!ex.autoExplore) return;
    const E = BALANCE.exploration;
    let pending = ex.queue.length + ex.scanning.length;
    while (pending < E.autoQueueDepth) {
      const id = this._frontier(ctx);
      if (id < 0) break;
      if (!this.startScan(ctx, id, true)) break;
      pending++;
    }
  }

  /** Région inconnue ayant le plus de voisins déjà cartographiés (−1 si aucune). */
  _frontier(ctx) {
    const { state, regions } = ctx;
    if (!regions) return -1;
    const ex = state.explore;
    let best = -1, bestScore = 0;
    for (let i = 0; i < regions.count; i++) {
      if (regions.discovered[i]) continue;
      if (this._isPending(state, i)) continue;
      const neigh = regions.neighbors(i);
      let known = 0;
      for (let j = 0; j < neigh.length; j++) if (regions.discovered[neigh[j]]) known++;
      if (known > bestScore) { bestScore = known; best = i; }
    }
    return best;
  }

  /* =================================================================== */
  /*  RÉVÉLATION D'UNE ZONE                                              */
  /* =================================================================== */

  _reveal(ctx, regionId) {
    const { state, regions, bus, rng } = ctx;
    const E = BALANCE.exploration;
    if (!regions || regionId < 0 || regionId >= regions.count) return;

    let science = 0;
    let anomalies = 0;
    let revealed = 0;

    const take = (id, base) => {
      if (regions.discovered[id]) return;
      regions.discovered[id] = 1;
      state.stats.scanned++;
      revealed++;
      science += base;
      if (regions.anomaly && regions.anomaly[id]) {
        anomalies++;
        science += E.anomalyScienceBonus;
      }
      this.game?.markRegionDirty?.(id);
      bus.emit('region:discovered', { regionId: id });
    };

    take(regionId, E.sciencePerScan);

    /* Propagation par anneaux : anneau 0 = voisins directs, anneau 1 = leurs
       voisins… Chaque anneau a sa propre probabilité, décroissante. On empile
       TOUS les voisins (révélés ou non) pour pouvoir construire l'anneau
       suivant, mais on ne révèle que les inconnus. */
    const rings = E.zoneRings || [];
    const seen = new Set([regionId]);
    let frontier = [regionId];
    for (let r = 0; r < rings.length && frontier.length; r++) {
      const chance = rings[r];
      const next = [];
      for (let k = 0; k < frontier.length; k++) {
        const neigh = regions.neighbors(frontier[k]);
        for (let j = 0; j < neigh.length; j++) {
          const n = neigh[j];
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
          if (regions.discovered[n]) continue;
          if (chance >= 1 || rng.next() < chance) take(n, E.sciencePerZoneRegion);
        }
      }
      frontier = next;
    }

    state.resources.science += science;

    // UNE seule notification par zone : la pile d'alertes n'est plus noyée.
    const text = anomalies
      ? `Zone du secteur ${regionId} cartographiée : ${revealed} secteurs, ${anomalies} anomalie(s) ! +${Math.round(science)} science.`
      : `Zone du secteur ${regionId} cartographiée : ${revealed} secteurs. +${Math.round(science)} science.`;
    pushLog(state, text, anomalies ? 'success' : 'info', '⌖');
    bus.emit('notify', { text, kind: anomalies ? 'success' : 'info', icon: '⌖' });
  }
}

export default ExplorationSystem;

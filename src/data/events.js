/**
 * Événements planétaires.
 *
 * Chaque événement :
 *  - `weight(ctx)` : poids de tirage (0 = impossible dans le contexte courant)
 *  - `apply(ctx)`  : applique l'effet, retourne { title, text, kind, regionId? }
 *
 * ctx = { state, regions, rng, bus, helpers }
 *
 * IMPORTANT : tout aléa doit passer par `ctx.rng` (générateur semé). Aucun
 * `Math.random()` ici, sous peine de casser le déterminisme par seed.
 * helpers : { randomRegion(filter), discoveredRegions(), addResource(k,v),
 *             addGlobal(k,v), damageBuilding(), notify() }
 *
 * Les événements sont rares (voir BALANCE.events) : ils doivent compter.
 */

const kindOf = (k) => k;

export const GAME_EVENTS = [
  /* ------------------------------------------------------------------ */
  /*  NÉGATIFS                                                           */
  /* ------------------------------------------------------------------ */
  {
    id: 'solar_storm',
    name: 'Tempête solaire',
    weight: () => 10,
    apply: ({ state, helpers }) => {
      const loss = Math.min(state.resources.energy, 40 + state.buildings.length * 6);
      state.resources.energy -= loss;
      helpers.addGlobal('stability', -2.5);
      return {
        title: 'Tempête solaire',
        text: `Une éjection de masse coronale frappe la planète. ${Math.round(loss)} unités d’énergie perdues, réseaux perturbés.`,
        kind: kindOf('danger'), icon: '☀',
      };
    },
  },
  {
    id: 'quake',
    name: 'Séisme',
    weight: ({ state }) => (state.buildings.length >= 4 ? 9 : 0),
    apply: ({ state, regions, rng, helpers }) => {
      const b = helpers.randomBuilding();
      if (!b) return null;
      state.buildings = state.buildings.filter((x) => x.id !== b.id);
      regions.buildingCount[b.region] = Math.max(0, regions.buildingCount[b.region] - 1);
      helpers.addGlobal('stability', -1.5);
      return {
        title: 'Séisme',
        text: `La croûte joue dans le secteur ${b.region}. Une installation est détruite.`,
        kind: kindOf('danger'), icon: '⚠', regionId: b.region, rebuild: true,
      };
    },
  },
  {
    id: 'eruption',
    name: 'Éruption volcanique',
    weight: ({ state }) => (state.globals.temperature > -60 ? 7 : 3),
    apply: ({ regions, helpers }) => {
      const i = helpers.randomRegion((r) => regions.geothermal[r] > 0.5);
      if (i < 0) return null;
      regions.pollution[i] = Math.min(1, regions.pollution[i] + 0.35);
      regions.vegetation[i] *= 0.3;
      helpers.addGlobal('co2', 0.35);
      helpers.addGlobal('pressure', 0.25);
      helpers.addGlobal('stability', -3);
      helpers.markRegion(i);
      return {
        title: 'Éruption volcanique',
        text: 'Un panache de cendres et de CO₂ s’élève. L’atmosphère s’épaissit, la région est ravagée.',
        kind: kindOf('warn'), icon: '🜂', regionId: i,
      };
    },
  },
  {
    id: 'meteorite',
    name: 'Impact de météorite',
    weight: ({ state }) => (state.globals.pressure < 25 ? 8 : 2),
    apply: ({ regions, helpers }) => {
      const i = helpers.randomRegion(() => true);
      if (i < 0) return null;
      regions.vegetation[i] = 0;
      regions.minerals[i] = Math.min(1, regions.minerals[i] + 0.28);
      regions.pollution[i] = Math.min(1, regions.pollution[i] + 0.1);
      helpers.addGlobal('stability', -1.2);
      helpers.markRegion(i);
      return {
        title: 'Impact de météorite',
        text: 'Un corps rocheux a percé l’atmosphère ténue. Le cratère expose un gisement métallique riche.',
        kind: kindOf('warn'), icon: '☄', regionId: i,
      };
    },
  },
  {
    id: 'breakdown',
    name: 'Panne en cascade',
    weight: ({ state }) => (state.globals.stability < 55 && state.buildings.length >= 6 ? 8 : 2),
    apply: ({ state, rng, helpers }) => {
      /* `rng` et non Math.random : le déterminisme par seed est un pilier du
         jeu. Une seule source non semée suffisait à rendre deux parties
         lancées avec la même seed divergentes — et la sonde d'équilibrage
         non reproductible. */
      const affected = state.buildings.filter(() => rng.next() < 0.22);
      affected.forEach((b) => { b.downtime = 45; });
      if (!affected.length) return null;
      return {
        title: 'Panne en cascade',
        text: `${affected.length} installation(s) hors service pendant 45 jours. Maintenance automatique engagée.`,
        kind: kindOf('warn'), icon: '⚡',
      };
    },
  },
  {
    id: 'biocollapse',
    name: 'Effondrement biologique',
    weight: ({ state }) => (state.globals.biomass > 8 && state.globals.stability < 50 ? 10 : 0),
    apply: ({ regions, helpers }) => {
      let n = 0;
      for (let i = 0; i < regions.count; i++) {
        if (regions.vegetation[i] > 0.1) { regions.vegetation[i] *= 0.55; n++; }
      }
      helpers.addGlobal('stability', -4);
      helpers.markRegion(null);
      return {
        title: 'Effondrement biologique',
        text: `La biosphère introduite trop vite s’effondre sur ${n} régions. Réduisez le rythme d’ensemencement.`,
        kind: kindOf('danger'), icon: '❋',
      };
    },
  },
  {
    id: 'runaway_warning',
    name: 'Emballement climatique',
    weight: ({ state }) => (state.globals.temperature > 34 ? 14 : 0),
    apply: ({ helpers }) => {
      helpers.addGlobal('stability', -6);
      return {
        title: 'Emballement climatique',
        text: 'La rétroaction vapeur d’eau s’emballe : la planète surchauffe. Réduisez les sources de chaleur.',
        kind: kindOf('danger'), icon: '🌡',
      };
    },
  },

  /* ------------------------------------------------------------------ */
  /*  POSITIFS                                                           */
  /* ------------------------------------------------------------------ */
  {
    id: 'mineral_discovery',
    name: 'Découverte minérale',
    weight: () => 9,
    apply: ({ regions, helpers }) => {
      const i = helpers.randomRegion((r) => regions.discovered[r] === 1);
      if (i < 0) return null;
      regions.minerals[i] = Math.min(1, regions.minerals[i] + 0.3);
      helpers.addResource('materials', 120);
      helpers.markRegion(i);
      return {
        title: 'Découverte minérale',
        text: 'Un filon métallique inattendu affleure. +120 matériaux et gisement enrichi.',
        kind: kindOf('success'), icon: '⛏', regionId: i,
      };
    },
  },
  {
    id: 'scientific_breakthrough',
    name: 'Percée scientifique',
    weight: ({ state }) => (state.buildings.some((b) => b.type === 'science_station') ? 10 : 3),
    apply: ({ helpers, state }) => {
      const gain = 60 + state.buildings.filter((b) => b.type === 'science_station').length * 25;
      helpers.addResource('science', gain);
      return {
        title: 'Percée scientifique',
        text: `Les données croisées des stations débloquent une avancée. +${Math.round(gain)} science.`,
        kind: kindOf('success'), icon: '⌬',
      };
    },
  },
  {
    id: 'mutation',
    name: 'Mutation biologique',
    weight: ({ state }) => (state.globals.biomass > 3 ? 8 : 0),
    apply: ({ regions, helpers }) => {
      let best = -1, bestV = 0;
      for (let i = 0; i < regions.count; i++) if (regions.vegetation[i] > bestV) { bestV = regions.vegetation[i]; best = i; }
      if (best < 0) return null;
      for (const n of regions.neighbors(best)) regions.vegetation[n] = Math.min(1, regions.vegetation[n] + 0.18);
      regions.vegetation[best] = Math.min(1, regions.vegetation[best] + 0.25);
      helpers.markRegion(null);
      return {
        title: 'Mutation biologique',
        text: 'Une souche mieux adaptée émerge et essaime autour de son foyer.',
        kind: kindOf('success'), icon: '❋', regionId: best,
      };
    },
  },
  {
    id: 'ice_vein',
    name: 'Nappe de glace profonde',
    weight: ({ state }) => (state.globals.waterCoverage < 0.2 ? 8 : 2),
    apply: ({ regions, helpers }) => {
      const i = helpers.randomRegion((r) => regions.discovered[r] === 1 && regions.ice[r] > 0.05);
      if (i < 0) return null;
      regions.ice[i] = Math.min(1, regions.ice[i] + 0.3);
      helpers.addResource('water', 180);
      helpers.markRegion(i);
      return {
        title: 'Nappe de glace profonde',
        text: 'Un réservoir d’eau fossile est localisé sous la surface. +180 eau.',
        kind: kindOf('success'), icon: '❄', regionId: i,
      };
    },
  },
  {
    id: 'anomaly_signal',
    name: 'Signal anormal',
    weight: ({ state, regions }) => {
      let n = 0;
      for (let i = 0; i < regions.count; i++) if (regions.anomaly[i] && !regions.discovered[i]) n++;
      return n > 0 ? 7 : 0;
    },
    apply: ({ regions, helpers }) => {
      const i = helpers.randomRegion((r) => regions.anomaly[r] === 1 && regions.discovered[r] === 0);
      if (i < 0) return null;
      helpers.reveal(i);
      helpers.addResource('science', 45);
      return {
        title: 'Signal anormal',
        text: 'Une émission structurée oriente les sondes vers une anomalie. Région révélée, +45 science.',
        kind: kindOf('success'), icon: '⌖', regionId: i,
      };
    },
  },
];

export const EVENT_INDEX = Object.fromEntries(GAME_EVENTS.map((e) => [e.id, e]));

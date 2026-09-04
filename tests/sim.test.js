/**
 * Tests de la simulation TERRA NOVA (node --test tests/sim.test.js).
 * Aucune dépendance externe, aucun DOM, aucun Three.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BALANCE } from '../src/data/balance.js';
import { BUILDINGS } from '../src/data/buildings.js';
import { createSimHarness, makeFakeRegions, allFinite } from './fakeRegions.js';

/* ===================================================================== */
/*  1. Une planète froide sans bâtiment reste froide et stable           */
/* ===================================================================== */

test('planète froide et vierge : pas de dérive absurde sur 3650 jours', () => {
  const h = createSimHarness({ seed: 11 });
  const t0 = h.state.globals.temperature;
  const s0 = h.state.globals.stability;

  h.run(3650);

  const g = h.state.globals;
  assert.ok(allFinite(g), 'aucune globale ne doit être NaN/Infinity');
  assert.ok(Math.abs(g.temperature - t0) < 15,
    `dérive thermique excessive : ${t0} → ${g.temperature}`);
  assert.ok(g.temperature < -20, 'la planète doit rester froide');
  /* La stabilité oscille : les événements planétaires aléatoires (tempête
     solaire, séisme, météorite) la font chuter, la récupération naturelle la
     ramène. Ce va-et-vient est VOULU — c'est ce qui en fait un levier de
     tension. On vérifie donc qu'elle reste dans une bande plausible, pas
     qu'elle est figée : l'ancienne assertion « ne doit pas se dégrader »
     ne tenait que parce que la récupération écrasait toutes les pénalités. */
  assert.ok(g.stability > 40, `stabilité effondrée sans industrie : ${g.stability}`);
  assert.ok(g.stability <= 100);
  assert.ok(g.iceCover > 0.3, 'la glace ne doit pas fondre toute seule');
  assert.ok(g.biomass === 0, 'aucune vie ne doit apparaître spontanément');
});

/* ===================================================================== */
/*  2. Les usines à effet de serre réchauffent et déstabilisent          */
/* ===================================================================== */

/**
 * ADAPTÉ AU MODÈLE EN PRESSIONS PARTIELLES. Deux changements de fond :
 *  1. `co2` est désormais un POURCENTAGE dérivé : il peut parfaitement baisser
 *     pendant qu'on injecte du CO₂, puisque la pression totale monte aussi.
 *     La grandeur à surveiller est la pression partielle `pCO2` (kPa).
 *  2. l'ancienne version comparait la planète à son état INITIAL. Or l'état
 *     initial de BALANCE (−52 °C) est plus chaud que l'équilibre radiatif de la
 *     planète-test : sans rien faire elle refroidit déjà. On compare donc
 *     maintenant à un TÉMOIN identique sans usines — ce qui teste l'effet des
 *     usines et non le tempo d'équilibrage.
 */
test('usines à gaz à effet de serre : CO₂ ↑, température ↑, stabilité ↓', () => {
  const build = (withFactories) => {
    const h = createSimHarness({ seed: 12 });
    // De l'énergie en abondance pour que les usines tournent à plein régime.
    h.addBuilding('fusion', 1, 1);
    h.addBuilding('fusion', 4, 1);
    h.addBuilding('fusion', 7, 1);
    if (withFactories) {
      for (let i = 0; i < 8; i++) h.addBuilding('ghg_factory', i * 3 + 2, 1);
    }
    h.state.resources.energy = 400;
    h.state.resources.water = 600;
    return h;
  };

  const h = build(true);
  const witness = build(false);
  const before = { ...h.state.globals };
  h.run(3650);
  witness.run(3650);
  const g = h.state.globals, w = witness.state.globals;

  assert.ok(allFinite(g));
  assert.ok(g.pCO2 > before.pCO2, `le CO₂ doit monter (${before.pCO2} → ${g.pCO2} kPa)`);
  assert.ok(g.pCO2 > w.pCO2 + 1, `plus de CO₂ qu'un témoin sans usines (${w.pCO2} → ${g.pCO2} kPa)`);
  assert.ok(g.pressure > w.pressure, 'la pression doit monter plus vite que le témoin');
  assert.ok(g.co2 + g.oxygen <= 100.01, 'la composition doit rester cohérente');
  assert.ok(g.temperature > w.temperature + 1,
    `la planète doit se réchauffer (témoin ${w.temperature} → ${g.temperature})`);
  assert.ok(g.stability < w.stability,
    `la stabilité doit chuter (témoin ${w.stability} → ${g.stability})`);

  // Le joueur doit pouvoir comprendre pourquoi : les contributions existent.
  const labels = h.state.contributions.temperature.map((r) => r.label);
  assert.ok(labels.includes('Effet de serre CO₂'));
  assert.ok(labels.includes('Étoile'));
  assert.ok(labels.includes('Albédo glaciaire'));
});

/* ===================================================================== */
/*  3. Rétroaction glace–albédo                                          */
/* ===================================================================== */

test('rétroaction glace–albédo : la fonte fait monter l’équilibre', () => {
  const h = createSimHarness({ seed: 13 });
  const g = h.state.globals;

  const ice0 = g.iceCover;
  const albedo0 = g.albedo;
  const eq0 = g.equilibrium;
  assert.ok(ice0 > 0.3, 'la planète de départ est bien englacée');

  // On force un réchauffement (équivalent d'un coup de pouce du joueur).
  g.temperature = 14;
  h.run(400);

  assert.ok(g.iceCover < ice0 - 0.05, `la glace doit fondre (${ice0} → ${g.iceCover})`);
  assert.ok(g.albedo < albedo0 - 0.02, `l’albédo doit baisser (${albedo0} → ${g.albedo})`);
  assert.ok(g.equilibrium > eq0 + 1,
    `l’équilibre radiatif doit monter (${eq0} → ${g.equilibrium})`);
  assert.ok(allFinite(g));
});

/* ===================================================================== */
/*  4. Pénurie d'énergie                                                 */
/* ===================================================================== */

test('pénurie d’énergie : la satisfaction chute et la production suit', () => {
  const mines = (withPower) => {
    const h = createSimHarness({ seed: 14 });
    for (let i = 0; i < 6; i++) h.addBuilding('mine', i * 3 + 1);
    // Des dépôts dans les deux cas : on compare des flux, pas des plafonds.
    h.addBuilding('depot', 40); h.addBuilding('depot', 41);
    if (withPower) for (let i = 0; i < 8; i++) h.addBuilding('solar', i * 5 + 2);
    h.state.resources.energy = 0;
    h.run(120);
    return h;
  };

  const poor = mines(false);
  const rich = mines(true);

  /* ADAPTÉ AU RESSERREMENT DU STOCKAGE (BALANCE.storage.materials divisé par
     trois) : après 120 jours, la version ALIMENTÉE remplit son entrepôt et son
     `flux.materials` retombe à zéro — le flux affiché est le net RÉELLEMENT
     encaissé, écrêtage compris. Comparer les deux flux comparait donc deux
     entrepôts pleins. On vide les stocks et on mesure UN jour de production :
     c'est bien la production, et non le plafond, qui est testée ici. */
  poor.state.resources.materials = 0;
  rich.state.resources.materials = 0;
  poor.run(1);
  rich.run(1);

  assert.ok(poor.state.power.satisfaction < 0.5,
    `satisfaction attendue basse, obtenue ${poor.state.power.satisfaction}`);
  assert.ok(poor.state.power.satisfaction >= BALANCE.power.brownoutFloor,
    'la satisfaction ne descend jamais sous le plancher de brownout');
  assert.ok(rich.state.power.satisfaction > 0.95, 'avec du solaire, tout tourne');
  assert.ok(poor.state.flux.materials < rich.state.flux.materials * 0.6,
    `la production doit s’effondrer en pénurie (${poor.state.flux.materials} vs ${rich.state.flux.materials})`);
  assert.ok(poor.state.resources.energy >= 0, 'aucune ressource négative');

  const warned = poor.events.some((e) => e.type === 'notify' && /Pénurie/.test(e.text));
  assert.ok(warned, 'une alerte de pénurie doit être émise');
  const warnCount = poor.events.filter((e) => e.type === 'notify' && /Pénurie/.test(e.text)).length;
  assert.ok(warnCount <= 1, 'pas de spam d’alertes (1 tous les 200 jours)');
});

/* ===================================================================== */
/*  5. Biosphère : pression minimale, croissance, propagation            */
/* ===================================================================== */

/**
 * ADAPTÉ AU MODÈLE « MIROIRS = NIVEAU » : `globals.insolation` n'est plus une
 * valeur que l'on pose, c'est un DÉRIVÉ recalculé chaque tick à partir des
 * miroirs orbitaux actifs. On chauffe donc la serre en posant 5 miroirs
 * (5 × BALANCE des miroirs = +0,25 d'ensoleillement), ce qui reproduit
 * exactement l'ancien 1,26 forcé à la main.
 */
function greenhouseHarness(pressure, mirrors = 5) {
  const h = createSimHarness({
    seed: 15, w: 8, h: 1,
    init: (R, state) => {
      for (let i = 0; i < R.count; i++) {
        // Bassins peu profonds : de l'eau libre sans devenir des océans.
        R.elevation[i] = BALANCE.planet.seaLevel - 0.43;
        R.ice[i] = 0;
        R.water[i] = 0.15;
        R.moisture[i] = 0.5;
        R.fertilityBase[i] = 1;
        R.geothermal[i] = 0;
        R.vegetation[i] = 0;
        R.temperature[i] = 16;
      }
      R.vegetation[0] = 0.5;
      state.globals.temperature = 16;
      state.globals.pressure = pressure;
      state.globals.co2 = 60;
    },
  });
  for (let k = 0; k < mirrors; k++) h.addBuilding('orbital_mirror', k % h.regions.count);
  h.state.resources.energy = 4000;
  return h;
}

test('la végétation ne pousse pas sous BALANCE.biosphere.minPressure', () => {
  const h = greenhouseHarness(BALANCE.biosphere.minPressure - 2);
  h.run(1000);
  assert.ok(h.regions.vegetation[0] < 0.5,
    'sans pression suffisante, la végétation dépérit');
  assert.equal(h.regions.vegetation[4], 0, 'et ne se propage pas');
  assert.ok(h.state.globals.biomass < 5);
});

test('la végétation pousse et se propage aux voisins en bonnes conditions', () => {
  const h = greenhouseHarness(60);
  const v0 = h.regions.vegetation[0];
  h.run(900);

  assert.ok(h.regions.vegetation[0] > v0,
    `la végétation doit croître (${v0} → ${h.regions.vegetation[0]})`);
  assert.ok(h.regions.vegetation[1] > 0.01, 'le voisin de droite doit être ensemencé');
  assert.ok(h.regions.vegetation[7] > 0.01, 'le voisin de gauche aussi');
  assert.ok(h.state.globals.biomass > 5, 'la biomasse globale doit progresser');
  // La photosynthèse convertit du CO₂ en O₂ : c'est `pO2` (kPa) qui monte.
  assert.ok(h.state.globals.pO2 > 0.5,
    `la photosynthèse doit produire de l’oxygène (${h.state.globals.pO2} kPa)`);
  assert.ok(h.state.globals.co2 + h.state.globals.oxygen <= 100.01);
});

/* ===================================================================== */
/*  6. Robustesse : 10 000 jours, aucune ressource négative, aucun NaN   */
/* ===================================================================== */

test('10 000 jours : aucun NaN, aucune ressource négative', () => {
  const h = createSimHarness({ seed: 16 });
  h.state.tech.unlocked.push('metallurgy', 'geothermal_tap', 'greenhouse_gases',
    'polar_engineering', 'atmospheric_engineering', 'carbon_capture', 'climate_control',
    'exobiology', 'pioneer_organisms', 'forestation', 'ecosystems', 'orbital_survey',
    'orbital_infrastructure', 'colonization');
  h.refreshTech();

  const types = ['mine', 'solar', 'depot', 'refinery', 'science_station', 'ice_extractor',
    'ghg_factory', 'atmo_processor', 'o2_generator', 'polar_melter', 'orbital_mirror',
    'climate_stabilizer', 'biodome', 'seeder', 'colony', 'geothermal'];
  types.forEach((t, k) => h.addBuilding(t, (k * 7) % h.regions.count));

  h.run(10000);

  const g = h.state.globals;
  assert.ok(allFinite(g), `globales non finies : ${JSON.stringify(g)}`);
  assert.ok(allFinite(h.state.resources), 'ressources non finies');
  assert.ok(allFinite(h.state.flux), 'flux non finis');
  for (const k in h.state.resources) {
    assert.ok(h.state.resources[k] >= 0, `ressource négative : ${k} = ${h.state.resources[k]}`);
  }
  assert.ok(g.stability >= BALANCE.stability.min && g.stability <= BALANCE.stability.max);
  assert.ok(g.pressure >= BALANCE.atmosphere.minPressure && g.pressure <= BALANCE.atmosphere.maxPressure);
  assert.ok(g.oxygen >= 0 && g.co2 >= 0);
  assert.ok(g.waterCoverage >= 0 && g.waterCoverage <= 1);

  for (let i = 0; i < h.regions.count; i++) {
    assert.ok(Number.isFinite(h.regions.temperature[i]), `température NaN en ${i}`);
    assert.ok(h.regions.ice[i] >= 0 && h.regions.ice[i] <= 1);
    assert.ok(h.regions.moisture[i] >= 0 && h.regions.moisture[i] <= 1);
    assert.ok(h.regions.vegetation[i] >= 0 && h.regions.vegetation[i] <= 1);
    assert.ok(h.regions.habitability[i] >= 0 && h.regions.habitability[i] <= 1);
    assert.ok(h.regions.biome[i] < 12, 'index de biome valide');
  }
});

/* ===================================================================== */
/*  7. Événements                                                        */
/* ===================================================================== */

test('aucun événement avant graceDays, puis des événements ensuite', () => {
  const h = createSimHarness({ seed: 17 });
  h.addBuilding('mine', 1); h.addBuilding('solar', 2); h.addBuilding('depot', 3);
  h.addBuilding('science_station', 4); h.addBuilding('mine', 7); h.addBuilding('solar', 8);

  h.run(BALANCE.events.graceDays - 1);
  assert.equal(h.state.stats.events, 0, 'aucun événement pendant la période de grâce');
  assert.equal(h.events.filter((e) => e.type === 'event').length, 0);

  h.run(6000);
  assert.ok(h.state.stats.events > 0, 'des événements doivent finir par se produire');
  assert.ok(h.state.log.length > 0, 'le journal doit être alimenté');
});

/* ===================================================================== */
/*  8. Exploration                                                       */
/* ===================================================================== */

/**
 * ADAPTÉ AU MODÈLE « ZONE + FILE D'ATTENTE ». Deux changements de fond :
 *  1. un scan ne révèle plus une cellule mais la cible ET son voisinage
 *     (BALANCE.exploration.zoneRings) ;
 *  2. faute de sonde libre OU de ressources, la région n'est plus REFUSÉE
 *     mais MISE EN FILE — le refus ne subsiste que pour les cas qui n'ont
 *     aucun sens (région inconnue, déjà cartographiée, déjà prévue).
 */
test('scan orbital : coût, durée, révélation en zone et refus explicite', () => {
  const h = createSimHarness({ seed: 18, init: (R) => { R.discovered.fill(0); R.discovered[0] = 1; } });
  const explo = h.systems.find((s) => s.constructor.name === 'ExplorationSystem');

  h.state.resources.energy = 2000;
  h.state.resources.materials = 2000;
  assert.equal(explo.startScan(h.ctx, 0), false, 'région déjà découverte → refus');
  assert.equal(explo.startScan(h.ctx, 5), true);
  assert.equal(h.state.explore.scanning.length, 1);
  assert.equal(explo.startScan(h.ctx, 5), false, 'scan déjà prévu → refus');

  // Sans ressources, la cible est mise en file au lieu d'être perdue.
  h.state.resources.energy = 0;
  h.state.resources.materials = 0;
  assert.equal(explo.startScan(h.ctx, 60), true, 'sans énergie → mise en file');
  assert.equal(h.state.explore.queue[0], 60);

  h.run(BALANCE.exploration.scanDays + 2);
  assert.equal(h.regions.discovered[5], 1, 'la région visée doit être révélée');
  assert.equal(h.state.explore.scanning.length, 0);
  assert.ok(h.state.stats.scanned >= 1);
  // Le scan couvre une ZONE : au moins un voisin direct est révélé aussi.
  const neigh = h.regions.neighbors(5);
  let around = 0;
  for (let j = 0; j < neigh.length; j++) if (h.regions.discovered[neigh[j]]) around++;
  assert.ok(around >= 1, `le premier anneau doit être révélé (${around} voisins)`);
  // La cible en file reste en attente tant que le coût n'est pas payable.
  assert.equal(h.state.explore.queue[0], 60, 'la file conserve la cible impayable');
  assert.equal(h.state.stats.scansLaunched, 1, 'un seul scan a réellement été lancé');
});

test('la file de scans est consommée par les sondes dès qu’elles se libèrent', () => {
  const h = createSimHarness({ seed: 118, init: (R) => { R.discovered.fill(0); R.discovered[0] = 1; } });
  const game = h.game;
  const explo = h.systems.find((s) => s.constructor.name === 'ExplorationSystem');
  h.state.resources.energy = 100000;
  h.state.resources.materials = 100000;

  // Bien plus de cibles que de sondes : tout doit être accepté.
  const targets = [];
  for (let i = 1; i < h.regions.count && targets.length < 9; i += 7) targets.push(i);
  for (const t of targets) assert.equal(explo.startScan(h.ctx, t), true, `cible ${t} acceptée`);

  const slots = h.state.explore.scanning.length;
  assert.ok(slots > 0 && slots <= BALANCE.start.probes, 'les sondes disponibles sont occupées');
  assert.equal(h.state.explore.queue.length, targets.length - slots, 'le reste est en file');
  assert.equal(h.state.explore.probesFree, 0, 'plus aucune sonde libre');

  // Annulation d'une cible en file : elle disparaît sans rien coûter.
  const queued = h.state.explore.queue[h.state.explore.queue.length - 1];
  assert.equal(explo.cancelScan(h.ctx, queued), true);
  assert.equal(h.state.explore.queue.indexOf(queued), -1);
  assert.equal(explo.cancelScan(h.ctx, queued), false, 'annuler deux fois ne fait rien');

  // Au bout de quelques cycles, la file s'est vidée toute seule.
  h.run(BALANCE.exploration.scanDays * 6);
  assert.equal(h.state.explore.queue.length, 0, 'la file doit se vider sans intervention');
  assert.ok(h.state.stats.scansLaunched >= 4, 'les sondes ont enchaîné les scans');
  assert.ok(game.dirty.size > 0 || game.allDirty, 'le rendu est prévenu des révélations');
});

test('exploration automatique : elle empile la frontière du territoire connu', () => {
  const h = createSimHarness({ seed: 119, init: (R) => { R.discovered.fill(0); R.discovered[0] = 1; } });
  h.state.resources.energy = 100000;
  h.state.resources.materials = 100000;
  h.state.explore.autoExplore = true;

  const before = h.state.stats.scansLaunched;
  h.run(BALANCE.exploration.scanDays * 3);
  assert.ok(h.state.stats.scansLaunched > before, 'des scans partent sans ordre du joueur');

  let discovered = 0;
  for (let i = 0; i < h.regions.count; i++) if (h.regions.discovered[i]) discovered++;
  assert.ok(discovered > 1, `la carte doit s'étendre toute seule (${discovered} secteurs)`);
  // Elle reste bornée : jamais plus que la profondeur de file configurée.
  assert.ok(h.state.explore.queue.length <= BALANCE.exploration.autoQueueDepth);
});

/* ===================================================================== */
/*  9. Victoire                                                          */
/* ===================================================================== */

test('VictorySystem.report retourne 8 lignes cohérentes', () => {
  const h = createSimHarness({ seed: 19 });
  const victory = h.systems.find((s) => s.constructor.name === 'VictorySystem');
  const rows = victory.report(h.state);

  assert.equal(rows.length, 8);
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['temperature', 'pressure', 'oxygen', 'waterCoverage',
    'biomass', 'population', 'stability', 'drift']);
  for (const r of rows) {
    assert.equal(typeof r.label, 'string');
    assert.ok(r.label.length > 0);
    assert.ok(Number.isFinite(r.value), `valeur non finie pour ${r.key}`);
    assert.ok(Number.isFinite(r.target));
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(r.progress >= 0 && r.progress <= 1);
    assert.equal(typeof r.format, 'string');
  }
  // Au départ, seule la stabilité initiale est déjà au niveau requis.
  assert.ok(rows.some((r) => !r.ok), 'la victoire n’est pas acquise au départ');
  assert.equal(rows.find((r) => r.key === 'temperature').ok, false);
  assert.equal(rows.find((r) => r.key === 'biomass').ok, false);
});

test('victoire déclenchée après sustainDays et une seule fois', () => {
  const h = createSimHarness({ seed: 20 });
  const g = h.state.globals;
  const victory = h.systems.find((s) => s.constructor.name === 'VictorySystem');
  // On teste VictorySystem SEUL : les autres systèmes recalculeraient les
  // globales à chaque tick et effaceraient les conditions forcées.
  const vctx = { game: h.game, state: h.state, regions: h.regions, bus: h.game.bus, dt: 1 };
  /* ADAPTÉ AUX OBJECTIFS RESSERRÉS (BALANCE.victory) : les anciens chiffres
     (biomasse 60, 30 000 habitants) sont désormais SOUS les seuils exigés.
     On force donc un monde confortablement au-dessus de chaque cible, ce que
     ce test veut vraiment vérifier : le décompte des `sustainDays`. */
  const win = () => {
    g.temperature = 14; g.pressure = 90; g.oxygen = 24;
    g.waterCoverage = 0.4; g.biomass = 80; g.population = 60000; g.stability = 96;
  };

  for (let d = 0; d < BALANCE.victory.sustainDays - 5; d++) { win(); victory.tick(vctx); }
  assert.equal(h.state.progress.victory, false, 'pas encore gagné');
  assert.ok(h.state.progress.sustained > BALANCE.victory.sustainDays / 2);

  for (let d = 0; d < 20; d++) { win(); victory.tick(vctx); }
  assert.equal(h.state.progress.victory, true);
  assert.ok(h.state.progress.victoryAt != null);
  assert.equal(h.events.filter((e) => e.type === 'victory').length, 1,
    'l’événement victoire ne doit être émis qu’une fois');

  // Perdre une condition remet le compteur à zéro et avertit le joueur.
  h.state.progress.sustained = BALANCE.victory.sustainDays * 0.75;
  g.oxygen = 2;
  victory.tick(vctx);
  assert.equal(h.state.progress.sustained, 0, 'le compteur repart de zéro');
  assert.ok(h.events.some((e) => e.type === 'notify' && /Stabilisation interrompue/.test(e.text)));

  const rows = victory.report(h.state);
  assert.equal(rows.length, 8);
});

/* ===================================================================== */
/*  11. MODÈLE ATMOSPHÉRIQUE EN PRESSIONS PARTIELLES                     */
/* ===================================================================== */

/** Raccourci : la loi fondamentale du modèle, vérifiable à tout instant. */
function assertAtmosphereCoherent(g, where = '') {
  assert.ok(Number.isFinite(g.pCO2) && Number.isFinite(g.pO2) && Number.isFinite(g.pInert),
    `pressions partielles non finies ${where}`);
  assert.ok(g.pCO2 >= 0 && g.pO2 >= 0 && g.pInert >= 0,
    `pression partielle négative ${where} : ${g.pCO2}/${g.pO2}/${g.pInert}`);
  assert.ok(Math.abs(g.pressure - (g.pCO2 + g.pO2 + g.pInert)) < 1e-6,
    `pressure ≠ pCO2+pO2+pInert ${where} : ${g.pressure} vs ${g.pCO2 + g.pO2 + g.pInert}`);
  assert.ok(g.co2 + g.oxygen <= 100.01,
    `co2 + oxygen = ${g.co2 + g.oxygen} > 100 ${where}`);
  assert.ok(g.co2 >= 0 && g.oxygen >= 0, `pourcentage négatif ${where}`);
}

test('l’état initial dérive les pressions partielles de BALANCE.start.globals', () => {
  const h = createSimHarness({ seed: 30 });
  const g = h.state.globals;
  const S = BALANCE.start.globals;
  assert.ok(Math.abs(g.pCO2 - S.pressure * S.co2 / 100) < 1e-6, 'pCO2 initial');
  assert.ok(Math.abs(g.pO2 - S.pressure * S.oxygen / 100) < 1e-6, 'pO2 initial');
  assertAtmosphereCoherent(g, 'au démarrage');
  // Rétrocompatibilité : un état sans pressions partielles (ancienne
  // sauvegarde) doit être reconstruit sans casser la composition affichée.
  delete g.pCO2; delete g.pO2; delete g.pInert;
  g.pressure = 50; g.co2 = 40; g.oxygen = 10;
  const climate = h.systems.find((x) => x.constructor.name === 'ClimateSystem');
  climate.reset(h.ctx);
  assert.ok(Math.abs(g.pCO2 - 20) < 1e-6, `pCO2 reconstruit : ${g.pCO2}`);
  assert.ok(Math.abs(g.pO2 - 5) < 1e-6, `pO2 reconstruit : ${g.pO2}`);
  assert.ok(Math.abs(g.pInert - 25) < 1e-6, `pInert reconstruit : ${g.pInert}`);
  assertAtmosphereCoherent(g, 'après migration');
});

test('20 000 jours de conversions : co2 + oxygen ≤ 100 à TOUT instant', () => {
  const h = createSimHarness({ seed: 31 });
  h.state.tech.unlocked.push('metallurgy', 'geothermal_tap', 'greenhouse_gases',
    'polar_engineering', 'atmospheric_engineering', 'carbon_capture', 'climate_control',
    'exobiology', 'pioneer_organisms', 'forestation', 'ecosystems', 'orbital_survey',
    'orbital_infrastructure', 'colonization', 'terraform_mastery');
  h.refreshTech();
  // Une flotte volontairement DÉMESURÉE : c'est le pire cas pour le modèle.
  for (let i = 0; i < 12; i++) h.addBuilding('fusion', i);
  for (let i = 0; i < 20; i++) h.addBuilding('ghg_factory', i * 2 + 1);
  for (let i = 0; i < 20; i++) h.addBuilding('atmo_processor', i * 2 + 2);
  for (let i = 0; i < 20; i++) h.addBuilding('o2_generator', i * 3 + 5);
  for (let i = 0; i < 8; i++) h.addBuilding('orbital_mirror', i);
  for (let i = 0; i < 10; i++) h.addBuilding('biodome', i * 5 + 3);
  h.state.resources.energy = 100000;
  h.state.resources.water = 100000;

  let worst = 0, day = 0;
  h.run(20000, (state) => {
    day += 1;
    const g = state.globals;
    assertAtmosphereCoherent(g, `au jour ${day}`);
    worst = Math.max(worst, g.co2 + g.oxygen);
  });
  assert.ok(worst <= 100.01, `pire somme observée : ${worst}`);
  // Et la pression ne doit jamais avoir tapé le plafond de sécurité.
  assert.ok(h.state.globals.pressure < BALANCE.atmosphere.maxPressure - 0.01,
    `la pression sature (${h.state.globals.pressure} kPa)`);
});

test('craquer du CO₂ en O₂ ne crée pas de matière et s’arrête à sec', () => {
  // On isole le ClimateSystem : un accumulateur fabriqué à la main permet de
  // ne tester QUE la conversion, sans les autres sources de gaz.
  const h = createSimHarness({ seed: 32, w: 4, h: 1 });
  const climate = h.systems.find((x) => x.constructor.name === 'ClimateSystem');
  const g = h.state.globals;

  const only = (oxygenRate) => ({
    produce: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
    consume: { energy: 0, materials: 0, science: 0, biomass: 0, water: 0 },
    global: { co2: 0, pressure: 0, oxygen: oxygenRate, temperature: 0, stability: 0, insolation: 0 },
    capacity: { energy: 0, materials: 0, water: 0 },
    staticGlobal: { insolation: 0 },
    dampening: 0, localHeat: null,
    contributions: { energy: [] },
  });

  // Atmosphère de départ maîtrisée, sans biomasse (pas de photosynthèse) et
  // sans glace (pas de sublimation) : la conversion est le seul mécanisme.
  for (let i = 0; i < h.regions.count; i++) { h.regions.ice[i] = 0; h.regions.vegetation[i] = 0; }
  g.biomass = 0;
  g.pCO2 = 20; g.pO2 = 1; g.pInert = 30;

  const ctx = { ...h.ctx, dt: 1, acc: only(0.5) };
  const before = g.pCO2 + g.pO2;
  climate.tick(ctx);
  const after = g.pCO2 + g.pO2;
  // Conservation stricte : la fuite atmosphérique est le seul autre terme, et
  // elle est proportionnelle (donc minuscule sur un jour).
  assert.ok(Math.abs(after - before) < before * BALANCE.atmosphere.leak * 2,
    `la conversion doit conserver la matière (${before} → ${after})`);
  assert.ok(g.pO2 > 1.4, `l’O₂ doit avoir gagné ~0,5 kPa (${g.pO2})`);
  assert.ok(g.pCO2 < 19.6, `le CO₂ doit avoir perdu autant (${g.pCO2})`);
  assertAtmosphereCoherent(g, 'après conversion');

  // À sec : on demande à craquer bien plus de CO₂ qu'il n'en reste.
  g.pCO2 = 0.4; g.pO2 = 5; g.pInert = 30;
  const sum0 = g.pCO2 + g.pO2;
  climate.tick({ ...h.ctx, dt: 1, acc: only(50) });
  assert.ok(g.pCO2 >= 0, `pCO2 négatif : ${g.pCO2}`);
  assert.ok(g.pCO2 < 0.001, `le CO₂ doit être épuisé, pas dépassé : ${g.pCO2}`);
  assert.ok(g.pO2 <= sum0 + 1e-6, `l’O₂ ne doit pas dépasser le stock total (${g.pO2} > ${sum0})`);
  assertAtmosphereCoherent(g, 'à sec');
});

/* ===================================================================== */
/*  12. MIROIRS ORBITAUX : UN NIVEAU, PAS UN CUMUL                       */
/* ===================================================================== */

test('les miroirs orbitaux sont réversibles : les démonter ramène insolation à 1', () => {
  const h = createSimHarness({ seed: 33 });
  h.state.resources.energy = 10000;
  assert.equal(h.state.globals.insolation, 1, 'aucun miroir → ensoleillement nominal');

  for (let i = 0; i < 6; i++) h.addBuilding('orbital_mirror', i);
  h.run(30);
  const withMirrors = h.state.globals.insolation;
  assert.ok(withMirrors > 1.2, `6 miroirs doivent éclairer davantage (${withMirrors})`);

  // Le niveau ne DÉRIVE PAS avec le temps : c'est un niveau, pas un taux.
  // Sur 10 ans, EventSystem peut détruire ou mettre en panne des miroirs :
  // l'ensoleillement doit alors valoir EXACTEMENT 1 + (miroirs actifs) × pas,
  // ni plus (accumulation) ni moins.
  const step = BUILDINGS.orbital_mirror.globalStatic.insolation;
  h.run(3650);
  h.state.buildings.forEach((b) => { b.downtime = 0; });
  h.run(1);
  const alive = h.state.buildings.filter((b) => b.type === 'orbital_mirror').length;
  assert.ok(Math.abs(h.state.globals.insolation - (1 + alive * step)) < 1e-6,
    `l’ensoleillement ne doit pas s’accumuler : ${alive} miroirs → ${h.state.globals.insolation}`);
  assert.ok(h.state.globals.insolation <= withMirrors + 1e-9,
    'il ne doit jamais dépasser le niveau posé par le joueur');
  assert.ok(h.state.globals.insolation <= BALANCE.climate.maxInsolation);

  // Le joueur démonte tout : on doit revenir exactement à 1 dès le tick suivant.
  h.state.buildings = h.state.buildings.filter((b) => b.type !== 'orbital_mirror');
  h.run(1);
  assert.equal(h.state.globals.insolation, 1,
    `démonter tous les miroirs doit ramener l’ensoleillement à 1 (${h.state.globals.insolation})`);

  // Et la planète doit REFROIDIR : la surchauffe n'est pas irréversible.
  const eqHot = (() => {
    for (let i = 0; i < 6; i++) h.addBuilding('orbital_mirror', i);
    h.run(5);
    return h.state.globals.equilibrium;
  })();
  h.state.buildings = h.state.buildings.filter((b) => b.type !== 'orbital_mirror');
  h.run(5);
  assert.ok(h.state.globals.equilibrium < eqHot - 5,
    `l’équilibre radiatif doit redescendre (${eqHot} → ${h.state.globals.equilibrium})`);

  // Une ligne de contribution explique le phénomène au joueur.
  for (let i = 0; i < 3; i++) h.addBuilding('orbital_mirror', i);
  h.run(2);
  const rows = h.state.contributions.temperature;
  const mirror = rows.find((r) => r.label === 'Miroirs orbitaux');
  assert.ok(mirror, 'la ligne « Miroirs orbitaux » doit exister');
  assert.ok(mirror.value > 0, `elle doit être positive (${mirror && mirror.value})`);
});

test('un bâtiment inactif ne contribue pas à staticGlobal', () => {
  const h = createSimHarness({ seed: 34 });
  h.state.resources.energy = 10000;
  for (let i = 0; i < 4; i++) h.addBuilding('orbital_mirror', i);
  h.run(2);
  const full = h.ctx.acc.staticGlobal.insolation;
  assert.ok(full > 0, 'quatre miroirs actifs contribuent');

  // Panne (downtime > 0) sur la moitié de la flotte.
  h.state.buildings.forEach((b, i) => { if (b.type === 'orbital_mirror' && i % 2 === 0) b.downtime = 100; });
  h.run(1);
  const half = h.ctx.acc.staticGlobal.insolation;
  assert.ok(Math.abs(half - full / 2) < 1e-9,
    `deux miroirs en panne = moitié moins d’ensoleillement (${full} → ${half})`);
  assert.ok(h.state.globals.insolation < 1 + full,
    'l’ensoleillement doit suivre la baisse');

  // Toute la flotte en panne : plus aucune contribution.
  h.state.buildings.forEach((b) => { if (b.type === 'orbital_mirror') b.downtime = 100; });
  h.run(1);
  assert.equal(h.ctx.acc.staticGlobal.insolation, 0, 'aucun miroir actif → aucun niveau');
  assert.equal(h.state.globals.insolation, 1);
});

/* ===================================================================== */
/*  13. Les colonies survivent quand la région les nourrit               */
/* ===================================================================== */

test('une colonie installée sur une région verte et humide croît au lieu de s’éteindre', () => {
  const h = createSimHarness({
    seed: 35, w: 8, h: 1,
    init: (R, state) => {
      for (let i = 0; i < R.count; i++) {
        R.elevation[i] = BALANCE.planet.seaLevel - 0.43;
        // Assez d'eau pour abreuver, pas assez pour noyer la végétation
        // (au-delà d'une demi-capacité de bassin, la cellule devient un océan).
        R.ice[i] = 0; R.water[i] = 0.15; R.moisture[i] = 0.8;
        R.vegetation[i] = 0.9; R.fertilityBase[i] = 1; R.temperature[i] = 15;
      }
      state.globals.temperature = 15;
      state.globals.pressure = 80;
      state.globals.co2 = 20;
      state.globals.oxygen = 20;
      state.globals.biomass = 60;
    },
  });
  // Ce test porte sur la démographie : on retire EventSystem pour qu'un
  // séisme aléatoire ne vienne pas raser la colonie au milieu de la mesure.
  const ev = h.systems.findIndex((x) => x.constructor.name === 'EventSystem');
  h.systems.splice(ev, 1);
  for (let k = 0; k < 5; k++) h.addBuilding('orbital_mirror', k);   // maintient ~15 °C
  h.addBuilding('colony', 2);
  h.state.resources.energy = 100000;
  // Stocks planétaires VIDES : la colonie ne doit compter que sur sa région.
  h.state.resources.water = 0;
  h.state.resources.biomass = 0;
  h.run(2000);

  const pop = h.state.globals.population;
  assert.ok(pop > BALANCE.colony.seedPopulation,
    `la colonie doit croître même sans stocks planétaires (${pop} habitants)`);
  assert.ok(Number.isFinite(pop));
  // Et l'agriculture locale doit alimenter la réserve de vivres.
  assert.ok(h.state.resources.biomass > 0, 'la colonie doit produire ses vivres');
});

/* ===================================================================== */
/*  10. Performance                                                      */
/* ===================================================================== */

test('un tick complet à 642 régions reste rapide', () => {
  const regions = makeFakeRegions({ w: 32, h: 21 });   // 672 régions
  const h = createSimHarness({ seed: 21, regions });
  for (let i = 0; i < 40; i++) h.addBuilding('mine', i * 7 % regions.count);
  for (let i = 0; i < 40; i++) h.addBuilding('solar', (i * 11 + 3) % regions.count);

  h.run(200);   // chauffe du JIT
  const t0 = process.hrtime.bigint();
  h.run(1000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  assert.ok(ms < 5, `tick trop lent : ${ms.toFixed(3)} ms`);
  // Indicatif : la cible de production est 1,5 ms/tick.
  console.log(`   → ${ms.toFixed(3)} ms par tick (${regions.count} régions)`);
});

/* ===================================================================== */
/*  14. RECHERCHE PROGRESSIVE                                            */
/* ===================================================================== */

/**
 * La recherche n'est plus un achat instantané : `Game.startResearch` ENGAGE le
 * laboratoire, `ResearchSystem` verse la science jour après jour, et
 * `Game.cancelResearch` rend la moitié des points investis. Ces tests portent
 * sur le contrat exact décrit dans docs/CONTRACTS.md.
 */

/** Le vrai `Game` touche localStorage via l'autosauvegarde : on le neutralise. */
function withFakeStorage(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prev = globalThis.localStorage;
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  globalThis.btoa = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
  globalThis.atob = globalThis.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));
  try { return fn(); } finally { if (had) globalThis.localStorage = prev; else delete globalThis.localStorage; }
}

test('startResearch engage le laboratoire au lieu d’acheter la technologie', async () => {
  const { Game } = await import('../src/core/Game.js');
  withFakeStorage(() => {
    const g = new Game();
    g.newGame({ seed: 4242 });
    const started = [];
    const done = [];
    g.bus.on('research:started', (p) => started.push(p.techId));
    g.bus.on('research:completed', (p) => done.push(p.techId));

    // Le stock de science n'est PLUS une condition : seuls comptent les
    // prérequis et le fait que le laboratoire soit libre.
    g.state.resources.science = 0;
    assert.equal(g.canResearch('orbital_survey').ok, true, 'aucun stock requis pour s’engager');
    assert.equal(g.startResearch('orbital_survey'), true);
    assert.equal(g.state.tech.current, 'orbital_survey');
    assert.equal(g.state.tech.progress, 0);
    assert.deepEqual(started, ['orbital_survey']);
    assert.equal(done.length, 0, 'la recherche ne se termine pas au lancement');
    assert.equal(g.state.tech.unlocked.includes('orbital_survey'), false);

    // Un seul axe à la fois : c'est là qu'est l'arbitrage.
    const busy = g.canResearch('metallurgy');
    assert.equal(busy.ok, false);
    assert.match(busy.reason, /Laboratoire occupé/);
    assert.equal(g.canResearch('fusion').ok, false, 'prérequis manquants');

    // La science produite alimente la technologie en cours.
    for (let d = 0; d < 200; d++) g._tick(1, d);
    assert.ok(g.state.tech.progress > 0, `la progression doit monter (${g.state.tech.progress})`);
    const eta = g.researchEta();
    assert.ok(eta === null || (Number.isFinite(eta) && eta >= 0), `ETA invalide : ${eta}`);

    // Jusqu'à l'achèvement, qui n'arrive qu'à la FIN.
    for (let d = 0; d < 20000 && !g.state.tech.unlocked.includes('orbital_survey'); d++) g._tick(1, d);
    assert.equal(g.state.tech.unlocked.includes('orbital_survey'), true, 'la recherche doit aboutir');
    assert.deepEqual(done, ['orbital_survey']);
    assert.equal(g.state.tech.current, null, 'le laboratoire se libère');
    assert.equal(g.state.tech.progress, 0);
    assert.equal(g.state.stats.researched, 1);
    // Et l'effet passif est bien appliqué (une sonde de plus).
    assert.equal(g.techEffects.probes, 1);
  });
});

test('cancelResearch rembourse la moitié des points investis', async () => {
  const { Game } = await import('../src/core/Game.js');
  withFakeStorage(() => {
    const g = new Game();
    g.newGame({ seed: 4243 });
    assert.equal(g.cancelResearch(), false, 'rien à annuler au départ');

    g.startResearch('metallurgy');
    for (let d = 0; d < 400; d++) g._tick(1, d);
    const invested = g.state.tech.progress;
    assert.ok(invested > 0);
    const stock = g.state.resources.science;

    assert.equal(g.cancelResearch(), true);
    assert.equal(g.state.tech.current, null);
    assert.equal(g.state.tech.progress, 0);
    assert.ok(Math.abs(g.state.resources.science - (stock + invested * BALANCE.research.refund)) < 1e-6,
      'la moitié des points doit revenir au stock');
    assert.equal(g.state.tech.unlocked.includes('metallurgy'), false);

    // Le laboratoire est de nouveau libre : on peut changer d'axe.
    assert.equal(g.canResearch('exobiology').ok, true);
  });
});

test('la file de scans et l’exploration automatique sont pilotables depuis Game', async () => {
  const { Game } = await import('../src/core/Game.js');
  withFakeStorage(() => {
    const g = new Game();
    g.newGame({ seed: 4244 });
    g.debug.addResources(50000);

    const unknown = [];
    for (let i = 0; i < g.regions.count && unknown.length < 8; i++) {
      if (!g.regions.discovered[i]) unknown.push(i);
    }
    for (const i of unknown) assert.equal(g.scanRegion(i), true, 'toute cible valide est acceptée');
    const pending = g.state.explore.queue.length + g.state.explore.scanning.length;
    assert.equal(pending, unknown.length, 'lancés ou mis en file, aucun n’est perdu');
    assert.equal(g.state.explore.probesFree, 0);

    assert.equal(g.cancelScan(unknown[unknown.length - 1]), true);
    assert.equal(g.state.explore.queue.length + g.state.explore.scanning.length, pending - 1);

    assert.equal(g.autoExplore, false);
    g.setAutoExplore(true);
    assert.equal(g.autoExplore, true);
    g.setAutoExplore(false);
    assert.equal(g.autoExplore, false);
  });
});

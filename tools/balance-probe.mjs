/**
 * Sonde d'équilibrage : joue une partie complète en accéléré, sans navigateur,
 * avec un « joueur automatique » raisonnable, et trace l'arc de la partie.
 *
 *   node tools/balance-probe.mjs [seed] [annees]
 *   node tools/balance-probe.mjs --multi [n] [annees]   (n seeds, résumé compact)
 *   node tools/balance-probe.mjs --bad   [n] [annees]   (joueur imprudent : doit perdre)
 *   node tools/balance-probe.mjs --ablate [seed] [annees]
 *        retire un bâtiment (ou une branche technologique) à la fois et
 *        compare la date de victoire : c'est le test « ce contenu sert-il à
 *        quelque chose ? ». Un écart nul = du décor, à corriger ou à supprimer.
 *
 * Ce n'est PAS un test de régression : c'est un outil de game design pour
 * répondre à « la partie est-elle gagnable, et en combien de temps ? ».
 *
 * Le joueur automatique est volontairement un joueur CORRECT, pas parfait :
 * il construit dans l'ordre où les leviers deviennent utiles ET il DÉMONTE
 * (miroirs orbitaux, usines à gaz, générateurs d'oxygène) quand il dépasse sa
 * cible. C'est cette capacité à revenir en arrière qui prouve que la
 * surchauffe n'est plus irréversible.
 */
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const { Game } = await import('../src/core/Game.js');
const { BALANCE } = await import('../src/data/balance.js');
const { TECH_LIST } = await import('../src/data/technologies.js');

/* Ordre de recherche d'un joueur qui vise la victoire. */
const PLAN = [
  'orbital_survey', 'geothermal_tap', 'metallurgy', 'greenhouse_gases', 'exobiology',
  'energy_grid', 'polar_engineering', 'automation', 'pioneer_organisms',
  'atmospheric_engineering', 'orbital_infrastructure', 'forestation',
  'carbon_capture', 'fusion', 'colonization', 'climate_control',
  'ecosystems', 'deep_drilling', 'terraform_mastery',
];

/** Fourchette de température visée par le joueur automatique (°C). */
const TARGET_T = { low: 4, high: 20, panic: 24 };

/**
 * Le joueur automatique n'explore plus TOUTE la planète : un scan révèle une
 * zone entière, et les plafonds de bâtiments sont serrés. Il cartographie donc
 * ce dont il a besoin (une bonne moitié du globe pour avoir le choix des
 * sites), en visant en priorité les anomalies et les zones minéralisées, puis
 * il laisse l'exploration automatique finir le travail.
 */
const EXPLORE_TARGET_RATIO = 0.55;

/**
 * Plafonds que s'impose le joueur automatique, type par type. Ils suivent les
 * `maxTotal` de buildings.js : le but est une partie gagnée en 60 à 90
 * bâtiments, pas en 265.
 */
const WANT = {
  mine: 6, refinery: 3, depot: 3, solar: 6, geothermal: 5, fusion: 3,
  science_station: 5, ice_extractor: 6, ghg_factory: 6, atmo_processor: 7,
  o2_generator: 6, polar_melter: 4, orbital_mirror: 8, climate_stabilizer: 3,
  biodome: 6, seeder: 5, colony: 6,
};

/**
 * Joue une partie et retourne son historique + son verdict.
 */
function playGame(seed, years, reckless = false, ablate = null) {
  /** Contenu retiré pour cette partie (sonde d'ablation). */
  const banned = new Set(ablate || []);
  const game = new Game();
  game.newGame({ seed });
  const R = game.regions, S = game.state;

  const ranked = (scoreFn) => {
    const out = [];
    for (let i = 0; i < R.count; i++) if (R.discovered[i]) out.push([i, scoreFn(i)]);
    out.sort((a, b) => b[1] - a[1]);
    return out.map((x) => x[0]);
  };

  function tryBuildMany(type, wanted, scoreFn) {
    if (banned.has(type)) return 0;
    let built = 0;
    for (const i of ranked(scoreFn)) {
      if (built >= wanted) break;
      if (game.canBuild(type, i).ok && game.build(type, i)) built++;
    }
    return built;
  }

  const count = (t) => S.buildings.filter((b) => b.type === t).length;

  /** Démonte `n` bâtiments du type donné (les plus récents d'abord). */
  function demolishSome(type, n) {
    const list = S.buildings.filter((b) => b.type === type);
    let done = 0;
    for (let k = list.length - 1; k >= 0 && done < n; k--) {
      if (game.demolish(list[k].id)) done++;
    }
    return done;
  }

  /** Fraction du globe déjà cartographiée. */
  function discoveredRatio() {
    let n = 0;
    for (let i = 0; i < R.count; i++) if (R.discovered[i]) n++;
    return n / R.count;
  }

  /**
   * Reconnaissance : on remplit la file de scans avec les meilleures cibles
   * inconnues encore accrochées au territoire connu (anomalie > minerai >
   * géothermie), et on s'arrête dès qu'on en sait assez.
   */
  function explore() {
    const ex = S.explore;
    if (discoveredRatio() >= EXPLORE_TARGET_RATIO) return;
    if (ex.queue.length + ex.scanning.length >= 3) return;

    let best = -1, bestScore = -1;
    for (let i = 0; i < R.count; i++) {
      if (R.discovered[i]) continue;
      const neigh = R.neighbors(i);
      let known = 0;
      for (let j = 0; j < neigh.length; j++) if (R.discovered[neigh[j]]) known++;
      if (!known) continue;                       // on n'explore pas au hasard
      const score = known * 0.5 + R.anomaly[i] * 4 + R.minerals[i] * 2 + R.geothermal[i];
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) game.scanRegion(best);
  }

  /* Le joueur agit une fois tous les 20 jours. */
  function play() {
    const g = S.globals;

    explore();
    // Recherche PROGRESSIVE : on ne peut en mener qu'une à la fois, on
    // enchaîne donc le plan dès que le laboratoire se libère.
    if (!S.tech.current) {
      for (const id of PLAN) {
        if (banned.has(id)) continue;
        if (game.canResearch(id).ok) { game.startResearch(id); break; }
      }
    }

    // Infrastructure de base, dimensionnée sur la demande.
    // L'énergie est devenue réellement rare : on garde une marge confortable
    // et on empile les sources dès qu'elle se réduit.
    const netEnergy = S.power.production - S.power.consumption;
    if (netEnergy < 30) {
      if (!tryBuildMany('fusion', 1, () => 1)) {
        if (!tryBuildMany('geothermal', 1, (i) => R.geothermal[i])) {
          tryBuildMany('solar', 1, (i) => 1 - Math.abs(R.latitude[i]));
        }
      }
    }
    if (count('mine') < WANT.mine) tryBuildMany('mine', 1, (i) => R.minerals[i]);
    if (count('science_station') < WANT.science_station) tryBuildMany('science_station', 1, (i) => R.anomaly[i] * 2 + R.radiation[i]);
    // Sans dépôt, le stock de matériaux plafonne trop bas pour épargner une
    // mégastructure : c'est désormais un investissement prioritaire.
    if (count('depot') < WANT.depot) tryBuildMany('depot', 1, (i) => -i);
    // L'eau se gère à la demande : on ouvre une station dès que le bilan
    // hydrique se dégrade (c'est exactement ce que fait un joueur attentif).
    const waterScore = (i) => R.ice[i] + R.water[i] / BALANCE.water.basinDepth + R.moisture[i];
    if (count('ice_extractor') < WANT.ice_extractor && (S.flux.water <= 0.5 || S.resources.water < 150)) {
      tryBuildMany('ice_extractor', 1, waterScore);
    }
    // La raffinerie vaut d'autant plus qu'elle est entourée de mines.
    if (count('refinery') < WANT.refinery) {
      tryBuildMany('refinery', 1, (i) => {
        let n = 0;
        const neigh = R.neighbors(i);
        for (const b of S.buildings) if (b.type === 'mine' && (b.region === i || neigh.includes(b.region))) n++;
        return n * 2 + R.minerals[i];
      });
    }

    /* --- JOUEUR IMPRUDENT : mode `--bad` -------------------------------
       Il empile TOUT ce qui réchauffe, tout de suite, et ne démonte jamais.
       C'est la démonstration que la partie est perdable — et pourquoi. */
    if (reckless) {
      // Il explore à l'aveugle, sans jamais viser : la file se remplit toute
      // seule et il ne regarde ni anomalies ni gisements.
      game.setAutoExplore(true);
      tryBuildMany('ghg_factory', 2, (i) => 1 - R.pollution[i]);
      tryBuildMany('polar_melter', 2, (i) => R.ice[i]);
      tryBuildMany('orbital_mirror', 2, (i) => -i);
      tryBuildMany('atmo_processor', 2, (i) => R.geothermal[i]);
      if (g.pressure > 25) tryBuildMany('o2_generator', 2, (i) => -i);
      if (g.temperature > -22) tryBuildMany('biodome', 2, (i) => R.habitability[i]);
      if (g.biomass > 3) tryBuildMany('seeder', 2, (i) => R.vegetation[i]);
      tryBuildMany('colony', 1, (i) => R.habitability[i]);
      return;
    }

    /* --- THERMOSTAT ---------------------------------------------------- */
    // Trop froid : on empile les leviers de chauffage.
    if (g.temperature < TARGET_T.low) {
      if (count('ghg_factory') < WANT.ghg_factory) tryBuildMany('ghg_factory', 1, (i) => 1 - R.pollution[i]);
      if (count('polar_melter') < WANT.polar_melter) tryBuildMany('polar_melter', 1, (i) => R.ice[i]);
      if (count('orbital_mirror') < WANT.orbital_mirror && g.temperature < TARGET_T.low - 2) {
        tryBuildMany('orbital_mirror', 1, (i) => -i);
      }
    }
    // Trop chaud : on démonte, dans l'ordre inverse de la mise en service.
    // C'est le test grandeur nature de la réversibilité des miroirs.
    if (g.temperature > TARGET_T.high || (g.dTemperature > 1.5 && g.temperature > TARGET_T.low)) {
      if (!demolishSome('orbital_mirror', 1)) {
        if (!demolishSome('ghg_factory', 1)) demolishSome('polar_melter', 1);
      }
    }
    if (g.temperature > TARGET_T.panic) {
      demolishSome('orbital_mirror', 2);
      demolishSome('ghg_factory', 2);
    }

    /* --- PRESSION ------------------------------------------------------- */
    if (g.pressure < 88 && count('atmo_processor') < WANT.atmo_processor) {
      tryBuildMany('atmo_processor', 1, (i) => R.geothermal[i]);
    }

    /* --- OXYGÈNE : après la biosphère, et sans assécher tout le CO₂ ----- */
    if (g.pressure > 30 && g.oxygen < 24 && g.co2 > 12 && count('o2_generator') < WANT.o2_generator) {
      tryBuildMany('o2_generator', 1, (i) => -i);
    }
    // Le craquage a mangé trop de CO₂ : on lève le pied (sinon la planète gèle).
    if (g.co2 < 7 && count('o2_generator') > 0) demolishSome('o2_generator', 2);

    /* --- BIOSPHÈRE ------------------------------------------------------ */
    if (g.temperature > -22 && count('biodome') < WANT.biodome) {
      tryBuildMany('biodome', 1, (i) => R.habitability[i] * 2 + R.moisture[i]);
    }
    if (g.biomass > 3 && count('seeder') < WANT.seeder) tryBuildMany('seeder', 1, (i) => R.vegetation[i]);

    /* --- STABILITÉ & COLONIES ------------------------------------------- */
    if (g.stability < 90 && count('climate_stabilizer') < WANT.climate_stabilizer) {
      tryBuildMany('climate_stabilizer', 1, (i) => -i);
    }
    // Une colonie se pose au bord de l'eau et sur du vert : c'est là qu'elle
    // se nourrit et s'abreuve toute seule.
    if (count('colony') < WANT.colony) {
      tryBuildMany('colony', 1, (i) => R.habitability[i] * 2 + R.vegetation[i]
        + Math.min(1, R.water[i] / BALANCE.water.basinDepth + R.moisture[i]));
    }
  }

  const days = years * 365;
  const marks = [];
  let victoryDay = null;
  /* Compteurs de DENSITÉ D'ACTION, relevés à l'instant exact de la victoire :
     c'est le nombre de gestes qu'a coûté la partie, la mesure que le test de
     jouabilité réclame (cible : < 80 scans, 60 à 90 bâtiments). */
  let atVictory = null;
  let maxT = -Infinity, minStab = Infinity, maxP = 0;
  /* PRESSION ÉCONOMIQUE — le rapport de jouabilité mesurait un stock de
     matériaux plein 92 % des jours et une énergie contrainte 2 % du temps :
     l'économie ne contraignait rien. On relève désormais les deux. */
  let daysFullMat = 0, daysTightPower = 0, daysCounted = 0;
  for (let d = 0; d < days; d++) {
    game._tick(1, d);
    if (d % 20 === 0) play();
    const g = S.globals;
    // On ne mesure que la partie RÉELLEMENT jouée : après la victoire, plus
    // rien n'est construit, le stock se remplit et la mesure n'a plus de sens.
    if (!S.progress.victory) {
      daysCounted++;
      if (S.capacity.materials > 0 && S.resources.materials >= S.capacity.materials - 1e-6) daysFullMat++;
      if ((S.power.satisfaction ?? 1) < 0.95) daysTightPower++;
    }
    if (g.temperature > maxT) maxT = g.temperature;
    if (g.stability < minStab) minStab = g.stability;
    if (g.pressure > maxP) maxP = g.pressure;
    if (d % 365 === 0) {
      marks.push({
        an: d / 365, T: g.temperature, P: g.pressure, O2: g.oxygen, CO2: g.co2,
        pCO2: g.pCO2, pO2: g.pO2, pInert: g.pInert,
        eau: g.waterCoverage * 100, bio: g.biomass, stab: g.stability, pop: g.population,
        ins: g.insolation, bat: S.buildings.length, tech: S.tech.unlocked.length,
        mir: S.buildings.filter((b) => b.type === 'orbital_mirror').length,
      });
    }
    if (S.progress.victory && victoryDay === null) {
      victoryDay = d;
      let discovered = 0;
      for (let i = 0; i < R.count; i++) if (R.discovered[i]) discovered++;
      atVictory = {
        buildings: S.buildings.length,
        built: S.stats.built,
        scans: S.stats.scansLaunched || 0,
        discovered,
        tech: S.tech.unlocked.length,
      };
    }
  }
  const economy = {
    fullMaterials: daysCounted ? daysFullMat / daysCounted : 0,
    tightPower: daysCounted ? daysTightPower / daysCounted : 0,
  };
  return { game, state: S, regions: R, marks, victoryDay, atVictory, maxT, minStab, maxP, economy };
}

/* ===================================================================== */
/*  CONTRÔLES DE COHÉRENCE                                               */
/* ===================================================================== */

function audit(run) {
  const g = run.state.globals;
  const A = BALANCE.atmosphere;
  const problems = [];
  for (const [k, v] of Object.entries(g)) {
    if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${k} non fini`);
  }
  if (g.co2 + g.oxygen > 100.01) problems.push(`co2+O2 = ${(g.co2 + g.oxygen).toFixed(2)} > 100`);
  if (Math.abs(g.pressure - (g.pCO2 + g.pO2 + g.pInert)) > 1e-6) problems.push('pressure ≠ pCO2+pO2+pInert');
  if (run.maxP >= A.maxPressure - 0.01) problems.push(`pression saturée (${run.maxP.toFixed(1)} kPa)`);
  if (g.pCO2 < 0 || g.pO2 < 0 || g.pInert < 0) problems.push('pression partielle négative');
  if (run.victoryDay !== null && g.population <= 0) problems.push('population nulle');
  return problems;
}

/* ===================================================================== */
/*  SORTIE                                                               */
/* ===================================================================== */

const f = (v, n = 1) => String(Number(v).toFixed(n)).padStart(7);

function printOne(seed, years, reckless = false) {
  const run = playGame(seed, years, reckless);
  const { state: S, regions: R, marks, victoryDay } = run;
  console.log(`\nSONDE D'ÉQUILIBRAGE — seed ${seed}, ${years} ans, ${R.count} régions\n`);
  console.log('  an       T°C     kPa     pCO2      pO2   pIner     O2%    CO2%    eau%     bio    stab      pop   insol mir  bât tech');
  console.log('  ' + '─'.repeat(126));
  for (const m of marks) {
    if (m.an % 5 !== 0 && m.an !== marks.length - 1) continue;
    console.log(`  ${String(m.an).padStart(3)} ${f(m.T)} ${f(m.P)} ${f(m.pCO2)} ${f(m.pO2)} ${f(m.pInert)} ${f(m.O2, 2)} ${f(m.CO2, 1)} ${f(m.eau, 1)} ${f(m.bio, 1)} ${f(m.stab)} ${String(Math.round(m.pop)).padStart(8)} ${f(m.ins, 2)} ${String(m.mir).padStart(3)} ${String(m.bat).padStart(4)} ${String(m.tech).padStart(4)}`);
  }

  console.log('\n  Conditions de victoire en fin de sonde :');
  for (const r of run.game.victoryReport()) {
    console.log(`   ${r.ok ? '✔' : '·'} ${String(r.label).padEnd(34)} ${String(Number(r.value).toFixed(2)).padStart(10)}   cible ${r.target}`);
  }
  console.log(`\n  Victoire : ${victoryDay !== null ? `an ${(victoryDay / 365).toFixed(1)}` : 'non atteinte'}`);
  if (run.atVictory) {
    const a = run.atVictory;
    console.log(`  À LA VICTOIRE — bâtiments : ${a.buildings} (posés : ${a.built}) · scans lancés : ${a.scans}`
      + ` · secteurs connus : ${a.discovered}/${R.count} · technologies : ${a.tech}/${TECH_LIST.length}`);
  }
  console.log(`  Pic de température : ${run.maxT.toFixed(1)} °C · creux de stabilité : ${run.minStab.toFixed(1)} · pic de pression : ${run.maxP.toFixed(1)} kPa`);
  console.log(`  Pression économique — stock de matériaux plein : ${(run.economy.fullMaterials * 100).toFixed(0)} % des jours`
    + ` · énergie contrainte (< 95 %) : ${(run.economy.tightPower * 100).toFixed(0)} % des jours`);
  console.log(`  Technologies : ${S.tech.unlocked.length}/${TECH_LIST.length} · bâtiments : ${S.buildings.length}`
    + ` · posés : ${S.stats.built} · scans : ${S.stats.scansLaunched || 0} · événements : ${S.stats.events}`);
  const problems = audit(run);
  console.log(problems.length ? `  ⚠ ANOMALIES : ${problems.join(' · ')}` : '  ✔ Aucune anomalie détectée.');
  console.log();
  return run;
}

function printMulti(n, years, reckless = false) {
  console.log(`\nSONDE MULTI-SEEDS — ${n} seeds, ${years} ans\n`);
  console.log('     seed   victoire     T°C     kPa     O2%    CO2%    eau%     bio    stab      pop  picT  bât scans anomalies');
  console.log('  ' + '─'.repeat(124));
  let wins = 0, inWindow = 0, inDensity = 0;
  const dens = [];
  const eco = [];
  for (let k = 0; k < n; k++) {
    const seed = 1000 + k * 7919;
    const run = playGame(seed, years, reckless);
    const g = run.state.globals;
    const v = run.victoryDay;
    if (v !== null) wins++;
    const year = v !== null ? v / 365 : null;
    if (year !== null && year >= 20 && year <= 45) inWindow++;
    const problems = audit(run);
    eco.push(run.economy);
    const a = run.atVictory;
    if (a) {
      dens.push(a);
      if (a.buildings >= 60 && a.buildings <= 90 && a.scans < 80) inDensity++;
    }
    const bat = a ? String(a.buildings).padStart(4) : '   —';
    const sc = a ? String(a.scans).padStart(5) : '    —';
    console.log(`  ${String(seed).padStart(7)} ${(year !== null ? `an ${year.toFixed(1)}` : '—').padStart(10)} ${f(g.temperature)} ${f(g.pressure)} ${f(g.oxygen, 2)} ${f(g.co2, 1)} ${f(g.waterCoverage * 100, 1)} ${f(g.biomass, 1)} ${f(g.stability)} ${String(Math.round(g.population)).padStart(8)} ${f(run.maxT, 0)} ${bat} ${sc} ${problems.length ? '⚠ ' + problems.join(' · ') : 'ok'}`);
  }
  const avg = (k) => dens.length ? (dens.reduce((a, b) => a + b[k], 0) / dens.length).toFixed(1) : '—';
  const avgEco = (k) => (eco.reduce((a, b) => a + b[k], 0) / Math.max(1, eco.length) * 100).toFixed(0);
  console.log(`\n  Victoires : ${wins}/${n} · dans la fenêtre an 20–45 : ${inWindow}/${n}`
    + ` · densité tenue (60–90 bât. et < 80 scans) : ${inDensity}/${n}`);
  console.log(`  Moyennes à la victoire — bâtiments : ${avg('buildings')} · scans : ${avg('scans')}`
    + ` · secteurs connus : ${avg('discovered')} · technologies : ${avg('tech')}`);
  console.log(`  Pression économique — matériaux au plafond : ${avgEco('fullMaterials')} % des jours`
    + ` · énergie contrainte : ${avgEco('tightPower')} % des jours\n`);
}

/* ===================================================================== */
/*  SONDE D'ABLATION — « ce contenu sert-il à quelque chose ? »          */
/* ===================================================================== */

/** Chaque scénario retire UN élément de contenu et rejoue la même partie. */
const ABLATIONS = [
  { label: 'référence', remove: [] },
  { label: 'sans dépôt logistique', remove: ['depot'] },
  { label: 'sans raffinerie', remove: ['refinery'] },
  { label: 'sans réacteur à fusion', remove: ['fusion'] },
  { label: 'sans centrale géothermique', remove: ['geothermal'] },
  { label: 'sans mine', remove: ['mine'] },
  { label: 'sans station scientifique', remove: ['science_station'] },
  { label: 'sans station de fonte polaire', remove: ['polar_melter'] },
  { label: 'sans stabilisateur climatique', remove: ['climate_stabilizer'] },
  { label: 'sans miroirs orbitaux', remove: ['orbital_mirror'] },
  { label: 'sans usines à gaz', remove: ['ghg_factory'] },
  { label: 'sans tours d’ensemencement', remove: ['seeder'] },
  { label: 'branche INDUSTRIE retirée', remove: ['metallurgy', 'automation', 'deep_drilling'] },
  { label: 'branche BIOLOGIE amputée (écosystèmes)', remove: ['ecosystems'] },
];

function printAblation(seed, years) {
  console.log(`\nSONDE D'ABLATION — seed ${seed}, ${years} ans`);
  console.log('  Un contenu dont le retrait ne change RIEN est du décor.\n');
  console.log('  scénario                                 victoire   bât  scans     T°C     bio      pop  écart');
  console.log('  ' + '─'.repeat(100));
  let ref = null;
  for (const a of ABLATIONS) {
    const run = playGame(seed, years, false, a.remove);
    const g = run.state.globals;
    const year = run.victoryDay !== null ? run.victoryDay / 365 : null;
    if (ref === null && year !== null) ref = year;
    const delta = year === null ? 'PERDU'
      : (ref === null ? '—' : (year - ref >= 0 ? '+' : '') + (year - ref).toFixed(1) + ' an');
    const bat = run.atVictory ? String(run.atVictory.buildings).padStart(4) : '   —';
    const sc = run.atVictory ? String(run.atVictory.scans).padStart(5) : '    —';
    console.log(`  ${a.label.padEnd(40)} ${(year !== null ? 'an ' + year.toFixed(1) : '—').padStart(9)}`
      + ` ${bat} ${sc} ${f(g.temperature)} ${f(g.biomass, 1)} ${String(Math.round(g.population)).padStart(8)}  ${delta}`);
  }
  console.log();
}

const arg0 = process.argv[2];
if (arg0 === '--ablate') {
  printAblation(Number(process.argv[3] ?? 20260904), Number(process.argv[4] ?? 60));
} else if (arg0 === '--multi') {
  printMulti(Number(process.argv[3] ?? 6), Number(process.argv[4] ?? 60));
} else if (arg0 === '--bad') {
  // Contre-épreuve : la même partie jouée sans discernement doit ÉCHOUER.
  printMulti(Number(process.argv[3] ?? 6), Number(process.argv[4] ?? 60), true);
} else {
  printOne(Number(arg0 ?? 20260904), Number(process.argv[3] ?? 60));
}

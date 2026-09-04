/**
 * Sonde d'équilibrage : joue une partie complète en accéléré, sans navigateur,
 * avec un « joueur automatique » raisonnable, et trace l'arc de la partie.
 *
 *   node tools/balance-probe.mjs [seed] [annees]
 *   node tools/balance-probe.mjs --multi [n] [annees]   (n seeds, résumé compact)
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
const TARGET_T = { low: 4, high: 22, panic: 27 };

/**
 * Joue une partie et retourne son historique + son verdict.
 */
function playGame(seed, years, reckless = false) {
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

  /* Le joueur agit une fois tous les 20 jours. */
  function play() {
    const g = S.globals;

    // Exploration continue.
    for (let i = 0; i < R.count; i++) {
      if (!R.discovered[i] && S.explore.scanning.length < 4) game.scanRegion(i);
    }
    // Recherche dès que la science le permet.
    for (const id of PLAN) if (game.canResearch(id).ok) { game.startResearch(id); break; }

    // Infrastructure de base, dimensionnée sur la demande.
    const netEnergy = S.power.production - S.power.consumption;
    if (netEnergy < 14) {
      if (!tryBuildMany('fusion', 1, () => 1)) {
        if (!tryBuildMany('geothermal', 1, (i) => R.geothermal[i])) {
          tryBuildMany('solar', 2, (i) => 1 - Math.abs(R.latitude[i]));
        }
      }
    }
    if (count('mine') < 16) tryBuildMany('mine', 1, (i) => R.minerals[i]);
    if (count('science_station') < 12) tryBuildMany('science_station', 1, (i) => R.anomaly[i] * 2 + R.radiation[i]);
    if (count('depot') < 5) tryBuildMany('depot', 1, (i) => -i);
    // L'eau se gère à la demande : on ouvre une station dès que le bilan
    // hydrique se dégrade (c'est exactement ce que fait un joueur attentif).
    const waterScore = (i) => R.ice[i] + R.water[i] / BALANCE.water.basinDepth + R.moisture[i];
    if (count('ice_extractor') < 16 && (S.flux.water <= 0.5 || S.resources.water < 250)) {
      tryBuildMany('ice_extractor', 1, waterScore);
    }
    if (count('refinery') < 5) tryBuildMany('refinery', 1, (i) => R.minerals[i]);

    /* --- JOUEUR IMPRUDENT : mode `--bad` -------------------------------
       Il empile TOUT ce qui réchauffe, tout de suite, et ne démonte jamais.
       C'est la démonstration que la partie est perdable — et pourquoi. */
    if (reckless) {
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
      if (count('ghg_factory') < 12) tryBuildMany('ghg_factory', 1, (i) => 1 - R.pollution[i]);
      if (count('polar_melter') < 8) tryBuildMany('polar_melter', 1, (i) => R.ice[i]);
      if (count('orbital_mirror') < 8 && g.temperature < TARGET_T.low - 2) {
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
    if (g.pressure < 82 && count('atmo_processor') < 14) {
      tryBuildMany('atmo_processor', 1, (i) => R.geothermal[i]);
    }

    /* --- OXYGÈNE : après la biosphère, et sans assécher tout le CO₂ ----- */
    if (g.pressure > 30 && g.oxygen < 19 && g.co2 > 12 && count('o2_generator') < 12) {
      tryBuildMany('o2_generator', 1, (i) => -i);
    }
    // Le craquage a mangé trop de CO₂ : on lève le pied (sinon la planète gèle).
    if (g.co2 < 7 && count('o2_generator') > 0) demolishSome('o2_generator', 2);

    /* --- BIOSPHÈRE ------------------------------------------------------ */
    if (g.temperature > -22 && count('biodome') < 12) {
      tryBuildMany('biodome', 1, (i) => R.habitability[i] * 2 + R.moisture[i]);
    }
    if (g.biomass > 3 && count('seeder') < 10) tryBuildMany('seeder', 1, (i) => R.vegetation[i]);

    /* --- STABILITÉ & COLONIES ------------------------------------------- */
    if (g.stability < 78 && count('climate_stabilizer') < 5) {
      tryBuildMany('climate_stabilizer', 1, (i) => -i);
    }
    // Une colonie se pose au bord de l'eau et sur du vert : c'est là qu'elle
    // se nourrit et s'abreuve toute seule.
    if (count('colony') < 8) {
      tryBuildMany('colony', 1, (i) => R.habitability[i] * 2 + R.vegetation[i]
        + Math.min(1, R.water[i] / BALANCE.water.basinDepth + R.moisture[i]));
    }
  }

  const days = years * 365;
  const marks = [];
  let victoryDay = null;
  let maxT = -Infinity, minStab = Infinity, maxP = 0;
  for (let d = 0; d < days; d++) {
    game._tick(1, d);
    if (d % 20 === 0) play();
    const g = S.globals;
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
    if (S.progress.victory && victoryDay === null) victoryDay = d;
  }
  return { game, state: S, regions: R, marks, victoryDay, maxT, minStab, maxP };
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
  console.log(`  Pic de température : ${run.maxT.toFixed(1)} °C · creux de stabilité : ${run.minStab.toFixed(1)} · pic de pression : ${run.maxP.toFixed(1)} kPa`);
  console.log(`  Technologies : ${S.tech.unlocked.length}/${TECH_LIST.length} · bâtiments : ${S.buildings.length} · événements : ${S.stats.events}`);
  const problems = audit(run);
  console.log(problems.length ? `  ⚠ ANOMALIES : ${problems.join(' · ')}` : '  ✔ Aucune anomalie détectée.');
  console.log();
  return run;
}

function printMulti(n, years, reckless = false) {
  console.log(`\nSONDE MULTI-SEEDS — ${n} seeds, ${years} ans\n`);
  console.log('     seed   victoire     T°C     kPa     O2%    CO2%    eau%     bio    stab      pop  picT anomalies');
  console.log('  ' + '─'.repeat(112));
  let wins = 0, inWindow = 0;
  for (let k = 0; k < n; k++) {
    const seed = 1000 + k * 7919;
    const run = playGame(seed, years, reckless);
    const g = run.state.globals;
    const v = run.victoryDay;
    if (v !== null) wins++;
    const year = v !== null ? v / 365 : null;
    if (year !== null && year >= 20 && year <= 45) inWindow++;
    const problems = audit(run);
    console.log(`  ${String(seed).padStart(7)} ${(year !== null ? `an ${year.toFixed(1)}` : '—').padStart(10)} ${f(g.temperature)} ${f(g.pressure)} ${f(g.oxygen, 2)} ${f(g.co2, 1)} ${f(g.waterCoverage * 100, 1)} ${f(g.biomass, 1)} ${f(g.stability)} ${String(Math.round(g.population)).padStart(8)} ${f(run.maxT, 0)}  ${problems.length ? '⚠ ' + problems.join(' · ') : 'ok'}`);
  }
  console.log(`\n  Victoires : ${wins}/${n} · dans la fenêtre an 20–45 : ${inWindow}/${n}\n`);
}

const arg0 = process.argv[2];
if (arg0 === '--multi') {
  printMulti(Number(process.argv[3] ?? 6), Number(process.argv[4] ?? 60));
} else if (arg0 === '--bad') {
  // Contre-épreuve : la même partie jouée sans discernement doit ÉCHOUER.
  printMulti(Number(process.argv[3] ?? 6), Number(process.argv[4] ?? 60), true);
} else {
  printOne(Number(arg0 ?? 20260904), Number(process.argv[3] ?? 60));
}

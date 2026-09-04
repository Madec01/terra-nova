/**
 * Sonde d'équilibrage : joue une partie complète en accéléré, sans navigateur,
 * avec un « joueur automatique » raisonnable, et trace l'arc de la partie.
 *
 *   node tools/balance-probe.mjs [seed] [annees]
 *
 * Ce n'est PAS un test de régression : c'est un outil de game design pour
 * répondre à « la partie est-elle gagnable, et en combien de temps ? ».
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

const seed = Number(process.argv[2] ?? 20260904);
const years = Number(process.argv[3] ?? 60);

const game = new Game();
game.newGame({ seed });
const R = game.regions, S = game.state;

/* Ordre de recherche d'un joueur qui vise la victoire. */
const PLAN = [
  'orbital_survey', 'geothermal_tap', 'metallurgy', 'greenhouse_gases', 'exobiology',
  'energy_grid', 'polar_engineering', 'automation', 'pioneer_organisms',
  'atmospheric_engineering', 'orbital_infrastructure', 'forestation',
  'carbon_capture', 'fusion', 'colonization', 'climate_control',
  'ecosystems', 'deep_drilling', 'terraform_mastery',
];

/** Meilleures régions pour un type de bâtiment donné. */
function ranked(scoreFn) {
  const out = [];
  for (let i = 0; i < R.count; i++) if (R.discovered[i]) out.push([i, scoreFn(i)]);
  out.sort((a, b) => b[1] - a[1]);
  return out.map((x) => x[0]);
}

function tryBuildMany(type, wanted, scoreFn) {
  let built = 0;
  for (const i of ranked(scoreFn)) {
    if (built >= wanted) break;
    if (game.canBuild(type, i).ok && game.build(type, i)) built++;
  }
  return built;
}

const count = (t) => S.buildings.filter((b) => b.type === t).length;

/* Le joueur agit une fois tous les 20 jours. */
function play() {
  // Exploration continue.
  for (let i = 0; i < R.count; i++) {
    if (!R.discovered[i] && S.explore.scanning.length < 4) game.scanRegion(i);
  }
  // Recherche dès que la science le permet.
  for (const id of PLAN) if (game.canResearch(id).ok) { game.startResearch(id); break; }

  // Infrastructure de base, dimensionnée sur la demande.
  const netEnergy = S.power.production - S.power.consumption;
  if (netEnergy < 12) {
    if (!tryBuildMany('fusion', 1, (i) => 1)) {
      if (!tryBuildMany('geothermal', 1, (i) => R.geothermal[i])) {
        tryBuildMany('solar', 2, (i) => 1 - Math.abs(R.latitude[i]));
      }
    }
  }
  if (count('mine') < 14) tryBuildMany('mine', 1, (i) => R.minerals[i]);
  if (count('science_station') < 10) tryBuildMany('science_station', 1, (i) => R.anomaly[i] * 2 + R.radiation[i]);
  if (count('depot') < 4) tryBuildMany('depot', 1, () => Math.random());
  if (count('ice_extractor') < 6) tryBuildMany('ice_extractor', 1, (i) => R.ice[i]);
  if (count('refinery') < 4) tryBuildMany('refinery', 1, (i) => R.minerals[i]);

  // Terraformation, dans l'ordre où elle devient utile.
  if (S.globals.temperature < -5) {
    if (count('ghg_factory') < 12) tryBuildMany('ghg_factory', 1, (i) => 1 - R.pollution[i]);
    if (count('polar_melter') < 8) tryBuildMany('polar_melter', 1, (i) => R.ice[i]);
    if (count('orbital_mirror') < 8) tryBuildMany('orbital_mirror', 1, () => Math.random());
  }
  if (S.globals.pressure < 70 && count('atmo_processor') < 14) {
    tryBuildMany('atmo_processor', 1, (i) => R.geothermal[i]);
  }
  if (S.globals.pressure > 25 && S.globals.oxygen < 18 && count('o2_generator') < 12) {
    tryBuildMany('o2_generator', 1, () => Math.random());
  }
  if (S.globals.temperature > -20 && count('biodome') < 10) {
    tryBuildMany('biodome', 1, (i) => R.habitability[i]);
  }
  if (S.globals.biomass > 4 && count('seeder') < 8) tryBuildMany('seeder', 1, (i) => R.vegetation[i]);
  if (S.globals.stability < 70 && count('climate_stabilizer') < 5) {
    tryBuildMany('climate_stabilizer', 1, () => Math.random());
  }
  if (count('colony') < 6) tryBuildMany('colony', 1, (i) => R.habitability[i]);
}

const days = years * 365;
const marks = [];
let victoryDay = null;
for (let d = 0; d < days; d++) {
  game._tick(1, d);
  if (d % 20 === 0) play();
  if (d % 365 === 0) {
    const g = S.globals;
    marks.push({
      an: d / 365, T: g.temperature, P: g.pressure, O2: g.oxygen, CO2: g.co2,
      eau: g.waterCoverage * 100, bio: g.biomass, stab: g.stability, pop: g.population,
      ins: g.insolation, bat: S.buildings.length, tech: S.tech.unlocked.length,
      sci: S.resources.science, mat: S.resources.materials, nrj: S.resources.energy,
    });
  }
  if (S.progress.victory && victoryDay === null) victoryDay = d;
}

const f = (v, n = 1) => String(v.toFixed(n)).padStart(7);
console.log(`\nSONDE D'ÉQUILIBRAGE — seed ${seed}, ${years} ans, ${R.count} régions\n`);
console.log('  an       T°C     kPa      O2%     CO2%    eau%     bio    stab      pop   insol  bât tech');
console.log('  ' + '─'.repeat(94));
for (const m of marks) {
  if (m.an % 5 !== 0 && m.an !== marks.length - 1) continue;
  console.log(`  ${String(m.an).padStart(3)} ${f(m.T)} ${f(m.P)} ${f(m.O2, 2)} ${f(m.CO2, 1)} ${f(m.eau, 1)} ${f(m.bio, 1)} ${f(m.stab)} ${String(Math.round(m.pop)).padStart(8)} ${f(m.ins, 2)} ${String(m.bat).padStart(4)} ${String(m.tech).padStart(4)}`);
}

console.log('\n  Conditions de victoire en fin de sonde :');
for (const r of game.victoryReport()) {
  console.log(`   ${r.ok ? '✔' : '·'} ${String(r.label).padEnd(24)} ${String(r.value).padStart(10)}   cible ${r.target}`);
}
console.log(`\n  Victoire : ${victoryDay !== null ? `an ${(victoryDay / 365).toFixed(1)}` : 'non atteinte'}`);
console.log(`  Technologies : ${S.tech.unlocked.length}/${TECH_LIST.length} · bâtiments : ${S.buildings.length} · événements : ${S.stats.events}`);
const bad = Object.entries(S.globals).filter(([, v]) => typeof v === 'number' && !isFinite(v));
if (bad.length) console.log('  ⚠ VALEURS INVALIDES :', bad.map(([k]) => k).join(', '));
console.log();

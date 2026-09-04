/**
 * Tests de la géométrie et de la génération procédurale.
 * Runner natif : `node --test tests/planet.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* SaveManager encode en base64 via btoa/atob (API navigateur) : polyfill Node. */
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
}

const { buildGoldberg, goldbergCellCount } = await import('../src/planet/Icosphere.js');
const { generatePlanet, PLANET_TYPES } = await import('../src/planet/PlanetGenerator.js');
const { RegionManager } = await import('../src/planet/RegionManager.js');
const { BALANCE } = await import('../src/data/balance.js');

const SEED = 20240917;

/* ================================================================== */
/*  Icosphere                                                          */
/* ================================================================== */

test('icosphère : nombre de cellules = 10*4^n + 2', () => {
  assert.equal(buildGoldberg(0).count, 12);
  assert.equal(buildGoldberg(1).count, 42);
  assert.equal(buildGoldberg(2).count, 162);
  assert.equal(buildGoldberg(3).count, 642);
  assert.equal(buildGoldberg(4).count, 2562);
  assert.equal(goldbergCellCount(3), 642);
});

test('icosphère : le cache renvoie exactement le même objet', () => {
  assert.equal(buildGoldberg(3), buildGoldberg(3));
});

test('icosphère : 5 ou 6 voisins, exactement 12 pentagones', () => {
  const g = buildGoldberg(3);
  let pentagons = 0;
  for (let i = 0; i < g.count; i++) {
    const d = g.neighborOffsets[i + 1] - g.neighborOffsets[i];
    assert.ok(d === 5 || d === 6, `cellule ${i} a ${d} voisins`);
    assert.equal(g.cornerOffsets[i + 1] - g.cornerOffsets[i], d, 'autant de coins que de voisins');
    if (d === 5) pentagons++;
  }
  assert.equal(pentagons, 12);
});

test('icosphère : la relation de voisinage est symétrique et sans doublon', () => {
  const g = buildGoldberg(3);
  for (let i = 0; i < g.count; i++) {
    const a = g.neighborOffsets[i], b = g.neighborOffsets[i + 1];
    const seen = new Set();
    for (let k = a; k < b; k++) {
      const j = g.neighbors[k];
      assert.notEqual(j, i, 'une cellule ne peut pas être sa propre voisine');
      assert.ok(!seen.has(j), 'voisin dupliqué');
      seen.add(j);
      let back = false;
      for (let m = g.neighborOffsets[j]; m < g.neighborOffsets[j + 1]; m++) {
        if (g.neighbors[m] === i) back = true;
      }
      assert.ok(back, `voisinage non symétrique entre ${i} et ${j}`);
    }
  }
});

test('icosphère : centres et coins sont sur la sphère unité', () => {
  const g = buildGoldberg(3);
  for (let i = 0; i < g.count; i++) {
    const x = g.positions[i * 3], y = g.positions[i * 3 + 1], z = g.positions[i * 3 + 2];
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-5);
    assert.ok(Math.abs(g.latitude[i] - y) < 1e-6, 'latitude = y');
    assert.ok(g.latitude[i] >= -1.0001 && g.latitude[i] <= 1.0001);
  }
  for (let c = 0; c < g.corners.length; c += 3) {
    assert.ok(Math.abs(Math.hypot(g.corners[c], g.corners[c + 1], g.corners[c + 2]) - 1) < 1e-5);
  }
});

test('icosphère : aires normalisées (somme ≈ count) et toutes > 0', () => {
  for (const n of [3, 4]) {
    const g = buildGoldberg(n);
    let sum = 0;
    for (let i = 0; i < g.count; i++) {
      assert.ok(g.area[i] > 0, 'aire nulle ou négative');
      sum += g.area[i];
    }
    assert.ok(Math.abs(sum - g.count) < 1e-2, `somme des aires ${sum} != ${g.count}`);
  }
});

test('icosphère : coins en ordre trigonométrique vu de l’extérieur', () => {
  const g = buildGoldberg(3);
  for (let i = 0; i < g.count; i++) {
    const cs = g.cornerOffsets[i], k = g.cornerOffsets[i + 1] - cs;
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < k; j++) {
      const o1 = (cs + j) * 3, o2 = (cs + ((j + 1) % k)) * 3;
      const x1 = g.corners[o1], y1 = g.corners[o1 + 1], z1 = g.corners[o1 + 2];
      const x2 = g.corners[o2], y2 = g.corners[o2 + 1], z2 = g.corners[o2 + 2];
      nx += y1 * z2 - z1 * y2; ny += z1 * x2 - x1 * z2; nz += x1 * y2 - y1 * x2;
    }
    const len = Math.hypot(nx, ny, nz);
    const dot = (nx * g.positions[i * 3] + ny * g.positions[i * 3 + 1] + nz * g.positions[i * 3 + 2]) / len;
    assert.ok(dot > 0.99, `polygone ${i} mal orienté (dot=${dot})`);
  }
});

/* ================================================================== */
/*  Génération                                                         */
/* ================================================================== */

test('génération : structure conforme au contrat', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });
  assert.ok(r instanceof RegionManager);
  assert.equal(r.count, 642);
  for (const f of ['elevation', 'minerals', 'geothermal', 'iceInit', 'fertilityBase', 'radiation',
    'temperature', 'moisture', 'ice', 'water', 'vegetation', 'pollution', 'population',
    'habitability', 'energyPotential']) {
    assert.ok(r[f] instanceof Float32Array, `${f} doit être un Float32Array`);
    assert.equal(r[f].length, r.count, `${f} mal dimensionné`);
  }
  for (const f of ['anomaly', 'biome', 'discovered', 'buildingCount']) {
    assert.ok(r[f] instanceof Uint8Array, `${f} doit être un Uint8Array`);
    assert.equal(r[f].length, r.count);
  }
  assert.ok(r.neighbors(0).length >= 5);
  assert.equal(r.cellCorners(0).length, r.neighbors(0).length * 3);
});

test('génération : les valeurs restent dans leurs bornes', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });
  for (let i = 0; i < r.count; i++) {
    assert.ok(r.elevation[i] >= -1 && r.elevation[i] <= 1, 'élévation hors [-1,1]');
    for (const f of ['minerals', 'geothermal', 'iceInit', 'fertilityBase', 'radiation', 'ice', 'moisture']) {
      assert.ok(r[f][i] >= 0 && r[f][i] <= 1, `${f}[${i}] = ${r[f][i]} hors [0,1]`);
    }
    assert.ok(r.anomaly[i] === 0 || r.anomaly[i] === 1);
    assert.ok(Number.isFinite(r.temperature[i]));
    assert.equal(r.water[i], 0, 'pas d’eau liquide à la genèse');
    assert.equal(r.vegetation[i], 0);
    assert.equal(r.population[i], 0);
    assert.equal(r.buildingCount[i], 0);
  }
});

test('génération : la fraction de terres émergées est jouable', () => {
  for (const seed of [1, 2, 7, 99, SEED, 123456789]) {
    const r = generatePlanet({ seed, subdivisions: 3 });
    let land = 0, total = 0;
    for (let i = 0; i < r.count; i++) {
      total += r.area[i];
      if (r.elevation[i] > r.seaLevel) land += r.area[i];
    }
    const frac = land / total;
    assert.ok(frac >= 0.35 && frac <= 0.75, `seed ${seed} : terres = ${frac.toFixed(3)}`);
  }
});

test('génération : géothermie rare mais présente, anomalies présentes', () => {
  for (const seed of [1, SEED, 4242]) {
    const r = generatePlanet({ seed, subdivisions: 3 });
    let hot = 0, anomalies = 0;
    for (let i = 0; i < r.count; i++) {
      if (r.geothermal[i] > 0.4) hot++;
      anomalies += r.anomaly[i];
    }
    assert.ok(hot >= 1, 'aucune région géothermique exploitable');
    const ratio = hot / r.count;
    assert.ok(ratio >= 0.05 && ratio <= 0.20, `géothermie ${(ratio * 100).toFixed(1)} % hors cible`);
    assert.ok(anomalies >= 1, 'aucune anomalie');
    assert.ok(anomalies <= 14, 'trop d’anomalies');
  }
});

test('génération : site d’atterrissage viable et régions révélées contiguës', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });
  const site = r.landingSite;
  assert.ok(site >= 0 && site < r.count);
  assert.ok(r.elevation[site] > r.seaLevel, 'site sous le niveau de mer');
  assert.ok(Math.abs(r.latitude[site]) < 0.9, 'site polaire');
  assert.equal(r.discovered[site], 1);

  let discovered = 0;
  for (let i = 0; i < r.count; i++) discovered += r.discovered[i];
  assert.equal(discovered, BALANCE.planet.initialDiscovered);

  // Contiguïté : tout ce qui est révélé doit être atteignable depuis le site.
  const seen = new Set([site]);
  const queue = [site];
  while (queue.length) {
    const i = queue.pop();
    for (const j of r.neighbors(i)) {
      if (r.discovered[j] && !seen.has(j)) { seen.add(j); queue.push(j); }
    }
  }
  assert.equal(seen.size, discovered, 'régions révélées non contiguës');
});

test('génération : déterminisme strict et sensibilité à la seed', () => {
  const a = generatePlanet({ seed: SEED, subdivisions: 3 });
  const b = generatePlanet({ seed: SEED, subdivisions: 3 });
  const c = generatePlanet({ seed: SEED + 1, subdivisions: 3 });

  for (const f of ['elevation', 'minerals', 'geothermal', 'iceInit', 'fertilityBase', 'radiation', 'temperature']) {
    assert.deepEqual(Array.from(a[f]), Array.from(b[f]), `${f} non déterministe`);
  }
  assert.deepEqual(Array.from(a.anomaly), Array.from(b.anomaly));
  assert.equal(a.landingSite, b.landingSite);

  let diff = 0;
  for (let i = 0; i < a.count; i++) if (Math.abs(a.elevation[i] - c.elevation[i]) > 1e-4) diff++;
  assert.ok(diff > a.count * 0.5, 'deux seeds différentes donnent la même planète');
});

test('génération : les cinq types de planète fonctionnent', () => {
  for (const type of Object.keys(PLANET_TYPES)) {
    const r = generatePlanet({ seed: SEED, subdivisions: 3, planetType: type });
    assert.equal(r.count, 642);
    assert.equal(r.planetType, type);
    let land = 0, total = 0, anomalies = 0;
    for (let i = 0; i < r.count; i++) {
      total += r.area[i];
      if (r.elevation[i] > r.seaLevel) land += r.area[i];
      anomalies += r.anomaly[i];
    }
    const frac = land / total;
    assert.ok(frac > 0.30 && frac < 0.80, `${type} : terres = ${frac.toFixed(2)}`);
    assert.ok(anomalies >= 1, `${type} : aucune anomalie`);
    assert.ok(r.landingSite >= 0, `${type} : pas de site d’atterrissage`);
  }
});

test('génération : un type inconnu retombe sur « rocky »', () => {
  const a = generatePlanet({ seed: SEED, subdivisions: 3, planetType: 'inexistant' });
  const b = generatePlanet({ seed: SEED, subdivisions: 3, planetType: 'rocky' });
  assert.deepEqual(Array.from(a.elevation), Array.from(b.elevation));
});

test('performance : n=3 sous 150 ms, n=4 sous 700 ms', () => {
  buildGoldberg(3); buildGoldberg(4);            // géométrie mise en cache en amont
  generatePlanet({ seed: 1, subdivisions: 3 });  // échauffement du JIT

  let t = performance.now();
  generatePlanet({ seed: SEED, subdivisions: 3 });
  const t3 = performance.now() - t;

  t = performance.now();
  generatePlanet({ seed: SEED, subdivisions: 4 });
  const t4 = performance.now() - t;

  assert.ok(t3 < 150, `n=3 : ${t3.toFixed(1)} ms`);
  assert.ok(t4 < 700, `n=4 : ${t4.toFixed(1)} ms`);
});

/* ================================================================== */
/*  RegionManager                                                      */
/* ================================================================== */

test('RegionManager : neighbors() et cellCorners() sont des sous-vues sans copie', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });
  const nb = r.neighbors(5);
  assert.ok(nb instanceof Int32Array);
  assert.equal(nb.buffer, r._neighbors.buffer, 'neighbors() doit être un subarray');
  const co = r.cellCorners(5);
  assert.equal(co.buffer, r.corners.buffer, 'cellCorners() doit être un subarray');

  let visited = 0;
  r.forEachNeighbor(5, (j, k) => { assert.equal(j, nb[k]); visited++; });
  assert.equal(visited, nb.length);
});

test('RegionManager : getRegionView() expose tout, en français', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });
  const v = r.getRegionView(r.landingSite);
  assert.equal(v.id, r.landingSite);
  assert.ok(v.lat >= -90 && v.lat <= 90);
  assert.ok(v.lon >= -180 && v.lon <= 180);
  assert.equal(typeof v.biomeName, 'string');
  assert.ok(v.biomeName.length > 0);
  assert.ok(Math.abs(v.elevationKm - r.elevation[r.landingSite] * 12) < 1e-4);
  assert.equal(v.isLandingSite, true);
  for (const k of ['elevation', 'minerals', 'geothermal', 'iceInit', 'fertilityBase', 'radiation',
    'anomaly', 'temperature', 'moisture', 'ice', 'water', 'vegetation', 'pollution',
    'population', 'biome', 'discovered', 'buildingCount', 'habitability', 'energyPotential', 'area']) {
    assert.ok(k in v, `getRegionView : ${k} manquant`);
  }
});

test('RegionManager : stats() agrège en pondérant par l’aire', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });
  const s = r.stats();
  assert.equal(s.count, r.count);
  assert.ok(s.landFraction > 0.3 && s.landFraction < 0.8);
  assert.equal(s.discovered, BALANCE.planet.initialDiscovered);
  assert.ok(s.anomalies >= 1);
  assert.equal(s.waterCoverage, 0);
  assert.ok(Number.isFinite(s.meanTemperature));
});

test('RegionManager : round-trip toJSON / fromJSON', () => {
  const r = generatePlanet({ seed: SEED, subdivisions: 3 });

  // On simule une partie déjà avancée.
  for (let i = 0; i < r.count; i++) {
    r.temperature[i] = -40 + i * 0.01;
    r.moisture[i] = (i % 100) / 100;
    r.ice[i] = ((i * 7) % 100) / 100;
    r.water[i] = ((i * 13) % 100) / 100;
    r.vegetation[i] = ((i * 3) % 100) / 100;
    r.pollution[i] = ((i * 11) % 100) / 100;
    r.population[i] = i * 2;
    r.biome[i] = i % 12;
    r.discovered[i] = i % 2;
    r.buildingCount[i] = i % 4;
  }

  const json = JSON.parse(JSON.stringify(r.toJSON()));
  assert.equal(json.seed, r.seed);
  assert.equal(json.subdivisions, 3);
  assert.equal(json.landingSite, r.landingSite);
  assert.equal(json.elevation, undefined, 'les champs statiques ne doivent pas être sauvegardés');
  assert.equal(json.minerals, undefined);

  const fresh = generatePlanet({ seed: SEED, subdivisions: 3 });
  const back = RegionManager.fromJSON(json, fresh);
  assert.equal(back, fresh, 'fromJSON doit retourner l’instance regénérée');

  for (const f of ['temperature', 'moisture', 'ice', 'water', 'vegetation', 'pollution', 'population']) {
    for (let i = 0; i < r.count; i++) {
      assert.ok(Math.abs(back[f][i] - r[f][i]) < 1e-5, `${f}[${i}] non restauré`);
    }
  }
  for (const f of ['biome', 'discovered', 'buildingCount']) {
    assert.deepEqual(Array.from(back[f]), Array.from(r[f]), `${f} non restauré`);
  }
  assert.equal(back.landingSite, r.landingSite);
  // Les statiques doivent rester ceux de la regénération, pas ceux du JSON.
  assert.deepEqual(Array.from(back.elevation), Array.from(generatePlanet({ seed: SEED, subdivisions: 3 }).elevation));
});

test('RegionManager : fromJSON tolère les champs manquants ou corrompus', () => {
  const fresh = generatePlanet({ seed: SEED, subdivisions: 3 });
  const reference = generatePlanet({ seed: SEED, subdivisions: 3 });

  const back = RegionManager.fromJSON({ subdivisions: 3, seed: SEED, landingSite: -99 }, fresh);
  assert.equal(back, fresh);
  assert.deepEqual(Array.from(back.ice), Array.from(reference.ice), 'valeur générée conservée');
  assert.equal(back.landingSite, reference.landingSite, 'landingSite invalide ignoré');

  assert.equal(RegionManager.fromJSON(null, fresh), fresh);
  assert.doesNotThrow(() => RegionManager.fromJSON({ temperature: '!!not-base64!!' }, fresh));
});

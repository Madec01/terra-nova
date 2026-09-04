import { test } from 'node:test';
import assert from 'node:assert/strict';

// btoa/atob n'existent pas nativement dans toutes les versions de Node.
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

const { EventBus } = await import('../src/core/EventBus.js');
const { TimeManager } = await import('../src/core/TimeManager.js');
const { createInitialState, pushLog } = await import('../src/core/GameState.js');
const { computeTechEffects } = await import('../src/core/TechEffects.js');
const { encodeFloat32, decodeFloat32, encodeUint8, decodeUint8 } = await import('../src/core/SaveManager.js');
const { Random, makeSeedLabel, hashString } = await import('../src/utils/rng.js');
const { SimplexNoise } = await import('../src/utils/noise.js');
const { clamp, lerp, smoothstep, bell, formatNumber, toLatLon } = await import('../src/utils/math.js');
const { BALANCE } = await import('../src/data/balance.js');
const { BUILDINGS, BUILDING_LIST } = await import('../src/data/buildings.js');
const { TECHNOLOGIES, TECH_LIST } = await import('../src/data/technologies.js');
const { GAME_EVENTS } = await import('../src/data/events.js');
const { BIOMES } = await import('../src/data/biomes.js');

test('EventBus : abonnement, émission, désabonnement', () => {
  const bus = new EventBus();
  let n = 0;
  const off = bus.on('x', (p) => { n += p; });
  bus.emit('x', 2);
  bus.emit('x', 3);
  off();
  bus.emit('x', 10);
  assert.equal(n, 5);
});

test('EventBus : une erreur dans un abonné ne casse pas les autres', () => {
  const bus = new EventBus();
  let reached = false;
  bus.on('x', () => { throw new Error('boum'); });
  bus.on('x', () => { reached = true; });
  bus.emit('x', null);
  assert.ok(reached);
});

test('TimeManager : pas fixe indépendant du framerate', () => {
  const bus = new EventBus();
  const step = BALANCE.time.tickSeconds;

  const tm = new TimeManager(bus);
  tm.setSpeed(1);
  let ticksA = 0;
  for (let i = 0; i < 100; i++) tm.advance(step / 10, () => ticksA++);   // 600 FPS

  const tm2 = new TimeManager(bus);
  tm2.setSpeed(1);
  let ticksB = 0;
  for (let i = 0; i < 10; i++) tm2.advance(step, () => ticksB++);        // 4 FPS

  assert.equal(ticksA, 10);
  assert.equal(ticksB, 10);
});

test('TimeManager : la pause arrête réellement le temps', () => {
  const tm = new TimeManager(new EventBus());
  tm.setSpeed(0);
  let ticks = 0;
  for (let i = 0; i < 50; i++) tm.advance(1, () => ticks++);
  assert.equal(ticks, 0);
});

test('TimeManager : x4 avance quatre fois plus vite que x1', () => {
  const mk = (speed) => {
    const tm = new TimeManager(new EventBus());
    tm.setSpeed(speed);
    let t = 0;
    for (let i = 0; i < 40; i++) tm.advance(BALANCE.time.tickSeconds / 4, () => t++);
    return t;
  };
  assert.equal(mk(1), 10);
  assert.equal(mk(4), 40);
});

test('TimeManager : anti-spirale de la mort (frames très longues)', () => {
  const tm = new TimeManager(new EventBus());
  tm.setSpeed(4);
  let ticks = 0;
  tm.advance(60, () => ticks++);
  assert.ok(ticks <= BALANCE.time.maxCatchUpTicks, `${ticks} ticks en une frame`);
});

test('RNG : déterminisme et reproductibilité', () => {
  const a = new Random(4242);
  const b = new Random(4242);
  const c = new Random(4243);
  const sa = Array.from({ length: 50 }, () => a.next());
  const sb = Array.from({ length: 50 }, () => b.next());
  const sc = Array.from({ length: 50 }, () => c.next());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every((v) => v >= 0 && v < 1));
});

test('RNG : fork produit des flux indépendants mais déterministes', () => {
  const r1 = new Random(7).fork(3).next();
  const r2 = new Random(7).fork(3).next();
  const r3 = new Random(7).fork(4).next();
  assert.equal(r1, r2);
  assert.notEqual(r1, r3);
});

test('RNG : weighted respecte les poids', () => {
  const rng = new Random(11);
  const items = [{ id: 'a', weight: 0 }, { id: 'b', weight: 1 }];
  for (let i = 0; i < 200; i++) assert.equal(rng.weighted(items).id, 'b');
});

test('Bruit : déterminisme, bornes et continuité', () => {
  const n1 = new SimplexNoise(99);
  const n2 = new SimplexNoise(99);
  assert.equal(n1.noise3(1.7, 2.3, 0.4), n2.noise3(1.7, 2.3, 0.4));
  let min = 2, max = -2;
  for (let i = 0; i < 5000; i++) {
    const v = n1.noise3(i * 0.013, i * 0.007, i * 0.019);
    min = Math.min(min, v); max = Math.max(max, v);
    assert.ok(isFinite(v));
  }
  assert.ok(min >= -1.01 && max <= 1.01, `hors bornes: ${min} ${max}`);
  const a = n1.noise3(3, 4, 5), b = n1.noise3(3.001, 4, 5);
  assert.ok(Math.abs(a - b) < 0.05);
});

test('Maths : helpers', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(bell(10, 10, 5), 1);
  assert.ok(bell(30, 10, 5) < 0.001);
  assert.equal(formatNumber(1500000, 1), '1.5 M');
  assert.ok(Math.abs(toLatLon(0, 1, 0).lat - 90) < 0.001);
});

test('Sauvegarde : encodage binaire aller-retour', () => {
  const f = new Float32Array([1.5, -2.25, 0, 1e6, -0.001]);
  assert.deepEqual(Array.from(decodeFloat32(encodeFloat32(f), f.length)), Array.from(f));
  const u = new Uint8Array([0, 1, 200, 255, 42]);
  assert.deepEqual(Array.from(decodeUint8(encodeUint8(u), u.length)), Array.from(u));
});

test('Sauvegarde : encodage d’un grand tableau (642 régions)', () => {
  const f = new Float32Array(642);
  for (let i = 0; i < f.length; i++) f[i] = Math.sin(i) * 100;
  const b64 = encodeFloat32(f);
  const back = decodeFloat32(b64, f.length);
  for (let i = 0; i < f.length; i++) assert.ok(Math.abs(back[i] - f[i]) < 1e-4);
  assert.ok(b64.length < 4000, 'encodage trop volumineux');
});

test('GameState : état initial cohérent et sérialisable', () => {
  const s = createInitialState({ seed: 5 });
  assert.equal(s.seed, 5);
  assert.equal(s.time.day, 0);
  assert.equal(s.globals.temperature, BALANCE.start.globals.temperature);
  assert.equal(s.buildings.length, 0);
  assert.deepEqual(s.tech.unlocked, []);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});

test('GameState : le journal est borné', () => {
  const s = createInitialState({ seed: 1 });
  for (let i = 0; i < 500; i++) pushLog(s, 'ligne ' + i);
  assert.ok(s.log.length <= 120);
});

test('TechEffects : agrégation multiplicative', () => {
  assert.equal(computeTechEffects([]).productionMultiplier.materials, 1);
  assert.ok(computeTechEffects(['automation']).productionMultiplier.materials > 1);
  const both = computeTechEffects(['forestation', 'ecosystems']);
  assert.ok(both.spreadMultiplier > 1 && both.growthMultiplier > 1);
});

test('Données : cohérence du catalogue de bâtiments', () => {
  for (const b of BUILDING_LIST) {
    assert.ok(b.id && b.name && b.desc, `bâtiment incomplet : ${b.id}`);
    assert.equal(BUILDINGS[b.id], b, `clé/id incohérents : ${b.id}`);
    assert.ok(b.cost && Object.keys(b.cost).length > 0, `${b.id} sans coût`);
    if (b.requires?.tech) assert.ok(TECHNOLOGIES[b.requires.tech], `${b.id} référence une techno inconnue`);
    if (b.outputScale) assert.equal(typeof b.outputScale, 'function');
  }
  assert.ok(BUILDING_LIST.length >= 8, 'le MVP demande au moins 8 bâtiments');
});

test('Données : l’arbre technologique est acyclique et entièrement atteignable', () => {
  const resolved = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of TECH_LIST) {
      if (resolved.has(t.id)) continue;
      if ((t.requires || []).every((r) => resolved.has(r))) { resolved.add(t.id); changed = true; }
    }
  }
  assert.deepEqual(TECH_LIST.filter((t) => !resolved.has(t.id)).map((t) => t.id), [],
    'technologies inatteignables (cycle ?)');
  for (const t of TECH_LIST) {
    for (const r of t.requires || []) assert.ok(TECHNOLOGIES[r], `prérequis inconnu ${r} pour ${t.id}`);
    assert.ok(t.cost > 0);
  }
});

test('Données : chaque bâtiment annoncé par une techno existe et la requiert', () => {
  for (const t of TECH_LIST) {
    for (const u of t.unlocks || []) {
      assert.ok(BUILDINGS[u], `${t.id} prétend débloquer ${u} qui n'existe pas`);
      assert.equal(BUILDINGS[u].requires?.tech, t.id, `${u} ne requiert pas ${t.id}`);
    }
  }
});

test('Données : événements bien formés', () => {
  assert.ok(GAME_EVENTS.length >= 8);
  for (const e of GAME_EVENTS) {
    assert.ok(e.id && e.name);
    assert.equal(typeof e.weight, 'function');
    assert.equal(typeof e.apply, 'function');
  }
});

test('Données : biomes avec couleurs valides', () => {
  for (const b of BIOMES) {
    assert.equal(b.color.length, 3);
    for (const c of b.color) assert.ok(c >= 0 && c <= 1, `couleur hors [0,1] pour ${b.id}`);
  }
});

test('Équilibrage : la partie démarre hors des conditions de victoire', () => {
  const v = BALANCE.victory;
  assert.ok(v.temperature.min < v.temperature.max);
  assert.ok(BALANCE.start.globals.temperature < v.temperature.min);
  assert.ok(BALANCE.start.globals.pressure < v.pressure.min);
  assert.ok(v.sustainDays > 0);
  assert.ok(BALANCE.atmosphere.maxPressure > v.pressure.min);
});

test('makeSeedLabel produit un identifiant stable', () => {
  assert.equal(makeSeedLabel(42), makeSeedLabel(42));
  assert.ok(/^TN-[0-9A-F]{6}$/.test(makeSeedLabel(hashString('bonjour'))));
});

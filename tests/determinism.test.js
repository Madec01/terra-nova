/**
 * Le déterminisme par seed est un PILIER du jeu : « même seed = même planète,
 * même partie ». Il est très facile à casser sans s'en apercevoir — une seule
 * source d'aléa non semée suffit, et le symptôme (deux parties identiques qui
 * divergent) n'apparaît qu'au bout de plusieurs milliers de jours.
 *
 * Ces tests sont là pour que cela ne passe jamais inaperçu.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    _d: new Map(),
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
  };
}

const { Game } = await import('../src/core/Game.js');

/** Empreinte compacte d'une partie : globales + agrégats de régions. */
function fingerprint(game) {
  const g = game.state.globals;
  const R = game.regions;
  let veg = 0, ice = 0, water = 0, disc = 0, pol = 0;
  for (let i = 0; i < R.count; i++) {
    veg += R.vegetation[i]; ice += R.ice[i]; water += R.water[i];
    disc += R.discovered[i]; pol += R.pollution[i];
  }
  return [
    g.temperature, g.pressure, g.oxygen, g.co2, g.waterCoverage, g.biomass,
    g.stability, g.population, veg, ice, water, disc, pol,
    game.state.buildings.length, game.state.stats.events,
  ].map((v) => (typeof v === 'number' ? v.toFixed(6) : String(v))).join('|');
}

/** Joue une partie scriptée, identique à chaque appel pour une seed donnée. */
function play(seed, days = 2500) {
  const game = new Game();
  game.newGame({ seed });
  const R = game.regions;
  for (let d = 0; d < days; d++) {
    game._tick(1, d);
    if (d % 30 === 0) {
      // Actions déterministes : toujours les mêmes, dans le même ordre.
      for (let i = 0; i < R.count; i++) {
        if (!R.discovered[i]) { game.scanRegion(i); break; }
      }
      let best = -1, bv = -1;
      for (let i = 0; i < R.count; i++) {
        if (R.discovered[i] && R.minerals[i] > bv && game.canBuild('mine', i).ok) { bv = R.minerals[i]; best = i; }
      }
      if (best >= 0) game.build('mine', best);
      if (game.canBuild('solar', 0).ok) game.build('solar', 0);
    }
  }
  return game;
}

test('même seed = même partie, à l’identique sur 2500 jours', () => {
  const a = fingerprint(play(20260904));
  const b = fingerprint(play(20260904));
  assert.equal(a, b, 'deux parties de même seed ont divergé');
});

test('des seeds différentes donnent des parties différentes', () => {
  const a = fingerprint(play(1111, 1200));
  const b = fingerprint(play(2222, 1200));
  assert.notEqual(a, b, 'deux seeds différentes donnent la même partie');
});

test('aucun Math.random dans les couches simulables', async () => {
  // Garde-fou statique : c'est exactement ainsi que le défaut a été introduit,
  // et une relecture ne l'avait pas vu.
  const { readFileSync, readdirSync } = await import('node:fs');

  /* Seule exception légitime : tirer la seed d'une NOUVELLE partie. À partir
     de là, tout doit être reproductible. */
  const EXCEPTIONS = new Set(['src/utils/rng.js:randomSeed']);

  const dirs = ['src/sim', 'src/data', 'src/core', 'src/planet', 'src/utils'];
  const coupables = [];
  for (const dir of dirs) {
    for (const f of readdirSync(new URL('../' + dir, import.meta.url))) {
      if (!f.endsWith('.js')) continue;
      const chemin = `${dir}/${f}`;
      const src = readFileSync(new URL('../' + chemin, import.meta.url), 'utf8')
        // On retire les commentaires : ils citent la règle, ils ne l'enfreignent pas.
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!src.includes('Math.random')) continue;
      const dansUneException = [...EXCEPTIONS].some((e) => {
        const [fichier, fonction] = e.split(':');
        if (fichier !== chemin) return false;
        const bloc = src.slice(Math.max(0, src.indexOf(fonction)));
        return bloc.slice(0, 220).includes('Math.random');
      });
      if (!dansUneException) coupables.push(chemin);
    }
  }
  assert.deepEqual(coupables, [],
    'ces fichiers utilisent Math.random hors des exceptions déclarées, ce qui casse le déterminisme par seed');
});

test('les événements sont reproductibles pour une seed donnée', () => {
  const a = play(4242, 3000);
  const b = play(4242, 3000);
  assert.equal(a.state.stats.events, b.state.stats.events, 'nombre d’événements différent');
  assert.deepEqual(a.state.log.map((l) => l.text), b.state.log.map((l) => l.text),
    'le journal de mission diffère');
});

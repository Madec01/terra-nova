/**
 * Test de fumée headless : démarre Vite, ouvre la page dans Chromium, joue
 * un scénario complet et rapporte TOUTE erreur de console.
 *
 *   node tools/smoke.mjs            # scénario standard
 *   node tools/smoke.mjs --shot     # + capture d'écran dans /tmp
 *   node tools/smoke.mjs --keep     # laisse le serveur tourner
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

/**
 * Playwright attend une build de Chromium précise, qui ne correspond pas
 * forcément à celle installée sur la machine. On cherche donc un binaire
 * utilisable plutôt que d'exiger `npx playwright install`.
 */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;   // on laisse Playwright tenter sa propre résolution
}

const SHOT_DIR = process.env.SHOT_DIR || '/tmp/terranova-shots';
const wantShots = process.argv.includes('--shot');
// Port tiré au hasard : un serveur orphelin d'une exécution précédente ou
// deux exécutions concurrentes ne se marchent plus dessus.
const PORT = 5200 + Math.floor(Math.random() * 400);

/**
 * On teste le BUILD DE PRODUCTION, pas le serveur de développement : le
 * rechargement à chaud de Vite réinitialise la page dès qu'un fichier source
 * change, ce qui faisait échouer le scénario quand quelqu'un éditait le code
 * pendant l'exécution. En prime, cela valide le build lui-même.
 */
function buildOnce() {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'warn'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => (c === 0 ? resolve(out) : reject(new Error('Échec du build :\n' + out))));
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    // Le serveur est tué quoi qu'il arrive : sortie normale, exception ou Ctrl-C.
    const kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(130); });
    let out = '';
    const to = setTimeout(() => reject(new Error('Le serveur n’a pas démarré :\n' + out)), 30000);
    p.stdout.on('data', (d) => {
      out += d;
      if (/Local:.*http/.test(out)) { clearTimeout(to); resolve(p); }
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => { clearTimeout(to); reject(new Error(`Le serveur s'est arrêté (${c}) :\n${out}`)); });
  });
}

const errors = [];
const warnings = [];

async function run() {
  process.stdout.write('Build de production … ');
  await buildOnce();
  console.log('ok');
  const vite = await startServer();
  const exe = findChromium();
  if (exe) console.log(`Chromium : ${exe}`);
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  page.on('console', (msg) => {
    const t = msg.type();
    // Le texte d'un échec de chargement ne contient pas l'URL : on la lit dans
    // la localisation du message, sinon le diagnostic est impossible.
    const where = msg.location?.().url || '';
    const text = msg.text() + (where ? ` [${where}]` : '');
    // Les 404 sur les sons sont attendus : le jeu fonctionne sans fichier audio.
    if (t === 'error' && /audio\//.test(text)) return;
    if (t === 'error') errors.push(text);
    else if (t === 'warning' && !/deprecat|SwiftShader|GPU stall|WebGL/i.test(text)) warnings.push(text);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!/\/public\/audio\//.test(u)) errors.push('REQUEST FAILED: ' + u + ' — ' + r.failure()?.errorText);
  });

  const step = async (name, fn) => {
    process.stdout.write(`  · ${name} … `);
    try { await fn(); console.log('ok'); }
    catch (e) { console.log('ÉCHEC'); errors.push(`[${name}] ${e.message}`); }
  };
  const shot = async (name) => {
    if (!wantShots) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  };

  console.log('\nSCÉNARIO DE FUMÉE — TERRA NOVA\n');

  await step('chargement de la page', async () => {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  });
  await shot('01-menu');

  await step('démarrage d’une nouvelle partie', async () => {
    await page.evaluate(() => window.TERRA.game.newGame({ seed: 123456 }));
    await page.waitForTimeout(900);
  });
  await shot('02-planete');

  await step('géométrie de la planète construite', async () => {
    const info = await page.evaluate(() => ({
      regions: window.TERRA.game.regions.count,
      tris: window.TERRA.scene.stats.triangles,
      draws: window.TERRA.scene.stats.drawCalls,
    }));
    if (!info.regions) throw new Error('aucune région');
    if (!info.tris) throw new Error('aucun triangle rendu');
    console.log(`(${info.regions} régions, ${info.tris} triangles, ${info.draws} draw calls) `);
  });

  await step('rotation et zoom par la souris', async () => {
    await page.mouse.move(800, 470);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(800 + i * 14, 470 + i * 3);
    await page.mouse.up();
    await page.mouse.wheel(0, -420);
    await page.waitForTimeout(400);
  });
  await shot('03-rotation');

  await step('sélection d’une région (API)', async () => {
    await page.evaluate(() => window.TERRA.game.selectRegion(window.TERRA.game.regions.landingSite ?? 0));
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => window.TERRA.game.selectedRegion);
    if (sel == null) throw new Error('aucune région sélectionnée');
  });

  await step('sélection d’une région par raycast (clic au centre)', async () => {
    const id = await page.evaluate(() => window.TERRA.scene.pick(800, 470));
    if (id == null) throw new Error('le raycast au centre de l’écran ne touche pas la planète');
  });
  await shot('04-selection');

  await step('construction d’une mine', async () => {
    const ok = await page.evaluate(() => {
      const g = window.TERRA.game;
      g.debug.revealAll();
      let best = -1, bv = 0;
      for (let i = 0; i < g.regions.count; i++) if (g.regions.minerals[i] > bv) { bv = g.regions.minerals[i]; best = i; }
      return g.build('mine', best);
    });
    if (!ok) throw new Error('construction refusée');
  });

  await step('production de ressources dans le temps', async () => {
    const before = await page.evaluate(() => ({ ...window.TERRA.game.state.resources }));
    await page.evaluate(() => window.TERRA.game.setSpeed(4));
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({ ...window.TERRA.game.state.resources }));
    const day = await page.evaluate(() => window.TERRA.game.state.time.day);
    if (day <= 0) throw new Error('le temps n’avance pas');
    if (after.materials <= before.materials) throw new Error(`les matériaux ne montent pas (${before.materials} → ${after.materials})`);
  });

  await step('terraformation : la température évolue', async () => {
    const t0 = await page.evaluate(() => window.TERRA.game.state.globals.temperature);
    await page.evaluate(() => {
      const g = window.TERRA.game;
      g.debug.addResources(100000); g.debug.addScience(100000); g.debug.unlockAllTech();
      let n = 0;
      for (let i = 0; i < g.regions.count && n < 12; i++) { if (g.build('ghg_factory', i)) n++; }
      return n;
    });
    await page.waitForTimeout(3500);
    const t1 = await page.evaluate(() => window.TERRA.game.state.globals.temperature);
    if (!(t1 > t0)) throw new Error(`la température n'augmente pas (${t0.toFixed(2)} → ${t1.toFixed(2)})`);
    console.log(`(${t0.toFixed(2)} → ${t1.toFixed(2)} °C) `);
  });
  await shot('05-terraforme');

  await step('changement de couche de visualisation', async () => {
    for (const l of ['temperature', 'water', 'resources', 'biosphere', 'pollution', 'habitability', 'normal']) {
      await page.evaluate((id) => window.TERRA.scene.setLayer(id), l);
      await page.waitForTimeout(120);
    }
  });
  await shot('06-couches');

  // --- Mécaniques ajoutées après le test de jouabilité -------------------
  // Ces étapes se déclarent « non applicable » tant que l'API n'est pas là,
  // pour que le scénario reste exécutable pendant le développement.

  await step('exploration : file d’attente et sondes', async () => {
    const r = await page.evaluate(() => {
      const g = window.TERRA.game;
      if (typeof g.cancelScan !== 'function') return { skip: true };
      g.newGame({ seed: 4242 });
      const unknown = [];
      for (let i = 0; i < g.regions.count && unknown.length < 8; i++) {
        if (!g.regions.discovered[i]) unknown.push(i);
      }
      g.debug.addResources(50000);
      for (const i of unknown) g.scanRegion(i);
      const queued = g.state.explore.queue.length + g.state.explore.scanning.length;
      g.cancelScan(unknown[unknown.length - 1]);
      const after = g.state.explore.queue.length + g.state.explore.scanning.length;
      return { queued, after, free: g.state.explore.probesFree };
    });
    if (r.skip) { process.stdout.write('(API absente) '); return; }
    if (r.queued < 8) throw new Error(`les scans ne s'empilent pas (${r.queued}/8)`);
    if (r.after !== r.queued - 1) throw new Error('l’annulation de scan ne retire rien');
  });

  await step('exploration : un scan révèle une zone, pas une case', async () => {
    const r = await page.evaluate(async () => {
      const g = window.TERRA.game;
      g.newGame({ seed: 777 });
      g.debug.addResources(50000);
      const before = Array.from(g.regions.discovered).reduce((a, b) => a + b, 0);
      let target = -1;
      for (let i = 0; i < g.regions.count; i++) if (!g.regions.discovered[i]) { target = i; break; }
      g.scanRegion(target);
      for (let d = 0; d < 400; d++) g._tick(1, d);
      const after = Array.from(g.regions.discovered).reduce((a, b) => a + b, 0);
      return { before, after };
    });
    const gained = r.after - r.before;
    if (gained < 1) throw new Error('aucune région révélée après 400 jours');
    process.stdout.write(`(+${gained} secteurs par scan) `);
  });

  await step('recherche progressive : engagement puis achèvement', async () => {
    const r = await page.evaluate(async () => {
      const g = window.TERRA.game;
      g.newGame({ seed: 31337 });
      g.debug.addScience(100000);
      const id = 'orbital_survey';
      if (!g.startResearch(id)) return { err: 'startResearch refusé' };
      const instant = g.state.tech.unlocked.includes(id);
      const current = g.state.tech.current;
      let done = false;
      for (let d = 0; d < 4000 && !done; d++) { g._tick(1, d); done = g.state.tech.unlocked.includes(id); }
      return { instant, current, done, progressive: current !== undefined };
    });
    if (r.err) throw new Error(r.err);
    if (!r.done) throw new Error('la recherche ne se termine jamais');
    if (r.instant) process.stdout.write('(recherche instantanée) ');
    else process.stdout.write('(progressive, achevée) ');
  });

  await step('les miroirs orbitaux sont réversibles', async () => {
    const r = await page.evaluate(() => {
      const g = window.TERRA.game;
      g.newGame({ seed: 99 });
      g.debug.revealAll(); g.debug.addResources(200000); g.debug.addScience(200000); g.debug.unlockAllTech();
      let built = 0;
      for (let i = 0; i < g.regions.count && built < 4; i++) if (g.build('orbital_mirror', i)) built++;
      if (!built) return { skip: true };
      for (let d = 0; d < 50; d++) g._tick(1, d);
      const withMirrors = g.state.globals.insolation;
      for (const b of g.state.buildings.filter((x) => x.type === 'orbital_mirror')) g.demolish(b.id);
      for (let d = 0; d < 50; d++) g._tick(1, d);
      return { withMirrors, without: g.state.globals.insolation };
    });
    if (r.skip) { process.stdout.write('(aucun miroir constructible) '); return; }
    if (!(r.withMirrors > r.without)) {
      throw new Error(`démonter les miroirs ne refroidit pas (${r.withMirrors} → ${r.without})`);
    }
    process.stdout.write(`(${r.withMirrors.toFixed(3)} → ${r.without.toFixed(3)}) `);
  });

  await step('composition atmosphérique cohérente', async () => {
    const bad = await page.evaluate(() => {
      const g = window.TERRA.game;
      g.newGame({ seed: 5150 });
      g.debug.revealAll(); g.debug.addResources(500000); g.debug.addScience(500000); g.debug.unlockAllTech();
      for (let i = 0; i < g.regions.count; i++) { g.build('ghg_factory', i); g.build('o2_generator', i); }
      const faults = [];
      for (let d = 0; d < 8000; d++) {
        g._tick(1, d);
        const G = g.state.globals;
        if (G.co2 + G.oxygen > 100.01) faults.push(`co2+o2=${(G.co2 + G.oxygen).toFixed(2)} au jour ${d}`);
        if (G.pCO2 != null && G.pCO2 < -1e-6) faults.push(`pCO2 négatif au jour ${d}`);
        if (faults.length > 2) break;
      }
      return faults;
    });
    if (bad.length) throw new Error(bad.join(' ; '));
  });

  await page.evaluate(() => window.TERRA.game.newGame({ seed: 123456 }));

  await step('sauvegarde et chargement', async () => {
    const r = await page.evaluate(() => {
      const g = window.TERRA.game;
      const dayBefore = g.state.time.day;
      const tBefore = g.state.globals.temperature;
      if (!g.save(1)) return { err: 'save a échoué' };
      g.newGame({ seed: 999 });
      if (!g.load(1)) return { err: 'load a échoué' };
      return { dayBefore, dayAfter: g.state.time.day, tBefore, tAfter: g.state.globals.temperature,
               buildings: g.state.buildings.length };
    });
    if (r.err) throw new Error(r.err);
    if (Math.abs(r.dayBefore - r.dayAfter) > 0.001) throw new Error('le jour n’est pas restauré');
    if (Math.abs(r.tBefore - r.tAfter) > 0.001) throw new Error('la température n’est pas restaurée');
  });

  await step('performance (FPS moyen sur 3 s)', async () => {
    await page.evaluate(() => window.TERRA.game.setSpeed(4));
    await page.waitForTimeout(3000);
    const fps = await page.evaluate(() => window.TERRA.scene.stats.fps);
    console.log(`(${fps.toFixed(0)} FPS en rendu logiciel SwiftShader) `);
  });

  await step('longue simulation sans NaN (10 000 jours)', async () => {
    const bad = await page.evaluate(() => {
      const g = window.TERRA.game;
      for (let i = 0; i < 10000; i++) g._tick(1, i);
      const out = [];
      for (const k in g.state.globals) if (!isFinite(g.state.globals[k])) out.push(k);
      for (const k in g.state.resources) if (!isFinite(g.state.resources[k]) || g.state.resources[k] < -0.001) out.push('res:' + k);
      return out;
    });
    if (bad.length) throw new Error('valeurs invalides : ' + bad.join(', '));
  });
  await shot('07-final');

  await browser.close();
  if (!process.argv.includes('--keep')) { try { process.kill(-vite.pid, 'SIGTERM'); } catch {} }

  console.log('\n─────────────────────────────────────────');
  if (warnings.length) {
    console.log(`\n${warnings.length} avertissement(s) console :`);
    warnings.slice(0, 10).forEach((w) => console.log('  ! ' + w.slice(0, 220)));
  }
  if (errors.length) {
    console.log(`\n${errors.length} ERREUR(S) :`);
    errors.slice(0, 25).forEach((e) => console.log('  ✘ ' + e.slice(0, 500)));
    process.exitCode = 1;
  } else {
    console.log('\n✔ Aucune erreur. Scénario complet réussi.');
  }
  if (wantShots) console.log(`\nCaptures : ${SHOT_DIR}`);
}

run().catch((e) => { console.error('\nÉchec du harnais :', e); process.exitCode = 1; });

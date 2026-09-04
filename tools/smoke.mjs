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

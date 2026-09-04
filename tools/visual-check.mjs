/**
 * ============================================================================
 *  TERRA NOVA — Instrument de contrôle VISUEL
 * ============================================================================
 *  Bâti sur le même harnais que tools/smoke.mjs (build de production + vite
 *  preview + Chromium headless), mais son but n'est pas de vérifier que le jeu
 *  fonctionne : c'est de PRODUIRE DES IMAGES qu'on regarde ensuite.
 *
 *  Chaque capture représente un « grand moment » du jeu, cadrée à une distance
 *  de caméra correcte (planète entière dans le champ, sauf pour les zooms).
 *
 *    node tools/visual-check.mjs            # toutes les captures
 *    node tools/visual-check.mjs a c e      # seulement celles dont le nom
 *                                           # commence par a-, c- ou e-
 *    node tools/visual-check.mjs --keep     # laisse le serveur tourner
 *
 *  Sortie : /tmp/tn-visual/*.png (surchargeable par SHOT_DIR).
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const SHOT_DIR = process.env.SHOT_DIR || '/tmp/tn-visual';
const PORT = 5600 + Math.floor(Math.random() * 300);
const KEEP = process.argv.includes('--keep');
/** Filtres passés en argument : `node tools/visual-check.mjs a c` → a-*, c-*. */
const FILTERS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/** Chromium : même stratégie de recherche que le test de fumée. */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

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

/**
 * On sert le BUILD, jamais `vite dev` : le rechargement à chaud réinitialise
 * la page dès qu'un shader est édité, ce qui ruinerait la capture en cours.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
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

/* -------------------------------------------------------------------------- */
/*  Cadrages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Place la caméra sans animation, dans la convention exacte d'OrbitControls
 * (x = sinφ·sinθ, y = cosφ, z = sinφ·cosθ). `dTheta`/`dPhi` sont RELATIFS à la
 * direction de l'étoile : 0 = pleine face éclairée, π = face nuit.
 *
 * NB : la fonction est passée telle quelle à page.evaluate (jamais sous forme
 * de chaîne — Playwright ignorerait alors l'argument et ne l'appellerait pas).
 */
function aimInPage(cfg) {
  const c = window.TERRA.scene.controls;
  const s = window.TERRA.scene.sunDirection;
  const sunPhi = Math.acos(Math.max(-1, Math.min(1, s.y)));
  const sunTheta = Math.atan2(s.x, s.z);
  c.autoRotate = false;
  c._focus = null;
  c.vTheta = 0; c.vPhi = 0;
  c.theta = sunTheta + cfg.dTheta;
  c.phi = Math.max(0.12, Math.min(Math.PI - 0.12, sunPhi + (cfg.dPhi || 0)));
  c.distance = cfg.dist;
  c.targetDistance = cfg.dist;
  c.target.set(0, 0, 0);
  c._applyCamera();
  return { theta: c.theta, phi: c.phi, dist: c.distance };
}

const errors = [];

async function run() {
  process.stdout.write('Build de production … ');
  await buildOnce();
  console.log('ok');
  const vite = await startServer();

  const exe = findChromium();
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  page.on('console', (msg) => {
    const t = msg.type();
    const where = msg.location?.().url || '';
    const text = msg.text() + (where ? ` [${where}]` : '');
    if (/audio\//.test(text)) return;
    if (t === 'error') errors.push(text);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));

  mkdirSync(SHOT_DIR, { recursive: true });

  const wanted = (name) => FILTERS.length === 0 || FILTERS.some((f) => name.startsWith(f));

  /** Capture nommée. Le rendu logiciel est lent : on laisse quelques frames. */
  const shot = async (name, settle = 900) => {
    if (!wanted(name)) return;
    await page.waitForTimeout(settle);
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
    console.log(`  · ${name}.png`);
  };
  const aim = async (cfg) => { await page.evaluate(aimInPage, cfg); };
  const hideUI = (hide) => page.evaluate((h) => {
    const el = document.getElementById('ui');
    if (el) el.style.display = h ? 'none' : '';
    const boot = document.getElementById('boot');
    if (boot) boot.style.display = 'none';
  }, hide);

  console.log(`\nCONTRÔLE VISUEL — TERRA NOVA  (${SHOT_DIR})\n`);

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await page.evaluate(() => window.TERRA.game.newGame({ seed: 20250904 }));
  await page.waitForTimeout(1200);
  await hideUI(true);

  /* --- a : planète vierge, tout est inexploré -------------------------- */
  await aim({ dTheta: -0.55, dPhi: 0.10, dist: 3.5 });
  await shot('a-vierge');

  /* --- capture de contrôle avec l'interface ---------------------------- */
  if (wanted('z-ui')) {
    await hideUI(false);
    await shot('z-ui-controle', 600);
    await hideUI(true);
  }

  /* --- b : tout révélé, monde mort ------------------------------------- */
  await page.evaluate(() => window.TERRA.game.debug.revealAll());
  await page.waitForTimeout(1400);   // l'animation de révélation dure ~0,9 s
  await aim({ dTheta: -0.55, dPhi: 0.10, dist: 3.5 });
  await shot('b-decouverte');

  /* --- terraformation complète ----------------------------------------- */
  // Deux temps :
  //  1. on joue VRAIMENT : on couvre la planète de terraformeurs, on débloque
  //     tout et on avance la simulation de plusieurs milliers de jours ;
  //  2. on impose ensuite l'état CIBLE de fin de partie (océans remplis,
  //     calottes réduites aux pôles, végétation installée, atmosphère dense).
  //     L'équilibrage de la simulation n'est pas l'objet de cet outil : ce qui
  //     est photographié ici, c'est le rendu d'un monde vivant, pour juger si
  //     les seuils du shader sont bien calés.
  const terra = await page.evaluate(() => {
    const g = window.TERRA.game;
    const d = g.debug;
    const R = g.regions;
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    d.addResources(5e7); d.addScience(5e7); d.unlockAllTech();
    const kinds = ['ghg_factory', 'atmo_processor', 'o2_generator', 'polar_melter',
      'orbital_mirror', 'fusion', 'seeder', 'biodome', 'colony', 'climate_stabilizer'];
    let built = 0;
    for (let pass = 0; pass < kinds.length; pass++) {
      for (let i = 0; i < R.count; i += 6) {
        if (g.build(kinds[(pass + i) % kinds.length], i)) built++;
      }
      d.addResources(5e7);
    }
    for (let i = 0; i < 6000; i++) {
      g._tick(1, i);
      if (i % 400 === 0) { d.addResources(5e7); d.addScience(5e7); }
    }

    /* --- état cible imposé -------------------------------------------- */
    const sea = window.TERRA.BALANCE.planet.seaLevel;
    const basin = window.TERRA.BALANCE.water.basinDepth;
    for (let i = 0; i < R.count; i++) {
      const lat = Math.abs(R.positions[i * 3 + 1]);          // 0 équateur, 1 pôle
      const depth = sea - R.elevation[i];
      const polar = clamp01((lat - 0.78) / 0.20);
      R.temperature[i] = 26 - 52 * lat * lat - R.elevation[i] * 22;
      if (depth > 0) {
        R.water[i] = basin * clamp01(0.35 + depth * 4.0);
        R.moisture[i] = 1;
        R.vegetation[i] = 0;
      } else {
        R.water[i] = 0;
        R.moisture[i] = clamp01(0.75 - R.elevation[i] * 1.1 - polar * 0.5);
        R.vegetation[i] = clamp01((0.95 - polar * 1.3) * (0.45 + R.moisture[i] * 0.75));
      }
      R.ice[i] = polar > 0 ? clamp01(polar * 1.4) : 0;
      if (R.ice[i] > 0.5) R.vegetation[i] = 0;
      R.pollution[i] = clamp01(R.pollution[i] * 0.5);
      R.population[i] = R.buildingCount[i] > 0 ? 900 + R.buildingCount[i] * 1400 : 0;
    }
    // Trois ticks : biomes, habitabilité et couverture globale se recalculent
    // à partir de l'état qu'on vient d'écrire.
    for (let i = 0; i < 3; i++) g._tick(1, i);

    const G = g.state.globals;
    G.temperature = 15.5;
    G.pressure = 97;
    G.oxygen = 21;
    G.co2 = 0.4;
    G.biomass = 64;
    G.stability = 92;
    G.cloudCover = 0.52;
    G.population = 420000;
    g.setSpeed(0);            // la simulation est gelée : l'image ne dérive plus
    g.markAllDirty();
    return {
      built, days: g.state.time.day | 0,
      waterCoverage: +G.waterCoverage.toFixed(3), iceCover: +G.iceCover.toFixed(3),
    };
  });
  console.log(`  (terraformation : ${terra.built} bâtiments, jour ${terra.days}, `
    + `eau ${terra.waterCoverage}, glace ${terra.iceCover})`);
  await page.waitForTimeout(2500);   // le lissage des globales converge

  /* --- c : monde vivant, même cadrage que a ---------------------------- */
  await aim({ dTheta: -0.55, dPhi: 0.10, dist: 3.5 });
  await shot('c-terraformee');

  /* --- d : face nuit ---------------------------------------------------- */
  await aim({ dTheta: Math.PI - 0.45, dPhi: 0.05, dist: 3.5 });
  await shot('d-nuit');

  /* --- e : limbe rasant (atmosphère + relief) --------------------------- */
  await aim({ dTheta: -1.45, dPhi: 0.35, dist: 2.4 });
  await shot('e-limbe');

  /* --- f/g/h : couches de données --------------------------------------- */
  await aim({ dTheta: -0.55, dPhi: 0.10, dist: 3.5 });
  for (const [layer, name] of [
    ['temperature', 'f-couche-temperature'],
    ['biosphere', 'g-couche-biosphere'],
    ['water', 'h-couche-eau'],
  ]) {
    await page.evaluate((l) => window.TERRA.scene.setLayer(l), layer);
    await shot(name, 1200);
  }
  await page.evaluate(() => window.TERRA.scene.setLayer('normal'));
  await page.waitForTimeout(900);

  /* --- i : zoom rapproché ----------------------------------------------- */
  await aim({ dTheta: -0.35, dPhi: 0.20, dist: 1.6 });
  await shot('i-zoom');

  /* --- j : contre-épreuve, planète vierge au même zoom ------------------ */
  if (wanted('j-zoom-vierge')) {
    await page.evaluate(() => window.TERRA.game.newGame({ seed: 20250904 }));
    await page.waitForTimeout(1400);
    await hideUI(true);
    await aim({ dTheta: -0.35, dPhi: 0.20, dist: 1.6 });
    await shot('j-zoom-vierge');
  }

  /* --- diagnostic chiffré : c'est lui qui permet de caler les seuils ---- */
  const diag = await page.evaluate(() => {
    const g = window.TERRA.game, sc = window.TERRA.scene, R = g.regions;
    const mean = (a) => { let s = 0; for (let i = 0; i < R.count; i++) s += a[i]; return s / R.count; };
    const max = (a) => { let m = 0; for (let i = 0; i < R.count; i++) m = Math.max(m, a[i]); return m; };
    return {
      globals: { ...g.state.globals },
      smoothed: { ...sc.smoothed },
      region: {
        water: +mean(R.water).toFixed(3), waterMax: +max(R.water).toFixed(3),
        ice: +mean(R.ice).toFixed(3),
        vegetation: +mean(R.vegetation).toFixed(3),
        moisture: +mean(R.moisture).toFixed(3),
        elevation: +mean(R.elevation).toFixed(3),
      },
      ocean: { visible: sc.planet.ocean.visible, scale: +sc.planet.ocean.scale.x.toFixed(4) },
      clouds: { visible: sc.clouds.mesh.visible, coverage: +sc.clouds.uniforms.uCoverage.value.toFixed(3) },
      atmo: { visible: sc.atmosphere.mesh.visible, scale: +sc.atmosphere.mesh.scale.x.toFixed(4) },
      stats: { ...sc.stats },
    };
  });
  console.log('\nDIAGNOSTIC :\n' + JSON.stringify(diag, null, 1));

  const stats = await page.evaluate(() => ({ ...window.TERRA.scene.stats }));
  await browser.close();
  if (!KEEP) { try { process.kill(-vite.pid, 'SIGTERM'); } catch {} }

  console.log(`\n${stats.drawCalls} draw calls, ${stats.triangles} triangles, ${stats.regions} régions`);
  console.log('─────────────────────────────────────────');
  if (errors.length) {
    console.log(`\n${errors.length} ERREUR(S) CONSOLE :`);
    errors.slice(0, 20).forEach((e) => console.log('  ✘ ' + e.slice(0, 400)));
    process.exitCode = 1;
  } else {
    console.log('\n✔ Aucune erreur console.');
  }
  console.log(`\nCaptures : ${SHOT_DIR}`);
}

run().catch((e) => { console.error('\nÉchec du harnais :', e); process.exitCode = 1; });

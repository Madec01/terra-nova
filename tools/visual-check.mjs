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
/**
 * Graine de la partie photographiée. 8919 est la partie de référence de
 * l'équilibrage (`node tools/balance-probe.mjs 8919 40`) : c'est elle qui donne
 * les valeurs auxquelles cet outil doit aboutir en JOUANT, et non en écrivant
 * l'état à la main.
 */
const SEED = 8919;
/** Années de jeu simulées avant la capture « terraformée ». */
const YEARS = 40;
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
  await page.evaluate((seed) => window.TERRA.game.newGame({ seed }), SEED);
  await page.waitForTimeout(1200);
  await hideUI(true);

  /* --- a : planète vierge, tout est inexploré -------------------------- */
  await aim({ dTheta: -1.05, dPhi: 0.16, dist: 3.5 });
  await shot('a-vierge');

  /* --- gros plan sur le site d'atterrissage (API focusRegion) ----------- */
  if (wanted('k-site')) {
    await page.evaluate(() => {
      const g = window.TERRA.game;
      window.TERRA.scene.controls.autoRotate = false;
      window.TERRA.scene.focusRegion(g.regions.landingSite ?? 0);
    });
    await shot('k-site', 1600);
  }

  /* --- capture de contrôle avec l'interface ---------------------------- */
  if (wanted('z-ui')) {
    await hideUI(false);
    await shot('z-ui-controle', 600);
    await hideUI(true);
  }

  /* --- b : tout révélé, monde mort ------------------------------------- */
  await page.evaluate(() => window.TERRA.game.debug.revealAll());
  await page.waitForTimeout(1400);   // l'animation de révélation dure ~0,9 s
  await aim({ dTheta: -1.05, dPhi: 0.16, dist: 3.5 });
  await shot('b-decouverte');

  /* --- terraformation : ON JOUE VRAIMENT LA PARTIE ---------------------- */
  // Aucune valeur n'est écrite à la main. Un « joueur automatique » (le même
  // que celui de tools/balance-probe.mjs) explore, cherche, construit ET
  // DÉMONTE pendant YEARS années de simulation. C'est le seul état sur lequel
  // il est honnête de caler des seuils de rendu : un état imposé produirait des
  // combinaisons (eau, glace, végétation) que la simulation ne génère jamais.
  //
  // Référence attendue à la fin (seed 8919, an 40, cf. balance-probe) :
  //   T ≈ 21 °C · P ≈ 87 kPa · O2 ≈ 24 % · eau ≈ 23 % · biomasse ≈ 86
  //   ~190 bâtiments · végétation moyenne ≈ 0,7 · glace moyenne ≈ 0,04
  const terra = await page.evaluate((years) => {
    const g = window.TERRA.game;
    const S = g.state, R = g.regions;
    const BAL = window.TERRA.BALANCE;

    /* Ordre de recherche d'un joueur qui vise la victoire. */
    const PLAN = [
      'orbital_survey', 'geothermal_tap', 'metallurgy', 'greenhouse_gases', 'exobiology',
      'energy_grid', 'polar_engineering', 'automation', 'pioneer_organisms',
      'atmospheric_engineering', 'orbital_infrastructure', 'forestation',
      'carbon_capture', 'fusion', 'colonization', 'climate_control',
      'ecosystems', 'deep_drilling', 'terraform_mastery',
    ];
    const TARGET_T = { low: 4, high: 22, panic: 27 };

    const ranked = (scoreFn) => {
      const out = [];
      for (let i = 0; i < R.count; i++) if (R.discovered[i]) out.push([i, scoreFn(i)]);
      out.sort((a, b) => b[1] - a[1]);
      return out.map((x) => x[0]);
    };
    const tryBuildMany = (type, wanted, scoreFn) => {
      let built = 0;
      for (const i of ranked(scoreFn)) {
        if (built >= wanted) break;
        if (g.canBuild(type, i).ok && g.build(type, i)) built++;
      }
      return built;
    };
    const count = (t) => S.buildings.filter((b) => b.type === t).length;
    const demolishSome = (type, n) => {
      const list = S.buildings.filter((b) => b.type === type);
      let done = 0;
      for (let k = list.length - 1; k >= 0 && done < n; k--) if (g.demolish(list[k].id)) done++;
      return done;
    };

    function play() {
      const gl = S.globals;
      for (let i = 0; i < R.count; i++) {
        if (!R.discovered[i] && S.explore.scanning.length < 4) g.scanRegion(i);
      }
      for (const id of PLAN) if (g.canResearch(id).ok) { g.startResearch(id); break; }

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
      const waterScore = (i) => R.ice[i] + R.water[i] / BAL.water.basinDepth + R.moisture[i];
      if (count('ice_extractor') < 16 && (S.flux.water <= 0.5 || S.resources.water < 250)) {
        tryBuildMany('ice_extractor', 1, waterScore);
      }
      if (count('refinery') < 5) tryBuildMany('refinery', 1, (i) => R.minerals[i]);

      if (gl.temperature < TARGET_T.low) {
        if (count('ghg_factory') < 12) tryBuildMany('ghg_factory', 1, (i) => 1 - R.pollution[i]);
        if (count('polar_melter') < 8) tryBuildMany('polar_melter', 1, (i) => R.ice[i]);
        if (count('orbital_mirror') < 8 && gl.temperature < TARGET_T.low - 2) {
          tryBuildMany('orbital_mirror', 1, (i) => -i);
        }
      }
      if (gl.temperature > TARGET_T.high || (gl.dTemperature > 1.5 && gl.temperature > TARGET_T.low)) {
        if (!demolishSome('orbital_mirror', 1)) {
          if (!demolishSome('ghg_factory', 1)) demolishSome('polar_melter', 1);
        }
      }
      if (gl.temperature > TARGET_T.panic) { demolishSome('orbital_mirror', 2); demolishSome('ghg_factory', 2); }

      if (gl.pressure < 82 && count('atmo_processor') < 14) {
        tryBuildMany('atmo_processor', 1, (i) => R.geothermal[i]);
      }
      if (gl.pressure > 30 && gl.oxygen < 19 && gl.co2 > 12 && count('o2_generator') < 12) {
        tryBuildMany('o2_generator', 1, (i) => -i);
      }
      if (gl.co2 < 7 && count('o2_generator') > 0) demolishSome('o2_generator', 2);

      if (gl.temperature > -22 && count('biodome') < 12) {
        tryBuildMany('biodome', 1, (i) => R.habitability[i] * 2 + R.moisture[i]);
      }
      if (gl.biomass > 3 && count('seeder') < 10) tryBuildMany('seeder', 1, (i) => R.vegetation[i]);
      if (gl.stability < 78 && count('climate_stabilizer') < 5) {
        tryBuildMany('climate_stabilizer', 1, (i) => -i);
      }
      if (count('colony') < 8) {
        tryBuildMany('colony', 1, (i) => R.habitability[i] * 2 + R.vegetation[i]
          + Math.min(1, R.water[i] / BAL.water.basinDepth + R.moisture[i]));
      }
    }

    const days = years * 365;
    let victoryDay = null;
    for (let d = 0; d < days; d++) {
      g._tick(1, d);
      if (d % 20 === 0) play();
      if (S.progress.victory && victoryDay === null) victoryDay = d;
    }

    g.setSpeed(0);          // la simulation est gelée : l'image ne dérive plus
    g.markAllDirty();

    const kinds = {};
    for (const b of S.buildings) kinds[b.type] = (kinds[b.type] || 0) + 1;
    return {
      built: S.buildings.length, kinds, day: S.time.day | 0,
      victoryYear: victoryDay === null ? null : +(victoryDay / 365).toFixed(1),
    };
  }, YEARS);
  console.log(`  (partie jouée : ${terra.built} bâtiments, jour ${terra.day}, `
    + `victoire an ${terra.victoryYear ?? '—'})`);
  console.log('   types : ' + Object.entries(terra.kinds)
    .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', '));
  await page.waitForTimeout(2500);   // le lissage des globales converge

  /* --- c : monde vivant, même cadrage que a ---------------------------- */
  await aim({ dTheta: -1.05, dPhi: 0.16, dist: 3.5 });
  await shot('c-terraformee');

  /* --- surface seule : isole l'origine d'un artefact -------------------- */
  // Toutes les couches optionnelles RETIRÉES DE LA SCÈNE (et non simplement
  // masquées : _syncGlobals rallume leur visibilité à chaque frame). Si un
  // défaut survit à cette capture, il vient du shader de surface ; sinon c'est
  // un conflit entre deux couches.
  if (wanted('y-surface')) {
    await page.evaluate(() => {
      const sc = window.TERRA.scene;
      sc.scene.remove(sc.atmosphere.object3D);
      sc.scene.remove(sc.clouds.object3D);
      sc.scene.remove(sc.structures.object3D);
      sc.scene.remove(sc.overlay.object3D);
      sc.planet.object3D.remove(sc.planet.ocean);
    });
    await shot('y-surface-seule', 900);
    await page.evaluate(() => {
      const sc = window.TERRA.scene;
      sc.scene.add(sc.atmosphere.object3D);
      sc.scene.add(sc.clouds.object3D);
      sc.scene.add(sc.structures.object3D);
      sc.scene.add(sc.overlay.object3D);
      sc.planet.object3D.add(sc.planet.ocean);
    });
    await page.waitForTimeout(400);
  }

  /* --- d : face nuit ---------------------------------------------------- */
  await aim({ dTheta: Math.PI - 0.45, dPhi: 0.05, dist: 3.5 });
  await shot('d-nuit');

  /* --- e : limbe rasant (atmosphère + relief) --------------------------- */
  await aim({ dTheta: -1.45, dPhi: 0.35, dist: 2.4 });
  await shot('e-limbe');

  /* --- f/g/h : couches de données --------------------------------------- */
  await aim({ dTheta: -1.05, dPhi: 0.16, dist: 3.5 });
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

  /* --- l : les BÂTIMENTS à trois distances ------------------------------ */
  // C'est la série qui juge la couche StructureLayer : pleine taille (l1),
  // début de l'atténuation (l2) et vue d'ensemble (l3, où il ne doit plus
  // rester qu'une planète). Le limbe est cadré exprès : c'est là qu'un
  // bâtiment mal ancré se met à flotter.
  for (const [name, cfg] of [
    ['l1-batiments-pres', { dTheta: -0.75, dPhi: 0.30, dist: 1.85 }],
    ['l2-batiments-limbe', { dTheta: -1.38, dPhi: 0.30, dist: 2.10 }],
    ['l3-batiments-loin', { dTheta: -0.90, dPhi: 0.18, dist: 3.05 }],
    // Côté nuit rapproché : c'est la seule image qui juge l'émissif (fenêtres,
    // voyants). Il doit se voir, sans transformer les bâtiments en lampions.
    ['l4-batiments-nuit', { dTheta: Math.PI - 0.55, dPhi: 0.12, dist: 1.95 }],
  ]) {
    await aim(cfg);
    await shot(name);
  }

  /* --- diagnostic chiffré : AVANT toute réinitialisation ---------------- */
  // (il portait autrefois sur la partie vierge relancée pour j-zoom-vierge,
  //  et ne décrivait donc pas du tout l'état photographié.)
  const diag = await page.evaluate(() => {
    const g = window.TERRA.game, sc = window.TERRA.scene, R = g.regions;
    const mean = (a) => { let s = 0; for (let i = 0; i < R.count; i++) s += a[i]; return s / R.count; };
    const max = (a) => { let m = 0; for (let i = 0; i < R.count; i++) m = Math.max(m, a[i]); return m; };
    const above = (a, t) => { let n = 0; for (let i = 0; i < R.count; i++) if (a[i] > t) n++; return +(n / R.count).toFixed(3); };
    return {
      globals: { ...g.state.globals },
      smoothed: { ...sc.smoothed },
      region: {
        water: +mean(R.water).toFixed(3), waterMax: +max(R.water).toFixed(3),
        waterAbove05: above(R.water, 0.05),
        ice: +mean(R.ice).toFixed(3), iceAbove30: above(R.ice, 0.30),
        vegetation: +mean(R.vegetation).toFixed(3), vegAbove30: above(R.vegetation, 0.30),
        moisture: +mean(R.moisture).toFixed(3),
        elevation: +mean(R.elevation).toFixed(3),
        populationMax: Math.round(max(R.population)),
        // Températures RÉGIONALES : c'est sur elles que travaille la rampe
        // thermique, alors qu'elle est centrée sur la moyenne GLOBALE. Si les
        // deux divergent, la couche est biaisée — d'où ce contrôle.
        tempMin: +Math.min(...R.temperature).toFixed(1),
        tempMean: +mean(R.temperature).toFixed(1),
        tempMax: +Math.max(...R.temperature).toFixed(1),
        tempBelow0: above(R.temperature, 0) !== undefined ? +(1 - above(R.temperature, 0)).toFixed(3) : 0,
      },
      ocean: { visible: sc.planet.ocean.visible, scale: +sc.planet.ocean.scale.x.toFixed(4) },
      clouds: { visible: sc.clouds.mesh.visible, coverage: +sc.clouds.uniforms.uCoverage.value.toFixed(3) },
      atmo: { visible: sc.atmosphere.mesh.visible, scale: +sc.atmosphere.mesh.scale.x.toFixed(4) },
      stats: { ...sc.stats },
    };
  });
  console.log('\nDIAGNOSTIC (état RÉELLEMENT joué) :\n' + JSON.stringify(diag, null, 1));

  /* --- j : contre-épreuve, planète vierge au même zoom ------------------ */
  if (wanted('j-zoom-vierge')) {
    await page.evaluate((seed) => window.TERRA.game.newGame({ seed }), SEED);
    await page.waitForTimeout(1400);
    await hideUI(true);
    await aim({ dTheta: -0.35, dPhi: 0.20, dist: 1.6 });
    await shot('j-zoom-vierge');
  }

  /* --- m : VITRINE des 17 modèles --------------------------------------- */
  // Catalogue de rendu : un exemplaire de chaque type sur des cellules
  // voisines, éclairage rasant. C'est la seule image qui permet de juger si
  // les silhouettes restent distinguables les unes des autres. Les entrées
  // sont poussées directement dans state.buildings : on photographie ici la
  // COUCHE DE RENDU, pas une situation de jeu (aucune règle n'est contournée
  // ailleurs dans cet outil).
  if (wanted('m-vitrine')) {
    const vit = await page.evaluate(() => {
      const g = window.TERRA.game, sc = window.TERRA.scene, R = g.regions;
      g.newGame({ seed: 4242 });
      g.debug.revealAll();
      g.setSpeed(0);

      // Cellule de référence : à 45° de l'étoile → lumière rasante, les
      // volumes se lisent. (Face à l'étoile, tout est plat.)
      const s = sc.sunDirection;
      let ux = -s.y, uy = s.x, uz = 0;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const c = Math.cos(0.72), si = Math.sin(0.72);
      const dx = s.x * c + ux * si, dy = s.y * c + uy * si, dz = s.z * c + uz * si;
      let best = 0, bestDot = -2;
      for (let i = 0; i < R.count; i++) {
        const d = R.positions[i * 3] * dx + R.positions[i * 3 + 1] * dy + R.positions[i * 3 + 2] * dz;
        if (d > bestDot) { bestDot = d; best = i; }
      }

      // Parcours en largeur : autant de cellules voisines que de types.
      const list = ['mine', 'refinery', 'depot', 'solar', 'geothermal', 'fusion',
        'science_station', 'ice_extractor', 'ghg_factory', 'atmo_processor',
        'o2_generator', 'polar_melter', 'orbital_mirror', 'climate_stabilizer',
        'biodome', 'seeder', 'colony'];
      const seen = new Set([best]);
      const order = [best];
      for (let h = 0; h < order.length && order.length < list.length; h++) {
        for (const n of R.neighbors(order[h])) {
          if (!seen.has(n)) { seen.add(n); order.push(n); if (order.length >= list.length) break; }
        }
      }
      g.state.buildings.length = 0;
      list.forEach((t, k) => {
        g.state.buildings.push({ id: 'vit' + k, type: t, region: order[k % order.length], active: true });
      });
      sc.syncBuildings(g.state);

      // VUE OBLIQUE. Viser le centre de la planète donne fatalement une vue
      // en plan (des toits, aucune silhouette). On vise donc la CELLULE, et on
      // place la caméra à 50° de sa verticale locale : c'est l'angle auquel un
      // joueur regarde ses bâtiments, et le seul qui montre les volumes.
      const cc = sc.controls;
      cc.autoRotate = false; cc._focus = null; cc.vTheta = 0; cc.vPhi = 0;
      const p = R.positions;
      const nx = p[best * 3], ny = p[best * 3 + 1], nz = p[best * 3 + 2];
      // On s'écarte PERPENDICULAIREMENT au plan qui contient l'étoile : la
      // lumière arrive alors de côté et sculpte les volumes. En s'écartant vers
      // l'étoile on obtiendrait au contraire un éclairage frontal, tout plat.
      let tx = s.x - nx * (s.x * nx + s.y * ny + s.z * nz);
      let ty = s.y - ny * (s.x * nx + s.y * ny + s.z * nz);
      let tz = s.z - nz * (s.x * nx + s.y * ny + s.z * nz);
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const ca = Math.cos(0.87), sa = Math.sin(0.87);   // 50°
      const vx = nx * ca + bx * sa, vy = ny * ca + by * sa, vz = nz * ca + bz * sa;
      cc.theta = Math.atan2(vx, vz);
      cc.phi = Math.max(0.02, Math.min(Math.PI - 0.02, Math.acos(Math.max(-1, Math.min(1, vy)))));
      cc.distance = 0.95; cc.targetDistance = 0.95;
      const cr = sc.planet.cellRadius[best];
      cc.target.set(nx * cr, ny * cr, nz * cr);
      cc._applyCamera();
      return { region: best, placed: list.length, cells: order.length };
    });
    console.log(`  (vitrine : ${vit.placed} modèles sur ${vit.cells} cellules)`);
    await shot('m-vitrine', 2200);
  }


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

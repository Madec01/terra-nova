/**
 * ============================================================================
 *  TERRA NOVA — Vérification des pictogrammes
 * ============================================================================
 *  Ce que cet outil PROUVE, dans un vrai navigateur, sur le build de
 *  production :
 *
 *   1. la planche se charge — aucune 404, aucune erreur de console, le jeu
 *      démarre toujours ;
 *   2. les 17 icônes de bâtiment sont DISTINCTES : elles sont composées sur le
 *      fond du jeu, ramenées à la taille où le joueur les voit vraiment, puis
 *      comparées deux à deux — 136 paires, trois mesures indépendantes
 *      (couleur, forme, intérieur de la plaque). La troisième est le critère
 *      dur : c'est celui qui avait piégé les modèles 3D, tous réduits à
 *      « une tache sombre avec un mât » ;
 *   3. les marqueurs apparaissent sur les bâtiments construits, et
 *      disparaissent quand on dézoome ;
 *   4. ils coûtent UN SEUL draw call, quel que soit le nombre de bâtiments.
 *
 *  Les captures sont déposées dans /tmp/tn-sprites/ — elles sont faites pour
 *  être REGARDÉES, aucune mesure ne remplace l'œil.
 *
 *    node tools/sprite-check.mjs
 * ============================================================================
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const DOSSIER = process.env.SHOT_DIR || '/tmp/tn-sprites';
const PORT = 5600 + Math.floor(Math.random() * 300);

/**
 * Seuils de distinction, en pourcentage d'écart quadratique moyen. Trois
 * mesures indépendantes, chacune avec son plancher : une paire est signalée
 * dès qu'elle passe SOUS L'UN d'eux.
 *
 *  couleur — l'icône composée sur le fond du jeu, en RVB. C'est « à quoi ça
 *            ressemble », teinte comprise.
 *  forme   — la même image en luminance NORMALISÉE : la couleur est neutralisée,
 *            seule la structure compte.
 *  glyphe  — la forme, restreinte à l'intérieur de la plaque. C'est le critère
 *            qui sépare deux icônes d'une MÊME catégorie, dont les plaques sont
 *            volontairement identiques.
 *
 * Les planchers sont posés nettement sous les valeurs mesurées (13,0 / 16,9 /
 * 29,6 au moment de leur calage) : ils ne certifient pas la beauté du jeu
 * d'icônes, ils empêchent une RÉGRESSION de passer inaperçue.
 */
const SEUIL_COULEUR = 10;
const SEUIL_FORME = 13;
const SEUIL_GLYPHE = 22;
/** Taille à laquelle on compare : celle du marqueur à l'écran. */
const TAILLE_COMPARAISON = 32;
/** Fond sur lequel les icônes sont composées : celui de la planète de nuit. */
const FOND = '#0a0f16';

const TYPES = ['mine', 'refinery', 'depot', 'solar', 'geothermal', 'fusion',
  'science_station', 'ice_extractor', 'ghg_factory', 'atmo_processor',
  'o2_generator', 'polar_melter', 'orbital_mirror', 'climate_stabilizer',
  'biodome', 'seeder', 'colony'];

/* -------------------------------------------------------------------------- */

function trouverChromium() {
  const c = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const x of c) if (existsSync(x)) return x;
  return undefined;
}

function construire() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('Échec du build :\n' + out))));
  });
}

function servir() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* déjà mort */ } };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(130); });
    let out = '';
    const to = setTimeout(() => rej(new Error('serveur muet :\n' + out)), 30000);
    p.stdout.on('data', (d) => { out += d; if (/Local:.*http/.test(out)) { clearTimeout(to); res(p); } });
    p.stderr.on('data', (d) => { out += d; });
  });
}

/* -------------------------------------------------------------------------- */

const erreurs = [];
let echecs = 0;

const ok = (msg) => console.log('    ✔ ' + msg);
const ko = (msg) => { console.log('    ✘ ' + msg); echecs++; };

/**
 * Le corps de la vérification. Il est appelé depuis `run()`, qui garantit dans
 * TOUS les cas la fermeture du navigateur et du serveur : sans ce filet, une
 * exception laissait un processus détaché vivant et Node ne rendait jamais la
 * main.
 */
async function verifier(port, page) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() + (m.location?.().url ? ` [${m.location().url}]` : '');
    if (/audio\//.test(t)) return;          // 404 audio : attendues, documentées
    erreurs.push(t);
  });
  page.on('pageerror', (e) => erreurs.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/audio\//.test(r.url())) erreurs.push(r.status() + ' ' + r.url()); });
  page.on('requestfailed', (r) => { if (!/\/audio\//.test(r.url())) erreurs.push('ÉCHEC ' + r.url()); });

  console.log('\nPICTOGRAMMES — VÉRIFICATION\n');

  /* ================================================================== */
  console.log('  1. Chargement');
  /* ================================================================== */
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 25000 });

  const atlasPrete = await page.waitForFunction(
    () => window.TERRA.scene.markers && window.TERRA.scene.markers.ready,
    { timeout: 10000 }).then(() => true).catch(() => false);
  atlasPrete ? ok('la planche embarquée est décodée (aucune requête réseau)')
    : ko('la planche embarquée ne se décode pas');

  // La planche COMMISE dans public/ doit rester servie et lisible : c'est la
  // référence que compare l'étape 2, et sa présence prouve que le build la
  // recopie bien à la racine.
  const fichier = await page.evaluate(async () => {
    const r = await fetch('./sprites/atlas.png');
    return { status: r.status, octets: r.ok ? (await r.blob()).size : 0 };
  });
  fichier.status === 200
    ? ok(`public/sprites/atlas.png servi — ${(fichier.octets / 1024).toFixed(1)} ko`)
    : ko(`public/sprites/atlas.png : HTTP ${fichier.status}`);

  /* ================================================================== */
  console.log('\n  2. Distinction des 17 icônes (136 paires)');
  /* ================================================================== */
  const distinction = await page.evaluate(async ({ types, taille, fond }) => {
    const meta = await (await fetch('./sprites/atlas.json')).json();
    const img = new Image();
    img.src = './sprites/atlas.png';
    await img.decode();

    const c = document.createElement('canvas');
    c.width = taille; c.height = taille;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    // Masque de l'intérieur de la plaque : un disque des 60 % centraux.
    const n = taille * taille;
    const masque = new Uint8Array(n);
    const R = taille * 0.30;
    for (let y = 0; y < taille; y++) {
      for (let x = 0; x < taille; x++) {
        const dx = x - taille / 2 + 0.5, dy = y - taille / 2 + 0.5;
        masque[y * taille + x] = (dx * dx + dy * dy) <= R * R ? 1 : 0;
      }
    }

    // Chaque icône est composée sur le fond du jeu puis ramenée à la taille où
    // le joueur la voit : c'est LÀ que se juge la distinction, pas à 96 pixels.
    const vignettes = {};
    for (const t of types) {
      const f = meta.frames[t];
      if (!f) throw new Error('case absente : ' + t);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = fond;
      g.fillRect(0, 0, taille, taille);
      g.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, taille, taille);
      const d = g.getImageData(0, 0, taille, taille).data;
      const rgb = new Float64Array(n * 3);
      const lum = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const o = k * 4;
        rgb[k * 3] = d[o] / 255; rgb[k * 3 + 1] = d[o + 1] / 255; rgb[k * 3 + 2] = d[o + 2] / 255;
        lum[k] = (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) / 255;
      }
      // Luminance normalisée : deux icônes de teintes différentes mais de même
      // dessin doivent se ressembler sur CETTE mesure — c'est le but.
      let mn = 1, mx = 0;
      for (const v of lum) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const etendue = Math.max(1e-3, mx - mn);
      const norm = new Float64Array(n);
      for (let k = 0; k < n; k++) norm[k] = (lum[k] - mn) / etendue;
      vignettes[t] = { rgb, norm };
    }

    const paires = [];
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const a = vignettes[types[i]], b = vignettes[types[j]];
        let sc = 0, sf = 0, sg = 0, ng = 0;
        for (let k = 0; k < n; k++) {
          for (let ch = 0; ch < 3; ch++) {
            const d = a.rgb[k * 3 + ch] - b.rgb[k * 3 + ch];
            sc += d * d;
          }
          const df = a.norm[k] - b.norm[k];
          sf += df * df;
          if (masque[k]) { sg += df * df; ng++; }
        }
        paires.push({
          a: types[i], b: types[j],
          couleur: Math.sqrt(sc / (n * 3)) * 100,
          forme: Math.sqrt(sf / n) * 100,
          glyphe: Math.sqrt(sg / Math.max(1, ng)) * 100,
        });
      }
    }
    paires.sort((x, y) => (x.couleur + x.forme + x.glyphe) - (y.couleur + y.forme + y.glyphe));
    return paires;
  }, { types: TYPES, taille: TAILLE_COMPARAISON, fond: FOND });

  const suspectes = distinction.filter((p) => p.couleur < SEUIL_COULEUR
    || p.forme < SEUIL_FORME || p.glyphe < SEUIL_GLYPHE);

  console.log('     les 6 paires les plus proches (écart quadratique moyen, %) :');
  for (const p of distinction.slice(0, 6)) {
    console.log(`       ${(p.a + ' / ' + p.b).padEnd(38)}`
      + ` couleur ${p.couleur.toFixed(1).padStart(5)}`
      + `   forme ${p.forme.toFixed(1).padStart(5)}`
      + `   glyphe ${p.glyphe.toFixed(1).padStart(5)}`);
  }
  const mini = (k) => Math.min(...distinction.map((p) => p[k]));
  const median = distinction.map((p) => p.couleur).sort((a, b) => a - b)[distinction.length >> 1];
  if (suspectes.length) {
    for (const p of suspectes) {
      ko(`trop ressemblantes : ${p.a} / ${p.b}`
        + ` (${p.couleur.toFixed(1)} / ${p.forme.toFixed(1)} / ${p.glyphe.toFixed(1)})`);
    }
  } else {
    ok(`${distinction.length} paires comparées, aucune sous les planchers`
      + ` (${SEUIL_COULEUR} / ${SEUIL_FORME} / ${SEUIL_GLYPHE})`);
    ok(`écarts minimaux : couleur ${mini('couleur').toFixed(1)} %,`
      + ` forme ${mini('forme').toFixed(1)} %, glyphe ${mini('glyphe').toFixed(1)} %`
      + ` — couleur médiane ${median.toFixed(1)} %`);
  }

  // Le tutoriel masque la moitié de l'écran : on le referme, les captures
  // servent à REGARDER la planète.
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('button')) {
      if (/^\s*Passer\s*$/.test(b.textContent || '')) { b.click(); return; }
    }
  });

  /* ================================================================== */
  console.log('\n  3. Marqueurs en situation');
  /* ================================================================== */

  // Vitrine : un exemplaire de chaque type sur des cellules voisines. Les
  // entrées sont poussées dans state.buildings — on photographie la COUCHE DE
  // RENDU, pas une situation de jeu (même procédé que tools/visual-check.mjs).
  const pose = await page.evaluate((types) => {
    const g = window.TERRA.game, sc = window.TERRA.scene;
    g.newGame({ seed: 4242 });
    g.debug.revealAll();
    g.setSpeed(0);
    // ATTENTION : `newGame` reconstruit la planète — il faut relire `regions`
    // APRÈS, sinon on garde la référence nulle de l'écran d'accueil.
    const R = g.regions;

    const s = sc.sunDirection;
    let best = 0, bestDot = -2;
    for (let i = 0; i < R.count; i++) {
      const d = R.positions[i * 3] * s.x + R.positions[i * 3 + 1] * s.y + R.positions[i * 3 + 2] * s.z;
      if (d > bestDot) { bestDot = d; best = i; }
    }
    const vus = new Set([best]);
    const ordre = [best];
    for (let h = 0; h < ordre.length && ordre.length < types.length; h++) {
      for (const v of R.neighbors(ordre[h])) {
        if (!vus.has(v)) { vus.add(v); ordre.push(v); if (ordre.length >= types.length) break; }
      }
    }
    g.state.buildings.length = 0;
    types.forEach((t, k) => {
      g.state.buildings.push({ id: 'spr' + k, type: t, region: ordre[k % ordre.length], active: k !== 3 });
    });
    sc.syncBuildings(g.state);
    return { region: best, poses: g.state.buildings.length, instances: sc.markers.count };
  }, TYPES);

  pose.instances === TYPES.length
    ? ok(`${pose.instances} marqueurs instanciés pour ${pose.poses} bâtiments`)
    : ko(`${pose.instances} marqueurs pour ${pose.poses} bâtiments`);

  /** Place la caméra en vue oblique sur une cellule, à la distance demandée. */
  const cadrer = (region, distance) => page.evaluate(({ region: r, distance: d }) => {
    const sc = window.TERRA.scene, R = window.TERRA.game.regions, cc = sc.controls;
    const p = R.positions;
    const nx = p[r * 3], ny = p[r * 3 + 1], nz = p[r * 3 + 2];
    cc.autoRotate = false; cc._focus = null; cc.vTheta = 0; cc.vPhi = 0;
    // Vue oblique : viser le centre donnerait une vue en plan, où les
    // marqueurs se superposeraient aux toits.
    const s = sc.sunDirection;
    const dot = s.x * nx + s.y * ny + s.z * nz;
    let tx = s.x - nx * dot, ty = s.y - ny * dot, tz = s.z - nz * dot;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const ca = Math.cos(0.80), sa = Math.sin(0.80);
    const vx = nx * ca + bx * sa, vy = ny * ca + by * sa, vz = nz * ca + bz * sa;
    cc.theta = Math.atan2(vx, vz);
    cc.phi = Math.max(0.02, Math.min(Math.PI - 0.02, Math.acos(Math.max(-1, Math.min(1, vy)))));
    cc.distance = d; cc.targetDistance = d;
    const cr = sc.planet.cellRadius[r];
    cc.target.set(nx * cr, ny * cr, nz * cr);
    cc._applyCamera();
  }, { region, distance });

  const mesurer = () => page.evaluate(() => ({
    visibles: window.TERRA.scene.markers.countVisible(window.TERRA.scene.camera),
    total: window.TERRA.scene.markers.count,
    draws: window.TERRA.scene.stats.drawCalls,
  }));

  await cadrer(pose.region, 0.95);
  await page.waitForTimeout(900);
  const proche = await mesurer();
  await page.screenshot({ path: `${DOSSIER}/1-proche.png` });

  await cadrer(pose.region, 1.60);
  await page.waitForTimeout(900);
  const moyen = await mesurer();
  await page.screenshot({ path: `${DOSSIER}/2-moyen.png` });

  // Dézoom complet : cadrage par défaut de SceneManager, planète entière.
  await page.evaluate(() => {
    const sc = window.TERRA.scene, cc = sc.controls;
    cc.target.set(0, 0, 0);
    const f = sc.fitDistance || 3.1;
    cc.distance = f; cc.targetDistance = f;
    cc._applyCamera();
  });
  await page.waitForTimeout(900);
  const loin = await mesurer();
  await page.screenshot({ path: `${DOSSIER}/3-loin.png` });

  proche.visibles >= 8
    ? ok(`vue rapprochée (0,95) : ${proche.visibles} / ${proche.total} marqueurs visibles`)
    : ko(`vue rapprochée : seulement ${proche.visibles} marqueurs visibles`);
  moyen.visibles >= 1
    ? ok(`vue intermédiaire (1,60) : ${moyen.visibles} marqueurs encore lisibles`)
    : ko('vue intermédiaire : plus aucun marqueur');
  loin.visibles === 0
    ? ok('planète entière : aucun marqueur — la vue d’ensemble reste propre')
    : ko(`planète entière : ${loin.visibles} marqueurs restent affichés`);

  /* ================================================================== */
  console.log('\n  4. Coût de rendu');
  /* ================================================================== */
  await cadrer(pose.region, 0.95);
  await page.waitForTimeout(700);
  const cout = await page.evaluate(async () => {
    const sc = window.TERRA.scene;
    const attendre = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    sc.setMarkersVisible(false); await attendre(); await attendre();
    const sans = sc.stats.drawCalls;
    sc.setMarkersVisible(true); await attendre(); await attendre();
    const avec = sc.stats.drawCalls;
    return { sans, avec, triangles: sc.stats.triangles };
  });
  const delta = cout.avec - cout.sans;
  delta === 1
    ? ok(`${cout.avec} draw calls au total — les 17 marqueurs en coûtent ${delta}`)
    : ko(`les marqueurs coûtent ${delta} draw calls (attendu : 1)`);

  /* ================================================================== */
  console.log('\n  5. Console');
  /* ================================================================== */
  if (erreurs.length) {
    erreurs.slice(0, 8).forEach((e) => ko(e.slice(0, 220)));
  } else ok('aucune erreur, aucune ressource manquante');

  console.log(`\nCaptures : ${DOSSIER}`);
}

async function run() {
  mkdirSync(DOSSIER, { recursive: true });
  process.stdout.write('Build de production … ');
  await construire();
  console.log('ok');

  const serveur = await servir();
  const navigateur = await chromium.launch({
    executablePath: trouverChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await navigateur.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await verifier(PORT, page);
  } catch (e) {
    console.error('\nÉchec du harnais :', e && (e.stack || e.message) || e);
    echecs++;
  } finally {
    await navigateur.close().catch(() => {});
    try { process.kill(-serveur.pid, 'SIGTERM'); } catch { /* déjà mort */ }
  }

  console.log(echecs ? `\n✘ ${echecs} vérification(s) en échec.\n` : '\n✔ Pictogrammes conformes.\n');
  if (echecs) process.exitCode = 1;
}

run();

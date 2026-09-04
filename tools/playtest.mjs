/**
 * ============================================================================
 *  TERRA NOVA — HARNAIS DE TEST DE JOUABILITÉ
 * ============================================================================
 *
 *   node tools/playtest.mjs               # partie complète, 1280×800
 *   node tools/playtest.mjs --small       # + passage à 900×700
 *   node tools/playtest.mjs --fast        # scénario court (pas de fin de partie)
 *   node tools/playtest.mjs --keep        # laisse le serveur de preview tourner
 *
 * DIFFÉRENCE ESSENTIELLE AVEC tools/smoke.mjs :
 *   smoke.mjs vérifie que le moteur ne casse pas, en appelant `game.build()`,
 *   `game.setLayer()` etc. depuis la console. Ici, au contraire, TOUT passe par
 *   l'interface réelle : on clique sur les vrais boutons du DOM et sur le vrai
 *   canvas 3D, exactement comme un joueur avec une souris et un clavier.
 *
 *   Les seules exceptions, explicitement listées et comptabilisées :
 *     · `scene.pick(x, y)` sert d'ŒIL : le harnais ne voit pas l'image, il a
 *       besoin de savoir quel secteur se trouve sous quel pixel avant de
 *       cliquer. Il ne modifie rien.
 *     · `game._tick(1, i)` sert d'HORLOGE : il fait avancer la simulation plus
 *       vite que le temps réel. Il ne joue jamais à la place du joueur (aucun
 *       build, aucun scan, aucune recherche n'est déclenché par le harnais
 *       autrement que par un clic ou une touche).
 *
 * Le rapport chiffré est écrit sur la sortie standard et dans
 * /tmp/tn-playtest/report.json ; les captures d'écran vont dans /tmp/tn-playtest/.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

/* ===================================================================== */
/*  INFRASTRUCTURE (calquée sur smoke.mjs)                               */
/* ===================================================================== */

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

const SHOT_DIR = process.env.SHOT_DIR || '/tmp/tn-playtest';
const PORT = 5600 + Math.floor(Math.random() * 300);
const FAST = process.argv.includes('--fast');
const SMALL = process.argv.includes('--small');

function buildOnce() {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'warn'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => (c === 0 ? resolve(out) : reject(new Error('Échec du build :\n' + out))));
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* ignore */ } };
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

/* ===================================================================== */
/*  LE JOUEUR : tout passe par ses mains                                 */
/* ===================================================================== */

/**
 * Compte chaque geste physique. Un clic = un clic, pas une intention.
 */
class Player {
  constructor(page) {
    this.page = page;
    this.clicks = 0;
    this.keys = 0;
    this.drags = 0;
    this.hovers = 0;
    this.marks = [];      // { label, clicks, keys, drags, seconds }
    this._t0 = Date.now();
  }

  /** Ouvre un chapitre de mesure. */
  begin(label) {
    this._mark = { label, clicks: this.clicks, keys: this.keys, drags: this.drags, t: Date.now() };
  }

  /** Ferme le chapitre et enregistre le coût en gestes. */
  end(extra = {}) {
    if (!this._mark) return null;
    const m = {
      label: this._mark.label,
      clicks: this.clicks - this._mark.clicks,
      keys: this.keys - this._mark.keys,
      drags: this.drags - this._mark.drags,
      seconds: +((Date.now() - this._mark.t) / 1000).toFixed(2),
      ...extra,
    };
    this.marks.push(m);
    this._mark = null;
    return m;
  }

  /**
   * Clic sur un sélecteur CSS (vrai clic de souris).
   * Un clic qui échoue (bouton disparu, recouvert, désactivé) est COMPTÉ :
   * du point de vue du joueur, le geste a bien été fait.
   */
  async click(selector, { timeout = 2500, optional = false } = {}) {
    const loc = this.page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
      this.clicks++;
      await this.page.waitForTimeout(60);
      return true;
    } catch (err) {
      this.clicks++;
      this.failedClicks = (this.failedClicks || 0) + 1;
      if (!optional) this.failures = (this.failures || []).concat(selector);
      return false;
    }
  }

  /** Clic sur un bouton repéré par son texte visible. */
  async clickText(selector, text, opts = {}) {
    const loc = this.page.locator(selector).filter({ hasText: text }).first();
    const timeout = opts.timeout ?? 15000;
    try {
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
    } catch {
      this.failedClicks = (this.failedClicks || 0) + 1;
    }
    this.clicks++;
    await this.page.waitForTimeout(60);
  }

  /** Clic à un pixel donné (canvas 3D). */
  async clickAt(x, y) {
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.up();
    this.clicks++;
    await this.page.waitForTimeout(50);
  }

  /** Glisser pour tourner la planète. */
  async drag(dx = 220, dy = 0) {
    const box = await this.page.locator('#viewport').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await this.page.mouse.move(cx, cy);
    await this.page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await this.page.mouse.move(cx + (dx * i) / 8, cy + (dy * i) / 8);
    }
    await this.page.mouse.up();
    this.drags++;
    await this.page.waitForTimeout(180);
  }

  async key(k) {
    await this.page.keyboard.press(k);
    this.keys++;
    await this.page.waitForTimeout(90);
  }

  async hover(selector) {
    await this.page.locator(selector).first().hover();
    this.hovers++;
    await this.page.waitForTimeout(320);   // le tooltip a 200 ms de délai
  }
}

/* ===================================================================== */
/*  ŒIL DU JOUEUR : où se trouve quel secteur à l'écran                  */
/* ===================================================================== */

/**
 * Échantillonne le canvas et retourne { regionId: [x, y] } pour tous les
 * secteurs visibles. Lecture seule : c'est ce que l'œil du joueur perçoit.
 */
async function pickMap(page, step = 26) {
  return page.evaluate((st) => {
    const s = window.TERRA.scene;
    const r = document.getElementById('viewport').getBoundingClientRect();
    const out = {};
    for (let y = r.top + 8; y < r.bottom - 8; y += st) {
      for (let x = r.left + 8; x < r.right - 8; x += st) {
        const id = s.pick(x, y);
        if (id !== null && id !== undefined && out[id] === undefined) {
          out[id] = [Math.round(x), Math.round(y)];
        }
      }
    }
    return out;
  }, step);
}

/** Lecture seule de l'état, comme un joueur qui regarde son écran. */
const peek = (page, fn, arg) => page.evaluate(fn, arg);

/** Compteurs de VISÉE : la planète tourne toute seule, la cible dérive. */
const aim = { shots: 0, drifted: 0, lost: 0, driftPx: [] };

/**
 * Clique le secteur `id`. Le joueur regarde l'écran juste avant d'appuyer :
 * on re-vérifie donc le pixel au dernier moment (comme un œil qui corrige).
 * On mesure au passage de combien la cible a bougé depuis le repérage —
 * la planète tourne seule au bout de 4 s d'inactivité (OrbitControls).
 */
async function clickRegion(page, p, id, map) {
  const at = map[id];
  if (!at) return false;
  const found = await page.evaluate(([rid, x, y]) => {
    const s = window.TERRA.scene;
    if (s.pick(x, y) === rid) return { x, y, d: 0 };
    for (let r = 4; r <= 48; r += 4) {
      for (let a = 0; a < 16; a++) {
        const nx = x + Math.cos((a / 16) * 6.2832) * r;
        const ny = y + Math.sin((a / 16) * 6.2832) * r;
        if (s.pick(nx, ny) === rid) return { x: Math.round(nx), y: Math.round(ny), d: r };
      }
    }
    return null;
  }, [id, at[0], at[1]]);

  aim.shots++;
  if (!found) { aim.lost++; return false; }
  if (found.d > 0) { aim.drifted++; aim.driftPx.push(found.d); }
  await p.clickAt(found.x, found.y);
  return true;
}

/** Avance la simulation de n jours (horloge accélérée, aucune action jouée). */
async function advanceDays(page, days) {
  await page.evaluate((n) => {
    const g = window.TERRA.game;
    for (let i = 0; i < n; i++) g._tick(1, i);
  }, days);
  await page.waitForTimeout(160);   // laisse l'UI (10 Hz) se rafraîchir
}

/* ===================================================================== */

const errors = [];
const warnings = [];
const findings = [];   // observations qualitatives datées
const metrics = {};

function note(severity, text) {
  findings.push({ severity, text });
  console.log(`    ${severity === 'BLOQUANT' ? '✘' : severity === 'IMPORTANT' ? '▲' : '·'} ${text}`);
}

async function run() {
  mkdirSync(SHOT_DIR, { recursive: true });

  process.stdout.write('Build de production … ');
  await buildOnce();
  console.log('ok');
  const vite = await startServer();

  const exe = findChromium();
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  page.on('console', (msg) => {
    const t = msg.type();
    const where = msg.location?.().url || '';
    const text = msg.text() + (where ? ` [${where}]` : '');
    if (t === 'error' && /audio\//.test(text)) return;
    if (t === 'error') errors.push(text);
    else if (t === 'warning' && !/deprecat|SwiftShader|GPU stall|WebGL/i.test(text)) warnings.push(text);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));

  const p = new Player(page);
  const shot = async (name) => { await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }); };

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  TEST DE JOUABILITÉ — TERRA NOVA (1280×800, souris+clavier) ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  /* ------------------------------------------------------------------ */
  /*  1. ARRIVÉE SUR LE JEU                                             */
  /* ------------------------------------------------------------------ */
  console.log('1. Arrivée sur le jeu');
  const tBoot = Date.now();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await page.waitForTimeout(700);
  metrics.bootSeconds = +((Date.now() - tBoot) / 1000).toFixed(2);
  await shot('01-accueil');

  const menuText = await peek(page, () => document.querySelector('.tn-menu-panel')?.innerText || '');
  metrics.menuTextLength = menuText.length;
  metrics.menuMentionsGoal = /180 jours|indicateurs/.test(menuText);
  console.log(`   écran d'accueil en ${metrics.bootSeconds}s · ${menuText.split('\n').length} lignes de texte`);

  /* ------------------------------------------------------------------ */
  /*  2. LANCEMENT DE LA PARTIE (par l'interface)                       */
  /* ------------------------------------------------------------------ */
  console.log('\n2. Lancement d’une partie');
  p.begin('Démarrer une partie depuis l’accueil');
  const tNew = Date.now();
  await p.clickText('button.tn-btn', 'Nouvelle partie');
  // La génération de la planète bloque le fil principal : on mesure le gel.
  await page.waitForFunction(() => !!window.TERRA.game.state, { timeout: 30000 }).catch(() => {});
  metrics.gelGenerationSeconds = +((Date.now() - tNew) / 1000).toFixed(2);
  await page.waitForTimeout(1400);
  console.log('   ' + JSON.stringify(p.end({ gelGénération: metrics.gelGenerationSeconds })));
  await shot('02-premier-regard');

  // Ce que le joueur a sous les yeux à la seconde zéro.
  const firstLook = await peek(page, () => ({
    ui: document.getElementById('ui').innerText,
    phase: document.querySelector('.tn-phase-tag')?.textContent || '',
    banner: document.querySelector('.tn-banner')?.hidden === false,
    notifs: [...document.querySelectorAll('.tn-notif-text')].map((n) => n.textContent),
    regionPanelOpen: document.querySelector('.tn-region')?.hidden === false,
    day: window.TERRA.game.state.time.day,
    discovered: (() => { const R = window.TERRA.game.regions; let n = 0;
      for (let i = 0; i < R.count; i++) n += R.discovered[i]; return n; })(),
    regions: window.TERRA.game.regions.count,
  }));
  metrics.firstLook = firstLook;
  console.log(`   secteurs révélés : ${firstLook.discovered}/${firstLook.regions} · phase « ${firstLook.phase} »`);
  console.log('   texte visible (extrait) : ' + firstLook.ui.replace(/\n+/g, ' | ').slice(0, 220));

  /* ------------------------------------------------------------------ */
  /*  3. TROUVER UN SECTEUR : combien de gestes ?                       */
  /* ------------------------------------------------------------------ */
  console.log('\n3. Sélectionner un secteur à la souris');
  p.begin('Sélectionner un secteur (clic sur la planète)');
  let map = await pickMap(page);
  const visibleIds = Object.keys(map).map(Number);
  const disc = await peek(page, () => { const R = window.TERRA.game.regions;
    return Array.from(R.discovered); });
  const visibleDiscovered = visibleIds.filter((i) => disc[i]);
  const visibleUnknown = visibleIds.filter((i) => !disc[i]);
  metrics.visibleRegions = visibleIds.length;
  metrics.visibleDiscovered = visibleDiscovered.length;

  // Le joueur cherche un secteur déjà cartographié : il doit peut-être tourner.
  let target = visibleDiscovered[0];
  let rotations = 0;
  while (target === undefined && rotations < 6) {
    await p.drag(200, 40); rotations++;
    map = await pickMap(page);
    const ids = Object.keys(map).map(Number).filter((i) => disc[i]);
    target = ids[0];
  }
  metrics.rotationsToFindStart = rotations;
  if (target !== undefined) await clickRegion(page, p, target, map);
  const sel = await peek(page, () => window.TERRA.game.selectedRegion);
  console.log('   ' + JSON.stringify(p.end({ trouvé: target ?? null, sélection: sel })));
  await shot('03-secteur-selectionne');

  /* ------------------------------------------------------------------ */
  /*  4. SCANNER UN SECTEUR                                             */
  /* ------------------------------------------------------------------ */
  console.log('\n4. Lancer un scan orbital');
  // On clique un secteur inconnu voisin, puis le bouton de scan.
  p.begin('Scanner 1 secteur inconnu');
  // La carte a pu changer (rotations) : on relit ce que le joueur voit.
  const unknownNow = Object.keys(map).map(Number).filter((i) => !disc[i]);
  let unknownTarget = unknownNow[0] ?? visibleUnknown[0];
  if (unknownTarget !== undefined && map[unknownTarget]) {
    await clickRegion(page, p, unknownTarget, map);
    await shot('04-secteur-inconnu');
    const hasScanBtn = await page.locator('.tn-region .tn-btn--primary').first().isVisible().catch(() => false);
    if (hasScanBtn) await p.click('.tn-region .tn-btn--primary');
  }
  const scanning = await peek(page, () => window.TERRA.game.state.explore.scanning.length);
  console.log('   ' + JSON.stringify(p.end({ scansEnCours: scanning })));

  // Combien de gestes pour 10 scans ? (mesure de la répétitivité)
  p.begin('Scanner 10 secteurs supplémentaires');
  let scanned = 0, scanRotations = 0, aimed = 0, missed = 0;
  const probes = await peek(page, () => window.TERRA.game.state.explore.probes);
  metrics.probes = probes;
  for (let round = 0; round < 8 && scanned < 10; round++) {
    map = await pickMap(page, 26);
    const st = await peek(page, () => ({
      d: Array.from(window.TERRA.game.regions.discovered),
      busy: window.TERRA.game.state.explore.scanning.map((s) => s.region),
      slots: window.TERRA.game.state.explore.probes - window.TERRA.game.state.explore.scanning.length,
    }));
    const free = Object.keys(map).map(Number)
      .filter((i) => !st.d[i] && !st.busy.includes(i))
      .slice(0, Math.max(0, st.slots));
    for (const id of free) {
      if (scanned >= 10) break;
      await clickRegion(page, p, id, map);
      // Précision : la planète tourne toute seule au bout de 4 s d'inactivité
      // (OrbitControls). Le secteur atteint est-il celui qu'on visait ?
      aimed++;
      const got = await peek(page, () => window.TERRA.game.selectedRegion);
      if (got !== id) missed++;
      const btn = page.locator('.tn-region .tn-btn--primary').first();
      if (await btn.isVisible().catch(() => false) && !(await btn.isDisabled().catch(() => true))) {
        await p.click('.tn-region .tn-btn--primary');
        scanned++;
      }
    }
    // Les sondes travaillent : le joueur ATTEND (14 jours de scan).
    if (scanned < 10) await advanceDays(page, 16);
  }
  await advanceDays(page, 30);
  const m10 = p.end({ scansRéalisés: scanned, rotations: scanRotations, clicsVisés: aimed, clicsRatés: missed });
  metrics.precisionClic = { visés: aimed, ratés: missed };
  metrics.clicksPer10Scans = m10.clicks;
  metrics.clicksPerScan = +(m10.clicks / Math.max(1, scanned)).toFixed(2);
  console.log('   ' + JSON.stringify(m10));
  console.log(`   → ${metrics.clicksPerScan} clics par secteur scanné`);

  const totalToReveal = await peek(page, () => {
    const R = window.TERRA.game.regions; let n = 0;
    for (let i = 0; i < R.count; i++) if (!R.discovered[i]) n++;
    return n;
  });
  metrics.regionsRestantesAScanner = totalToReveal;
  metrics.clicsEstimésPourToutRévéler = Math.round(totalToReveal * metrics.clicksPerScan);
  note('MESURE', `${totalToReveal} secteurs restent inconnus → ≈${metrics.clicsEstimésPourToutRévéler} clics pour tout cartographier`);

  /* ------------------------------------------------------------------ */
  /*  5. CONSTRUIRE                                                     */
  /* ------------------------------------------------------------------ */
  console.log('\n5. Construire');
  p.begin('Construire une première mine (menu → carte → secteur)');
  await p.click('button.tn-tool[data-tool="build"]');
  await shot('05-menu-construction');
  await p.click('.tn-card[data-type="mine"]');
  map = await pickMap(page);
  const d2 = await peek(page, () => Array.from(window.TERRA.game.regions.discovered));
  const minerals = await peek(page, () => Array.from(window.TERRA.game.regions.minerals));
  const buildable = Object.keys(map).map(Number)
    .filter((i) => d2[i] && minerals[i] >= 0.22)
    .sort((a, b) => minerals[b] - minerals[a]);
  let built = 0;
  if (buildable.length) {
    await clickRegion(page, p, buildable[0], map);
    built = await peek(page, () => window.TERRA.game.state.buildings.filter((b) => b.type === 'mine').length);
  }
  const mMine = p.end({ minesConstruites: built });
  metrics.clicksFirstMine = mMine.clicks;
  console.log('   ' + JSON.stringify(mMine));
  await shot('06-mine-construite');

  // Le mode placement persiste-t-il ? Coût de la 2e, 3e, 4e mine.
  p.begin('Construire 4 bâtiments de plus (le mode placement reste-t-il actif ?)');
  let extra = 0;
  const stillOk = await peek(page, (ids) => ids.filter((i) => window.TERRA.game.canBuild('solar', i).ok),
    Object.keys(map).map(Number));
  if (stillOk.length) {
    await p.click('.tn-card[data-type="solar"]');   // 1 clic pour choisir le type
    for (const id of stillOk) {
      if (extra >= 4) break;
      if (await clickRegion(page, p, id, map)) extra++;
    }
  }
  const mMore = p.end({ minesAjoutées: extra });
  // Le 1er clic choisit le type : les suivants sont le coût marginal réel.
  metrics.clicksPerExtraBuilding = +((mMore.clicks - 1) / Math.max(1, extra)).toFixed(2);
  console.log('   ' + JSON.stringify(mMore) + `  → ${metrics.clicksPerExtraBuilding} clic(s) par bâtiment suivant`);

  /* ------------------------------------------------------------------ */
  /*  6. POURQUOI C'EST REFUSÉ ?                                        */
  /* ------------------------------------------------------------------ */
  console.log('\n6. Lisibilité des refus');
  // 6a. Clic sur un secteur au minerai insuffisant, mine en main.
  const poor = Object.keys(map).map(Number).filter((i) => d2[i] && minerals[i] < 0.22);
  let refusal = { notif: null, strip: null };
  if (poor.length) {
    await clickRegion(page, p, poor[0], map);
    refusal = await peek(page, () => ({
      notif: [...document.querySelectorAll('.tn-notif-text')].map((n) => n.textContent).slice(-1)[0] || null,
      strip: document.querySelector('.tn-place-strip')?.textContent || null,
      cardStatus: document.querySelector('.tn-card[data-type="mine"] .tn-card-status')?.textContent || null,
    }));
  }
  metrics.refusMine = refusal;
  console.log('   refus « minerai » → notification : ' + JSON.stringify(refusal.notif));
  console.log('                        bandeau secteur : ' + JSON.stringify(refusal.strip));

  // 6b. Bâtiment verrouillé par la technologie : que se passe-t-il au clic ?
  const lockedBefore = await peek(page, () => ({
    placing: window.TERRA.ui.placingType,
    status: document.querySelector('.tn-card[data-type="fusion"] .tn-card-status')?.textContent || null,
    hasLockedClass: document.querySelector('.tn-card[data-type="fusion"]')?.classList.contains('is-locked'),
    disabled: document.querySelector('.tn-card[data-type="fusion"]')?.disabled ?? null,
  }));
  await p.click('.tn-card[data-type="fusion"]');
  const lockedAfter = await peek(page, () => ({
    placing: window.TERRA.ui.placingType,
    notif: [...document.querySelectorAll('.tn-notif-text')].map((n) => n.textContent).slice(-1)[0] || null,
  }));
  metrics.carteVerrouillee = { avant: lockedBefore, apres: lockedAfter };
  console.log('   carte verrouillée (fusion) : statut=' + JSON.stringify(lockedBefore.status)
    + ' · clic → ' + JSON.stringify(lockedAfter));
  if (lockedBefore.hasLockedClass && lockedAfter.placing === lockedBefore.placing && !lockedAfter.notif?.includes('Techno')) {
    note('CONFORT', 'Cliquer une carte verrouillée ne produit AUCUN retour (ni notification ni son) — le bouton paraît mort.');
  }

  await p.key('Escape');   // sortir du mode placement

  /* ------------------------------------------------------------------ */
  /*  7. RECHERCHE                                                      */
  /* ------------------------------------------------------------------ */
  console.log('\n7. Recherche');
  // Combien de jours de jeu avant que la PREMIÈRE technologie soit payable ?
  await p.key('r');
  let waited = 0;
  for (; waited < 4000; waited += 50) {
    const ready = await peek(page, () => document.querySelectorAll('.tn-tech.is-ready').length);
    if (ready > 0) break;
    await advanceDays(page, 50);
  }
  const dayFirstTech = await peek(page, () => window.TERRA.game.state.time.day);
  metrics.joursAvantPremiereTech = Math.round(dayFirstTech);
  console.log(`   première technologie payable au jour ${Math.round(dayFirstTech)} `
    + `(≈ ${(dayFirstTech / 4).toFixed(0)} s de jeu réel à ×1, ${(dayFirstTech / 16).toFixed(0)} s à ×4)`);
  p.begin('Lancer une recherche');
  await shot('07-recherche');
  const readyTech = await peek(page, () => {
    const c = [...document.querySelectorAll('.tn-tech.is-ready')];
    return c.map((n) => n.dataset.tech);
  });
  if (readyTech.length) await p.click(`.tn-tech[data-tech="${readyTech[0]}"]`);
  const unlocked = await peek(page, () => window.TERRA.game.state.tech.unlocked.length);
  const mRes = p.end({ techDisponibles: readyTech.length, techAcquises: unlocked });
  metrics.clicksResearch = mRes.clicks;
  metrics.researchIsInstant = true;
  console.log('   ' + JSON.stringify(mRes));

  const researchPanel = await peek(page, () => {
    const n = document.querySelector('.tn-research');
    return { scrollH: n?.scrollHeight, clientH: n?.clientHeight,
      scrollW: n?.scrollWidth, clientW: n?.clientWidth };
  });
  metrics.researchPanelOverflow = researchPanel;
  if (researchPanel.scrollW > researchPanel.clientW + 4) {
    note('IMPORTANT', `L’arbre technologique déborde horizontalement du panneau (${researchPanel.scrollW}px pour ${researchPanel.clientW}px).`);
  }

  /* ------------------------------------------------------------------ */
  /*  8. COUCHES                                                        */
  /* ------------------------------------------------------------------ */
  console.log('\n8. Couches de visualisation');
  p.begin('Changer de couche (souris)');
  await p.click('button.tn-tool[data-tool="layers"]');
  await p.click('.tn-layer[data-layer="temperature"]');
  console.log('   ' + JSON.stringify(p.end()));
  await shot('08-couche-temperature');

  p.begin('Changer de couche (clavier, Tab)');
  await p.clickAt(300, 650);   // clic dans le vide : on sort le focus de l'UI
  await p.key('Tab');
  const layerAfterTab = await peek(page, () => window.TERRA.ui.panels.layers.current);
  console.log('   ' + JSON.stringify(p.end({ couche: layerAfterTab })));

  /* ------------------------------------------------------------------ */
  /*  9. INFOBULLES : comprend-on POURQUOI ça bouge ?                   */
  /* ------------------------------------------------------------------ */
  console.log('\n9. Infobulles de contribution');
  await p.key('Escape');
  const tips = {};
  for (const [name, sel] of [
    ['température', '.tn-ind-cell[aria-label="Température"]'],
    ['pression', '.tn-ind-cell[aria-label="Pression"]'],
    ['oxygène', '.tn-ind-cell[aria-label="Oxygène"]'],
    ['eau libre', '.tn-ind-cell[aria-label="Eau libre"]'],
    ['biomasse', '.tn-ind-cell[aria-label="Biomasse"]'],
    ['stabilité', '.tn-ind-cell[aria-label="Stabilité"]'],
    ['énergie', '.tn-res-cell[aria-label="Énergie"]'],
    ['matériaux', '.tn-res-cell[aria-label="Matériaux"]'],
  ]) {
    try {
      await p.hover(sel);
      const t = await peek(page, () => {
        const n = document.querySelector('.tn-tooltip');
        return n && !n.hidden ? n.innerText : null;
      });
      tips[name] = t;
    } catch { tips[name] = null; }
  }
  metrics.tooltips = tips;
  await p.hover('.tn-ind-cell[aria-label="Température"]');
  await shot('09-infobulle-temperature');
  for (const k in tips) {
    const lines = (tips[k] || '').split('\n').filter(Boolean).length;
    console.log(`   ${k.padEnd(12)} : ${lines} ligne(s) ${tips[k] ? '' : '— AUCUNE INFOBULLE'}`);
  }
  if (!tips['eau libre'] || !/Total|Contribution|\+|−/.test(tips['eau libre'] || '')) {
    note('IMPORTANT', 'L’indicateur « eau libre » n’a pas de décomposition : impossible de savoir pourquoi l’eau monte ou baisse.');
  }
  if (!tips['biomasse'] || (tips['biomasse'] || '').split('\n').length < 4) {
    note('IMPORTANT', 'L’indicateur « biomasse » n’a pas de décomposition de contributions.');
  }

  /* ------------------------------------------------------------------ */
  /*  10. CLAVIER SEUL                                                  */
  /* ------------------------------------------------------------------ */
  console.log('\n10. Jouabilité au clavier seul');
  const kb = {};
  await p.key('b'); kb.b = await peek(page, () => window.TERRA.ui.activePanel);
  await p.key('b');
  await p.key('r'); kb.r = await peek(page, () => window.TERRA.ui.activePanel);
  await p.key('r');
  await p.key('l'); kb.l = await peek(page, () => window.TERRA.ui.activePanel);
  await p.key('l');
  await p.key(' '); kb.pause = await peek(page, () => window.TERRA.game.state.time.speed);
  await p.key('3'); kb.speed3 = await peek(page, () => window.TERRA.game.state.time.speed);
  await p.key('1');

  // Peut-on sélectionner un secteur au clavier ? (aucune touche prévue)
  const before = await peek(page, () => window.TERRA.game.selectedRegion);
  await p.key('Escape');   // désélectionne
  for (let i = 0; i < 8; i++) await p.key('Tab');
  const focused = await peek(page, () => {
    const a = document.activeElement;
    return a ? (a.className || a.tagName) : null;
  });
  kb.selectionAuClavier = (await peek(page, () => window.TERRA.game.selectedRegion)) !== null;
  kb.focusApres8Tab = focused;
  metrics.clavier = kb;
  console.log('   ' + JSON.stringify(kb));
  if (!kb.selectionAuClavier) {
    note('IMPORTANT', 'Aucun moyen de sélectionner un secteur au clavier : le jeu est injouable sans souris (et Tab est détourné par le cycle de couches).');
  }

  /* ------------------------------------------------------------------ */
  /*  11. PARTIE COMPLÈTE À LA SOURIS                                   */
  /* ------------------------------------------------------------------ */
  console.log('\n11. Partie longue jouée par l’interface');
  const play = await playFullGame(page, p, { fast: FAST, shot });
  metrics.partie = play;

  /* ------------------------------------------------------------------ */
  /*  12. MISE EN PAGE                                                  */
  /* ------------------------------------------------------------------ */
  console.log('\n12. Mise en page');
  metrics.layout = {};
  metrics.layout['1280x800'] = await inspectLayout(page, p, '1280x800', shot);
  if (SMALL || true) {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(800);
    metrics.layout['900x700'] = await inspectLayout(page, p, '900x700', shot);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
  }

  /* ------------------------------------------------------------------ */
  await browser.close();
  if (!process.argv.includes('--keep')) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* ignore */ } }

  metrics.gestesTotaux = { clics: p.clicks, touches: p.keys, glissers: p.drags, survols: p.hovers,
    clicsSansEffet: p.failedClicks || 0 };
  metrics.visee = {
    tirs: aim.shots, cibleDéplacée: aim.drifted, ciblePerdue: aim.lost,
    dérivePixelsMoyenne: aim.driftPx.length
      ? +(aim.driftPx.reduce((a, b) => a + b, 0) / aim.driftPx.length).toFixed(1) : 0,
  };
  console.log('VISÉE : ' + JSON.stringify(metrics.visee));
  metrics.chapitres = p.marks;
  metrics.erreursConsole = errors;
  metrics.avertissementsConsole = warnings;
  metrics.observations = findings;

  writeFileSync(`${SHOT_DIR}/report.json`, JSON.stringify(metrics, null, 2));

  console.log('\n─────────────────────────────────────────────────────────');
  console.log('GESTES TOTAUX : ' + JSON.stringify(metrics.gestesTotaux));
  if (errors.length) {
    console.log(`\n${errors.length} ERREUR(S) CONSOLE :`);
    errors.slice(0, 15).forEach((e) => console.log('  ✘ ' + e.slice(0, 300)));
  } else console.log('\n✔ Aucune erreur console.');
  if (warnings.length) {
    console.log(`${warnings.length} avertissement(s) :`);
    warnings.slice(0, 8).forEach((w) => console.log('  ! ' + w.slice(0, 200)));
  }
  console.log(`\nCaptures et rapport JSON : ${SHOT_DIR}`);
}

/* ===================================================================== */
/*  PARTIE COMPLÈTE, JOUÉE PAR L'INTERFACE                               */
/* ===================================================================== */

/**
 * Joue une partie du début à la fin en ne touchant QUE l'interface :
 *  · recherche  : clic sur les cartes « Disponible » du panneau ⌬
 *  · scans      : clic sur un secteur inconnu + clic sur « Lancer un scan »
 *  · bâtiments  : clic sur la carte du menu ⛏ puis clics sur les secteurs
 *  · temps      : le harnais avance l'horloge (game._tick), jamais l'action
 *
 * Retourne le journal de la partie et le décompte des gestes.
 */
async function playFullGame(page, p, { fast = false, shot } = {}) {
  const PLAN = [
    'orbital_survey', 'geothermal_tap', 'metallurgy', 'greenhouse_gases', 'exobiology',
    'energy_grid', 'polar_engineering', 'automation', 'pioneer_organisms',
    'atmospheric_engineering', 'orbital_infrastructure', 'forestation',
    'carbon_capture', 'fusion', 'colonization', 'climate_control',
    'ecosystems', 'deep_drilling', 'terraform_mastery',
  ];

  // Objectifs de construction, dans l'ordre où un joueur les découvre.
  const WANT = [
    ['mine', 16], ['solar', 10], ['depot', 4], ['science_station', 10],
    ['ice_extractor', 12], ['geothermal', 6], ['refinery', 5],
    ['ghg_factory', 12], ['atmo_processor', 14], ['polar_melter', 8],
    ['orbital_mirror', 8], ['biodome', 16], ['o2_generator', 12],
    ['seeder', 12], ['fusion', 5], ['colony', 12], ['climate_stabilizer', 4],
  ];

  p.begin('Partie complète (recherche + construction + scans par l’interface)');
  const journal = [];
  const startClicks = p.clicks;
  let rounds = 0;
  const maxRounds = fast ? 5 : 30;
  let victory = false;

  for (rounds = 0; rounds < maxRounds && !victory; rounds++) {
    /* --- 1. Recherche : on clique tout ce qui est « Disponible » ------ */
    await ensurePanel(page, p, 'research');
    for (let k = 0; k < 4; k++) {
      const ready = await peek(page, (plan) => {
        const cards = [...document.querySelectorAll('.tn-tech.is-ready')].map((n) => n.dataset.tech);
        return plan.filter((t) => cards.includes(t));
      }, PLAN);
      if (!ready.length) break;
      await p.click(`.tn-tech[data-tech="${ready[0]}"]`);
    }

    /* --- 2. Scans : le joueur cartographie ce qu'il voit -------------- */
    const slots = await peek(page, () => {
      const s = window.TERRA.game.state;
      const t = window.TERRA.game.techEffects;
      return (s.explore.probes + (t.probes || 0)) - s.explore.scanning.length;
    });
    // Une seule carte de repérage par tour : le joueur regarde son écran,
    // il ne le re-scanne pas entre chaque geste.
    const map = await pickMap(page, 30);
    if (slots > 0) {
      const d = await peek(page, () => Array.from(window.TERRA.game.regions.discovered));
      const busy = await peek(page, () => window.TERRA.game.state.explore.scanning.map((s) => s.region));
      const free = Object.keys(map).map(Number).filter((i) => !d[i] && !busy.includes(i)).slice(0, slots);
      for (const id of free) {
        await clickRegion(page, p, id, map);
        const btn = page.locator('.tn-region .tn-btn--primary').first();
        if (await btn.isVisible().catch(() => false) && !(await btn.isDisabled().catch(() => true))) {
          await p.click('.tn-region .tn-btn--primary');
        }
      }
    }

    /* --- 3. Construction : carte du menu puis clics sur les secteurs -- */
    const ids = Object.keys(map).map(Number);
    await ensurePanel(page, p, 'build');
    for (const [type, wanted] of WANT) {
      const info = await peek(page, ([t, list]) => {
        const g = window.TERRA.game;
        const have = g.state.buildings.filter((b) => b.type === t).length;
        const locked = document.querySelector(`.tn-card[data-type="${t}"]`)?.classList.contains('is-locked');
        const ok = list.filter((i) => g.canBuild(t, i).ok);
        return { have, locked, ok: ok.slice(0, 6) };
      }, [type, ids]);
      if (info.locked || info.have >= wanted || !info.ok.length) continue;
      await p.click(`.tn-card[data-type="${type}"]`);
      for (const id of info.ok) {
        const have = await peek(page, (t) => window.TERRA.game.state.buildings.filter((b) => b.type === t).length, type);
        if (have >= wanted) break;
        await clickRegion(page, p, id, map);
      }
      await p.key('Escape');   // le mode placement reste actif sinon
    }

    /* --- 4. Thermostat : le joueur démonte s'il surchauffe ------------ */
    const g = await peek(page, () => ({ ...window.TERRA.game.state.globals }));
    if (g.temperature > 24) {
      // Démonter passe par la fiche de secteur : on ouvre le secteur du miroir.
      const mirror = await peek(page, () => {
        const b = window.TERRA.game.state.buildings.filter((x) => x.type === 'orbital_mirror'
          || x.type === 'ghg_factory');
        return b.length ? b[b.length - 1].region : null;
      });
      if (mirror !== null && map[mirror]) {
        await clickRegion(page, p, mirror, map);
        const del = page.locator('.tn-bcard .tn-icon-btn.tn-danger').last();
        if (await del.isVisible().catch(() => false)) {
          await del.click(); p.clicks++;          // arme
          await del.click(); p.clicks++;          // confirme
        }
      }
    }

    /* --- 5. Le temps passe -------------------------------------------- */
    await advanceDays(page, 340);

    const st = await peek(page, () => ({
      day: window.TERRA.game.state.time.day,
      ...window.TERRA.game.state.globals,
      sustained: window.TERRA.game.state.progress.sustained,
      victory: window.TERRA.game.state.progress.victory,
      buildings: window.TERRA.game.state.buildings.length,
      tech: window.TERRA.game.state.tech.unlocked.length,
      discovered: (() => { const R = window.TERRA.game.regions; let n = 0;
        for (let i = 0; i < R.count; i++) n += R.discovered[i]; return n; })(),
    }));
    victory = st.victory;
    journal.push({
      an: +(st.day / 365).toFixed(1), T: +st.temperature.toFixed(1), kPa: +st.pressure.toFixed(1),
      O2: +st.oxygen.toFixed(1), bio: +st.biomass.toFixed(1), stab: +st.stability.toFixed(0),
      pop: Math.round(st.population), bât: st.buildings, tech: st.tech, vus: st.discovered,
      clics: p.clicks,
    });
    if (rounds % 6 === 0 || victory) {
      const l = journal[journal.length - 1];
      console.log(`   an ${String(l.an).padStart(5)} · ${String(l.T).padStart(6)}°C · ${String(l.kPa).padStart(5)}kPa · O₂ ${String(l.O2).padStart(5)}% · bio ${String(l.bio).padStart(5)} · stab ${String(l.stab).padStart(3)} · pop ${String(l.pop).padStart(6)} · ${l.bât} bât · ${l.tech} tech · ${l.vus} secteurs · ${l.clics} clics`);
    }
    if (rounds === 3 && shot) await shot('10-partie-milieu');
  }

  const m = p.end({ tours: rounds, victoire: victory });
  if (shot) await shot(victory ? '11-victoire' : '11-fin-de-sonde');

  const final = await peek(page, () => ({
    day: window.TERRA.game.state.time.day,
    victory: window.TERRA.game.state.progress.victory,
    victoryAt: window.TERRA.game.state.progress.victoryAt,
    buildings: window.TERRA.game.state.buildings.length,
    tech: window.TERRA.game.state.tech.unlocked.length,
    victoryScreen: document.querySelector('.tn-victory-screen')?.hidden === false,
    report: window.TERRA.game.victoryReport().map((r) => ({ k: r.key, v: +Number(r.value).toFixed(2), ok: r.ok })),
  }));
  console.log(`   → ${m.clicks} clics pour cette partie (an ${(final.day / 365).toFixed(1)}), victoire : ${final.victory}`);
  if (final.victory) console.log(`   → écran de victoire affiché : ${final.victoryScreen}`);

  return { journal, gestes: m, final, clicsPartie: p.clicks - startClicks };
}

/** Ouvre un panneau du dock s'il n'est pas déjà ouvert (compté en clics). */
async function ensurePanel(page, p, id) {
  const cur = await peek(page, () => window.TERRA.ui.activePanel);
  if (cur === id) return;
  await p.click(`button.tn-tool[data-tool="${id}"]`);
}

/* ===================================================================== */
/*  MISE EN PAGE                                                         */
/* ===================================================================== */

/**
 * Relève les chevauchements, les débordements et les textes tronqués.
 * Tout est mesuré sur le DOM réel, à la taille de fenêtre courante.
 */
async function inspectLayout(page, p, label, shot) {
  // On ouvre un panneau ET une fiche de secteur : c'est le cas le plus chargé.
  await ensurePanel(page, p, 'build');
  const sel = await peek(page, () => window.TERRA.game.selectedRegion);
  if (sel === null) {
    await page.evaluate(() => {
      // Sélection par l'UI officielle : clic simulé impossible sans pick ici.
      const g = window.TERRA.game;
      for (let i = 0; i < g.regions.count; i++) if (g.regions.discovered[i]) { g.selectRegion(i); break; }
    });
  }
  await page.waitForTimeout(400);
  await shot(`12-mise-en-page-${label}`);

  const res = await page.evaluate(() => {
    const rect = (s) => {
      const n = document.querySelector(s);
      if (!n || n.hidden) return null;
      const r = n.getBoundingClientRect();
      return { s, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const boxes = ['.tn-topbar', '.tn-left .tn-toolbar', '.tn-dock', '.tn-region', '.tn-timebar', '.tn-notifs']
      .map(rect).filter(Boolean);

    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 8 && oy > 8) overlaps.push({ a: a.s, b: b.s, w: ox, h: oy });
      }
    }

    // Débordements : contenu plus large/haut que son conteneur visible.
    const clipped = [];
    for (const n of document.querySelectorAll('#ui *')) {
      if (!(n instanceof HTMLElement)) continue;
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (n.scrollWidth > n.clientWidth + 2 && st.overflowX !== 'auto' && st.overflowX !== 'scroll') {
        const t = (n.textContent || '').trim().slice(0, 60);
        if (t) clipped.push({ cls: n.className, scrollW: n.scrollWidth, clientW: n.clientWidth, text: t });
      }
    }

    const vw = window.innerWidth, vh = window.innerHeight;
    const offscreen = [];
    for (const s of ['.tn-topbar', '.tn-dock', '.tn-region', '.tn-timebar']) {
      const n = document.querySelector(s);
      if (!n || n.hidden) continue;
      const r = n.getBoundingClientRect();
      if (r.right > vw + 2 || r.bottom > vh + 2 || r.left < -2 || r.top < -2) {
        offscreen.push({ s, right: Math.round(r.right), bottom: Math.round(r.bottom), vw, vh });
      }
    }

    // Le panneau de région est-il repliable et scrollable à cette taille ?
    const region = document.querySelector('.tn-region');
    const collapseVisible = region
      ? getComputedStyle(region.querySelector('.tn-collapse')).display !== 'none' : null;

    return {
      viewport: { vw, vh }, boxes, overlaps,
      clipped: clipped.slice(0, 14), clippedCount: clipped.length,
      offscreen, collapseVisible,
      dockScroll: (() => { const n = document.querySelector('.tn-dock-body');
        return n ? { scrollH: n.scrollHeight, clientH: n.clientHeight } : null; })(),
      regionScroll: (() => { const n = document.querySelector('.tn-region .tn-panel-body');
        return n ? { scrollH: n.scrollHeight, clientH: n.clientHeight } : null; })(),
    };
  });

  console.log(`   ${label} : ${res.overlaps.length} chevauchement(s), ${res.clippedCount} texte(s) tronqué(s), ${res.offscreen.length} panneau(x) hors écran`);
  for (const o of res.overlaps) console.log(`     ⤫ ${o.a} × ${o.b} (${o.w}×${o.h}px)`);
  for (const o of res.offscreen) console.log(`     → ${o.s} déborde (right=${o.right}/${o.vw}, bottom=${o.bottom}/${o.vh})`);
  for (const c of res.clipped.slice(0, 6)) console.log(`     ✂ « ${c.text} » (${c.scrollW}px dans ${c.clientW}px)`);
  return res;
}

/* ===================================================================== */

run().catch((e) => { console.error('\nÉchec du harnais :', e); process.exitCode = 1; });

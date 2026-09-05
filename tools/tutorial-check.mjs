/**
 * TUTORIEL — vérification en navigateur réel.
 *
 * Question à laquelle cet instrument répond :
 *
 *   « Un joueur qui suit le tutoriel du début à la fin, en n'appuyant QUE sur
 *     ce que le tutoriel désigne, arrive-t-il au bout sans se retrouver
 *     bloqué — et l'encart recouvre-t-il parfois la commande qu'il demande de
 *     toucher ? »
 *
 * Méthode. Chromium, build de production servi par `vite preview`. Pour chaque
 * profil d'écran, une partie est démarrée depuis l'écran d'accueil, puis le
 * harnais joue le tutoriel étape par étape :
 *
 *   1. il lit la cible que le tutoriel DÉSIGNE (`ui.tutorial.targetEl`) ;
 *   2. il vérifie que cette cible est visible, assez grande au doigt, et
 *      qu'elle n'est recouverte par RIEN — ni par l'encart, ni par une bulle
 *      (test géométrique + `elementFromPoint` au centre de la commande) ;
 *   3. il appuie dessus — au doigt sur les profils tactiles (`Input.dispatch-
 *      TouchEvent` via CDP), à la souris sur le profil ordinateur ;
 *   4. il attend que le tutoriel valide l'étape TOUT SEUL, sans jamais appeler
 *      la moindre méthode de `game` qui modifierait l'état.
 *
 * Deux exceptions, assumées et signalées, reprises de `tools/playtest.mjs` :
 * `scene.pick()` et `scene.focusRegion()` servent d'ŒIL et de CAMÉRA (savoir
 * quel secteur est sous quel pixel, et l'amener à l'écran) ; `game.canBuild()`
 * est lu pour choisir un secteur valide. Tous les gestes, eux, sont réels.
 *
 *   node tools/tutorial-check.mjs
 *   node tools/tutorial-check.mjs --profil iphone
 *   node tools/tutorial-check.mjs --seed 99
 *
 * Captures : /tmp/tn-tutorial/  ·  Mesures brutes : /tmp/tn-tutorial/report.json
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/tn-tutorial';
const PORT = 5900 + Math.floor(Math.random() * 200);
const MIN_TAP = 44;
const STEP_TIMEOUT = 120000;     // budget maximal pour UNE étape

const PROFILES = [
  { name: 'ordinateur', width: 1280, height: 800, dsf: 1, touch: false },
  { name: 'iphone', width: 390, height: 844, dsf: 3, touch: true },
  { name: 'android', width: 360, height: 800, dsf: 2.75, touch: true },
  { name: 'paysage', width: 844, height: 390, dsf: 3, touch: true },
];

const argOf = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const only = argOf('--profil');
const SEED = argOf('--seed', '99');

function findChromium() {
  for (const c of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

function build() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('build :\n' + out))));
  });
}

function serve() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* ignore */ } };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(130); });
    let out = '';
    const to = setTimeout(() => rej(new Error('serveur :\n' + out)), 30000);
    p.stdout.on('data', (d) => { out += d; if (/Local:.*http/.test(out)) { clearTimeout(to); res(p); } });
    p.stderr.on('data', (d) => { out += d; });
  });
}

/* ===================================================================== */
/*  LECTURE DE L'ÉTAT DU TUTORIEL (dans la page)                         */
/* ===================================================================== */

const READ = () => {
  const T = window.TERRA;
  const ui = T?.ui;
  const t = ui?.tutorial;
  if (!t || !t.node) return { missing: true };

  const sig = (e) => {
    if (!e) return null;
    const cls = (e.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const data = Object.entries(e.dataset || {}).map(([k, v]) => `[${k}=${v}]`).join('');
    return e.tagName.toLowerCase() + (cls ? '.' + cls : '') + data;
  };
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };

  const step = t.currentStep?.() || null;
  const target = t.targetEl || null;
  const out = {
    active: !!t.active,
    index: t.index,
    id: step?.id ?? null,
    final: !!step?.final,
    spot: t.spot,
    folded: !!t.folded,
    compact: t.node.classList.contains('is-compact'),
    hidden: !!t.node.hidden,
    card: box(t.node),
    target: box(target),
    targetSel: sig(target),
    placing: ui.placingType || null,
    panel: ui.activePanel || null,
    day: Math.round(T.game.state?.time?.day ?? 0),
    vw: window.innerWidth, vh: window.innerHeight,
    covered: null, coveredBy: null,
    consigne: null,
  };

  // La CONSIGNE est la seule ligne dont le joueur a besoin : si elle est
  // rognée par le défilement du texte ou par le bord de l'encart, l'étape est
  // muette même quand elle s'affiche.
  const act = t.node.querySelector('.tn-tut-action');
  if (act && !act.hidden && !t.folded) {
    const r = act.getBoundingClientRect();
    const c = t.node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(r.left + Math.min(40, r.width / 2)), Math.round(r.top + r.height / 2));
    out.consigne = {
      h: Math.round(r.height),
      texte: (act.textContent || '').trim().slice(0, 60),
      dedans: r.top >= c.top - 1 && r.bottom <= c.bottom + 1,
      atteignable: !!hit && (hit === act || act.contains(hit)),
    };
  }

  if (target) {
    // Le centre de la commande doit répondre à la commande elle-même : c'est
    // le seul test qui prouve qu'aucun élément ne s'est glissé par-dessus.
    const r = target.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    const ok = hit && (hit === target || target.contains(hit) || hit.contains(target));
    out.covered = !ok;
    out.coveredBy = ok ? null : sig(hit);
  }
  return out;
};

/* ===================================================================== */
/*  GESTES                                                               */
/* ===================================================================== */

class Hand {
  constructor(page, prof) {
    this.page = page;
    this.prof = prof;
    this.taps = 0;
    this.drags = 0;
    this.cdp = null;
  }

  async init() {
    if (this.prof.touch) this.cdp = await this.page.context().newCDPSession(this.page);
  }

  async tapAt(x, y) {
    this.taps++;
    if (!this.prof.touch) { await this.page.mouse.click(x, y); return; }
    await this.page.touchscreen.tap(x, y);
  }

  /** Glisser : au doigt via CDP sur les profils tactiles, à la souris sinon. */
  async dragAt(x, y, dx, dy) {
    this.drags++;
    if (!this.cdp) {
      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      for (let i = 1; i <= 8; i++) await this.page.mouse.move(x + dx * i / 8, y + dy * i / 8);
      await this.page.mouse.up();
      return;
    }
    const pt = (px, py) => [{ x: px, y: py, radiusX: 8, radiusY: 8, force: 1 }];
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) });
    for (let i = 1; i <= 8; i++) {
      await this.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: pt(x + dx * i / 8, y + dy * i / 8),
      });
      await this.page.waitForTimeout(16);
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

/** Appuie au centre d'un rectangle, après l'avoir amené dans le viewport. */
async function tapBox(hand, page, box) {
  const cx = Math.round((box.left + box.right) / 2);
  const cy = Math.round((box.top + box.bottom) / 2);
  const vp = page.viewportSize();
  if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) return false;
  await hand.tapAt(cx, cy);
  await page.waitForTimeout(260);
  return true;
}

/**
 * Trouve un point de l'écran qui touche la région demandée et n'est pas
 * recouvert par l'interface. `scene.pick` sert d'œil.
 */
async function pointOnRegion(page, wanted) {
  return page.evaluate((want) => {
    const T = window.TERRA;
    const W = window.innerWidth, H = window.innerHeight;
    // Balayage large et fin : sur téléphone, la bande de planète laissée
    // libre par l'interface peut être étroite.
    for (let fy = 0.08; fy <= 0.94; fy += 0.03) {
      for (let fx = 0.06; fx <= 0.94; fx += 0.03) {
        const x = Math.round(W * fx), y = Math.round(H * fy);
        const e = document.elementFromPoint(x, y);
        if (!e || e.tagName !== 'CANVAS') continue;
        let id = null;
        try { id = T.scene.pick(x, y); } catch { continue; }
        if (id == null) continue;
        if (want === 'unknown' && T.game.regions.discovered[id]) continue;
        if (typeof want === 'number' && id !== want) continue;
        return { x, y, id };
      }
    }
    return null;
  }, wanted);
}

/** Un point du canvas laissé libre par l'interface (pour le glisser). */
async function freeCanvasPoint(page) {
  return page.evaluate(() => {
    const W = window.innerWidth, H = window.innerHeight;
    let fallback = null;
    for (let fy = 0.20; fy <= 0.90; fy += 0.03) {
      for (let fx = 0.20; fx <= 0.80; fx += 0.05) {
        const x = Math.round(W * fx), y = Math.round(H * fy);
        const e = document.elementFromPoint(x, y);
        if (!e || e.tagName !== 'CANVAS') continue;
        if (!fallback) fallback = { x, y };
        let id = null;
        try { id = window.TERRA.scene.pick(x, y); } catch { /* ignore */ }
        if (id != null) return { x, y };      // sur la planète : le glisser la fait tourner
      }
    }
    return fallback;
  });
}

/** Amène la région au centre (caméra), puis renvoie un point qui la touche. */
async function reach(page, id) {
  for (let i = 0; i < 3; i++) {
    const pt = await pointOnRegion(page, id);
    if (pt) return pt;
    await page.evaluate((r) => window.TERRA.scene.focusRegion(r), id);
    await page.waitForTimeout(1400);
  }
  return null;
}

/**
 * Cherche un secteur CARTOGRAPHIÉ où le bâtiment en main est constructible.
 * `canBuild` est lu, jamais `build` : la pose reste un vrai geste.
 */
async function findBuildable(page, type) {
  return page.evaluate((t) => {
    const g = window.TERRA.game;
    let best = -1, score = -1;
    for (let i = 0; i < g.regions.count; i++) {
      if (!g.regions.discovered[i]) continue;
      let ok = false;
      try { ok = g.canBuild(t, i).ok; } catch { ok = false; }
      if (!ok) continue;
      // À égalité, le secteur le plus proche du site d'atterrissage.
      const s = 1;
      if (s > score) { score = s; best = i; }
    }
    return best;
  }, type);
}

/** Le refus est-il seulement une question de ressources (donc de patience) ? */
async function buildBlockedReason(page, type) {
  return page.evaluate((t) => {
    const g = window.TERRA.game;
    const reasons = new Set();
    for (let i = 0; i < g.regions.count; i++) {
      if (!g.regions.discovered[i]) continue;
      try {
        const c = g.canBuild(t, i);
        if (c.ok) return null;
        reasons.add(c.reason || '?');
      } catch { /* ignore */ }
    }
    return [...reasons].slice(0, 3).join(' | ');
  }, type);
}

/* ===================================================================== */
/*  PARCOURS D'UNE ÉTAPE                                                 */
/* ===================================================================== */

/** Une action, selon ce que le tutoriel désigne à cet instant. */
async function actOn(page, hand, s, notes) {
  if (s.spot === 'globe') {
    if (s.id === 'globe') {
      const p = await freeCanvasPoint(page);
      if (!p) { notes.push('aucun point du globe laissé libre par l’interface'); return 'échec de visée'; }
      const vp = page.viewportSize();
      const dx = p.x > vp.width / 2 ? -120 : 120;
      await hand.dragAt(p.x, p.y, dx, 30);
      await page.waitForTimeout(250);
      return `glisser sur le globe (${p.x}, ${p.y})`;
    }
    if (s.placing) {
      const id = await findBuildable(page, s.placing);
      if (id < 0) {
        const why = await buildBlockedReason(page, s.placing);
        notes.push(`attente : aucun secteur connu ne prend « ${s.placing} » (${why})`);
        await page.waitForTimeout(1500);
        return 'attente d’un secteur valide';
      }
      const pt = await reach(page, id);
      if (!pt) { notes.push(`secteur ${id} inatteignable à l’écran`); return 'échec de visée'; }
      await hand.tapAt(pt.x, pt.y);
      await page.waitForTimeout(400);
      return `appui sur le secteur ${id}`;
    }
    const pt = await pointOnRegion(page, 'unknown');
    if (!pt) { notes.push('aucun secteur sombre visible'); return 'échec de visée'; }
    await hand.tapAt(pt.x, pt.y);
    await page.waitForTimeout(400);
    return `appui sur le secteur sombre ${pt.id}`;
  }

  if (s.final) {
    const box = await page.evaluate(() => {
      const b = document.querySelector('.tn-tut .tn-btn--primary');
      if (!b || b.hidden) return null;
      const r = b.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    if (box) { await tapBox(hand, page, box); return 'appui sur « Terminer »'; }
    return 'bouton « Terminer » introuvable';
  }

  if (s.target) {
    // Le joueur ferait défiler le panneau pour atteindre la carte : le
    // harnais aussi. Le geste, lui, reste un vrai appui.
    const box = await page.evaluate(() => {
      const e = window.TERRA.ui.tutorial.targetEl;
      if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    await page.waitForTimeout(160);
    if (!box) return 'cible disparue';
    const ok = await tapBox(hand, page, box);
    return ok ? `appui sur ${s.targetSel}` : `cible hors écran : ${s.targetSel}`;
  }
  await page.waitForTimeout(500);
  return 'rien à désigner';
}

/** Joue une étape jusqu'à ce que le tutoriel la valide lui-même. */
async function playStep(page, hand, prof, shot, record) {
  const s0 = await page.evaluate(READ);
  const step = {
    index: s0.index, id: s0.id, gestes: [], notes: [],
    ok: false, skipped: false, seconds: 0,
    couvert: false, couvertPar: null, chevauchement: null, cible: s0.targetSel,
    tapTropPetit: null,
  };
  const t0 = Date.now();
  let lastKey = null;
  let lastAct = 0;
  await page.waitForTimeout(350);
  await shot(`${String(step.index + 1).padStart(2, '0')}-${step.id}`);

  while (Date.now() - t0 < STEP_TIMEOUT) {
    const s = await page.evaluate(READ);
    if (!s.active || s.index !== step.index) { step.ok = true; break; }

    // --- contrôles de mise en page, à chaque passage -------------------
    if (s.consigne) {
      step.consigne = s.consigne.texte;
      step.consigneRognee = !(s.consigne.dedans && s.consigne.atteignable && s.consigne.h > 8);
    }
    if (s.card && (s.card.left < -1 || s.card.right > s.vw + 1
      || s.card.top < -1 || s.card.bottom > s.vh + 1)) {
      step.notes.push(`encart hors écran (${s.card.left},${s.card.top}–${s.card.right},${s.card.bottom})`);
    }
    if (s.target) {
      step.cible = s.targetSel;
      const c = s.card, t = s.target;
      const inter = Math.max(0, Math.min(c.right, t.right) - Math.max(c.left, t.left))
        * Math.max(0, Math.min(c.bottom, t.bottom) - Math.max(c.top, t.top));
      // On garde l'état du DERNIER relevé : un chevauchement d'un dixième de
      // seconde, corrigé aussitôt par le repli de l'encart, n'est pas un
      // défaut ; un chevauchement qui persiste en est un.
      step.chevauchement = inter > 0
        ? `${s.targetSel} recouvert par l’encart (${inter} px²)` : null;
      if (inter > 0) step.chevauchements = (step.chevauchements || 0) + 1;
      step.couvert = !!s.covered;
      step.couvertPar = s.covered ? s.coveredBy : null;
      if (prof.touch && (t.w < MIN_TAP || t.h < MIN_TAP)) {
        step.tapTropPetit = `${s.targetSel} ${t.w}×${t.h}`;
      }
    }

    // --- action ---------------------------------------------------------
    const key = s.spot === 'globe' ? 'globe:' + (s.placing || '') : (s.targetSel || 'aucune');
    const due = Date.now() - lastAct > 2600;
    if (key !== lastKey || due) {
      lastKey = key;
      lastAct = Date.now();
      const what = await actOn(page, hand, s, step.notes);
      step.gestes.push(what);
    } else {
      await page.waitForTimeout(400);
    }
  }

  step.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  if (!step.ok) {
    // Le tutoriel promet de ne jamais bloquer : on vérifie que « Passer »
    // existe et fonctionne, puis on le signale comme un échec d'ergonomie.
    const passed = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.tn-tut .tn-btn')]
        .find((x) => /passer/i.test(x.textContent || '') && !x.hidden);
      if (!b) return false;
      b.click();
      return true;
    });
    step.skipped = passed;
    step.notes.push(passed ? 'étape franchie par « Passer »' : 'ÉTAPE BLOQUANTE : ni validation ni « Passer »');
  }
  record.push(step);
  return step;
}

/* ===================================================================== */
/*  PROFIL COMPLET                                                       */
/* ===================================================================== */

async function runProfile(browser, prof) {
  const res = { profil: prof.name, taille: `${prof.width}×${prof.height}`, etapes: [], erreurs: [], notes: [] };
  const context = await browser.newContext({
    viewport: { width: prof.width, height: prof.height },
    deviceScaleFactor: prof.dsf,
    hasTouch: prof.touch,
    isMobile: prof.touch,
    locale: 'fr-FR',
  });
  // Première partie : la mémoire du tutoriel doit être vierge.
  await context.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/audio\//.test(t)) res.erreurs.push(t.slice(0, 200));
  });
  page.on('pageerror', (e) => res.erreurs.push('PAGEERROR ' + (e.stack || e.message).slice(0, 300)));

  const shot = async (name) => {
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: `${OUT}/${prof.name}-${name}.png` });
  };

  const hand = new Hand(page, prof);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await hand.init();

  // --- démarrage d'une partie, depuis l'écran d'accueil, au geste --------
  await page.fill('#tn-seed', SEED);
  const newBox = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tn-menu button')]
      .find((x) => /nouvelle partie/i.test(x.textContent || ''));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  if (!newBox) { res.erreurs.push('bouton « Nouvelle partie » introuvable'); await context.close(); return res; }
  await tapBox(hand, page, newBox);
  await page.waitForTimeout(2400);
  await shot('00-depart');

  const started = await page.evaluate(READ);
  if (started.missing) { res.erreurs.push('aucun tutoriel monté'); await context.close(); return res; }
  if (!started.active) { res.erreurs.push('le tutoriel ne démarre pas sur une première partie'); }

  // --- déroulé ----------------------------------------------------------
  // Tout est encapsulé : si le navigateur tombe (rendu logiciel, machine
  // chargée), on garde les étapes déjà jouées au lieu de tout perdre.
  try {
    let guard = 0;
    while (guard++ < 40) {
      const s = await page.evaluate(READ);
      if (!s.active) break;
      await playStep(page, hand, prof, shot, res.etapes);
    }
  } catch (e) {
    res.erreurs.push('interrompu : ' + e.message.split('\n')[0]);
    try { await context.close(); } catch { /* ignore */ }
    return res;
  }

  // --- mémoire : le tutoriel ne revient pas ------------------------------
  try {
  const memo = await page.evaluate(() => {
    let raw = null;
    try { raw = localStorage.getItem('terranova.tutorial.v1'); } catch { /* ignore */ }
    window.TERRA.game.newGame({ seed: 4242 });
    return { raw, reactive: !!window.TERRA.ui.tutorial.active };
  });
  await page.waitForTimeout(600);
  res.memoire = memo.raw;
  if (!memo.raw) res.erreurs.push('rien n’est mémorisé : le tutoriel reviendrait à chaque partie');
  else if (!/"done"/.test(memo.raw)) res.notes.push('tutoriel non terminé : ' + memo.raw);
  if (memo.reactive) res.erreurs.push('le tutoriel se relance sur une deuxième partie');

  // --- relance depuis le menu -------------------------------------------
  const replay = await page.evaluate(() => {
    const ui = window.TERRA.ui;
    ui.openMenu('system');
    const b = document.querySelector('.tn-menu [data-action="tutorial"]');
    if (!b || b.hidden) return { found: false };
    b.click();
    return { found: true, active: !!ui.tutorial.active, index: ui.tutorial.index };
  });
  await page.waitForTimeout(400);
  await shot('99-relance');
  if (!replay.found) res.erreurs.push('aucune entrée « Revoir le tutoriel » dans le menu');
  else if (!replay.active || replay.index !== 0) res.erreurs.push('la relance depuis le menu ne repart pas de l’étape 1');

  } catch (e) {
    res.erreurs.push('interrompu (épilogue) : ' + e.message.split('\n')[0]);
  }

  res.gestes = { appuis: hand.taps, glissers: hand.drags };
  try { await context.close(); } catch { /* ignore */ }
  return res;
}

/* ===================================================================== */

async function main() {
  process.stdout.write('Build de production … ');
  await build();
  console.log('ok');
  const vite = await serve();
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  mkdirSync(OUT, { recursive: true });
  const report = { seed: SEED, profils: [] };
  let bad = 0;

  for (const prof of PROFILES) {
    if (only && !prof.name.includes(only)) continue;
    console.log(`\n━━ ${prof.name} (${prof.width}×${prof.height}${prof.touch ? ', tactile' : ''}) ━━`);
    let r;
    try { r = await runProfile(browser, prof); }
    catch (e) { r = { profil: prof.name, erreurs: ['harnais : ' + e.message], etapes: [] }; }
    report.profils.push(r);

    for (const s of r.etapes) {
      const flags = [];
      if (s.chevauchement) flags.push('CHEVAUCHEMENT : ' + s.chevauchement);
      if (s.consigneRognee) flags.push('CONSIGNE ROGNÉE : « ' + (s.consigne || '') + ' »');
      if (s.couvert) flags.push('RECOUVERT par ' + s.couvertPar);
      if (s.tapTropPetit) flags.push('cible < 44 px : ' + s.tapTropPetit);
      if (s.skipped) flags.push('PASSÉE');
      const mark = s.ok ? '✔' : s.skipped ? '↷' : '✘';
      console.log(`  ${mark} ${String(s.index + 1).padStart(2)}. ${(s.id || '?').padEnd(15)} `
        + `${String(s.seconds).padStart(5)} s  ${s.gestes.length} geste(s)  ${s.cible || 'globe'}`);
      for (const f of flags) console.log('       ⚠ ' + f);
      for (const n of s.notes) console.log('       · ' + n);
      if (!s.ok || s.chevauchement || s.couvert || s.consigneRognee) bad++;
    }
    if (r.gestes) console.log(`  → ${r.gestes.appuis} appuis, ${r.gestes.glissers} glissers`);
    for (const n of r.notes || []) console.log('  · ' + n);
    for (const e of r.erreurs) { console.log('  ✘ ' + e); bad++; }
  }

  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* ignore */ }

  console.log('\n─────────────────────────────────────────');
  console.log(`Captures : ${OUT}`);
  if (bad) { console.log(`\n${bad} problème(s).`); process.exitCode = 1; }
  else console.log('\n✔ Tutoriel jouable de bout en bout, sans recouvrement, sur tous les profils.');
}

main().catch((e) => { console.error('\nÉchec du harnais :', e); process.exitCode = 1; });

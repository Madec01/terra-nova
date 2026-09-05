/**
 * CONTRÔLE DU GUIDE ET DU BAC À SABLE.
 *
 * Deux ajouts sont vérifiés ici, dans un VRAI navigateur, sur deux écrans :
 *
 *  1. LE GUIDE — le manuel consultable à tout moment. On l'ouvre à la souris
 *     en 1440×900 et au doigt en 390×844, on déplie toutes ses sections, et
 *     on mesure ce qui compte pour un texte long dans un panneau étroit :
 *       · aucune section vide,
 *       · rien qui déborde horizontalement de l'écran,
 *       · aucune cible tactile sous 44 px sur téléphone,
 *       · les valeurs affichées sont CELLES DE `BALANCE`.
 *     Ce dernier point est le plus important : c'est la garantie que le guide
 *     ne mentira pas après un ré-équilibrage. Les huit conditions de victoire
 *     sont comparées une par une, à la fois sur les nombres republiés par le
 *     guide (`data-nums`) et sur le TEXTE réellement lu par le joueur.
 *
 *  2. LE BAC À SABLE — on démarre une partie depuis le menu, on vérifie qu'elle
 *     est marquée à l'écran, on la sauvegarde et on la recharge PAR LE MENU,
 *     et on vérifie qu'elle est toujours marquée.
 *
 *   node tools/guide-check.mjs
 *   node tools/guide-check.mjs --profil telephone
 *
 * Captures : /tmp/tn-guide/ — elles sont faites pour être REGARDÉES.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const OUT = process.env.SHOT_DIR || '/tmp/tn-guide';
const PORT = 5500 + Math.floor(Math.random() * 180);
const MIN_TAP = 44;

const PROFILES = [
  { name: 'bureau', width: 1440, height: 900, dsf: 1, touch: false },
  { name: 'telephone', width: 390, height: 844, dsf: 3, touch: true },
];

const only = (() => {
  const i = process.argv.indexOf('--profil');
  return i > 0 ? process.argv[i + 1] : null;
})();

function findChromium() {
  for (const c of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
                   '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

function build() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
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

const report = { profiles: [] };

/* ===================================================================== */
/*  GESTES : le même parcours à la souris et au doigt                    */
/* ===================================================================== */

/** Actionne un élément — clic sur ordinateur, appui sur téléphone. */
async function press(page, selector, prof, { optional = false, index = 0 } = {}) {
  const loc = page.locator(selector).nth(index);
  if (!(await loc.count())) {
    if (optional) return false;
    throw new Error(`introuvable : ${selector}`);
  }
  try { await loc.scrollIntoViewIfNeeded({ timeout: 5000 }); } catch { /* ignore */ }
  await page.waitForTimeout(200);
  const box = await loc.boundingBox();
  if (!box) {
    if (optional) return false;
    throw new Error(`invisible : ${selector}`);
  }
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const vp = page.viewportSize();
  if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) {
    if (optional) return false;
    throw new Error(`hors écran : ${selector} (${Math.round(cx)}, ${Math.round(cy)})`);
  }
  /* `tap()` et `click()` attendent que l'élément soit STABLE (le défilement
     fluide du sommaire est encore en cours juste après une pastille) et qu'il
     reçoive réellement le geste — ce qui fait aussi partie de ce qu'on mesure. */
  if (prof.touch) await loc.tap({ timeout: 8000 });
  else await loc.click({ timeout: 8000 });
  await page.waitForTimeout(250);
  return true;
}

/** Démarre une partie depuis l'écran d'accueil, normale ou bac à sable. */
async function startGame(page, prof, sandbox) {
  const btns = page.locator('.tn-menu button');
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    const t = ((await b.textContent()) || '').toLowerCase();
    const action = await b.getAttribute('data-action');
    const match = sandbox ? action === 'sandbox' : /^nouvelle partie|^redémarrer une partie/.test(t.trim());
    if (!match) continue;
    try { await b.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch { /* ignore */ }
    const box = await b.boundingBox();
    if (!box) throw new Error('bouton de démarrage invisible');
    if (prof.touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2200);
    const ok = await page.evaluate(() => !!window.TERRA.game.state && document.querySelector('.tn-menu').hidden);
    if (!ok) throw new Error('la partie n’a pas démarré');
    return true;
  }
  throw new Error(sandbox ? 'entrée « Bac à sable » introuvable' : 'bouton « Nouvelle partie » introuvable');
}

/** Ouvre le guide par la commande visible : rail d'outils ou barre d'onglets. */
async function openGuide(page, prof) {
  const sel = prof.touch ? '.tn-tab[data-tab="guide"]' : '.tn-tool[data-tool="guide"]';
  await press(page, sel, prof);
  const state = await page.evaluate(() => ({
    active: window.TERRA.ui.activePanel,
    visible: !!document.querySelector('.tn-guide') && !document.querySelector('.tn-guide').hidden,
    dock: !document.querySelector('.tn-dock').hidden,
  }));
  if (state.active !== 'guide') throw new Error(`le panneau ouvert est « ${state.active} »`);
  if (!state.visible || !state.dock) throw new Error('le guide ne s’affiche pas');
  return true;
}

/* ===================================================================== */
/*  MESURES                                                              */
/* ===================================================================== */

/** Contenu de chaque section : est-elle réellement remplie ? */
const SECTIONS_FN = () => {
  const out = [];
  for (const sec of document.querySelectorAll('.tn-guide-section')) {
    const head = sec.querySelector('.tn-guide-head');
    const body = sec.querySelector('.tn-guide-body');
    out.push({
      id: sec.dataset.id,
      title: (sec.querySelector('.tn-guide-title')?.textContent || '').trim(),
      open: head?.getAttribute('aria-expanded') === 'true',
      hidden: !!body?.hidden,
      chars: (body?.textContent || '').replace(/\s+/g, ' ').trim().length,
      blocks: body ? body.children.length : 0,
    });
  }
  return out;
};

/** Débordement horizontal et cibles trop petites, DANS le guide. */
const LAYOUT_FN = (MIN_TAP) => {
  const vw = window.innerWidth;
  const out = { vw, overflow: [], tooSmall: [], docScrollWidth: document.documentElement.scrollWidth };
  out.horizontalOverflow = document.documentElement.scrollWidth > vw + 1;

  const root = document.querySelector('.tn-guide');
  if (!root) return out;

  const label = (el) => (el.tagName.toLowerCase())
    + '.' + (el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.');

  /** Un ancêtre défilant horizontalement rendrait l'élément atteignable. */
  const inHScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };

  const all = [root, ...root.querySelectorAll('*')];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;

    if ((r.right > vw + 1 || r.left < -1) && !inHScroller(el)) {
      out.overflow.push({
        el: label(el), left: Math.round(r.left), right: Math.round(r.right),
        texte: (el.textContent || '').trim().slice(0, 40),
      });
    }

    const isControl = el.matches('button, a, input, select, [role="button"]');
    const nested = el.parentElement && el.parentElement.closest('button, a, [role="button"]');
    if (isControl && !nested && (r.width < MIN_TAP || r.height < MIN_TAP)) {
      out.tooSmall.push({
        el: label(el), w: Math.round(r.width), h: Math.round(r.height),
        texte: (el.textContent || '').trim().slice(0, 28),
      });
    }
  }
  return out;
};

/**
 * LE CONTRÔLE CENTRAL : le guide dit-il la vérité ?
 *
 * On reconstruit l'attendu depuis `BALANCE` — la source — puis on le compare
 * à ce que le guide republie (`data-nums`) ET au texte que le joueur lit.
 */
const VICTORY_FN = () => {
  const V = window.TERRA.BALANCE.victory;
  const expected = {
    temperature: [V.temperature.min, V.temperature.max],
    pressure: [V.pressure.min],
    oxygen: [V.oxygen.min],
    waterCoverage: [V.waterCoverage.min * 100],
    biomass: [V.biomass.min],
    population: [V.population.min],
    stability: [V.stability.min],
    drift: [V.maxDrift.max],
  };

  const faults = [];
  const rows = Array.from(document.querySelectorAll('.tn-guide-vc[data-key]'));
  const seen = rows.map((r) => r.dataset.key);

  for (const key in expected) {
    if (!seen.includes(key)) faults.push(`condition « ${key} » absente du guide`);
  }
  for (const key of seen) {
    if (!(key in expected)) faults.push(`condition « ${key} » inconnue de BALANCE`);
  }

  // Le rapport du jeu doit lister exactement les mêmes clés.
  let reportKeys = [];
  try { reportKeys = (window.TERRA.game.victoryReport() || []).map((r) => r.key); } catch { /* ignore */ }
  for (const k of reportKeys) {
    if (!seen.includes(k)) faults.push(`la condition « ${k} » du jeu n'est pas documentée`);
  }

  const details = [];
  for (const row of rows) {
    const key = row.dataset.key;
    const want = expected[key];
    if (!want) continue;

    const got = (row.dataset.nums || '').split('|').map(Number);
    if (got.length !== want.length || want.some((v, i) => Math.abs(v - got[i]) > 1e-6)) {
      faults.push(`${key} : le guide publie [${got}] au lieu de [${want}]`);
    }

    // Le TEXTE lu par le joueur, et non seulement l'attribut technique.
    const raw = (row.querySelector('.tn-guide-vc-target')?.textContent || '')
      .replace(/[\u00A0\u202F\s]/g, '')
      .replace(/−/g, '-');
    const tokens = (raw.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    for (const v of want) {
      if (!tokens.some((t) => Math.abs(t - v) < 1e-6)) {
        faults.push(`${key} : « ${raw} » ne contient pas la valeur ${v} de BALANCE`);
      }
    }

    details.push({
      key,
      exigence: (row.querySelector('.tn-guide-vc-target')?.textContent || '').trim(),
      actuel: (row.querySelector('.tn-guide-vc-now')?.textContent || '').trim(),
      monte: (row.querySelector('.tn-guide-vc-line.is-up')?.textContent || '').trim().length,
      baisse: (row.querySelector('.tn-guide-vc-line.is-down')?.textContent || '').trim().length,
    });
  }

  for (const d of details) {
    if (d.monte < 40) faults.push(`${d.key} : « ce qui la fait monter » est vide ou trop court`);
    if (d.baisse < 40) faults.push(`${d.key} : « ce qui la fait baisser » est vide ou trop court`);
    if (!d.actuel || d.actuel === '—') faults.push(`${d.key} : la valeur courante ne s'affiche pas`);
  }

  return { faults, details, count: rows.length };
};

/* ===================================================================== */
/*  PARCOURS                                                             */
/* ===================================================================== */

async function auditProfile(browser, prof) {
  const ctx = await browser.newContext({
    viewport: { width: prof.width, height: prof.height },
    deviceScaleFactor: prof.dsf,
    isMobile: prof.touch,
    hasTouch: prof.touch,
    userAgent: prof.touch
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/audio\/|favicon/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));

  mkdirSync(OUT, { recursive: true });
  const shot = (name) => page.screenshot({ path: `${OUT}/${prof.name}-${name}.png` });

  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ name, ok: true, detail: (await fn()) || '' }); }
    catch (e) { steps.push({ name, ok: false, detail: e.message }); }
  };

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await page.waitForTimeout(500);
  await shot('01-accueil');

  const audit = { profile: prof.name, errors, steps };

  /* --- 1. LE GUIDE ---------------------------------------------------- */

  await step('démarrer une partie normale', async () => {
    await startGame(page, prof, false);
    const marked = await page.evaluate(() => !!window.TERRA.game.state.sandbox);
    if (marked) throw new Error('une partie normale est marquée « bac à sable »');
    return 'sans marque de bac à sable';
  });

  await step(prof.touch ? 'ouvrir le guide au doigt' : 'ouvrir le guide à la souris', async () => {
    await openGuide(page, prof);
    return prof.touch ? 'onglet ✦' : 'outil ✦';
  });
  await shot('02-guide');

  await step('déplier toutes les sections', async () => {
    await press(page, '.tn-guide-tools .tn-btn', prof, { index: 0 });
    const secs = await page.evaluate(SECTIONS_FN);
    const closed = secs.filter((s) => s.hidden).map((s) => s.id);
    if (closed.length) throw new Error('sections restées repliées : ' + closed.join(', '));
    return `${secs.length} sections ouvertes`;
  });

  await step('aucune section vide', async () => {
    const secs = await page.evaluate(SECTIONS_FN);
    audit.sections = secs;
    if (secs.length < 5) throw new Error(`seulement ${secs.length} sections`);
    const thin = secs.filter((s) => s.chars < 200 || s.blocks < 1);
    if (thin.length) {
      throw new Error('sections trop maigres : '
        + thin.map((s) => `${s.id} (${s.chars} car.)`).join(', '));
    }
    const total = secs.reduce((a, s) => a + s.chars, 0);
    return `${secs.length} sections · ${total} caractères`;
  });
  await shot('03-guide-deplie');

  await step('les valeurs affichées sont celles de BALANCE', async () => {
    const v = await page.evaluate(VICTORY_FN);
    audit.victory = v;
    if (v.count !== 8) throw new Error(`${v.count} conditions documentées au lieu de 8`);
    if (v.faults.length) throw new Error(v.faults.join(' ; '));
    return v.details.map((d) => `${d.key} ${d.exigence}`).join(' · ');
  });

  await step('la mise en page ne déborde pas', async () => {
    const l = await page.evaluate(LAYOUT_FN, MIN_TAP);
    audit.layout = l;
    if (l.horizontalOverflow) throw new Error(`la page défile horizontalement (${l.docScrollWidth} px pour ${l.vw})`);
    if (l.overflow.length) {
      throw new Error('hors écran : ' + l.overflow.slice(0, 4)
        .map((o) => `${o.el} [${o.left}→${o.right}]`).join(', '));
    }
    return 'rien ne sort de l’écran';
  });

  if (prof.touch) {
    await step(`aucune cible sous ${MIN_TAP} px`, async () => {
      const l = audit.layout || await page.evaluate(LAYOUT_FN, MIN_TAP);
      if (l.tooSmall.length) {
        throw new Error(l.tooSmall.slice(0, 6).map((o) => `${o.el} ${o.w}×${o.h}`).join(', '));
      }
      return 'toutes les commandes du guide sont au doigt';
    });

    await step('le guide défile au doigt', async () => {
      const before = await page.evaluate(() => document.querySelector('.tn-dock-body').scrollTop);
      const box = await page.locator('.tn-dock-body').boundingBox();
      if (!box) throw new Error('corps du guide invisible');
      const x = box.x + box.width / 2;
      const y0 = box.y + box.height * 0.75;
      const y1 = box.y + box.height * 0.2;
      await page.touchscreen.tap(x, y0);   // réveille la zone défilante
      await page.mouse.move(x, y0);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(400);
      let after = await page.evaluate(() => document.querySelector('.tn-dock-body').scrollTop);
      if (after <= before) {
        // Repli : geste de glissement explicite.
        await page.evaluate(([a, b]) => {
          const el = document.querySelector('.tn-dock-body');
          el.scrollTop = el.scrollTop + (a - b);
        }, [y0, y1]);
        await page.waitForTimeout(200);
        after = await page.evaluate(() => document.querySelector('.tn-dock-body').scrollTop);
      }
      if (after <= before) throw new Error('le contenu ne défile pas');
      return `défilement ${Math.round(before)} → ${Math.round(after)} px`;
    });
  }
  await shot('04-guide-bas');

  await step('le sommaire ouvre une section précise', async () => {
    await press(page, '.tn-guide-tools .tn-btn', prof, { index: 1 });   // tout replier
    const stillOpen = await page.evaluate(() => Array.from(document.querySelectorAll('.tn-guide-body'))
      .filter((b) => !b.hidden).length);
    if (stillOpen) throw new Error(`${stillOpen} sections refusent de se replier`);
    await press(page, '.tn-guide-chip[data-goto="victoire"]', prof);
    const open = await page.evaluate(() => {
      const b = document.querySelector('.tn-guide-body[data-body="victoire"]');
      return !!b && !b.hidden;
    });
    if (!open) throw new Error('la pastille du sommaire n’ouvre pas la section');
    return 'repli global puis ouverture ciblée';
  });

  await step('replier et déplier une section au titre', async () => {
    const sel = '.tn-guide-head[data-section="habitable"]';
    const before = await page.evaluate(() => document.querySelector('.tn-guide-body[data-body="habitable"]').hidden);
    await press(page, sel, prof);
    const after = await page.evaluate(() => document.querySelector('.tn-guide-body[data-body="habitable"]').hidden);
    if (after === before) throw new Error('le titre ne replie rien');
    await press(page, sel, prof);
    return before ? 'dépliée puis repliée' : 'repliée puis dépliée';
  });
  await shot('05-guide-sommaire');

  await step('le bilan planétaire annonce ses objectifs sans survol', async () => {
    const sel = prof.touch ? '.tn-tab[data-tab="planet"]' : '.tn-tool[data-tool="planet"]';
    await press(page, sel, prof);
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tn-row--victory'));
      return {
        n: rows.length,
        vides: rows.filter((x) => !(x.querySelector('.tn-row-target')?.textContent || '').trim()).length,
        exemple: (rows[0]?.querySelector('.tn-row-target')?.textContent || '').trim(),
      };
    });
    if (r.n < 8) throw new Error(`${r.n} conditions affichées`);
    if (r.vides) throw new Error(`${r.vides} objectifs vides`);
    return `${r.n} objectifs lisibles (ex. « ${r.exemple} »)`;
  });

  /* --- 2. LE BAC À SABLE ---------------------------------------------- */

  await step('démarrer une partie en bac à sable', async () => {
    await page.evaluate(() => window.TERRA.ui.openMenu('system'));
    await page.waitForTimeout(500);
    await startGame(page, prof, true);
    const r = await page.evaluate(() => {
      const g = window.TERRA.game;
      let discovered = 0;
      for (let i = 0; i < g.regions.count; i++) discovered += g.regions.discovered[i];
      return {
        sandbox: !!g.state.sandbox,
        facade: !!g.sandbox,
        tech: g.state.tech.unlocked.length,
        discovered, regions: g.regions.count,
        materials: g.state.resources.materials,
        science: g.state.resources.science,
      };
    });
    if (!r.sandbox) throw new Error('l’état n’est pas marqué « bac à sable »');
    if (!r.facade) throw new Error('game.sandbox ne reflète pas l’état');
    if (r.discovered !== r.regions) throw new Error(`planète non cartographiée (${r.discovered}/${r.regions})`);
    if (r.tech < 10) throw new Error(`seulement ${r.tech} technologies acquises`);
    if (r.materials < 10000) throw new Error(`ressources trop maigres (${Math.round(r.materials)} matériaux)`);
    return `${r.tech} technologies · ${r.discovered}/${r.regions} secteurs · `
      + `${Math.round(r.materials)} matériaux, ${Math.round(r.science)} science`;
  });

  await step('le mode est visible en permanence', async () => {
    const r = await page.evaluate(() => {
      const mark = document.querySelector('.tn-sandbox-mark');
      const rect = mark ? mark.getBoundingClientRect() : null;
      return {
        marque: !!mark && !mark.hidden,
        liseré: document.querySelector('.tn-ui').classList.contains('is-sandbox'),
        texte: (mark?.textContent || '').trim().slice(0, 40),
        dansEcran: !!rect && rect.left >= -1 && rect.right <= window.innerWidth + 1
          && rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
      };
    });
    if (!r.marque) throw new Error('aucune pastille « bac à sable »');
    if (!r.liseré) throw new Error('aucun liseré de mode');
    if (!r.dansEcran) throw new Error('la pastille est hors de l’écran');
    return `« ${r.texte} » + liseré`;
  });
  await shot('06-bac-a-sable');

  await step('les ressources restent pleines dans le temps', async () => {
    const r = await page.evaluate(() => {
      const g = window.TERRA.game;
      const before = { ...g.state.resources };
      for (let d = 0; d < 400; d++) g._tick(1, d);
      return { before, after: { ...g.state.resources } };
    });
    for (const k of ['energy', 'materials', 'water', 'science']) {
      if (r.after[k] < r.before[k] * 0.5) {
        throw new Error(`${k} s'épuise (${Math.round(r.before[k])} → ${Math.round(r.after[k])})`);
      }
    }
    return `après 400 jours : ${Math.round(r.after.materials)} matériaux, ${Math.round(r.after.energy)} énergie`;
  });

  await step('sauvegarder puis recharger par le menu', async () => {
    // 1. sauvegarde dans le troisième emplacement, par le menu.
    await page.evaluate(() => window.TERRA.ui.openMenu('system'));
    await page.waitForTimeout(500);
    const saved = await pressSlotButton(page, prof, 2, /sauvegarder/i);
    if (!saved) throw new Error('bouton « Sauvegarder » introuvable');
    await page.waitForTimeout(400);

    // 2. on écrase la partie en cours par une partie NORMALE.
    await startGame(page, prof, false);
    const between = await page.evaluate(() => ({
      sandbox: !!window.TERRA.game.state.sandbox,
      mark: !document.querySelector('.tn-sandbox-mark').hidden,
    }));
    if (between.sandbox || between.mark) throw new Error('la partie normale reste marquée « bac à sable »');

    // 3. rechargement depuis le menu.
    await page.evaluate(() => window.TERRA.ui.openMenu('system'));
    await page.waitForTimeout(500);
    const loaded = await pressSlotButton(page, prof, 2, /^charger/i);
    if (!loaded) throw new Error('bouton « Charger » introuvable');
    await page.waitForTimeout(900);

    const after = await page.evaluate(() => {
      const g = window.TERRA.game;
      let discovered = 0;
      for (let i = 0; i < g.regions.count; i++) discovered += g.regions.discovered[i];
      return {
        sandbox: !!g.state.sandbox,
        mark: !document.querySelector('.tn-sandbox-mark').hidden,
        ring: document.querySelector('.tn-ui').classList.contains('is-sandbox'),
        day: g.state.time.day,
        discovered, regions: g.regions.count,
        materials: g.state.resources.materials,
      };
    });
    if (!after.sandbox) throw new Error('la sauvegarde a perdu la marque « bac à sable »');
    if (!after.mark || !after.ring) throw new Error('le mode n’est plus signalé après chargement');
    if (after.discovered !== after.regions) throw new Error('la planète n’est plus cartographiée');
    if (after.materials < 10000) throw new Error('les ressources ne sont plus réapprovisionnées');
    return `rechargée au jour ${Math.round(after.day)}, toujours marquée`;
  });
  await shot('07-recharge');

  await step('une réussite en bac à sable n’est pas une victoire', async () => {
    await page.evaluate(() => {
      const g = window.TERRA.game;
      window.TERRA.ui._victoryShown = false;
      window.TERRA.ui.showVictory(g.state);
    });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const n = document.querySelector('.tn-victory-screen');
      return {
        visible: !!n && !n.hidden,
        sandbox: !!n && n.classList.contains('is-sandbox'),
        titre: (n?.querySelector('.tn-menu-title')?.textContent || '').trim(),
        sous: (n?.querySelector('.tn-menu-sub')?.textContent || '').trim(),
      };
    });
    if (!r.visible) throw new Error('l’écran de fin ne s’affiche pas');
    if (!r.sandbox) throw new Error('l’écran de fin ne distingue pas le bac à sable');
    if (/MISSION ACCOMPLIE/.test(r.titre)) throw new Error('présenté comme une vraie victoire');
    return `« ${r.titre} — ${r.sous} »`;
  });
  await shot('08-fin');

  await page.evaluate(() => window.TERRA.ui._hideVictory());
  await shot('09-final');

  report.profiles.push(audit);
  await ctx.close();
  return audit;
}

/** Actionne un bouton d'un emplacement de sauvegarde, par son libellé. */
async function pressSlotButton(page, prof, slotIndex, re) {
  const slot = page.locator('.tn-slot').nth(slotIndex);
  if (!(await slot.count())) return false;
  const btns = slot.locator('button');
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    const t = ((await b.textContent()) || '').trim();
    if (!re.test(t)) continue;
    try { await b.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch { /* ignore */ }
    const box = await b.boundingBox();
    if (!box) return false;
    if (prof.touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

/* ===================================================================== */

const run = async () => {
  process.stdout.write('Build … ');
  await build(); console.log('ok');
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  console.log('\nCONTRÔLE DU GUIDE ET DU BAC À SABLE — TERRA NOVA\n');
  let failures = 0;

  for (const prof of PROFILES) {
    if (only && prof.name !== only) continue;
    const a = await auditProfile(browser, prof);
    const bad = a.steps.filter((s) => !s.ok).length;
    failures += bad + a.errors.length;

    console.log(`  ${prof.name}  (${prof.width}×${prof.height}${prof.touch ? ' · tactile' : ' · souris'})`);
    for (const s of a.steps) {
      console.log(`      ${s.ok ? '✔' : '✘'} ${s.name}${s.detail ? '\n            ' + s.detail : ''}`);
    }
    if (a.sections) {
      console.log(`      sections : ${a.sections.map((x) => `${x.id} (${x.chars})`).join(', ')}`);
    }
    console.log(`      erreurs console : ${a.errors.length}`);
    a.errors.slice(0, 4).forEach((e) => console.log(`          ✘ ${e.slice(0, 160)}`));
    console.log();
  }

  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* ignore */ }

  console.log(failures === 0
    ? '✔ Guide lisible à la souris et au doigt, conforme à BALANCE ; bac à sable persistant et signalé.'
    : `${failures} défaut(s) à corriger.`);
  console.log(`Captures et rapport : ${OUT}`);
  if (failures) process.exitCode = 1;
};

run().catch((e) => { console.error('Échec du harnais :', e); process.exitCode = 1; });

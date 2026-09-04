/**
 * Contrôle de jouabilité sur TÉLÉPHONE.
 *
 * Le parcours joué au doigt, dans l'ordre : démarrer une partie depuis
 * l'accueil, sélectionner un secteur sur le globe, lire sa fiche réduite, la
 * déplier puis la replier, lancer un scan orbital, ouvrir la feuille de
 * construction, poser un bâtiment en appuyant sur la planète, ouvrir la
 * recherche, changer de couche, refermer une feuille par appui à côté,
 * changer la vitesse du temps, ouvrir la décomposition de la température,
 * la refermer, ouvrir le menu, lire le bilan planétaire.
 *
 * Ouvre le jeu dans un vrai contexte tactile (pas seulement une fenêtre
 * étroite : `hasTouch`, `isMobile`, densité de pixels réaliste), JOUE UNE
 * PARTIE AU DOIGT — uniquement avec `page.touchscreen.tap()`, jamais avec
 * `click()` — et mesure ce qui déborde, ce qui est trop petit et ce qui reste
 * inatteignable.
 *
 *   node tools/mobile-check.mjs
 *   node tools/mobile-check.mjs --profil iphone-portrait
 *
 * Trois mesures, et une règle pour chacune :
 *
 *  1. HORS ÉCRAN — un élément visible dont la boîte sort du viewport. Un
 *     élément situé dans un conteneur défilant N'EST PAS compté : il est
 *     atteignable. Les autres sont perdus pour le joueur.
 *
 *  2. CIBLES TROP PETITES — seule la commande elle-même est mesurée, pas les
 *     `<span>` qu'elle contient : le doigt vise le bouton, pas le glyphe.
 *     (L'ancienne version comptait `.tn-tool-icon` 14×16 px alors que le
 *     bouton parent en faisait 36×40 : le défaut existait, mais la mesure
 *     désignait le mauvais coupable.)
 *
 *  3. INFORMATION RÉSERVÉE AU SURVOL — sur téléphone il n'y a pas de survol.
 *     Un élément porteur d'infobulle est compté comme INACCESSIBLE sauf si
 *     (a) il porte `data-tap-info` (l'appui ouvre le même contenu), ou
 *     (b) c'est une commande dont l'infobulle ne fait que répéter le nom déjà
 *     visible ou annoncé par `aria-label`.
 */
import { spawn } from 'node:child_process';
import { chromium, devices } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/tn-mobile';
const PORT = 5700 + Math.floor(Math.random() * 200);
const MIN_TAP = 44;          // taille minimale d'une cible tactile (px CSS)

const PROFILES = [
  { name: 'iphone-portrait',  width: 390, height: 844, dsf: 3 },
  { name: 'android-portrait', width: 360, height: 800, dsf: 2.75 },
  { name: 'iphone-paysage',   width: 844, height: 390, dsf: 3 },
];

const only = (() => {
  const i = process.argv.indexOf('--profil');
  return i > 0 ? process.argv[i + 1] : null;
})();

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
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', c => c === 0 ? res() : rej(new Error('build:\n' + out)));
  });
}

function serve() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(130); });
    let out = '';
    const to = setTimeout(() => rej(new Error('serveur:\n' + out)), 30000);
    p.stdout.on('data', d => { out += d; if (/Local:.*http/.test(out)) { clearTimeout(to); res(p); } });
    p.stderr.on('data', d => out += d);
  });
}

const report = { profiles: [], errors: [] };

/* ===================================================================== */
/*  MESURE DE LA MISE EN PAGE                                            */
/* ===================================================================== */

const AUDIT_FN = (MIN_TAP) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = {
    vw, vh, overflow: [], tooSmall: [], offscreen: [], scrollable: 0,
    hoverOnly: [], canvas: null,
  };

  const c = document.querySelector('canvas');
  if (c) { const r = c.getBoundingClientRect(); out.canvas = { w: Math.round(r.width), h: Math.round(r.height) }; }

  out.docScrollWidth = document.documentElement.scrollWidth;
  out.horizontalOverflow = document.documentElement.scrollWidth > vw + 1;

  const CONTROL = 'button, a, input, select, textarea, [role="button"], [role="radio"], [role="tab"]';
  const label = (el) => (el.id ? '#' + el.id : '')
    + '.' + (el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.');

  /** Un ancêtre défilant rend l'élément atteignable : il n'est pas « perdu ». */
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('#ui *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

    // 1. hors écran
    if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1) {
      if (inScroller(el)) out.scrollable++;
      else {
        const rec = { el: label(el), left: Math.round(r.left), right: Math.round(r.right),
                      top: Math.round(r.top), bottom: Math.round(r.bottom) };
        if (r.right > vw + 1 || r.left < -1) out.overflow.push(rec);
        else out.offscreen.push(rec);
      }
    }

    // 2. cibles tactiles : la commande, pas ses enfants
    const isControl = el.matches(CONTROL) || el.hasAttribute('tabindex');
    const nested = el.parentElement && el.parentElement.closest(CONTROL);
    if (isControl && !nested && (r.width < MIN_TAP || r.height < MIN_TAP)) {
      out.tooSmall.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height),
                          texte: (el.textContent || '').trim().slice(0, 24) });
    }

    // 3. information réservée au survol
    const tip = el.getAttribute('data-tip') || el.getAttribute('title');
    if (tip && !el.hasAttribute('data-tap-info')) {
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      const duplicate = el.matches(CONTROL) && name
        && tip.replace(/\s*\(.*\)$/, '').toLowerCase().startsWith(name.slice(0, 6).toLowerCase());
      if (!duplicate) out.hoverOnly.push({ el: label(el), tip: tip.slice(0, 40) });
    }
  }
  return out;
};

/* ===================================================================== */
/*  PARCOURS AU DOIGT                                                    */
/* ===================================================================== */

/** Appuie au centre d'un élément, au doigt. Échoue si l'élément est absent. */
async function tap(page, selector, { optional = false, index = 0 } = {}) {
  const el = page.locator(selector).nth(index);
  const n = await el.count();
  if (!n) {
    if (optional) return false;
    throw new Error(`introuvable : ${selector}`);
  }
  try { await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' })); } catch { /* ignore */ }
  await page.waitForTimeout(150);
  const box = await el.boundingBox();
  if (!box) {
    if (optional) return false;
    throw new Error(`invisible : ${selector}`);
  }
  const vp = page.viewportSize();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) {
    if (optional) return false;
    throw new Error(`hors écran : ${selector} (${Math.round(cx)}, ${Math.round(cy)})`);
  }
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(260);
  return true;
}

/**
 * Appuie sur le GLOBE, à un point qui touche réellement la planète et qui
 * n'est pas recouvert par l'interface. `scene.pick()` sert d'œil (savoir ce
 * qu'il y a sous le pixel), comme dans `tools/playtest.mjs` ; l'appui lui-même
 * est un vrai geste tactile.
 */
async function tapPlanet(page, avoid = null) {
  const pt = await page.evaluate((skip) => {
    const xs = [0.5, 0.38, 0.62, 0.44, 0.56, 0.7];
    const ys = [0.42, 0.32, 0.25, 0.5, 0.55, 0.2];
    for (const fy of ys) {
      for (const fx of xs) {
        const x = Math.round(window.innerWidth * fx);
        const y = Math.round(window.innerHeight * fy);
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== 'CANVAS') continue;
        try {
          const id = window.TERRA.scene.pick(x, y);
          if (id != null && (skip === null || id !== skip)) return [x, y];
        } catch { /* ignore */ }
      }
    }
    return null;
  }, avoid);
  if (!pt) return false;
  await page.touchscreen.tap(pt[0], pt[1]);
  await page.waitForTimeout(450);
  return true;
}

/** Amène un secteur au centre de la vue, puis l'atteint au doigt. */
async function reachRegion(page, id) {
  await page.evaluate((r) => window.TERRA.scene.focusRegion(r), id);
  await page.waitForTimeout(1600);
  for (let i = 0; i < 3; i++) {
    if (await tapPlanet(page)) {
      const sel = await page.evaluate(() => window.TERRA.game.selectedRegion);
      if (sel === id) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function walkthrough(page, prof, shot) {
  const steps = [];
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail: detail || '' });
    } catch (e) {
      steps.push({ name, ok: false, detail: e.message });
    }
  };

  await step('démarrer une partie', async () => {
    const btns = page.locator('.tn-menu button');
    const n = await btns.count();
    for (let i = 0; i < n; i++) {
      const t = (await btns.nth(i).textContent() || '').toLowerCase();
      if (/nouvelle partie/.test(t)) {
        try { await btns.nth(i).scrollIntoViewIfNeeded({ timeout: 2000 }); } catch { /* ignore */ }
        const b = await btns.nth(i).boundingBox();
        const vp = page.viewportSize();
        if (!b || b.y + b.height / 2 > vp.height || b.y < 0) {
          throw new Error(`« Nouvelle partie » hors de l'écran (y = ${b ? Math.round(b.y) : '?'} pour ${vp.height})`);
        }
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(2200);
        const started = await page.evaluate(() => !!window.TERRA.game.state
          && document.querySelector('.tn-menu').hidden);
        if (!started) throw new Error('le menu ne s’est pas fermé');
        return 'au doigt, depuis l’écran d’accueil';
      }
    }
    throw new Error('bouton « Nouvelle partie » introuvable');
  });

  await shot('03-partie');

  await step('sélectionner un secteur au doigt', async () => {
    // La partie démarre cadrée sur le site d'atterrissage, déjà sélectionné :
    // on referme sa fiche au doigt avant de viser un autre secteur.
    await tap(page, '.tn-region button[aria-label="Fermer la fiche du secteur"]', { optional: true });
    const before = await page.evaluate(() => window.TERRA.game.selectedRegion);
    for (let i = 0; i < 4; i++) {
      if (!(await tapPlanet(page, before))) continue;
      const id = await page.evaluate(() => window.TERRA.game.selectedRegion);
      if (id != null && id !== before) return 'secteur ' + id;
    }
    throw new Error('aucun secteur sélectionné par appui sur le globe');
  });

  await step('lire la fiche du secteur (état réduit)', async () => {
    const info = await page.evaluate(() => {
      const p = document.querySelector('.tn-region');
      if (!p || p.hidden) return null;
      const sum = p.querySelector('.tn-region-summary');
      return { peek: p.classList.contains('is-peek'), text: (sum?.textContent || '').trim().slice(0, 90) };
    });
    if (!info) throw new Error('la fiche de secteur ne s’ouvre pas');
    if (!info.text) throw new Error('la fiche est vide');
    return (info.peek ? 'réduite : ' : 'dépliée : ') + info.text.replace(/\s+/g, ' ');
  });

  await step('déplier puis replier la fiche', async () => {
    const state = () => page.evaluate(() => {
      const p = document.querySelector('.tn-region');
      return p && !p.hidden ? !p.classList.contains('is-peek') : null;
    });
    const grab = '.tn-region .tn-sheet-grab';
    const before = await state();
    if (before === null) throw new Error('la fiche n’est pas ouverte');
    const land = await page.evaluate(() => document.documentElement.classList.contains('tn-phone-land'));
    if (land) return 'sans objet en paysage : la fiche latérale affiche tout';
    const hit = await tap(page, grab, { optional: true })
      || await tap(page, '.tn-region .tn-collapse', { optional: true });
    if (!hit) throw new Error('aucune poignée ni bouton de repli');
    const mid = await state();
    if (mid === before) throw new Error('l’appui sur la poignée ne change rien');
    // On termine repliée : la planète doit rester visible et atteignable.
    if (mid === true) {
      await tap(page, grab, { optional: true }) || await tap(page, '.tn-region .tn-collapse', { optional: true });
    }
    return before ? 'repliée puis dépliée' : 'dépliée puis repliée';
  });

  await step('lancer un scan orbital', async () => {
    const target = await page.evaluate(() => {
      const g = window.TERRA.game;
      const id = g.selectedRegion;
      if (id != null && !g.regions.discovered[id]) return id;
      for (let i = 0; i < g.regions.count; i++) if (!g.regions.discovered[i]) return i;
      return -1;
    });
    if (target < 0) throw new Error('aucun secteur inconnu');
    const sel = await page.evaluate(() => window.TERRA.game.selectedRegion);
    if (sel !== target && !(await reachRegion(page, target))) {
      throw new Error('impossible d’atteindre un secteur inconnu au doigt');
    }
    const before = await page.evaluate(() => (window.TERRA.game.state.explore.scanning?.length ?? 0)
      + (window.TERRA.game.state.explore.queue?.length ?? 0));
    const btns = page.locator('.tn-region button');
    const n = await btns.count();
    for (let i = 0; i < n; i++) {
      const t = (await btns.nth(i).textContent() || '');
      if (!/scan orbital/i.test(t)) continue;
      const b = await btns.nth(i).boundingBox();
      if (!b) continue;
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => (window.TERRA.game.state.explore.scanning?.length ?? 0)
        + (window.TERRA.game.state.explore.queue?.length ?? 0));
      if (after <= before) throw new Error('le bouton n’a lancé aucun scan');
      return `${after} scan(s) en cours ou en file`;
    }
    throw new Error('bouton de scan introuvable dans la fiche');
  });

  await shot('04-scan');

  await step('ouvrir le menu de construction', async () => {
    await tap(page, '.tn-tab[data-tab="build"]');
    const open = await page.evaluate(() => window.TERRA.ui.activePanel === 'build'
      && !document.querySelector('.tn-dock').hidden);
    if (!open) throw new Error('la feuille « Construire » ne s’ouvre pas');
    return 'feuille ouverte';
  });

  await shot('05-construire');

  await step('construire au doigt', async () => {
    // Se placer sur un secteur cartographié constructible avant de choisir.
    const pick = await page.evaluate(() => {
      const g = window.TERRA.game;
      for (const type of ['solar', 'science_station', 'depot', 'mine']) {
        for (let i = 0; i < g.regions.count; i++) {
          if (g.regions.discovered[i] && g.canBuild(type, i).ok) return { type, region: i };
        }
      }
      return null;
    });
    if (!pick) throw new Error('aucun secteur constructible');
    const { type, region: target } = pick;
    const before = await page.evaluate(() => window.TERRA.game.state.buildings.length);

    // 1. choisir la carte dans la feuille (au doigt)
    const card = page.locator(`.tn-card[data-type="${type}"]`);
    if (!(await card.count())) throw new Error(`carte « ${type} » absente`);
    // La liste défile : on amène la carte dans la feuille avant d'appuyer,
    // puis on VÉRIFIE que le point visé touche bien la carte.
    await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(250);
    const b = await card.boundingBox();
    if (!b) throw new Error('carte introuvable à l’écran');
    const cx = b.x + b.width / 2;
    const pt = await page.evaluate(([x, ys, t]) => {
      for (const y of ys) {
        const e = document.elementFromPoint(x, y);
        if (e && e.closest(`.tn-card[data-type="${t}"]`) && !e.closest('.tn-card-info')) return y;
      }
      return null;
    }, [cx, [b.y + 24, b.y + b.height / 2, b.y + 8, b.y + b.height - 8], type]);
    if (pt === null) {
      throw new Error(`la carte n'est pas atteignable au doigt (y ≈ ${Math.round(b.y)} pour ${page.viewportSize().height})`);
    }
    await page.touchscreen.tap(cx, pt);
    await page.waitForTimeout(400);
    const placing = await page.evaluate(() => window.TERRA.ui.placingType);
    if (placing !== type) throw new Error('le mode placement ne démarre pas');

    // 2. amener la cible sous le doigt et appuyer VRAIMENT dessus : viser le
    //    globe au hasard peut atteindre un secteur voisin non cartographié,
    //    et le placement est alors refusé — ce n'est pas ce qu'on mesure ici.
    if (!(await reachRegion(page, target))) {
      throw new Error('impossible d’atteindre le secteur visé au doigt');
    }
    const after = await page.evaluate(() => window.TERRA.game.state.buildings.length);
    if (after <= before) throw new Error('aucun bâtiment posé après appui sur le globe');
    return `${type} : ${after - before} installation posée par appui sur la planète`;
  });

  await shot('06-construit');

  await step('ouvrir la recherche', async () => {
    await tap(page, '.tn-tab[data-tab="research"]');
    const ok = await page.evaluate(() => window.TERRA.ui.activePanel === 'research'
      && document.querySelectorAll('.tn-tech').length > 0);
    if (!ok) throw new Error('l’arbre de recherche ne s’affiche pas');
    return await page.evaluate(() => document.querySelectorAll('.tn-tech').length + ' technologies listées');
  });

  await step('changer de couche', async () => {
    await tap(page, '.tn-tab[data-tab="layers"]');
    const before = await page.evaluate(() => window.TERRA.ui.panels.layers.current);
    const layers = page.locator('.tn-layer');
    const n = await layers.count();
    for (let i = 0; i < n; i++) {
      const id = await layers.nth(i).getAttribute('data-layer');
      if (id === before) continue;
      await layers.nth(i).evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      const box = await layers.nth(i).boundingBox();
      const vp = page.viewportSize();
      if (!box || box.y + box.height / 2 > vp.height || box.y < 0) continue;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => window.TERRA.ui.panels.layers.current);
      if (after !== before) return `${before} → ${after}`;
    }
    throw new Error('aucune couche sélectionnable au doigt');
  });

  await shot('07-couches');

  await step('fermer la feuille par appui à côté', async () => {
    let open = await page.evaluate(() => !!window.TERRA.ui.activePanel);
    if (!open) { await tap(page, '.tn-tab[data-tab="layers"]'); open = await page.evaluate(() => !!window.TERRA.ui.activePanel); }
    if (!open) throw new Error('aucune feuille ouverte');
    await page.touchscreen.tap(prof.width / 2, Math.round(prof.height * 0.28));
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => !window.TERRA.ui.activePanel);
    if (!closed) throw new Error('la feuille reste ouverte');
    return 'voile réactif';
  });

  await step('changer la vitesse du temps', async () => {
    const speeds = page.locator('.tn-speed');
    const n = await speeds.count();
    if (!n) throw new Error('contrôles du temps absents');
    let done = null;
    for (let i = 0; i < n; i++) {
      const t = (await speeds.nth(i).textContent() || '').trim();
      if (t !== '×4') continue;
      const b = await speeds.nth(i).boundingBox();
      if (!b) throw new Error('bouton ×4 hors écran');
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(300);
      done = await page.evaluate(() => window.TERRA.game.state.time.speed);
    }
    if (done !== 4) throw new Error('la vitesse n’a pas changé (' + done + ')');
    return 'vitesse ×4';
  });

  await step('lire la décomposition de la température', async () => {
    const cell = page.locator('.tn-ind-cell').first();
    const b = await cell.boundingBox();
    if (!b) throw new Error('indicateur de température hors écran');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const t = document.querySelector('.tn-tooltip');
      if (!t || t.hidden) return null;
      const full = (t.textContent || '').replace(/\s+/g, ' ');
      return {
        tap: t.classList.contains('is-tap'),
        rows: t.querySelectorAll('.tn-tip-row').length,
        total: /Équilibre visé|Total/.test(full),
        units: /°C|kPa|%/.test(full),
        text: full.slice(0, 120),
      };
    });
    if (!info) throw new Error('aucun panneau ne s’ouvre à l’appui');
    if (!info.tap) throw new Error('le panneau n’est pas en présentation tactile');
    if (info.rows < 4) throw new Error('décomposition quasi vide (' + info.rows + ' lignes)');
    if (!info.total) throw new Error('pas de total dans la décomposition');
    if (!info.units) throw new Error('aucune unité dans la décomposition');
    return `${info.rows} lignes · ${info.text.slice(0, 60)}…`;
  });

  await shot('08-decomposition');

  await step('refermer le panneau d’information', async () => {
    await tap(page, '.tn-tip-close');
    const closed = await page.evaluate(() => document.querySelector('.tn-tooltip').hidden);
    if (!closed) throw new Error('le panneau reste ouvert');
    return 'croix de fermeture';
  });

  await step('ouvrir le menu (onglet ≡)', async () => {
    await tap(page, '.tn-tab[data-tab="log"]');
    const ok = await page.evaluate(() => window.TERRA.ui.activePanel === 'log');
    if (!ok) throw new Error('l’onglet Menu n’ouvre rien');
    await tap(page, '.tn-tab[data-tab="log"]');   // referme
    return 'journal et sauvegardes accessibles';
  });

  // Laissée ouverte : la mesure finale doit AUSSI porter sur le contenu d'une
  // feuille, pas seulement sur l'écran nu.
  await step('lire le bilan planétaire', async () => {
    await tap(page, '.tn-tab[data-tab="planet"]');
    const info = await page.evaluate(() => ({
      active: window.TERRA.ui.activePanel,
      rows: document.querySelectorAll('.tn-row--victory').length,
      explore: (document.querySelector('.tn-explore-line')?.textContent || '').trim(),
    }));
    if (info.active !== 'planet') throw new Error('l’onglet Planète n’ouvre rien');
    if (info.rows < 3) throw new Error('les conditions de victoire ne s’affichent pas');
    return `${info.rows} conditions · ${info.explore}`;
  });

  return steps;
}

/* ===================================================================== */

async function auditProfile(browser, prof) {
  const ctx = await browser.newContext({
    viewport: { width: prof.width, height: prof.height },
    deviceScaleFactor: prof.dsf,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/audio\/|favicon/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  mkdirSync(OUT, { recursive: true });
  const shot = (name) => page.screenshot({ path: `${OUT}/${prof.name}-${name}.png` });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('01-accueil');

  // L'écran d'accueil se mesure aussi : c'est le premier écran du joueur.
  const home = await page.evaluate(AUDIT_FN, MIN_TAP);

  const steps = await walkthrough(page, prof, shot);

  await page.waitForTimeout(400);
  const audit = await page.evaluate(AUDIT_FN, MIN_TAP);
  audit.home = home;
  audit.steps = steps;
  audit.profile = prof.name;
  audit.errors = errors;
  audit.phone = await page.evaluate(() => ({
    phone: document.documentElement.classList.contains('tn-phone'),
    touch: document.documentElement.classList.contains('tn-touch'),
  }));
  await shot('09-final');
  report.profiles.push(audit);

  await ctx.close();
  return audit;
}

const run = async () => {
  process.stdout.write('Build … ');
  await build(); console.log('ok');
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  console.log('\nCONTRÔLE TÉLÉPHONE — TERRA NOVA\n');
  let failures = 0;
  for (const prof of PROFILES) {
    if (only && prof.name !== only) continue;
    const a = await auditProfile(browser, prof);
    const bad = a.steps.filter(s => !s.ok).length;
    failures += bad + a.overflow.length + a.offscreen.length + a.tooSmall.length
      + a.errors.length + a.home.tooSmall.length + a.home.overflow.length;

    console.log(`  ${prof.name}  (${a.vw}×${a.vh})   mode mobile : ${a.phone.phone ? 'oui' : 'NON'}`);
    console.log(`    canvas ................. ${a.canvas ? a.canvas.w + '×' + a.canvas.h : 'ABSENT'}`);
    console.log(`    débordement horizontal . ${a.horizontalOverflow ? 'OUI (' + a.docScrollWidth + ' px pour ' + a.vw + ')' : 'non'}`);
    console.log(`    éléments hors écran .... ${a.overflow.length + a.offscreen.length}`
      + `   (accueil : ${a.home.overflow.length + a.home.offscreen.length})`);
    for (const o of [...a.overflow, ...a.offscreen].slice(0, 8)) {
      console.log(`        ${o.el}  [x ${o.left}→${o.right} · y ${o.top}→${o.bottom}]`);
    }
    console.log(`    dans un conteneur défilant (atteignable) : ${a.scrollable}`);
    console.log(`    cibles < ${MIN_TAP} px ......... ${a.tooSmall.length}   (accueil : ${a.home.tooSmall.length})`);
    for (const o of [...a.tooSmall, ...a.home.tooSmall].slice(0, 8)) {
      console.log(`        ${o.el}  ${o.w}×${o.h}  « ${o.texte} »`);
    }
    console.log(`    infos réservées au survol  ${a.hoverOnly.length}`);
    for (const o of a.hoverOnly.slice(0, 5)) console.log(`        ${o.el} — « ${o.tip} »`);
    console.log(`    erreurs console ........ ${a.errors.length}`);
    a.errors.slice(0, 4).forEach(e => console.log(`        ✘ ${e.slice(0, 160)}`));
    console.log(`    parcours au doigt ...... ${a.steps.filter(s => s.ok).length}/${a.steps.length}`);
    for (const s of a.steps) {
      console.log(`        ${s.ok ? '✔' : '✘'} ${s.name}${s.detail ? ' — ' + s.detail : ''}`);
    }
    console.log();
  }

  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  console.log(failures === 0
    ? '✔ Aucun défaut : rien hors écran, aucune cible sous 44 px, parcours complet au doigt.'
    : `${failures} défaut(s) à corriger.`);
  console.log(`Captures et rapport : ${OUT}`);
  if (failures) process.exitCode = 1;
};

run().catch(e => { console.error('Échec :', e); process.exitCode = 1; });

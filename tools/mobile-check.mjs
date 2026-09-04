/**
 * Contrôle de jouabilité sur TÉLÉPHONE.
 *
 * Ouvre le jeu dans un vrai contexte tactile (pas seulement une fenêtre
 * étroite : `hasTouch`, `isMobile`, densité de pixels réaliste), tente de
 * jouer AU DOIGT uniquement, et mesure ce qui déborde, ce qui est trop petit
 * et ce qui est inatteignable.
 *
 *   node tools/mobile-check.mjs
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

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${prof.name}-01-accueil.png` });

  // Démarrer une partie au doigt : on cherche le bouton du menu d'accueil.
  const started = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(x => /nouvelle partie|commencer|lancer/i.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!started) await page.evaluate(() => window.TERRA.game.newGame({ seed: 4242 }));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${prof.name}-02-jeu.png` });

  const audit = await page.evaluate((MIN_TAP) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = { vw, vh, overflow: [], tooSmall: [], offscreen: [], hoverOnly: 0, canvas: null };

    const c = document.querySelector('canvas');
    if (c) { const r = c.getBoundingClientRect(); out.canvas = { w: Math.round(r.width), h: Math.round(r.height) }; }

    // Débordement horizontal réel du document.
    out.docScrollWidth = document.documentElement.scrollWidth;
    out.horizontalOverflow = document.documentElement.scrollWidth > vw + 1;

    for (const el of document.querySelectorAll('#ui *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

      const label = (el.id ? '#' + el.id : '') + '.' + (el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.');

      // Élément qui sort de l'écran alors qu'il est visible.
      if (r.right > vw + 1 || r.left < -1) out.overflow.push({ el: label, left: Math.round(r.left), right: Math.round(r.right) });
      if (r.bottom > vh + 1 && cs.position === 'fixed') out.offscreen.push({ el: label, bottom: Math.round(r.bottom) });

      // Cibles tactiles trop petites.
      const clickable = el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT'
        || el.getAttribute('role') === 'button' || cs.cursor === 'pointer';
      if (clickable && (r.width < MIN_TAP || r.height < MIN_TAP)) {
        out.tooSmall.push({ el: label, w: Math.round(r.width), h: Math.round(r.height),
                            texte: (el.textContent || '').trim().slice(0, 24) });
      }
    }
    // Information disponible uniquement au survol.
    out.hoverOnly = document.querySelectorAll('[data-tip], [title]').length;
    return out;
  }, MIN_TAP);

  audit.profile = prof.name;
  audit.errors = errors;
  report.profiles.push(audit);

  // Peut-on sélectionner un secteur au doigt, au centre de l'écran ?
  const tap = await page.evaluate(() => {
    const id = window.TERRA.scene.pick(window.innerWidth / 2, window.innerHeight / 2);
    return id;
  });
  audit.tapSelectsRegion = tap != null;
  if (tap != null) {
    await page.touchscreen.tap(prof.width / 2, prof.height / 2);
    await page.waitForTimeout(600);
    audit.regionSelected = await page.evaluate(() => window.TERRA.game.selectedRegion);
    await page.screenshot({ path: `${OUT}/${prof.name}-03-secteur.png` });
  }

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
  for (const prof of PROFILES) {
    const a = await auditProfile(browser, prof);
    console.log(`  ${prof.name}  (${a.vw}×${a.vh})`);
    console.log(`    canvas ................. ${a.canvas ? a.canvas.w + '×' + a.canvas.h : 'ABSENT'}`);
    console.log(`    débordement horizontal . ${a.horizontalOverflow ? 'OUI (' + a.docScrollWidth + ' px pour ' + a.vw + ')' : 'non'}`);
    console.log(`    éléments hors écran .... ${a.overflow.length}`);
    if (a.overflow.length) a.overflow.slice(0, 6).forEach(o => console.log(`        ${o.el}  [${o.left} → ${o.right}]`));
    console.log(`    cibles < ${MIN_TAP} px ......... ${a.tooSmall.length}`);
    if (a.tooSmall.length) a.tooSmall.slice(0, 8).forEach(o => console.log(`        ${o.el}  ${o.w}×${o.h}  « ${o.texte} »`));
    console.log(`    infobulles au survol ... ${a.hoverOnly}`);
    console.log(`    secteur sélectionnable . ${a.tapSelectsRegion ? 'oui' : 'NON'}`);
    console.log(`    erreurs console ........ ${a.errors.length}`);
    a.errors.slice(0, 4).forEach(e => console.log(`        ✘ ${e.slice(0, 160)}`));
    console.log();
  }

  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  console.log(`Captures et rapport : ${OUT}`);
};

run().catch(e => { console.error('Échec :', e); process.exitCode = 1; });

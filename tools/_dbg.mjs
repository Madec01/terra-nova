/** Sonde temporaire : pourquoi l'onglet « Construire » ne s'ouvre-t-il pas ? */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const PORT = 5990 + Math.floor(Math.random() * 8);
const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise(r => { let o = ''; p.stdout.on('data', d => { o += d; if (/Local:.*http/.test(o)) r(); }); });
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium'].find(existsSync);
const b = await chromium.launch({ executablePath: exe, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error' && !/audio\//.test(m.text())) console.log('ERR', m.text()); });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
await page.evaluate(() => window.TERRA.game.newGame({ seed: 4242 }));
await page.waitForTimeout(2000);

const box = await page.locator('.tn-tab[data-tab="build"]').boundingBox();
console.log('tab box', box);
const top = await page.evaluate(([x, y]) => {
  const e = document.elementFromPoint(x, y);
  return e ? (e.tagName + '.' + e.className + ' | parent ' + (e.parentElement?.className || '')) : 'rien';
}, [box.x + box.width / 2, box.y + box.height / 2]);
console.log('élément au point du doigt :', top);

await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(600);
console.log('après tap :', await page.evaluate(() => ({
  active: window.TERRA.ui.activePanel,
  dockHidden: document.querySelector('.tn-dock').hidden,
  dockBox: (() => { const r = document.querySelector('.tn-dock').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
  cards: document.querySelectorAll('.tn-card').length,
  cardBox: (() => { const c = document.querySelector('.tn-card'); if (!c) return null; const r = c.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
})));
await page.screenshot({ path: '/tmp/tn-mobile/_dbg-build.png' });

// second essai : onglet recherche
await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
console.log('après 2e tap (doit refermer) :', await page.evaluate(() => window.TERRA.ui.activePanel));
await b.close(); try { process.kill(-p.pid, 'SIGTERM'); } catch {}
process.exit(0);

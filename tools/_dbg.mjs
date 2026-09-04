/** Sonde temporaire : mise en page sur ORDINATEUR (pointeur fin). */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
const PORT = 5990 + Math.floor(Math.random() * 8);
const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise(r => { let o = ''; p.stdout.on('data', d => { o += d; if (/Local:.*http/.test(o)) r(); }); });
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium'].find(existsSync);
const b = await chromium.launch({ executablePath: exe, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
mkdirSync('/tmp/tn-desk', { recursive: true });
for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], [1024, 768]]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/audio\//.test(m.text())) errs.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await page.evaluate(() => window.TERRA.game.newGame({ seed: 4242 }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.TERRA.ui.openPanel('build'); });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const bar = document.querySelector('.tn-topbar');
    const cut = [];
    for (const el of document.querySelectorAll('#ui *')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (b.right > window.innerWidth + 1 || b.left < -1) {
        cut.push('.' + (el.className || '').toString().split(' ')[0] + ' [' + Math.round(b.left) + '→' + Math.round(b.right) + ']');
      }
    }
    const box = (s) => { const e = document.querySelector(s); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const A = box('.tn-notifs'), B = box('.tn-region');
    let overlap = null;
    if (A && B) {
      const ow = Math.min(A.r, B.r) - Math.max(A.l, B.l), oh = Math.min(A.b, B.b) - Math.max(A.t, B.t);
      if (ow > 0 && oh > 0) overlap = Math.round(ow) + '×' + Math.round(oh);
    }
    return {
      topbar: bar.scrollWidth + '/' + bar.clientWidth,
      res: (() => { const e = document.querySelector('.tn-res'); return e.scrollWidth + '/' + e.clientWidth; })(),
      ind: (() => { const e = document.querySelector('.tn-ind'); return e.scrollWidth + '/' + e.clientWidth; })(),
      barH: Math.round(bar.getBoundingClientRect().height),
      cut, overlap,
      touch: document.documentElement.className,
    };
  });
  console.log(`${w}×${h}`, JSON.stringify(r), errs.length ? 'ERREURS: ' + errs.slice(0, 3).join(' | ') : '');
  await page.screenshot({ path: `/tmp/tn-desk/${w}x${h}.png` });
  await page.close();
}
await b.close(); try { process.kill(-p.pid, 'SIGTERM'); } catch {}
process.exit(0);

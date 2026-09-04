/**
 * Contrôle de DÉMARRAGE, rapide (~40 s).
 *
 * Raison d'être : `npx esbuild` ne valide que la SYNTAXE. Un fichier
 * syntaxiquement parfait qui appelle une fonction non définie casse le jeu au
 * chargement sans qu'aucun contrôle statique ne s'en aperçoive — c'est
 * exactement ce qui est arrivé, et le jeu est resté mort plusieurs heures.
 *
 * À lancer avant de committer un état intermédiaire :
 *   node tools/boot-check.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const PORT = 5900 + Math.floor(Math.random() * 90);

function findChromium() {
  for (const c of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
                   '/usr/bin/chromium', '/usr/bin/google-chrome']) if (c && existsSync(c)) return c;
  return undefined;
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', c => c === 0 ? res(out) : rej(new Error(out)));
  });
}

let server = null;
const stop = () => { if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

try {
  process.stdout.write('build … ');
  await run('npx', ['vite', 'build', '--logLevel', 'error']);
  console.log('ok');

  server = await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const to = setTimeout(() => rej(new Error(out)), 25000);
    p.stdout.on('data', d => { out += d; if (/Local:.*http/.test(out)) { clearTimeout(to); res(p); } });
    p.stderr.on('data', d => out += d);
  });

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/audio\/|favicon/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)));

  process.stdout.write('chargement … ');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 25000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  console.log('ok');

  process.stdout.write('nouvelle partie … ');
  const info = await page.evaluate(() => {
    window.TERRA.game.newGame({ seed: 20260904 });
    return { regions: window.TERRA.game.regions.count };
  });
  await page.waitForTimeout(1200);
  const stats = await page.evaluate(() => ({ ...window.TERRA.scene.stats }));
  console.log(`ok (${info.regions} régions, ${stats.triangles} triangles)`);

  process.stdout.write('interface montée … ');
  const ui = await page.evaluate(() => {
    const root = document.getElementById('ui');
    return { children: root ? root.children.length : 0,
             boutons: document.querySelectorAll('#ui button').length };
  });
  if (!ui.children || !ui.boutons) throw new Error(`interface vide (${ui.children} nœuds, ${ui.boutons} boutons)`);
  console.log(`ok (${ui.boutons} boutons)`);

  await browser.close();

  if (errors.length) {
    console.log(`\n✘ ${errors.length} erreur(s) console :`);
    errors.slice(0, 8).forEach(e => console.log('   ' + e.slice(0, 400)));
    process.exitCode = 1;
  } else {
    console.log('\n✔ Le jeu démarre et s’affiche, sans erreur console.');
  }
} catch (e) {
  console.error('\n✘ ÉCHEC DU DÉMARRAGE :\n' + String(e.message || e).slice(0, 1500));
  process.exitCode = 1;
}
stop();

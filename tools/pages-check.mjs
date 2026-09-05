/**
 * Vérifie que le jeu fonctionne dans les DEUX modes de publication possibles,
 * servi depuis un sous-répertoire comme le fait GitHub Pages :
 *
 *   1. SOURCE BRUTE — le dépôt tel quel, sans build. C'est ce que sert Pages
 *      par défaut. Cela ne marche que grâce à la table d'imports d'index.html
 *      et à `vendor/three.module.js`.
 *   2. BUILD — le contenu de `dist/`, publié par le workflow GitHub Actions.
 *
 * Le premier mode a longtemps été cassé sans le moindre message : le module
 * principal ne se résolvait pas et la page restait indéfiniment sur son écran
 * d'amorçage. D'où cet outil.
 *
 *   node tools/pages-check.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const RACINE = resolve(new URL('..', import.meta.url).pathname);
const PREFIXE = '/terra-nova';        // on sert volontairement sous un sous-chemin
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.png': 'image/png',
};

function servir(racine, port) {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith(PREFIXE)) { res.writeHead(404).end(); return; }
    p = p.slice(PREFIXE.length) || '/';
    if (p.endsWith('/')) p += 'index.html';
    try {
      const buf = await readFile(join(racine, normalize(p)));
      res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }).end(buf);
    } catch { res.writeHead(404).end('introuvable'); }
  });
  return new Promise((r) => s.listen(port, () => r(s)));
}

function build() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: RACINE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', c => c === 0 ? res() : rej(new Error(out)));
  });
}

async function verifier(navigateur, racine, port, titre, mobile) {
  const serveur = await servir(racine, port);
  const ctx = await navigateur.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('console', m => { if (m.type() === 'error' && !/\/audio\//.test(m.text())) erreurs.push(m.text()); });
  page.on('pageerror', e => erreurs.push('PAGEERROR: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/\/audio\//.test(r.url())) erreurs.push(r.status() + ' ' + r.url()); });

  let verdict;
  try {
    await page.goto(`http://localhost:${port}${PREFIXE}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => !!window.TERRA, { timeout: 25000 });
    const r = await page.evaluate(() => {
      window.TERRA.game.newGame({ seed: 7 });
      return { regions: window.TERRA.game.regions.count,
               boutons: document.querySelectorAll('#ui button').length,
               amorce: !!document.getElementById('boot') };
    });
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({ ...window.TERRA.scene.stats }));
    if (r.amorce) throw new Error('l’écran d’amorçage n’a pas été retiré');
    verdict = `${r.regions} régions · ${s.triangles} triangles · ${r.boutons} boutons`;
  } catch (e) {
    erreurs.unshift('DÉMARRAGE : ' + e.message);
  }

  console.log(`  ${titre}`);
  console.log(`    ${verdict ? '✔ ' + verdict : '✘ le jeu ne démarre pas'}`);
  if (erreurs.length) erreurs.slice(0, 5).forEach(e => console.log('    ✘ ' + e.slice(0, 180)));
  else console.log('    ✔ aucune erreur, aucune ressource manquante');

  await ctx.close();
  serveur.close();
  return verdict && !erreurs.length;
}

const navigateur = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

console.log('\nPUBLICATION — les deux modes, servis en sous-répertoire\n');
const a = await verifier(navigateur, RACINE, 4401, 'Source brute, sur téléphone (Pages sans build)', true);
process.stdout.write('  Construction du jeu … ');
await build();
console.log('ok');
const b = await verifier(navigateur, join(RACINE, 'dist'), 4402, 'Build de production, sur ordinateur', false);

await navigateur.close();
console.log(a && b ? '\n✔ Le jeu est publiable dans les deux modes.\n'
                   : '\n✘ Au moins un mode de publication est cassé.\n');
if (!(a && b)) process.exitCode = 1;

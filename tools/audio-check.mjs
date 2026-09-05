/**
 * Mesure objective de la couche audio.
 *
 * Personne ne peut vérifier « c'est agréable » par un test. En revanche, ce qui
 * rendait l'ancien son désagréable est parfaitement mesurable : attaques
 * instantanées (le « clic » numérique), absence de queue de réverbération,
 * excès d'aigu, ondes riches en harmoniques impaires.
 *
 * L'outil rend chaque son dans un OfflineAudioContext — donc sans carte son,
 * de façon déterministe — puis analyse enveloppe et spectre.
 *
 *   node tools/audio-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 6100 + Math.floor(Math.random() * 200);

const SEUILS = {
  creteMax: 0.99,
  attaqueMinMs: 6,
  queueMinMs: 120,
  aiguMax: 0.12,          // part d'énergie au-dessus de 5 kHz
  centroideMaxSfx: 4000,
  centroideMaxMusique: 2500,
  rmsMin: 0.0005,
  variationMinMusique: 0.08,
  morceauxMin: 4,
  /* Plancher de PRÉSENCE. Un haut-parleur de téléphone ne restitue quasiment
     rien sous ~400 Hz : un morceau dont toute l'énergie est dans le grave est
     magnifique au casque et SILENCIEUX sur le mobile — or le jeu se joue
     beaucoup sur téléphone. On exige donc une part minimale d'énergie dans la
     bande réellement reproductible, et un centroïde qui ne s'effondre pas. */
  presenceMin: 0.15,          // part d'énergie entre 400 Hz et 5 kHz
  centroideMinMusique: 180,   // Hz
  centroideMinSfx: 200,
};

function chromiumPath() {
  for (const c of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
                   '/usr/bin/chromium', '/usr/bin/google-chrome']) if (c && existsSync(c)) return c;
  return undefined;
}

function build() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--logLevel', 'error'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
    p.on('exit', c => c === 0 ? res() : rej(new Error(o)));
  });
}

function serve() {
  return new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
    process.on('exit', kill);
    let o = '';
    const to = setTimeout(() => rej(new Error(o)), 25000);
    p.stdout.on('data', d => { o += d; if (/Local:.*http/.test(o)) { clearTimeout(to); res(p); } });
    p.stderr.on('data', d => o += d);
  });
}

/* --- Analyse exécutée DANS la page (accès à OfflineAudioContext) --------- */
const ANALYSE = `
(() => {
  // FFT radix-2 minimale : suffisante pour un centroïde et des bandes d'énergie.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  window.__analyser = function (buffer) {
    const sr = buffer.sampleRate;
    const n = buffer.length;
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;

    let crete = 0, somme = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(mono[i]); if (a > crete) crete = a; somme += mono[i] * mono[i]; }
    const rms = Math.sqrt(somme / n);

    // Enveloppe RMS par fenêtres de 5 ms
    const w = Math.max(1, Math.round(sr * 0.005));
    const env = [];
    for (let i = 0; i + w <= n; i += w) {
      let s = 0; for (let k = 0; k < w; k++) s += mono[i + k] * mono[i + k];
      env.push(Math.sqrt(s / w));
    }
    const envMax = Math.max(...env, 1e-12);
    const iMax = env.indexOf(envMax);
    // Attaque : temps pour franchir 90 % du maximum
    let iAtt = 0;
    for (let i = 0; i <= iMax; i++) if (env[i] >= envMax * 0.9) { iAtt = i; break; }
    const attaqueMs = iAtt * 5;
    // Queue : depuis le maximum jusqu'à retomber sous 1 % (−40 dB)
    let iFin = env.length - 1;
    for (let i = iMax; i < env.length; i++) if (env[i] < envMax * 0.01) { iFin = i; break; }
    const queueMs = (iFin - iMax) * 5;

    // Variation de l'énergie (une nappe figée a un écart-type quasi nul)
    const moy = env.reduce((a, b) => a + b, 0) / env.length;
    let v = 0; for (const e of env) v += (e - moy) * (e - moy);
    const variation = moy > 1e-9 ? Math.sqrt(v / env.length) / moy : 0;

    // Spectre moyen sur plusieurs fenêtres
    const N = 4096;
    const bandes = new Float64Array(N / 2);
    let fenetres = 0;
    for (let start = 0; start + N < n; start += Math.max(N, Math.floor((n - N) / 12))) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = mono[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
      fft(re, im);
      for (let k = 0; k < N / 2; k++) bandes[k] += Math.hypot(re[k], im[k]);
      fenetres++;
    }
    let total = 0, pondere = 0, aigu = 0, presence = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N, m = bandes[k] / Math.max(1, fenetres);
      total += m; pondere += m * f;
      if (f > 5000) aigu += m;
      if (f >= 400 && f <= 5000) presence += m;   // bande audible sur un téléphone
    }
    return {
      crete, rms, attaqueMs, queueMs, variation,
      centroide: total > 0 ? pondere / total : 0,
      partAigu: total > 0 ? aigu / total : 0,
      presence: total > 0 ? presence / total : 0,
      dureeMs: (n / sr) * 1000,
    };
  };
})();
`;

const run = async () => {
  process.stdout.write('Build … ');
  await build(); console.log('ok');
  const serveur = await serve();
  const nav = await chromium.launch({ executablePath: chromiumPath(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await nav.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.TERRA, { timeout: 20000 });
  await page.evaluate(ANALYSE);

  const dispo = await page.evaluate(() => !!window.TERRA.AudioEngine);
  if (!dispo) {
    console.log('\n✘ window.TERRA.AudioEngine absent : le moteur audio n’est pas exposé (voir docs/AUDIO.md).');
    await nav.close(); try { process.kill(-serveur.pid, 'SIGTERM'); } catch {}
    process.exitCode = 1; return;
  }

  /* ---------------- Effets ---------------- */
  const sfx = await page.evaluate(async () => {
    const cles = window.TERRA.audio?.keys?.() || Object.keys(window.TERRA.SFX_KEYS || {});
    const out = {};
    for (const k of cles) {
      const off = new OfflineAudioContext(2, 44100 * 3, 44100);
      const eng = new window.TERRA.AudioEngine({ ctx: off, destination: off.destination });
      if (eng.ready === false) { out[k] = { erreur: 'moteur non prêt' }; continue; }
      eng.playSfx(k, { when: 0.05 });
      const buf = await off.startRendering();
      out[k] = window.__analyser(buf);
    }
    return out;
  });

  /* ---------------- Musique ---------------- */
  const musique = await page.evaluate(async () => {
    const pistes = window.TERRA.MUSIC_TRACKS || [];
    const out = { pistes: pistes.map(t => t.id || t), mesures: {} };
    for (const t of out.pistes) {
      const off = new OfflineAudioContext(2, 44100 * 20, 44100);
      const eng = new window.TERRA.AudioEngine({ ctx: off, destination: off.destination });
      eng.music.start(t);
      const buf = await off.startRendering();
      out.mesures[t] = window.__analyser(buf);
    }
    return out;
  });

  await nav.close();
  try { process.kill(-serveur.pid, 'SIGTERM'); } catch {}

  /* ---------------- Verdict ---------------- */
  const S = SEUILS;
  const defauts = [];
  const ligne = (n, m, regles) => {
    const ko = regles.filter(r => !r.ok);
    console.log(`  ${ko.length ? '✘' : '✔'} ${n.padEnd(16)} crête ${m.crete.toFixed(2)} · attaque ${String(m.attaqueMs.toFixed(0)).padStart(4)} ms · queue ${String(m.queueMs.toFixed(0)).padStart(5)} ms · aigu ${(m.partAigu * 100).toFixed(1)} % · centroïde ${String(m.centroide.toFixed(0)).padStart(4)} Hz · présence tél. ${(m.presence * 100).toFixed(0)} %`);
    ko.forEach(r => { console.log(`      → ${r.msg}`); defauts.push(`${n} : ${r.msg}`); });
  };

  console.log('\nEFFETS SONORES\n');
  for (const [k, m] of Object.entries(sfx)) {
    if (m.erreur) { console.log(`  ✘ ${k} : ${m.erreur}`); defauts.push(k + ' ' + m.erreur); continue; }
    ligne(k, m, [
      { ok: m.crete < S.creteMax, msg: `écrêtage (crête ${m.crete.toFixed(2)})` },
      { ok: m.rms > S.rmsMin, msg: 'quasi silencieux' },
      { ok: m.attaqueMs >= S.attaqueMinMs, msg: `attaque trop brutale (${m.attaqueMs.toFixed(0)} ms < ${S.attaqueMinMs})` },
      { ok: m.queueMs >= S.queueMinMs, msg: `pas de queue (${m.queueMs.toFixed(0)} ms < ${S.queueMinMs})` },
      { ok: m.partAigu <= S.aiguMax, msg: `trop d'aigu (${(m.partAigu * 100).toFixed(1)} % > ${S.aiguMax * 100} %)` },
      { ok: m.centroide <= S.centroideMaxSfx, msg: `trop brillant (${m.centroide.toFixed(0)} Hz)` },
      { ok: m.centroide >= S.centroideMinSfx, msg: `trop sourd (${m.centroide.toFixed(0)} Hz) : inaudible sur un téléphone` },
      { ok: m.presence >= S.presenceMin, msg: `pas assez de présence (${(m.presence * 100).toFixed(0)} % entre 400 Hz et 5 kHz, minimum ${S.presenceMin * 100} %) : sera silencieux sur un haut-parleur de téléphone` },
    ]);
  }

  console.log(`\nMUSIQUE — ${musique.pistes.length} morceau(x)\n`);
  if (musique.pistes.length < S.morceauxMin) {
    defauts.push(`seulement ${musique.pistes.length} morceaux (minimum ${S.morceauxMin})`);
    console.log(`  ✘ seulement ${musique.pistes.length} morceaux, ${S.morceauxMin} attendus`);
  }
  const empreintes = [];
  for (const [t, m] of Object.entries(musique.mesures)) {
    ligne(t, m, [
      { ok: m.crete < S.creteMax, msg: `écrêtage (${m.crete.toFixed(2)})` },
      { ok: m.rms > S.rmsMin, msg: 'silencieux' },
      { ok: m.centroide <= S.centroideMaxMusique, msg: `trop brillant pour une nappe (${m.centroide.toFixed(0)} Hz)` },
      { ok: m.variation >= S.variationMinMusique, msg: `nappe figée (variation ${(m.variation * 100).toFixed(0)} %)` },
      { ok: m.centroide >= S.centroideMinMusique, msg: `trop sourd (${m.centroide.toFixed(0)} Hz) : quasi inaudible sur un haut-parleur de téléphone` },
      { ok: m.presence >= S.presenceMin, msg: `pas assez de présence (${(m.presence * 100).toFixed(0)} % entre 400 Hz et 5 kHz, minimum ${S.presenceMin * 100} %)` },
    ]);
    empreintes.push({ t, c: m.centroide, r: m.rms });
  }
  for (let i = 0; i < empreintes.length; i++) {
    for (let j = i + 1; j < empreintes.length; j++) {
      const a = empreintes[i], b = empreintes[j];
      const proche = Math.abs(a.c - b.c) < 60 && Math.abs(a.r - b.r) / Math.max(a.r, b.r, 1e-9) < 0.05;
      if (proche) defauts.push(`« ${a.t} » et « ${b.t} » sonnent identiquement`);
    }
  }

  if (erreurs.length) defauts.push(...erreurs.map(e => 'erreur page : ' + e));
  console.log('\n─────────────────────────────────────────');
  console.log(defauts.length ? `\n✘ ${defauts.length} défaut(s) :\n  ` + defauts.join('\n  ') + '\n'
                             : '\n✔ Aucun défaut objectif : attaques douces, queues présentes, aigu maîtrisé, morceaux distincts et vivants.\n');
  if (defauts.length) process.exitCode = 1;
};

run().catch(e => { console.error('Échec :', e); process.exitCode = 1; });

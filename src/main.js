/**
 * Point d'entrée. Assemble les trois couches — simulation (Game), rendu
 * (SceneManager) et interface (UIManager) — et fait tourner la boucle.
 *
 * Règle d'architecture : c'est le SEUL fichier qui connaît les trois à la fois.
 */
import { Game } from './core/Game.js';
import { PLANET_TYPE_LIST } from './planet/PlanetGenerator.js';
import { SceneManager } from './render/SceneManager.js';
import { UIManager } from './ui/UIManager.js';
import { AudioManager } from './audio/AudioManager.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { MUSIC_TRACKS } from './data/audio.js';
import { BALANCE } from './data/balance.js';
import { makeSeedLabel } from './utils/rng.js';

const UI_HZ = 10;

function fatal(message, detail) {
  console.error('[TERRA NOVA]', message, detail || '');
  const boot = document.getElementById('boot');
  if (boot) boot.remove();
  const div = document.createElement('div');
  div.className = 'fatal';
  div.innerHTML = `<h1>Impossible de démarrer</h1><p>${message}</p>`
    + (detail ? `<pre>${String(detail).slice(0, 600)}</pre>` : '');
  document.body.appendChild(div);
}

function boot() {
  const canvas = document.getElementById('viewport');
  const uiRoot = document.getElementById('ui');

  const game = new Game();
  const audio = new AudioManager();
  game.audio = audio;
  // Le menu d'accueil propose les types de monde sans importer le générateur
  // (l'interface n'a pas le droit de dépendre de la couche planète).
  game.planetPresets = PLANET_TYPE_LIST;

  let scene;
  try {
    scene = new SceneManager(canvas, game.bus);
  } catch (err) {
    fatal('Le rendu 3D n’a pas pu être initialisé. Votre navigateur ou votre carte graphique ne semble pas supporter WebGL.', err && err.message);
    return;
  }

  const ui = new UIManager(uiRoot, game, scene);
  ui.mount();

  /* ------------------------------------------------------------------ */
  /*  Ponts entre les couches                                            */
  /* ------------------------------------------------------------------ */

  // Cadrer la caméra sur le site d'atterrissage et l'y sélectionner : sans
  // cela, deux parties sur cinq commencent face à l'hémisphère caché et le
  // joueur ne sait pas que ses sept secteurs connus sont derrière (PLAYTEST B3).
  const onWorldReset = () => {
    scene.setPlanet(game.regions, game.state);
    scene.syncBuildings(game.state);
    const site = game.regions?.landingSite;
    if (Number.isInteger(site) && site >= 0 && site < game.regions.count) {
      // Cadrage d'ouverture : montrer la planète ET situer le site dessus,
      // et non zoomer au ras du sol (voir BALANCE.render.startFitRatio).
      scene.focusRegion(site, BALANCE.render.startFitRatio);
      game.selectRegion(site);
    } else {
      scene.setSelected(null);
    }
    document.title = `TERRA NOVA · ${makeSeedLabel(game.state.seed)}`;
  };
  game.bus.on('game:new', onWorldReset);
  game.bus.on('game:loaded', onWorldReset);

  game.bus.on('building:placed', ({ building }) => {
    scene.syncBuildings(game.state);
    scene.pulse(building.region);
    audio.play('build');
  });
  game.bus.on('building:removed', () => scene.syncBuildings(game.state));
  game.bus.on('scan:started', ({ regionId, duration }) => {
    scene.scanWave(regionId, duration);
    audio.play('scan');
  });
  game.bus.on('region:discovered', ({ regionId }) => {
    scene.markRegionsDirty([regionId]);
    audio.play('discovery');
  });
  game.bus.on('region:selected', ({ regionId }) => {
    scene.setSelected(regionId);
    if (regionId != null) { scene.pulse(regionId); audio.play('region'); }
  });
  game.bus.on('research:completed', () => audio.play('research'));
  game.bus.on('event:triggered', () => audio.play('event'));
  game.bus.on('victory', () => audio.play('victory'));
  game.bus.on('notify', ({ kind }) => { if (kind === 'warn' || kind === 'danger') audio.play('error'); });

  // La musique suit l'état de la planète : à chaque phase de progression son
  // morceau. La bande-son devient ainsi une récompense de plus, au même titre
  // que la transformation visuelle du monde. `setMood` ignore les répétitions.
  game.bus.on('game:tick', ({ state }) => audio.setMood(state?.progress?.phase ?? 1));

  /* ------------------------------------------------------------------ */
  /*  Interaction avec la planète                                        */
  /* ------------------------------------------------------------------ */

  // L'interface n'écoute pas le canvas : elle réagit à `region:selected`.
  // Un clic sur la planète se contente donc de sélectionner ; c'est l'UI qui
  // décide ensuite s'il s'agit d'une consultation ou d'un placement.
  scene.onRegionClick = (regionId) => {
    audio.unlock();
    game.selectRegion(regionId);
  };
  scene.onRegionHover = (regionId) => scene.setHovered(regionId);

  /* ------------------------------------------------------------------ */
  /*  Boucle principale                                                  */
  /* ------------------------------------------------------------------ */

  let last = performance.now();
  let uiAccumulator = 0;
  let running = true;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dtReal = Math.min((now - last) / 1000, 0.25);
    last = now;

    if (game.state) {
      // 1. Simulation à pas fixe (peut exécuter 0..n ticks).
      game.update(dtReal);

      // 2. Propagation des régions modifiées vers le rendu.
      const dirty = game.consumeDirty();
      if (dirty === null) scene.markRegionsDirty(null);
      else if (dirty.length) scene.markRegionsDirty(dirty);

      // 3. Rendu.
      scene.update(dtReal, game.state);
      game.bus.emit('game:frame', { state: game.state, dtReal });

      // 4. Interface, à fréquence réduite.
      uiAccumulator += dtReal;
      if (uiAccumulator >= 1 / UI_HZ) {
        uiAccumulator = 0;
        ui.update(game.state);
      }
    } else {
      scene.update(dtReal, null);
    }
  }

  window.addEventListener('resize', () => scene.resize());
  // Le changement d'orientation redimensionne la fenêtre APRÈS l'événement :
  // on repasse un peu plus tard, sinon le canvas garde l'ancien rapport.
  window.addEventListener('orientationchange', () => setTimeout(() => scene.resize(), 250));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => scene.resize());
  }

  // iOS : pincer ou taper deux fois zoomerait la PAGE au lieu de la planète.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  window.addEventListener('beforeunload', () => { running = false; });
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  // Débloque l'audio au premier geste, quel qu'il soit.
  const unlockOnce = () => { audio.unlock(); audio.startAmbient(); };
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.remove();

  requestAnimationFrame(frame);

  // Exposé pour le débogage manuel dans la console — et pour `tools/audio-check.mjs`,
  // qui instancie le moteur dans un OfflineAudioContext pour le mesurer.
  window.TERRA = { game, scene, ui, audio, BALANCE, AudioEngine, MUSIC_TRACKS };
}

window.addEventListener('error', (e) => {
  if (!document.querySelector('.fatal') && !document.getElementById('ui')?.children.length) {
    fatal('Une erreur est survenue au démarrage.', e.message);
  }
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/**
 * TERRA NOVA — contenu du tutoriel contextuel.
 *
 * Ce fichier contient TOUT ce que le joueur lit pendant sa première partie :
 * l'ordre des étapes, leurs titres, leurs textes, la consigne, l'élément à
 * mettre en évidence et la condition qui valide l'étape. `src/ui/Tutorial.js`
 * ne fait que l'afficher — il ne connaît aucune chaîne de caractères.
 *
 * ---------------------------------------------------------------------------
 *  PRINCIPES
 * ---------------------------------------------------------------------------
 *  1. Une étape = une action + la RAISON de cette action. Le joueur doit
 *     comprendre la boucle du jeu, pas seulement cliquer où on lui dit.
 *  2. Chaque étape se valide SEULE, en observant l'état ou le bus. Le joueur
 *     n'est jamais bloqué : s'il fait autre chose, le tutoriel attend ; il
 *     peut passer une étape ou tout quitter à n'importe quel moment.
 *  3. Les conditions comparent l'état COURANT à un instantané pris à l'entrée
 *     de l'étape (`enter`) : l'étape demande une action nouvelle, pas un état
 *     déjà atteint.
 *
 * ---------------------------------------------------------------------------
 *  FORME D'UNE ÉTAPE
 * ---------------------------------------------------------------------------
 *  {
 *    id      : identifiant stable (utilisé par l'instrument de vérification)
 *    title   : titre court
 *    body    : [paragraphes] — le QUOI et le POURQUOI
 *    action  : la consigne, à l'impératif, une ligne
 *    target  : (ctx) => 'globe' | [sélecteurs CSS] | null
 *              Le premier sélecteur VISIBLE l'emporte : cela couvre d'un seul
 *              coup le rail d'outils (ordinateur) et la barre d'onglets
 *              (téléphone), sans que le contenu connaisse la disposition.
 *    enter   : (ctx) => instantané (objet libre), optionnel
 *    done    : (ctx, snap) => booléen
 *    final   : true sur la dernière étape (bouton « Terminer »)
 *  }
 *
 *  `ctx` = { game, state, regions, ui, flags }
 *  `flags` = { rotated, layer, panel, placing }
 */
import { BUILDINGS } from './buildings.js';

/** Clé de mémorisation : le tutoriel ne se déclenche qu'à la première partie. */
export const TUTORIAL_STORAGE_KEY = 'terranova.tutorial.v1';

/* --------------------------------------------------------------------- */
/*  Petites lectures d'état, partagées par les conditions                 */
/* --------------------------------------------------------------------- */

/** Nombre d'installations d'un type donné. */
function countType(state, type) {
  const list = state?.buildings || [];
  let n = 0;
  for (let i = 0; i < list.length; i++) if (list[i].type === type) n++;
  return n;
}

/** Nombre d'installations d'une catégorie (industrie, terraformation…). */
function countCategory(state, category) {
  const list = state?.buildings || [];
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    if (BUILDINGS[list[i].type]?.category === category) n++;
  }
  return n;
}

/** Secteurs cartographiés. */
function discovered(regions) {
  if (!regions?.discovered) return 0;
  let n = 0;
  for (let i = 0; i < regions.count; i++) if (regions.discovered[i]) n++;
  return n;
}

/** Scans en cours + en file d'attente. */
function scansPending(state) {
  const ex = state?.explore || {};
  return (ex.scanning?.length ?? 0) + (Array.isArray(ex.queue) ? ex.queue.length : 0);
}

/**
 * Cible d'une étape de construction, en trois temps : l'entrée du menu tant
 * qu'il est fermé, la carte du bâtiment une fois le menu ouvert, le globe une
 * fois le bâtiment en main — c'est là qu'il faut appuyer.
 * Le rail d'outils et la barre d'onglets sont donnés ensemble : seul le
 * visible des deux est retenu, ce qui couvre ordinateur et téléphone sans que
 * le contenu ait à connaître la disposition.
 */
function buildTarget(type) {
  return (ctx) => {
    if (ctx.flags.placing === type) return 'globe';
    if (ctx.flags.panel === 'build') return [`.tn-card[data-type="${type}"]`];
    return ['[data-tool="build"]', '[data-tab="build"]'];
  };
}

/* --------------------------------------------------------------------- */
/*  LES ÉTAPES                                                            */
/* --------------------------------------------------------------------- */

export const TUTORIAL_STEPS = [
  /* -- 1 ------------------------------------------------------------- */
  {
    id: 'globe',
    title: 'Un monde inconnu',
    body: [
      'Vous pilotez une sonde de commandement en orbite. La planète sous vos yeux est morte : trop froide, sans atmosphère respirable, sans eau libre.',
      'Les secteurs sombres ne sont pas cartographiés — vous n’en savez rien et vous ne pouvez rien y construire. Seuls sept secteurs sont relevés, autour de votre site d’atterrissage, déjà sélectionné : sa fiche est ouverte sur le côté.',
    ],
    action: 'Glissez sur la planète pour la faire tourner.',
    target: () => 'globe',
    done: (ctx) => ctx.flags.rotated,
  },

  /* -- 2 ------------------------------------------------------------- */
  {
    id: 'cible',
    title: 'Désigner une cible',
    body: [
      'Un secteur non cartographié n’a aucune donnée : ni minerai, ni glace, ni température. Toute la partie consiste à choisir où poser quoi ; sans relevés, il n’y a pas de choix.',
      'Cartographier, c’est ouvrir des emplacements.',
    ],
    action: 'Sélectionnez un secteur sombre sur le globe.',
    target: () => 'globe',
    done: (ctx) => {
      const id = ctx.game.selectedRegion;
      return id != null && !ctx.regions?.discovered?.[id];
    },
  },

  /* -- 3 ------------------------------------------------------------- */
  {
    id: 'scan',
    title: 'Lancer un scan orbital',
    body: [
      'Un scan coûte 40 d’énergie et 14 de matériaux, dure 16 jours, et révèle la cible avec sa couronne de voisins — une douzaine de secteurs d’un coup.',
      'Vous n’avez que trois sondes et 200 d’énergie au départ : quatre scans, pas plus, avant d’avoir une production. Viser une zone prometteuse vaut mieux que la case d’à côté.',
    ],
    action: 'Appuyez sur « Lancer un scan orbital » dans la fiche du secteur.',
    target: () => ['.tn-region [data-action="scan"]', '.tn-region'],
    enter: (ctx) => ({ pending: scansPending(ctx.state), seen: discovered(ctx.regions) }),
    done: (ctx, snap) => scansPending(ctx.state) > snap.pending
      || discovered(ctx.regions) > snap.seen,
  },

  /* -- 4 ------------------------------------------------------------- */
  {
    id: 'temps',
    title: 'Le temps est une ressource',
    body: [
      'Rien n’avance si le temps ne passe pas : production, climat, scans, recherche. Seize jours de scan, c’est seize secondes en ×1 et quatre en ×4.',
      'La vitesse ne change que votre patience, jamais l’équilibre du jeu. Passez en ×4 dès que vous attendez quelque chose.',
    ],
    action: 'Passez en ×4 et attendez la fin du scan.',
    target: () => ['[data-speed="4"]'],
    enter: (ctx) => ({ seen: discovered(ctx.regions) }),
    done: (ctx, snap) => discovered(ctx.regions) > snap.seen,
  },

  /* -- 5 ------------------------------------------------------------- */
  {
    id: 'solaire',
    title: 'L’énergie conditionne tout',
    body: [
      'Chaque scan, chaque mine, chaque laboratoire consomme de l’énergie. Quand la réserve s’épuise, les installations s’arrêtent les unes après les autres et la production s’effondre.',
      'Le champ solaire ne coûte que 90 de matériaux et n’exige rien du terrain — seulement de la lumière : il rend beaucoup moins près des pôles.',
    ],
    action: 'Ouvrez Construire, choisissez « Champ solaire », puis appuyez sur un secteur cartographié.',
    target: buildTarget('solar'),
    enter: (ctx) => ({ n: countType(ctx.state, 'solar') }),
    done: (ctx, snap) => countType(ctx.state, 'solar') > snap.n,
  },

  /* -- 6 ------------------------------------------------------------- */
  {
    id: 'mine',
    title: 'Lire le terrain avant de bâtir',
    body: [
      'Une mine exige 30 % de minerai dans le secteur, et son rendement suit cette richesse. Les bons gisements sont rares : c’est pour eux que l’on cartographie.',
      'Chaque carte de construction dit si elle est posable sur le secteur sélectionné, et sinon pourquoi. Un refus est une information, pas une panne.',
    ],
    action: 'Construisez une mine sur un secteur riche en minerai.',
    target: buildTarget('mine'),
    enter: (ctx) => ({ n: countType(ctx.state, 'mine') }),
    done: (ctx, snap) => countType(ctx.state, 'mine') > snap.n,
  },

  /* -- 7 ------------------------------------------------------------- */
  {
    id: 'science',
    title: 'Sans laboratoire, pas de technologie',
    body: [
      'L’orbite ne produit que 0,35 de science par jour ; une station scientifique en produit 2,4, davantage sur une anomalie ou un terrain extrême.',
      'Toute la terraformation est derrière l’arbre technologique : la station scientifique n’est pas un bonus, c’est le péage.',
    ],
    action: 'Construisez une station scientifique.',
    target: buildTarget('science_station'),
    enter: (ctx) => ({ n: countType(ctx.state, 'science_station') }),
    done: (ctx, snap) => countType(ctx.state, 'science_station') > snap.n,
  },

  /* -- 8 ------------------------------------------------------------- */
  {
    id: 'recherche',
    title: 'Engager le laboratoire',
    body: [
      'Une seule recherche à la fois. La science produite l’alimente jour après jour ; l’abandonner ne rend que la moitié des points investis.',
      'L’ordre que vous choisissez est votre plan de partie. « Gaz à effet de serre » ouvre l’usine à halocarbures, le levier de réchauffement le plus rapide du jeu.',
    ],
    action: 'Ouvrez Recherche et engagez « Gaz à effet de serre ».',
    target: (ctx) => (ctx.flags.panel === 'research'
      ? ['.tn-tech[data-tech="greenhouse_gases"]', '.tn-tree']
      : ['[data-tool="research"]', '[data-tab="research"]']),
    enter: (ctx) => ({ n: ctx.state?.tech?.unlocked?.length ?? 0 }),
    done: (ctx, snap) => !!ctx.state?.tech?.current
      || (ctx.state?.tech?.unlocked?.length ?? 0) > snap.n,
  },

  /* -- 9 ------------------------------------------------------------- */
  {
    id: 'couches',
    title: 'Regarder les données, pas l’image',
    body: [
      'Huit couches recolorent le globe : température, eau, ressources, biosphère, habitabilité… C’est là que les décisions se lisent.',
      'La vue normale laisse la moitié de la planète dans la nuit ; une couche de données reste lisible partout, de jour comme de nuit.',
    ],
    action: 'Ouvrez Couches et affichez la température.',
    target: (ctx) => (ctx.flags.panel === 'layers'
      ? ['[data-layer="temperature"]']
      : ['[data-tool="layers"]', '[data-tab="layers"]']),
    done: (ctx) => ctx.flags.layer === 'temperature',
  },

  /* -- 10 ------------------------------------------------------------ */
  {
    id: 'terraformation',
    title: 'Première action de terraformation',
    body: [
      'La station hydrique sublime la glace du sous-sol : de la vapeur d’eau, un peu de CO₂ piégé, donc de la pression — et la pression réchauffe.',
      'Là est le cœur du jeu : réchauffer fait fondre la glace, la glace fondue assombrit la surface, une surface sombre absorbe plus de lumière et réchauffe encore. Vous ne poussez pas un curseur, vous lancez une boucle.',
      'Quand « Gaz à effet de serre » aboutira, l’usine à halocarbures fera le même travail dix fois plus vite — et la même boucle s’emballera dix fois plus vite.',
    ],
    action: 'Construisez une station hydrique sur un secteur glacé.',
    target: buildTarget('ice_extractor'),
    enter: (ctx) => ({
      n: countType(ctx.state, 'ice_extractor'),
      t: countCategory(ctx.state, 'terraformation'),
    }),
    done: (ctx, snap) => countType(ctx.state, 'ice_extractor') > snap.n
      || countCategory(ctx.state, 'terraformation') > snap.t,
  },

  /* -- 11 ------------------------------------------------------------ */
  {
    id: 'bilan',
    title: 'Où se lit la mission',
    body: [
      'Le panneau Planète porte les huit conditions de victoire, leur cible, leur tendance, et la barre des 180 jours de maintien.',
      'Il ne suffit pas de traverser la bonne fourchette de température : il faut y stabiliser un monde. Une planète qui dérive encore ne valide rien.',
      'Les indicateurs de la barre du haut donnent la même chose en continu ; ouvrez-en un pour voir d’où vient sa valeur.',
    ],
    action: 'Ouvrez le panneau Planète.',
    target: () => ['[data-tool="planet"]', '[data-tab="planet"]'],
    done: (ctx) => ctx.flags.panel === 'planet',
  },

  /* -- 12 ------------------------------------------------------------ */
  {
    id: 'reversible',
    title: 'Rien n’est définitif',
    body: [
      'Toute installation se démolit depuis la fiche de son secteur : 40 % des matériaux reviennent. Une erreur de placement se corrige.',
      'Les miroirs orbitaux, plus tard, ne cumulent pas de chaleur : ils maintiennent un niveau d’ensoleillement tant qu’ils sont en service. En démonter refroidit immédiatement. C’est votre thermostat, et c’est ce qui rend une planète surchauffée récupérable.',
      'La boucle du jeu tient en une phrase : cartographier pour avoir le choix, produire pour financer, chercher pour débloquer, chauffer — puis freiner au bon moment.',
    ],
    action: 'Bonne mission.',
    target: () => null,
    final: true,
    done: () => false,
  },
];

export default TUTORIAL_STEPS;

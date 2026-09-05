/**
 * ============================================================================
 *  TERRA NOVA — Générateur de pictogrammes (atlas de sprites)
 * ============================================================================
 *  POURQUOI CE FICHIER EXISTE
 *  --------------------------
 *  Les banques d'assets libres sont inaccessibles depuis l'environnement de
 *  développement, et embarquer des images dont la licence n'est pas vérifiable
 *  serait irresponsable. Le reste du jeu est déjà entièrement procédural
 *  (planète, relief, sons) : les icônes le sont aussi. Elles appartiennent au
 *  projet, elles se régénèrent, elles se relisent.
 *
 *  CE QU'IL PRODUIT
 *  ----------------
 *   · public/sprites/atlas.png       planche unique, grille régulière, fond
 *                                    transparent ;
 *   · public/sprites/atlas.json      position de chaque case ;
 *   · public/sprites/svg/<id>.svg    la source vectorielle de chaque icône ;
 *   · src/render/SpriteAtlas.js      LA MÊME planche, encodée en data URI.
 *
 *  Pourquoi ce dernier fichier ? Parce que le jeu doit fonctionner servi en
 *  SOURCE BRUTE (dépôt tel quel, sans build) comme CONSTRUIT. Or `public/` est
 *  recopié à la RACINE par Vite : une même URL ne peut pas désigner le fichier
 *  dans les deux modes — c'est exactement le piège qui a valu à `favicon.svg`
 *  d'être remonté à la racine du dépôt. Plutôt que de dupliquer un binaire,
 *  l'atlas est embarqué dans un module ES : zéro requête, zéro 404, zéro
 *  chemin à deviner, et il fonctionne hors ligne. Les fichiers de
 *  `public/sprites/` restent la référence lisible (et servent à la
 *  vérification de distinction).
 *
 *  DIRECTION ARTISTIQUE
 *  --------------------
 *  Terminal scientifique : trait net, aplats sombres, palette de l'interface.
 *  Chaque icône combine TROIS signaux redondants, pour rester lisible à 30
 *  pixels sur une planète en mouvement :
 *    1. la FORME DE LA PLAQUE dit la catégorie (carré = industrie,
 *       hexagone = énergie, cercle = science, losange = eau,
 *       octogone = terraformation, hexagone couché = biosphère,
 *       double cercle = colonisation) ;
 *    2. la COULEUR DE LA PLAQUE confirme cette catégorie ;
 *    3. le PICTOGRAMME dit le type exact, et deux pictogrammes d'une même
 *       catégorie n'ont jamais la même charpente.
 *  C'est ce triple codage qui règle le défaut relevé à l'audit : à distance de
 *  jeu, mine / station scientifique / dépôt / ensemenceur convergeaient tous
 *  vers « une tache sombre avec un mât ».
 *
 *  USAGE
 *  -----
 *    node tools/sprite-gen.mjs          régénère tout (résultat identique)
 *    node tools/sprite-gen.mjs --sheet  + une planche de contrôle lisible
 * ============================================================================
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

import { BUILDING_LIST } from '../src/data/buildings.js';

const RACINE = resolve(new URL('..', import.meta.url).pathname);
const SORTIE = join(RACINE, 'public', 'sprites');

/* -------------------------------------------------------------------------- */
/*  Palette — strictement celle de l'interface                                */
/* -------------------------------------------------------------------------- */

const P = {
  fond: '#080b11',          // fond de plaque
  ligne: '#2b3d52',         // trait structurel
  texte: '#c9d6e4',         // trait principal des pictogrammes
  cyan: '#5fd3e8',          // accent
  vert: '#5fd39a',          // succès
  ambre: '#e0a34a',         // avertissement
  rouge: '#e05a5a',         // danger
  // Deux dérivés, obtenus par assombrissement / désaturation des précédents :
  // sept catégories ne tiennent pas dans quatre accents.
  ambreSourd: '#c9903f',    // ambre assombri  → industrie
  glace: '#7fc4dd',         // entre cyan et texte → eau
  clair: '#dfe9f4',         // texte éclairci  → colonisation
};

/* -------------------------------------------------------------------------- */
/*  Géométrie de la planche                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Côté d'une case, en pixels de l'atlas. Un marqueur mesure ~40 pixels CSS à
 * l'écran, soit ~80 pixels physiques sur un écran à double densité : 96 suffit
 * largement, et la planche reste sous les 40 ko.
 */
const CASE = 96;
/** Colonnes de la grille. */
const COLS = 6;
/**
 * Marge interne : l'icône n'occupe que le carré central. Sans elle, les
 * niveaux de mipmap mélangeraient les cases voisines et chaque marqueur
 * porterait un fantôme de son voisin.
 */
const MARGE = 10;
/** Repère de dessin des icônes : tout est décrit dans un carré 64 × 64. */
const BOITE = 64;
const ECHELLE = (CASE - 2 * MARGE) / BOITE;

/* -------------------------------------------------------------------------- */
/*  Fabriques SVG                                                             */
/* -------------------------------------------------------------------------- */

/** Trait. */
const T = (d, c = P.texte, w = 3.0, extra = '') =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}"${extra ? ' ' + extra : ''}/>`;
/** Aplat. */
const A = (d, c = P.texte) => `<path d="${d}" fill="${c}" stroke="none"/>`;
/** Cercle en trait. */
const CT = (x, y, r, c = P.texte, w = 3.0) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
/** Cercle plein. */
const CA = (x, y, r, c = P.texte) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
/** Rectangle en trait. */
const RT = (x, y, w, h, c = P.texte, sw = 3.0, rx = 1.5) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
/** Rectangle plein. */
const RA = (x, y, w, h, c = P.texte, rx = 0.8) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${c}"/>`;

/** Polygone régulier centré en (32,32). `phase` en degrés. */
function polygone(n, r, phase) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((phase + (360 / n) * i) * Math.PI) / 180;
    pts.push(`${(32 + r * Math.cos(a)).toFixed(2)},${(32 - r * Math.sin(a)).toFixed(2)}`);
  }
  return 'M' + pts.join(' L') + ' Z';
}

/* -------------------------------------------------------------------------- */
/*  Plaques — une forme et une couleur par catégorie                          */
/* -------------------------------------------------------------------------- */

const PLAQUES = {
  //                      forme                                    couleur
  industrie:      { d: null, rect: [7, 7, 50, 50, 7], c: P.ambreSourd },
  energie:        { d: polygone(6, 30, 90), c: P.ambre },          // hexagone pointe en haut
  science:        { d: null, cercle: 28, c: P.cyan },
  eau:            { d: polygone(4, 30, 90), c: P.glace },          // losange
  terraformation: { d: polygone(8, 30, 22.5), c: P.texte },        // octogone
  biosphere:      { d: polygone(6, 30, 0), c: P.vert },            // hexagone couché
  colonisation:   { d: null, cercle: 28, anneau: 22.5, c: P.clair },
};

/** Dessine la plaque d'une catégorie. */
function plaque(cat) {
  const p = PLAQUES[cat] || PLAQUES.terraformation;
  const fond = `fill="${P.fond}" fill-opacity="0.86"`;
  let out = '';
  if (p.rect) {
    const [x, y, w, h, rx] = p.rect;
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ${fond} stroke="${p.c}" stroke-width="2.8"/>`;
  } else if (p.cercle) {
    out += `<circle cx="32" cy="32" r="${p.cercle}" ${fond} stroke="${p.c}" stroke-width="2.8"/>`;
  } else {
    out += `<path d="${p.d}" ${fond} stroke="${p.c}" stroke-width="2.8"/>`;
  }
  if (p.anneau) out += CT(32, 32, p.anneau, p.c, 1.6);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Les 17 pictogrammes                                                       */
/* -------------------------------------------------------------------------- */
/**
 * Chaque entrée reçoit sa couleur d'accent et rend le contenu INTÉRIEUR de la
 * plaque. Contrainte de dessin : rester dans le carré 16 → 48, seul domaine
 * commun à toutes les formes de plaque.
 */
const GLYPHES = {
  /* --- industrie ---------------------------------------------------- */
  // Pioche : tête bombée + manche en diagonale. Rien d'autre dans le jeu
  // n'a de diagonale aussi franche.
  mine: (a) => T('M16,27 C23.5,15.5 40.5,13.5 48,23.5', a, 3.8) + T('M22,18.5 L41,47', P.texte, 3.8),

  // Colonne de distillation + cuve + torchère : deux verticales de hauteurs
  // différentes, une flamme. Lecture « usine chimique ».
  refinery: (a) =>
    T('M16,48 H50', P.texte, 2.6)
    + T('M21,48 V28 A6.5,6.5 0 0 1 34,28 V48', P.texte, 2.8)
    + T('M21,35 H34', P.texte, 1.9) + T('M21,41.5 H34', P.texte, 1.9)
    + T('M42.5,48 V26', P.texte, 2.6)
    + A('M42.5,25 C46.5,20.5 45,17 42.5,13 C40,17 38.5,20.5 42.5,25 Z', a),

  // Trois caisses empilées : une silhouette en escalier, aucun mât.
  depot: (a) =>
    RT(16, 32, 15, 15, P.texte, 2.8) + RT(33, 32, 15, 15, P.texte, 2.8)
    + RT(24.5, 16, 15, 15, P.texte, 2.8)
    + T('M16,39.5 H31', a, 1.8) + T('M33,39.5 H48', a, 1.8) + T('M24.5,23.5 H39.5', a, 1.8),

  /* --- énergie ------------------------------------------------------ */
  // Astre + panneau incliné : le disque plein est unique dans le jeu.
  solar: (a) =>
    CA(23, 19, 6.4, a)
    + T('M23,8.5 V11.5', a, 2.2) + T('M14.5,12 L16.8,14.3', a, 2.2) + T('M31.5,12 L29.2,14.3', a, 2.2)
    + T('M12.5,19 H9.5', a, 2.2)
    + RT(14, 31, 36, 13, P.texte, 2.8)
    + T('M23,31 V44', P.texte, 1.8) + T('M32,31 V44', P.texte, 1.8) + T('M41,31 V44', P.texte, 1.8)
    + T('M32,44 V48', P.texte, 2.4) + T('M25,48 H39', P.texte, 2.6),

  // Massif volcanique à double crête + panaches de chaleur.
  geothermal: (a) =>
    T('M14,48 L25,30 L32,38 L39,30 L50,48 Z', P.texte, 2.8)
    + T('M23,23 c3,-3.4 6,3.4 9,0 c3,-3.4 6,3.4 9,0', a, 2.4)
    + T('M27,15 c2.5,-3 5,3 7.5,0', a, 2.0),

  // Atome : noyau plein + deux orbitales croisées.
  fusion: (a) =>
    `<ellipse cx="32" cy="32" rx="16" ry="6.5" fill="none" stroke="${P.texte}" stroke-width="2.6" transform="rotate(32 32 32)"/>`
    + `<ellipse cx="32" cy="32" rx="16" ry="6.5" fill="none" stroke="${P.texte}" stroke-width="2.6" transform="rotate(-32 32 32)"/>`
    + CA(32, 32, 4.6, a),

  /* --- science ------------------------------------------------------ */
  // Erlenmeyer : col étroit, corps évasé, niveau de liquide.
  science_station: (a) =>
    T('M25,17 H39', P.texte, 2.8) + T('M27.5,17 V25', P.texte, 2.8) + T('M36.5,17 V25', P.texte, 2.8)
    + T('M27.5,25 L19,45 H45 L36.5,25', P.texte, 3.0)
    + T('M22.2,39 H41.8', a, 3.4),

  /* --- eau ---------------------------------------------------------- */
  // Goutte + cristal : la seule forme organique de la planche.
  ice_extractor: (a) =>
    T('M32,14 C39,27 43,32 43,37 A11,11 0 0 1 21,37 C21,32 25,27 32,14 Z', P.texte, 2.8)
    + T('M32,31 V43', a, 2.4) + T('M26.8,34 L37.2,40', a, 2.4) + T('M26.8,40 L37.2,34', a, 2.4),

  /* --- terraformation ----------------------------------------------- */
  // Cheminée + panache : le panache est en ROUGE, seule icône à l'utiliser.
  ghg_factory: (a) =>
    T('M13,48 H51', P.texte, 2.6)
    + T('M15,48 V38 L22,32 V38 L29,32 V48', P.texte, 2.8)
    + T('M32.5,48 V22 H40.5 V48', P.texte, 2.8)
    + CA(45, 17, 4.4, a) + CA(50.5, 12, 3.0, a) + CA(37.5, 13, 2.8, a),

  // Cuve trapue + grande flèche montante : « on épaissit l'atmosphère ».
  atmo_processor: (a) =>
    RT(18, 36, 28, 12, P.texte, 2.8, 3)
    + T('M32,34 V18', a, 3.4) + T('M25,25 L32,17 L39,25', a, 3.2)
    + T('M22,32 V27', P.texte, 2.0) + T('M42,32 V27', P.texte, 2.0),

  // Molécule O₂ : deux atomes, double liaison. Aucune verticale.
  o2_generator: (a) =>
    CT(21.5, 31, 9.5, a, 4.0) + CT(42.5, 31, 9.5, a, 4.0)
    + T('M29,28 H35', P.texte, 2.6) + T('M29,34 H35', P.texte, 2.6)
    + T('M24,44.5 H40', P.texte, 2.4),

  // Calotte + faisceau descendant : le seul objet qui pointe vers le bas.
  polar_melter: (a) =>
    T('M13,48 H51', P.texte, 2.6)
    + T('M16.5,48 C19,38.5 25,34.5 32,34.5 C39,34.5 45,38.5 47.5,48', P.texte, 2.8)
    + RA(18, 13.5, 28, 4.6, a, 1.6)
    + T('M23,20 V26', a, 2.6) + T('M32,20 V28.5', a, 2.6) + T('M41,20 V26', a, 2.6),

  // Voile orbitale inclinée + arc planétaire + rayons incidents.
  orbital_mirror: (a) =>
    `<ellipse cx="33" cy="25" rx="16" ry="6.4" fill="${P.fond}" stroke="${P.texte}" stroke-width="3.0" transform="rotate(-22 33 25)"/>`
    + T('M21,29.5 L45,20.5', P.texte, 1.8)
    + T('M33,31 V38', P.texte, 2.4)
    + T('M14,48 Q32,38.5 50,48', P.texte, 3.0)
    + T('M13.5,14 L20.5,18', a, 2.6) + T('M19,9 L26,13', a, 2.6),

  // Onde amortie sur sa ligne de référence : littéralement la fonction du
  // bâtiment. Impossible à confondre avec quoi que ce soit d'autre.
  climate_stabilizer: (a) =>
    T('M14,32 H50', P.ligne, 1.8)
    + T('M14,32 C17,14 21,14 24,32 C27,48 31,48 34,32 C36,22.5 39,22.5 41,32 C42.5,37 44,37 50,32', a, 3.0),

  /* --- biosphère ----------------------------------------------------- */
  // Dôme fermé + pousse à deux feuilles.
  biodome: (a) =>
    T('M12,46 H52', P.texte, 2.6)
    + T('M17,46 A15,15 0 0 1 47,46', P.texte, 3.0)
    + T('M32,31 V46', P.texte, 1.8)
    + T('M20.5,38.5 Q32,34.5 43.5,38.5', P.texte, 1.8)
    + A('M32,45 C24.5,45 22,38 22,38 C29.5,37 32,45 32,45 Z', a)
    + A('M32,41.5 C39.5,41.5 42,34.5 42,34.5 C34.5,33.5 32,41.5 32,41.5 Z', a),

  // Tour d'ensemencement : mât à traverses + arcs de diffusion + spores.
  // C'est le SEUL mât de la planche, et il est signé par ses spores.
  seeder: (a) =>
    T('M32,47 V30', P.texte, 3.2)
    + T('M25,47 L32,41 L39,47', P.texte, 2.6)
    + T('M23,26.5 Q32,18.5 41,26.5', a, 2.6)
    + T('M17,31 Q32,14.5 47,31', a, 2.6)
    + CA(32, 12.5, 3.2, a),

  /* --- colonisation --------------------------------------------------- */
  // Habitat sous dôme, fenêtres allumées, antenne.
  colony: (a) =>
    T('M18,44 H46', P.texte, 2.6)
    + T('M20,44 A12,12 0 0 1 44,44', P.texte, 2.8)
    + RA(24.5, 37, 4, 6, a) + RA(30, 37, 4, 6, a) + RA(35.5, 37, 4, 6, a)
    + T('M32,31.5 V22', P.texte, 2.2) + CA(32, 19.5, 2.6, a),
};

/** Accent de chaque type : il sépare aussi les icônes d'une même catégorie. */
const ACCENTS = {
  mine: P.ambre, refinery: P.rouge, depot: P.cyan,
  solar: P.ambre, geothermal: P.rouge, fusion: P.cyan,
  science_station: P.cyan,
  ice_extractor: P.glace,
  ghg_factory: P.rouge, atmo_processor: P.cyan, o2_generator: P.vert,
  polar_melter: P.ambre, orbital_mirror: P.ambre, climate_stabilizer: P.cyan,
  biodome: P.vert, seeder: P.vert,
  colony: P.ambre,
};

/* -------------------------------------------------------------------------- */
/*  Pictogrammes de ressources (sans plaque)                                  */
/* -------------------------------------------------------------------------- */

const RESSOURCES = {
  energy: () => A('M35,8 L17,35 H29 L25,56 L47,27 H33 Z', P.ambre),
  materials: () =>
    A('M14,46 H50 L44,32 H20 Z', P.ambreSourd) + A('M22,29 H42 L37,18 H27 Z', P.texte),
  water: () =>
    A('M32,9 C43,29 49,35 49,42 A17,17 0 0 1 15,42 C15,35 21,29 32,9 Z', P.glace),
  science: () =>
    `<ellipse cx="32" cy="32" rx="21" ry="8.5" fill="none" stroke="${P.cyan}" stroke-width="3" transform="rotate(32 32 32)"/>`
    + `<ellipse cx="32" cy="32" rx="21" ry="8.5" fill="none" stroke="${P.cyan}" stroke-width="3" transform="rotate(-32 32 32)"/>`
    + CA(32, 32, 5.5, P.cyan),
  biomass: () =>
    A('M32,55 C31,31 39,14 54,9 C57,32 47,52 32,55 Z', P.vert) + T('M32,55 C36,38 44,24 52,15', P.fond, 2.2),
};

/* -------------------------------------------------------------------------- */
/*  Assemblage                                                                */
/* -------------------------------------------------------------------------- */

/** Ordre stable de la planche : les 17 bâtiments, puis les 5 ressources. */
function inventaire() {
  const cases = [];
  for (const b of BUILDING_LIST) {
    if (!GLYPHES[b.id]) throw new Error(`Pictogramme manquant pour « ${b.id} »`);
    cases.push({ id: b.id, kind: 'building', name: b.name, category: b.category });
  }
  for (const id of Object.keys(RESSOURCES)) {
    cases.push({ id: 'res_' + id, kind: 'resource', name: id, category: null });
  }
  return cases;
}

/** Contenu SVG d'une case, dans le repère 0 → 64. */
function dessin(entree) {
  if (entree.kind === 'resource') return RESSOURCES[entree.id.slice(4)]();
  return plaque(entree.category) + GLYPHES[entree.id](ACCENTS[entree.id] || P.cyan);
}

/** Une icône isolée (fichier .svg individuel). */
function svgIsole(entree) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`
    + `<g stroke-linecap="round" stroke-linejoin="round">${dessin(entree)}</g></svg>\n`;
}

/** La planche complète. */
function svgAtlas(cases) {
  const rows = Math.ceil(cases.length / COLS);
  const w = COLS * CASE;
  const h = rows * CASE;
  let corps = '';
  cases.forEach((e, i) => {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    const tx = col * CASE + MARGE;
    const ty = row * CASE + MARGE;
    corps += `<g transform="translate(${tx} ${ty}) scale(${ECHELLE})">${dessin(e)}</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<g stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision">${corps}</g></svg>`;
}

/* -------------------------------------------------------------------------- */

function trouverChromium() {
  const candidats = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidats) if (existsSync(c)) return c;
  return undefined;
}

/**
 * Rasterise un SVG et renvoie `{ png, rgba }` — le PNG tel que l'encode
 * Chromium, et les pixels bruts, qui serviront au ré-encodage indexé.
 */
async function rasteriser(svg, largeur, hauteur) {
  const navigateur = await chromium.launch({
    executablePath: trouverChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb',
      '--disable-lcd-text', '--font-render-hinting=none'],
  });
  const page = await navigateur.newPage({
    viewport: { width: largeur, height: hauteur },
    deviceScaleFactor: 1,
  });
  // `omitBackground` ne suffit pas : il faut aussi que le document lui-même
  // soit transparent, sinon Chromium compose sur du blanc.
  await page.setContent(
    `<!doctype html><meta charset="utf-8">`
    + `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>`
    + svg,
    { waitUntil: 'load' });
  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  // Relecture des pixels : on repasse par le décodeur du navigateur plutôt que
  // d'écrire un décodeur PNG, ce qui garantit d'analyser EXACTEMENT l'image
  // produite.
  const brut = await page.evaluate(async (uri) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = '';
    // Transfert en base64 : un tableau de 900 000 nombres en JSON serait
    // absurde, une chaîne binaire l'est beaucoup moins.
    const CH = 0x8000;
    for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
    return { b64: btoa(s), w: c.width, h: c.height };
  }, 'data:image/png;base64,' + png.toString('base64'));
  await navigateur.close();
  return { png, rgba: Buffer.from(brut.b64, 'base64'), largeur: brut.w, hauteur: brut.h };
}

/* -------------------------------------------------------------------------- */
/*  Ré-encodage en PNG INDEXÉ                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Chromium écrit un PNG en couleurs vraies : quatre octets par pixel avant
 * compression, alors que la planche ne contient qu'une dizaine de teintes et
 * leurs bords antialiasés. Un PNG à palette (256 entrées, choisies par coupe
 * médiane sur les couleurs réellement présentes) divise le fichier par trois
 * sans différence visible. Tout est déterministe : mêmes pixels → même octet.
 *
 * Aucune dépendance : `node:zlib` fait la compression, la table CRC tient en
 * dix lignes.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunkPNG(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const corps = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corps), 0);
  return Buffer.concat([len, corps, crc]);
}

/**
 * Coupe médiane sur RGBA. Les pixels totalement transparents sont sortis du
 * calcul et reçoivent l'entrée 0 : ils représentent les trois quarts de la
 * planche et fausseraient toutes les moyennes.
 */
function palettiser(rgba, maxCouleurs) {
  const compte = new Map();                 // couleur empaquetée -> occurrences
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    const k = a === 0 ? 0 : ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | a) >>> 0;
    compte.set(k, (compte.get(k) || 0) + 1);
  }
  const couleurs = [...compte.keys()].filter((k) => k !== 0).sort((x, y) => x - y);
  const poids = couleurs.map((k) => compte.get(k));
  const canal = (k, c) => (k >>> (24 - c * 8)) & 0xff;

  let boites = [{ idx: couleurs.map((_, i) => i) }];
  const etendue = (b) => {
    let best = -1, canalBest = 0;
    for (let c = 0; c < 4; c++) {
      let mn = 255, mx = 0;
      for (const i of b.idx) { const v = canal(couleurs[i], c); if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mx - mn > best) { best = mx - mn; canalBest = c; }
    }
    return { span: best, canal: canalBest };
  };

  while (boites.length < maxCouleurs) {
    let cible = -1, meilleur = 0, info = null;
    for (let i = 0; i < boites.length; i++) {
      if (boites[i].idx.length < 2) continue;
      const e = etendue(boites[i]);
      // Critère : plus grande étendue, départagée par le nombre de pixels —
      // strictement déterministe.
      const score = e.span * 1e6 + boites[i].idx.reduce((s, j) => s + poids[j], 0);
      if (score > meilleur) { meilleur = score; cible = i; info = e; }
    }
    if (cible < 0 || info.span === 0) break;
    const b = boites[cible];
    const tri = [...b.idx].sort((x, y) => canal(couleurs[x], info.canal) - canal(couleurs[y], info.canal) || x - y);
    const demi = tri.length >> 1;
    boites.splice(cible, 1, { idx: tri.slice(0, demi) }, { idx: tri.slice(demi) });
  }

  // Entrée 0 : le transparent absolu. Ensuite, une entrée par boîte.
  const palette = [[0, 0, 0, 0]];
  const table = new Map([[0, 0]]);
  for (const b of boites) {
    let r = 0, g = 0, bl = 0, a = 0, n = 0;
    for (const i of b.idx) {
      const w = poids[i];
      r += canal(couleurs[i], 0) * w; g += canal(couleurs[i], 1) * w;
      bl += canal(couleurs[i], 2) * w; a += canal(couleurs[i], 3) * w; n += w;
    }
    const entree = [Math.round(r / n), Math.round(g / n), Math.round(bl / n), Math.round(a / n)];
    const id = palette.length;
    palette.push(entree);
    for (const i of b.idx) table.set(couleurs[i], id);
  }
  return { palette, table };
}

/** Écrit un PNG indexé (type couleur 3) à partir de pixels RGBA. */
function encoderPNGIndexe(rgba, largeur, hauteur) {
  const { palette, table } = palettiser(rgba, 255);

  // Une ligne = un octet de filtre (0 = aucun) + un index par pixel. Filtrer
  // des index n'a pas de sens : les valeurs voisines ne sont pas des couleurs
  // voisines.
  const lignes = Buffer.alloc(hauteur * (largeur + 1));
  let o = 0;
  for (let y = 0; y < hauteur; y++) {
    lignes[o++] = 0;
    for (let x = 0; x < largeur; x++) {
      const i = (y * largeur + x) * 4;
      const a = rgba[i + 3];
      const k = a === 0 ? 0 : ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | a) >>> 0;
      lignes[o++] = table.get(k) ?? 0;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8;    // 8 bits par index
  ihdr[9] = 3;    // palette
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const plte = Buffer.alloc(palette.length * 3);
  const trns = Buffer.alloc(palette.length);
  palette.forEach((c, i) => {
    plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2];
    trns[i] = c[3];
  });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkPNG('IHDR', ihdr),
    chunkPNG('PLTE', plte),
    chunkPNG('tRNS', trns),
    chunkPNG('IDAT', deflateSync(lignes, { level: 9, memLevel: 9 })),
    chunkPNG('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */

async function principal() {
  const cases = inventaire();
  const rows = Math.ceil(cases.length / COLS);
  const largeur = COLS * CASE;
  const hauteur = rows * CASE;

  console.log(`\nGÉNÉRATION DES PICTOGRAMMES — ${cases.length} cases (${COLS} × ${rows}), ${largeur} × ${hauteur} px\n`);

  mkdirSync(SORTIE, { recursive: true });
  mkdirSync(join(SORTIE, 'svg'), { recursive: true });

  /* --- SVG individuels ------------------------------------------------ */
  for (const e of cases) writeFileSync(join(SORTIE, 'svg', e.id + '.svg'), svgIsole(e));
  console.log(`  · ${cases.length} fichiers SVG`);

  /* --- planche PNG ----------------------------------------------------- */
  const rendu = await rasteriser(svgAtlas(cases), largeur, hauteur);
  const indexe = encoderPNGIndexe(rendu.rgba, rendu.largeur, rendu.hauteur);
  // On garde le plus petit des deux, quoi qu'il arrive : le ré-encodage est un
  // gain, pas un dogme.
  const png = indexe.length < rendu.png.length ? indexe : rendu.png;
  writeFileSync(join(SORTIE, 'atlas.png'), png);
  console.log(`  · atlas.png — ${(png.length / 1024).toFixed(1)} ko`
    + ` (Chromium : ${(rendu.png.length / 1024).toFixed(1)} ko, indexé : ${(indexe.length / 1024).toFixed(1)} ko)`);

  /* --- descripteur ------------------------------------------------------ */
  const frames = {};
  cases.forEach((e, i) => {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    frames[e.id] = { col, row, x: col * CASE, y: row * CASE, w: CASE, h: CASE };
  });
  const meta = {
    version: 1,
    genere_par: 'tools/sprite-gen.mjs',
    image: 'atlas.png',
    cell: CASE, cols: COLS, rows, width: largeur, height: hauteur,
    frames,
  };
  writeFileSync(join(SORTIE, 'atlas.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log('  · atlas.json');

  /* --- module embarqué --------------------------------------------------- */
  // Le data URI est découpé en tranches : un littéral d'une seule ligne de
  // 40 000 caractères est illisible dans un diff et fâche certains outils.
  const b64 = png.toString('base64');
  const tranches = [];
  for (let i = 0; i < b64.length; i += 96) tranches.push(b64.slice(i, i + 96));
  const module = `/**
 * ============================================================================
 *  TERRA NOVA — Planche de pictogrammes embarquée
 * ============================================================================
 *  FICHIER GÉNÉRÉ — ne pas modifier à la main.
 *  Source : tools/sprite-gen.mjs · relancer \`node tools/sprite-gen.mjs\`.
 *
 *  L'image est embarquée en data URI plutôt que chargée depuis \`public/\` :
 *  c'est la seule forme qui fonctionne À LA FOIS quand le dépôt est servi en
 *  source brute (les fichiers de \`public/\` ne sont alors pas à la racine) et
 *  quand le jeu est construit (Vite recopie \`public/\` À la racine). Aucune
 *  requête réseau, donc aucun 404 possible, et le jeu reste jouable hors ligne.
 *  Le PNG de référence reste consultable dans public/sprites/.
 * ============================================================================
 */

/** Taille d'une case, en pixels de la planche. */
export const SPRITE_CELL = ${CASE};
/** Grille de la planche. */
export const SPRITE_GRID = { cols: ${COLS}, rows: ${rows}, width: ${largeur}, height: ${hauteur} };

/**
 * Position de chaque icône : \`{ col, row }\`. Les coordonnées de texture se
 * déduisent de la grille — voir BuildingMarkers._frameUv().
 */
export const SPRITE_FRAMES = ${JSON.stringify(
    Object.fromEntries(cases.map((e, i) => [e.id, { col: i % COLS, row: (i / COLS) | 0 }])), null, 2)
    .replace(/\n/g, '\n')};

/** La planche elle-même (PNG, fond transparent). */
export const SPRITE_ATLAS_URI = 'data:image/png;base64,'
${tranches.map((t) => `  + '${t}'`).join('\n')};

export default { SPRITE_CELL, SPRITE_GRID, SPRITE_FRAMES, SPRITE_ATLAS_URI };
`;
  const chemin = join(RACINE, 'src', 'render', 'SpriteAtlas.js');
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, module);
  console.log(`  · src/render/SpriteAtlas.js — ${(module.length / 1024).toFixed(1)} ko`);

  /* --- planche de contrôle (facultative) --------------------------------- */
  if (process.argv.includes('--sheet')) {
    const dossier = '/tmp/tn-sprites';
    mkdirSync(dossier, { recursive: true });
    const cell = 150;
    let corps = '';
    cases.forEach((e, i) => {
      const col = i % COLS, row = (i / COLS) | 0;
      corps += `<g transform="translate(${col * cell + 12} ${row * cell + 8}) scale(${(cell - 46) / BOITE})">`
        + `<g stroke-linecap="round" stroke-linejoin="round">${dessin(e)}</g></g>`
        + `<text x="${col * cell + cell / 2}" y="${row * cell + cell - 12}" fill="${P.texte}"`
        + ` font-family="ui-monospace,monospace" font-size="13" text-anchor="middle">${e.id}</text>`;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * cell}" height="${rows * cell}">`
      + `<rect width="100%" height="100%" fill="${P.fond}"/>${corps}</svg>`;
    const sheet = await rasteriser(svg, COLS * cell, rows * cell);
    writeFileSync(join(dossier, 'planche.png'), sheet.png);
    console.log(`  · ${dossier}/planche.png (contrôle visuel)`);
  }

  console.log('\n✔ Pictogrammes régénérés.\n');
}

principal().catch((e) => { console.error('\nÉchec de la génération :', e); process.exitCode = 1; });

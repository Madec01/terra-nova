/**
 * ============================================================================
 *  TERRA NOVA — Planche de pictogrammes embarquée
 * ============================================================================
 *  FICHIER GÉNÉRÉ — ne pas modifier à la main.
 *  Source : tools/sprite-gen.mjs · relancer `node tools/sprite-gen.mjs`.
 *
 *  L'image est embarquée en data URI plutôt que chargée depuis `public/` :
 *  c'est la seule forme qui fonctionne À LA FOIS quand le dépôt est servi en
 *  source brute (les fichiers de `public/` ne sont alors pas à la racine) et
 *  quand le jeu est construit (Vite recopie `public/` À la racine). Aucune
 *  requête réseau, donc aucun 404 possible, et le jeu reste jouable hors ligne.
 *  Le PNG de référence reste consultable dans public/sprites/.
 * ============================================================================
 */

/** Taille d'une case, en pixels de la planche. */
export const SPRITE_CELL = 96;
/** Grille de la planche. */
export const SPRITE_GRID = { cols: 6, rows: 4, width: 576, height: 384 };

/**
 * Position de chaque icône : `{ col, row }`. Les coordonnées de texture se
 * déduisent de la grille — voir BuildingMarkers._frameUv().
 */
export const SPRITE_FRAMES = {
  "mine": {
    "col": 0,
    "row": 0
  },
  "refinery": {
    "col": 1,
    "row": 0
  },
  "depot": {
    "col": 2,
    "row": 0
  },
  "solar": {
    "col": 3,
    "row": 0
  },
  "geothermal": {
    "col": 4,
    "row": 0
  },
  "fusion": {
    "col": 5,
    "row": 0
  },
  "science_station": {
    "col": 0,
    "row": 1
  },
  "ice_extractor": {
    "col": 1,
    "row": 1
  },
  "ghg_factory": {
    "col": 2,
    "row": 1
  },
  "atmo_processor": {
    "col": 3,
    "row": 1
  },
  "o2_generator": {
    "col": 4,
    "row": 1
  },
  "polar_melter": {
    "col": 5,
    "row": 1
  },
  "orbital_mirror": {
    "col": 0,
    "row": 2
  },
  "climate_stabilizer": {
    "col": 1,
    "row": 2
  },
  "biodome": {
    "col": 2,
    "row": 2
  },
  "seeder": {
    "col": 3,
    "row": 2
  },
  "colony": {
    "col": 4,
    "row": 2
  },
  "res_energy": {
    "col": 5,
    "row": 2
  },
  "res_materials": {
    "col": 0,
    "row": 3
  },
  "res_water": {
    "col": 1,
    "row": 3
  },
  "res_science": {
    "col": 2,
    "row": 3
  },
  "res_biomass": {
    "col": 3,
    "row": 3
  }
};

/** La planche elle-même (PNG, fond transparent). */
export const SPRITE_ATLAS_URI = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAkAAAAGACAMAAAByRC0tAAADAFBMVEUAAAADCg0JFBYGChELFBcHDBIIChAIChELDhQQExkX'
  + 'HSIeKSozJhwqND1Z1phe1Jld1Jxe1Jtd0aJV1KpV/6pb1OdE+cVe0+cA//9A//9T1fdZ1OtV6/lc1Opc1Opf1ete0+pe05le'
  + '05lf05tf05pf1Jtd0ude0+df0+de0+de0+le0+g4RE1DSVNe0ple0ple0ppe0ppe0ppe05lf05pf05pf05pe05lf05pe0ude'
  + '0+de0+he0uhf0+hf0+hf05pd0udd0ude0ude0+de0+gJDBIWJyUkJyxINSNaQSY2R05CTVZKUFotXEozXWtWXGYxalM1dFla'
  + 'Zmw+iGc0b31Dd4ZJoXxXwY5Im6xe0ppMqbtf05pQscRf0ufHjjvUgCr9gQLOkzvSljz/mTPLjzzhWFjMk0DNjkD/Zmbbmkbh'
  + 'oUjnokfhoklk0pt39olh3Z5g1ZvgpUngpErkpUnipUjlqUX/qgDssU//tkn/v0D//wDhWVnJjz3Jjz/NlEDhpEngo0rfoknY'
  + 'nEbbcXPgokrhokrgo0pjPitsUStsLzJxMTVoXltiaXNudoB2WC13MzZ0e4R1fYh6UDB5aVV7bVl4fYd5f4l8WzB7gYt+Xi9+'
  + 'hY7fWVnIjz7TmUTcn0iDUzOLZjOUSExmbnhrdH53gIp9hpGgQkSYcDejdzmygjy3SkzPU1SkfkrWVVWthUvWVlbYVlbZVlaw'
  + 'fILgWlqCi5aGkJuGmqBwxaJo0aCLlJ+OmKSTm6XIjz/doUnfokrgo0rWt4nSv6Fm2e5wzOSAweh/xd6AyOGAzOaA1P+A///G'
  + '4+PI1uNp0OZ+w95/xNyAw96AxN2Axd2AxtzI1eXI1+TJ1ePZ5fLz9v3Z5PHTo6zK1ePJ1eTJ1ubJ1eTL2OXV4uzg6vXf6fR/'
  + 'xNx/xNx+xNx+w91hlqmSnKeTnalpmq6Ao7F+xN2Uoa2aprLK1+Xd6POeqbSqsr3T3+vf6PNnn7WBrL6YpLB70q2fqrairrp6'
  + 'wNh/xN2uvMi6xdLCztrL1+XB7spNAAABAHRSTlMAKEx6j9Xb29vc3eDh4RY5JEELBgMqCkUBBAkbCRExITteflWAXl15XoNY'
  + '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';

export default { SPRITE_CELL, SPRITE_GRID, SPRITE_FRAMES, SPRITE_ATLAS_URI };

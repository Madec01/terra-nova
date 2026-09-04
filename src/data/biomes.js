/**
 * Biomes : purement descriptifs et visuels. Le biome d'une région est recalculé
 * à partir de son climat courant ; il n'est jamais « stocké » comme une vérité.
 * L'index dans ce tableau est ce qui est envoyé au shader.
 */

export const BIOMES = [
  // 0
  { id: 'ocean',      name: 'Océan',            color: [0.05, 0.22, 0.42], desc: 'Étendue d’eau liquide.' },
  // 1
  { id: 'ice_sheet',  name: 'Calotte glaciaire', color: [0.82, 0.88, 0.94], desc: 'Glace permanente. Réfléchit la lumière stellaire.' },
  // 2
  { id: 'tundra',     name: 'Toundra',          color: [0.44, 0.46, 0.42], desc: 'Sol gelé, végétation rase possible.' },
  // 3
  { id: 'barren',     name: 'Désert de roche',  color: [0.38, 0.31, 0.26], desc: 'Roche nue exposée au vide.' },
  // 4
  { id: 'desert',     name: 'Désert',           color: [0.66, 0.52, 0.33], desc: 'Chaud et sec.' },
  // 5
  { id: 'steppe',     name: 'Steppe',           color: [0.52, 0.50, 0.30], desc: 'Plaine semi-aride.' },
  // 6
  { id: 'grassland',  name: 'Prairie',          color: [0.33, 0.50, 0.24], desc: 'Couverture végétale continue.' },
  // 7
  { id: 'forest',     name: 'Forêt',            color: [0.16, 0.38, 0.19], desc: 'Écosystème dense et stable.' },
  // 8
  { id: 'jungle',     name: 'Forêt dense',      color: [0.10, 0.34, 0.14], desc: 'Biomasse maximale.' },
  // 9
  { id: 'volcanic',   name: 'Région volcanique', color: [0.24, 0.15, 0.14], desc: 'Activité géothermique intense.' },
  // 10
  { id: 'highland',   name: 'Haute montagne',   color: [0.48, 0.45, 0.43], desc: 'Altitude extrême, froid permanent.' },
  // 11
  { id: 'wetland',    name: 'Zone humide',      color: [0.24, 0.42, 0.31], desc: 'Sol saturé d’eau, très fertile.' },
];

export const BIOME_INDEX = Object.fromEntries(BIOMES.map((b, i) => [b.id, i]));
export const BIOME_COUNT = BIOMES.length;

/** Palette plate (Float32Array) prête pour un uniform de shader. */
export function biomePaletteArray() {
  const arr = new Float32Array(BIOMES.length * 3);
  BIOMES.forEach((b, i) => { arr[i * 3] = b.color[0]; arr[i * 3 + 1] = b.color[1]; arr[i * 3 + 2] = b.color[2]; });
  return arr;
}

/**
 * Catalogue des infrastructures.
 * Les valeurs sont exprimées PAR JOUR de simulation (voir BALANCE.time).
 *
 * Champs :
 *  cost      : payé une fois à la construction
 *  upkeep    : consommé chaque jour (si impayé → bâtiment inactif)
 *  produces  : produit chaque jour (modulé par outputScale et la satisfaction énergétique)
 *  requires  : conditions de placement
 *  local     : effets sur la région (par jour)
 *  global    : effets planétaires exprimés comme un TAUX (par jour, × dt, cumulatif)
 *  globalStatic : effets planétaires exprimés comme un NIVEAU (sommés sur les
 *                 bâtiments actifs, sans dt — démonter annule immédiatement)
 *  outputScale(region, state) : multiplicateur contextuel, fonction PURE.
 *                 Il module AUSSI les effets `global` (mais pas `globalStatic`).
 *
 * ---------------------------------------------------------------------------
 *  SÉMANTIQUE DES EFFETS ATMOSPHÉRIQUES (modèle en pressions partielles)
 * ---------------------------------------------------------------------------
 *  L'atmosphère est décrite par trois réservoirs en kPa — pCO2, pO2, pInert —
 *  dont `pressure`, `co2` (%) et `oxygen` (%) sont DÉRIVÉS
 *  (cf. src/sim/ClimateSystem.js). Les trois canaux disponibles sont donc :
 *
 *   global.co2      → kPa de CO₂ AJOUTÉS par jour.
 *                     Dégazage volcanique, halocarbures, fonte des calottes.
 *                     Réchauffe (effet de serre) et épaissit l'atmosphère.
 *
 *   global.pressure → kPa de gaz INERTES (azote + argon) ajoutés par jour.
 *                     Dégazage du régolithe. Épaissit l'atmosphère SANS
 *                     toucher au rapport CO₂/O₂ : c'est le levier « pression »
 *                     propre, celui qui rend l'eau liquide stable.
 *
 *   global.oxygen   → kPa de CO₂ CONVERTIS en O₂ par jour (craquage).
 *                     Ce n'est PAS une création de matière : ce qui est ajouté
 *                     à pO2 est retiré de pCO2, et la conversion s'arrête s'il
 *                     n'y a plus de CO₂. Rendre l'air respirable assèche donc
 *                     l'effet de serre : c'est la tension de fin de partie.
 *
 *  Corollaire d'équilibrage : un bâtiment ne doit JAMAIS cumuler `oxygen` et
 *  un `co2` négatif — le craquage débite déjà le CO₂ tout seul.
 */

import { BALANCE } from './balance.js';
import { smoothstep } from '../utils/math.js';

export const BUILDINGS = {
  /* ------------------------------------------------------------------ */
  /*  INDUSTRIE                                                          */
  /* ------------------------------------------------------------------ */
  mine: {
    id: 'mine', name: 'Mine', category: 'industrie', icon: '⛏', tier: 1,
    desc: 'Extrait les minerais de la croûte. Rendement proportionnel à la richesse minérale locale.',
    cost: { materials: 45 },
    upkeep: { energy: 1.6 },
    produces: { materials: 2.4 },
    requires: { minerals: 0.22 },
    local: { pollution: 0.0016 },
    maxPerRegion: 1,
    outputScale: (r) => 0.4 + r.minerals * 1.6,
  },

  refinery: {
    id: 'refinery', name: 'Raffinerie', category: 'industrie', icon: '⚗', tier: 2,
    desc: 'Améliore le rendement des mines de la région et des régions voisines. Polluante.',
    cost: { materials: 160, science: 20 },
    upkeep: { energy: 4.5 },
    produces: { materials: 3.2 },
    requires: { tech: 'metallurgy' },
    local: { pollution: 0.0042 },
    maxPerRegion: 1,
    neighborBonus: { building: 'mine', resource: 'materials', factor: 0.45 },
    outputScale: (r) => 0.6 + r.minerals * 0.9,
  },

  depot: {
    id: 'depot', name: 'Dépôt logistique', category: 'industrie', icon: '▤', tier: 1,
    desc: 'Augmente la capacité de stockage d’énergie, de matériaux et d’eau.',
    cost: { materials: 70 },
    upkeep: { energy: 0.4 },
    produces: {},
    requires: {},
    maxPerRegion: 1,
    storage: true,
  },

  /* ------------------------------------------------------------------ */
  /*  ÉNERGIE                                                            */
  /* ------------------------------------------------------------------ */
  solar: {
    id: 'solar', name: 'Champ solaire', category: 'energie', icon: '☀', tier: 1,
    desc: 'Convertit la lumière stellaire. Moins efficace près des pôles et sous les nuages.',
    cost: { materials: 35 },
    upkeep: {},
    produces: { energy: 3.0 },
    requires: {},
    maxPerRegion: 2,
    outputScale: (r, s) => {
      const lat = 1 - Math.abs(r.latitude) * 0.65;          // pénalité polaire
      const clouds = 1 - Math.min(0.45, s.globals.cloudCover ?? 0) * 0.9; // nuages
      return lat * clouds * s.globals.insolation;
    },
  },

  geothermal: {
    id: 'geothermal', name: 'Centrale géothermique', category: 'energie', icon: '♨', tier: 2,
    desc: 'Puise la chaleur interne. Très productive, mais uniquement sur les failles actives.',
    cost: { materials: 110, science: 15 },
    upkeep: {},
    produces: { energy: 9.0 },
    requires: { tech: 'geothermal_tap', geothermal: 0.38 },
    local: { pollution: 0.0008, heat: 0.0 },
    maxPerRegion: 1,
    outputScale: (r) => 0.5 + r.geothermal * 1.4,
  },

  fusion: {
    id: 'fusion', name: 'Réacteur à fusion', category: 'energie', icon: '⬢', tier: 3,
    desc: 'Production énergétique massive et indépendante du climat. Coûteux.',
    cost: { materials: 480, science: 140 },
    upkeep: { water: 0.8 },
    produces: { energy: 34 },
    requires: { tech: 'fusion' },
    maxPerRegion: 1,
    maxTotal: 6,
  },

  /* ------------------------------------------------------------------ */
  /*  SCIENCE & EAU                                                      */
  /* ------------------------------------------------------------------ */
  science_station: {
    id: 'science_station', name: 'Station scientifique', category: 'science', icon: '⌬', tier: 1,
    desc: 'Analyse l’environnement. Bonus important sur les anomalies et les régions extrêmes.',
    cost: { materials: 80 },
    upkeep: { energy: 2.2 },
    produces: { science: 1.5 },
    requires: {},
    maxPerRegion: 1,
    outputScale: (r) => (r.anomaly ? 2.4 : 1) * (1 + r.radiation * 0.5),
  },

  ice_extractor: {
    id: 'ice_extractor', name: 'Station hydrique', category: 'eau', icon: '❄', tier: 1,
    desc: 'Sublime la glace du sous-sol, puis pompe lacs et nappes une fois la planète dégelée.',
    cost: { materials: 60 },
    upkeep: { energy: 2.6 },
    produces: { water: 2.6 },
    requires: { ice: 0.12 },
    local: { moisture: 0.0016, ice: -0.00035 },
    // La glace sublimée rend surtout de la vapeur et un peu de CO₂ piégé.
    global: { pressure: 0.00008, co2: 0.00003 },
    maxPerRegion: 1,
    /* Le rendement suit la glace TANT QU'IL Y EN A, puis bascule sur l'eau
       libre et l'humidité. Sans cette bascule, la production d'eau s'effondrait
       exactement au moment où la planète dégelait : les colonies mouraient de
       soif sur une planète couverte de lacs. */
    outputScale: (r) => 0.25 + r.ice * 1.4
      + Math.min(1, r.water / BALANCE.water.basinDepth + r.moisture) * 1.6,
  },

  /* ------------------------------------------------------------------ */
  /*  TERRAFORMATION                                                     */
  /* ------------------------------------------------------------------ */
  ghg_factory: {
    id: 'ghg_factory', name: 'Usine à gaz à effet de serre', category: 'terraformation', icon: '🜂', tier: 2,
    desc: 'Relâche des halocarbures. Réchauffe rapidement la planète — mais pollue et déstabilise.',
    cost: { materials: 190, science: 40 },
    upkeep: { energy: 6.5, materials: 0.6 },
    produces: {},
    requires: { tech: 'greenhouse_gases' },
    local: { pollution: 0.0055 },
    // Levier de réchauffement le plus rapide : du CO₂ pur, peu d'inertes.
    // 12 usines ≈ +0,96 kPa de CO₂ par an, soit ~+10 °C d'effet de serre en
    // une douzaine d'années.
    global: { co2: 0.00016, pressure: 0.00006, stability: -0.0016 },
    maxPerRegion: 1,
    /* Les halocarbures se photodissocient : plus le CO₂ est déjà abondant,
       moins l'usine en ajoute. C'est le frein qui empêche l'emballement de
       l'effet de serre — et ce qui rend la surchauffe corrigeable. */
    outputScale: (r, s) => 1 - smoothstep(BALANCE.atmosphere.co2Soft,
      BALANCE.atmosphere.co2Ceiling, s.globals.pCO2 ?? 0),
  },

  atmo_processor: {
    id: 'atmo_processor', name: 'Processeur atmosphérique', category: 'terraformation', icon: '⧗', tier: 2,
    desc: 'Dégaze le régolithe et épaissit l’atmosphère. Rendement meilleur en région volcanique.',
    cost: { materials: 240, science: 60 },
    upkeep: { energy: 8.0 },
    produces: {},
    requires: { tech: 'atmospheric_engineering' },
    // Levier de PRESSION : des inertes, presque pas de CO₂.
    // 14 processeurs ≈ +4 kPa/an → il faut une quinzaine d'années pour
    // amener l'atmosphère de 5 à ~70 kPa : c'est le tempo de la partie.
    global: { pressure: 0.00050, co2: 0.00003 },
    maxPerRegion: 1,
    /* Le rendement s'effondre quand l'atmosphère devient épaisse : le régolithe
       ne rend plus ses gaz contre la pression ambiante. C'est ce qui empêche
       la pression de saturer même si le joueur oublie ses processeurs. */
    outputScale: (r, s) => (0.7 + r.geothermal * 0.9)
      * (1 - smoothstep(BALANCE.atmosphere.degassingSoft, BALANCE.atmosphere.degassingCeiling, s.globals.pressure)),
  },

  o2_generator: {
    id: 'o2_generator', name: 'Générateur d’oxygène', category: 'terraformation', icon: '◎', tier: 3,
    desc: 'Craque le CO₂ en oxygène. Indispensable pour rendre l’air respirable.',
    cost: { materials: 300, science: 110 },
    upkeep: { energy: 12 },
    produces: {},
    requires: { tech: 'carbon_capture' },
    // `oxygen` est une CONVERSION CO₂ → O₂ : inutile (et faux) d'y ajouter un
    // `co2` négatif, le craquage débite déjà le réservoir de CO₂.
    // 12 générateurs ≈ +1,5 kPa d'O₂ par an, prélevés sur le CO₂.
    global: { oxygen: 0.00025, stability: 0.0004 },
    maxPerRegion: 1,
    /* Le craquage travaille contre la contre-pression d'oxygène déjà présente :
       le rendement s'annule vers `o2Ceiling`. Sans ce frein, les générateurs
       vidaient tout le CO₂ et regelaient la planète. */
    outputScale: (r, s) => 1 - smoothstep(BALANCE.atmosphere.o2Soft,
      BALANCE.atmosphere.o2Ceiling, s.globals.pO2 ?? 0),
  },

  polar_melter: {
    id: 'polar_melter', name: 'Station de fonte polaire', category: 'terraformation', icon: '≋', tier: 2,
    desc: 'Chauffe la calotte pour libérer l’eau et les gaz piégés. À placer sur la glace.',
    cost: { materials: 170, science: 45 },
    upkeep: { energy: 7.5 },
    produces: { water: 1.4 },
    requires: { tech: 'polar_engineering', ice: 0.35 },
    local: { ice: -0.0042, moisture: 0.0034, heat: 0.9 },
    // La calotte est surtout de la glace carbonique : elle rend du CO₂.
    global: { pressure: 0.00008, co2: 0.00008 },
    maxPerRegion: 1,
  },

  orbital_mirror: {
    id: 'orbital_mirror', name: 'Miroir orbital', category: 'terraformation', icon: '◇', tier: 3,
    desc: 'Constellation de réflecteurs. Augmente l’ensoleillement de toute la planète.',
    cost: { materials: 380, science: 130 },
    upkeep: { energy: 3.0 },
    produces: {},
    requires: { tech: 'orbital_infrastructure' },
    /* NIVEAU, pas taux : l'ensoleillement vaut 1 + somme des miroirs ACTIFS.
       8 miroirs = +0,40 d'ensoleillement ≈ +25 °C ; démonter un miroir retire
       ses ~3 °C dès le tick suivant. C'est le thermostat de la partie. */
    globalStatic: { insolation: 0.05 },
    maxPerRegion: 1,
    maxTotal: 8,
    orbital: true,
  },

  climate_stabilizer: {
    id: 'climate_stabilizer', name: 'Stabilisateur climatique', category: 'terraformation', icon: '⊛', tier: 3,
    desc: 'Amortit les variations brutales du climat et restaure la stabilité planétaire.',
    cost: { materials: 320, science: 150 },
    upkeep: { energy: 9.0 },
    produces: {},
    requires: { tech: 'climate_control' },
    global: { stability: 0.030 },
    maxPerRegion: 1,
    dampening: 0.10,
  },

  /* ------------------------------------------------------------------ */
  /*  BIOSPHÈRE                                                          */
  /* ------------------------------------------------------------------ */
  biodome: {
    id: 'biodome', name: 'Bio-dôme', category: 'biosphere', icon: '❋', tier: 2,
    desc: 'Cultive des organismes pionniers et ensemence la région. Nécessite eau et douceur.',
    cost: { materials: 150, science: 55 },
    upkeep: { energy: 4.0, water: 0.6 },
    produces: { biomass: 0.35 },
    requires: { tech: 'pioneer_organisms', minTemp: -25 },
    local: { vegetation: 0.0042, moisture: 0.0008 },
    // Craquage d'appoint : symbolique à côté de la photosynthèse planétaire.
    global: { oxygen: 0.00006 },
    maxPerRegion: 1,
  },

  seeder: {
    id: 'seeder', name: 'Tour d’ensemencement', category: 'biosphere', icon: '⁂', tier: 3,
    desc: 'Disperse des spores sur toute la zone. Accélère fortement la propagation végétale.',
    cost: { materials: 260, science: 120 },
    upkeep: { energy: 5.5, water: 0.9 },
    produces: { biomass: 0.5 },
    requires: { tech: 'forestation' },
    local: { vegetation: 0.0030 },
    spread: { radius: 1, vegetation: 0.0022 },
    maxPerRegion: 1,
  },

  /* ------------------------------------------------------------------ */
  /*  COLONISATION                                                       */
  /* ------------------------------------------------------------------ */
  colony: {
    id: 'colony', name: 'Colonie', category: 'colonisation', icon: '⌂', tier: 3,
    desc: 'Habitat humain permanent. Produit science et matériaux, consomme eau, énergie et vivres.',
    cost: { materials: 400, science: 100 },
    upkeep: {},
    produces: {},
    requires: { tech: 'colonization', habitability: 0.45 },
    local: { pollution: 0.0012 },
    maxPerRegion: 1,
    colony: true,
  },
};

export const BUILDING_LIST = Object.values(BUILDINGS);

export const BUILDING_CATEGORIES = [
  { id: 'industrie',      name: 'Industrie',      icon: '⛏' },
  { id: 'energie',        name: 'Énergie',        icon: '⚡' },
  { id: 'science',        name: 'Science',        icon: '⌬' },
  { id: 'eau',            name: 'Eau',            icon: '❄' },
  { id: 'terraformation', name: 'Terraformation', icon: '⧗' },
  { id: 'biosphere',      name: 'Biosphère',      icon: '❋' },
  { id: 'colonisation',   name: 'Colonisation',   icon: '⌂' },
];

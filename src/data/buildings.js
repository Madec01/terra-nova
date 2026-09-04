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
 *  global    : effets sur les paramètres planétaires (par jour)
 *  outputScale(region, state) : multiplicateur contextuel, fonction PURE
 */

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
    id: 'ice_extractor', name: 'Extracteur de glace', category: 'eau', icon: '❄', tier: 1,
    desc: 'Sublime la glace du sous-sol. Libère de l’eau et un peu de vapeur atmosphérique.',
    cost: { materials: 60 },
    upkeep: { energy: 2.6 },
    produces: { water: 2.2 },
    requires: { ice: 0.2 },
    local: { moisture: 0.0016, ice: -0.00035 },
    global: { pressure: 0.00045 },
    maxPerRegion: 1,
    outputScale: (r) => 0.3 + r.ice * 1.8,
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
    global: { co2: 0.0075, pressure: 0.0055, stability: -0.0016 },
    maxPerRegion: 1,
  },

  atmo_processor: {
    id: 'atmo_processor', name: 'Processeur atmosphérique', category: 'terraformation', icon: '⧗', tier: 2,
    desc: 'Dégaze le régolithe et épaissit l’atmosphère. Rendement meilleur en région volcanique.',
    cost: { materials: 240, science: 60 },
    upkeep: { energy: 8.0 },
    produces: {},
    requires: { tech: 'atmospheric_engineering' },
    global: { pressure: 0.0022, co2: 0.0006 },
    maxPerRegion: 1,
    outputScale: (r) => 0.7 + r.geothermal * 0.9,
  },

  o2_generator: {
    id: 'o2_generator', name: 'Générateur d’oxygène', category: 'terraformation', icon: '◎', tier: 3,
    desc: 'Craque le CO₂ en oxygène. Indispensable pour rendre l’air respirable.',
    cost: { materials: 300, science: 110 },
    upkeep: { energy: 12 },
    produces: {},
    requires: { tech: 'carbon_capture' },
    global: { oxygen: 0.0100, co2: -0.0045, stability: 0.0004 },
    maxPerRegion: 1,
  },

  polar_melter: {
    id: 'polar_melter', name: 'Station de fonte polaire', category: 'terraformation', icon: '≋', tier: 2,
    desc: 'Chauffe la calotte pour libérer l’eau et les gaz piégés. À placer sur la glace.',
    cost: { materials: 170, science: 45 },
    upkeep: { energy: 7.5 },
    produces: { water: 1.4 },
    requires: { tech: 'polar_engineering', ice: 0.35 },
    local: { ice: -0.0042, moisture: 0.0034, heat: 0.9 },
    global: { pressure: 0.0022, co2: 0.0012 },
    maxPerRegion: 1,
  },

  orbital_mirror: {
    id: 'orbital_mirror', name: 'Miroir orbital', category: 'terraformation', icon: '◇', tier: 3,
    desc: 'Constellation de réflecteurs. Augmente l’ensoleillement de toute la planète.',
    cost: { materials: 380, science: 130 },
    upkeep: { energy: 3.0 },
    produces: {},
    requires: { tech: 'orbital_infrastructure' },
    global: { insolation: 0.00001 },   // cumulatif : 8 miroirs ≈ +0,03 d'ensoleillement par an
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
    upkeep: { energy: 4.0, water: 1.2 },
    produces: { biomass: 0.35 },
    requires: { tech: 'pioneer_organisms', minTemp: -25 },
    local: { vegetation: 0.0042, moisture: 0.0008 },
    global: { oxygen: 0.0006 },
    maxPerRegion: 1,
  },

  seeder: {
    id: 'seeder', name: 'Tour d’ensemencement', category: 'biosphere', icon: '⁂', tier: 3,
    desc: 'Disperse des spores sur toute la zone. Accélère fortement la propagation végétale.',
    cost: { materials: 260, science: 120 },
    upkeep: { energy: 5.5, water: 1.8 },
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

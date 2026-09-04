/**
 * Arbre technologique. Coût en science, prérequis par identifiants.
 * `unlocks` sert uniquement à l'affichage : la vraie porte est `requires.tech`
 * dans buildings.js et les effets passifs listés dans `effects`.
 */

export const TECH_BRANCHES = [
  { id: 'energie',    name: 'Énergie',    color: '#f2b45c', icon: '⚡' },
  { id: 'industrie',  name: 'Industrie',  color: '#c8cdd8', icon: '⛏' },
  { id: 'atmosphere', name: 'Atmosphère', color: '#6fd3e8', icon: '⧗' },
  { id: 'biologie',   name: 'Biologie',   color: '#7fd08a', icon: '❋' },
  { id: 'espace',     name: 'Espace',     color: '#a98bf0', icon: '◇' },
];

export const TECHNOLOGIES = {
  /* --- INDUSTRIE ---------------------------------------------------- */
  metallurgy: {
    id: 'metallurgy', branch: 'industrie', name: 'Métallurgie avancée', cost: 40, requires: [],
    desc: 'Traitement du minerai sur place.', unlocks: ['refinery'],
  },
  automation: {
    id: 'automation', branch: 'industrie', name: 'Automatisation', cost: 120, requires: ['metallurgy'],
    desc: 'Les mines et raffineries produisent 25 % de plus.',
    effects: { productionMultiplier: { materials: 1.25 } },
  },
  deep_drilling: {
    id: 'deep_drilling', branch: 'industrie', name: 'Forage profond', cost: 260, requires: ['automation'],
    desc: 'Les mines fonctionnent même sur des gisements pauvres, et la géothermie gagne 20 %.',
    effects: { minMineralOverride: 0.08, productionMultiplier: { energy: 1.0 } },
  },

  /* --- ÉNERGIE ------------------------------------------------------ */
  geothermal_tap: {
    id: 'geothermal_tap', branch: 'energie', name: 'Captage géothermique', cost: 55, requires: [],
    desc: 'Exploite les failles thermiques.', unlocks: ['geothermal'],
  },
  energy_grid: {
    id: 'energy_grid', branch: 'energie', name: 'Réseau énergétique', cost: 110, requires: ['geothermal_tap'],
    desc: 'Capacité de batterie doublée et pertes réduites.',
    effects: { storageMultiplier: { energy: 2 } },
  },
  fusion: {
    id: 'fusion', branch: 'energie', name: 'Fusion contrôlée', cost: 420, requires: ['energy_grid', 'atmospheric_engineering'],
    desc: 'Énergie quasi illimitée.', unlocks: ['fusion'],
  },

  /* --- ATMOSPHÈRE --------------------------------------------------- */
  greenhouse_gases: {
    id: 'greenhouse_gases', branch: 'atmosphere', name: 'Gaz à effet de serre', cost: 70, requires: [],
    desc: 'Synthèse d’halocarbures à fort pouvoir réchauffant.', unlocks: ['ghg_factory'],
  },
  polar_engineering: {
    id: 'polar_engineering', branch: 'atmosphere', name: 'Ingénierie polaire', cost: 140, requires: ['greenhouse_gases'],
    desc: 'Libère l’eau et le CO₂ piégés dans les calottes.', unlocks: ['polar_melter'],
  },
  atmospheric_engineering: {
    id: 'atmospheric_engineering', branch: 'atmosphere', name: 'Ingénierie atmosphérique', cost: 200, requires: ['polar_engineering'],
    desc: 'Dégazage industriel du régolithe.', unlocks: ['atmo_processor'],
  },
  carbon_capture: {
    id: 'carbon_capture', branch: 'atmosphere', name: 'Capture du carbone', cost: 320, requires: ['atmospheric_engineering'],
    desc: 'Conversion du CO₂ en oxygène respirable.', unlocks: ['o2_generator'],
  },
  climate_control: {
    id: 'climate_control', branch: 'atmosphere', name: 'Contrôle climatique', cost: 520, requires: ['carbon_capture'],
    desc: 'Amortit les emballements du climat.', unlocks: ['climate_stabilizer'],
  },

  /* --- BIOLOGIE ----------------------------------------------------- */
  exobiology: {
    id: 'exobiology', branch: 'biologie', name: 'Exobiologie', cost: 60, requires: [],
    desc: 'Analyse du potentiel biologique du sol. +1 science par station scientifique.',
    effects: { flatScience: 0.4 },
  },
  pioneer_organisms: {
    id: 'pioneer_organisms', branch: 'biologie', name: 'Organismes pionniers', cost: 150, requires: ['exobiology'],
    desc: 'Bactéries et lichens résistants au froid.', unlocks: ['biodome'],
  },
  forestation: {
    id: 'forestation', branch: 'biologie', name: 'Forestation', cost: 300, requires: ['pioneer_organisms'],
    desc: 'Végétation supérieure. La propagation naturelle double.',
    unlocks: ['seeder'], effects: { spreadMultiplier: 2 },
  },
  ecosystems: {
    id: 'ecosystems', branch: 'biologie', name: 'Écosystèmes complexes', cost: 560, requires: ['forestation'],
    desc: 'La biosphère devient auto-régulée : +50 % de croissance, stabilité renforcée.',
    effects: { growthMultiplier: 1.5, stabilityBonus: 0.012 },
  },

  /* --- ESPACE ------------------------------------------------------- */
  orbital_survey: {
    id: 'orbital_survey', branch: 'espace', name: 'Cartographie orbitale', cost: 45, requires: [],
    desc: 'Une sonde supplémentaire et scans 35 % plus rapides.',
    effects: { probes: 1, scanSpeed: 1.35 },
  },
  orbital_infrastructure: {
    id: 'orbital_infrastructure', branch: 'espace', name: 'Infrastructure orbitale', cost: 240, requires: ['orbital_survey'],
    desc: 'Assemblage de structures en orbite.', unlocks: ['orbital_mirror'],
  },
  colonization: {
    id: 'colonization', branch: 'espace', name: 'Programme de colonisation', cost: 400, requires: ['orbital_infrastructure', 'pioneer_organisms'],
    desc: 'Transport et implantation de populations humaines.', unlocks: ['colony'],
  },
  terraform_mastery: {
    id: 'terraform_mastery', branch: 'espace', name: 'Maîtrise de la terraformation', cost: 800, requires: ['colonization', 'climate_control', 'ecosystems'],
    desc: 'Tous les effets globaux des bâtiments sont augmentés de 30 %.',
    effects: { globalEffectMultiplier: 1.3 },
  },
};

export const TECH_LIST = Object.values(TECHNOLOGIES);

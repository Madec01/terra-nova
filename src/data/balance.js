/**
 * ============================================================================
 *  TERRA NOVA — TABLE D'ÉQUILIBRAGE CENTRALE
 * ============================================================================
 *  TOUTES les constantes de gameplay vivent ici. Aucun nombre magique ailleurs.
 *  Modifier ce fichier suffit pour ré-équilibrer entièrement le jeu.
 * ============================================================================
 */

export const BALANCE = {
  version: 1,

  /* --------------------------------------------------------------------- */
  /*  TEMPS                                                                */
  /* --------------------------------------------------------------------- */
  time: {
    /** Durée réelle (secondes) d'un tick de simulation à la vitesse x1. */
    tickSeconds: 0.25,
    /** Nombre de jours de jeu simulés par tick. */
    daysPerTick: 1,
    /** Vitesses sélectionnables. 0 = pause. */
    speeds: [0, 1, 2, 4],
    /** Nombre maximum de ticks rattrapés en une frame (anti spirale de la mort). */
    maxCatchUpTicks: 6,
    /** Période d'échantillonnage de l'historique, en jours. */
    historyEveryDays: 10,
    historyMaxPoints: 240,
  },

  /* --------------------------------------------------------------------- */
  /*  PLANÈTE                                                              */
  /* --------------------------------------------------------------------- */
  planet: {
    /** Subdivisions de l'icosphère : 3 → 642 régions, 4 → 2562 régions. */
    subdivisions: 3,
    /** Rayon visuel de la planète dans la scène. */
    radius: 1,
    /** Amplitude du relief (fraction du rayon). */
    reliefScale: 0.045,
    /** Niveau de mer, exprimé en altitude normalisée (-1..1). */
    seaLevel: -0.08,
    /** Fréquence de base du bruit continental. */
    continentFrequency: 1.35,
    mountainFrequency: 3.1,
    detailFrequency: 7.0,
    /** Nombre de régions révélées au départ (site d'atterrissage + voisines). */
    initialDiscovered: 7,
  },

  /* --------------------------------------------------------------------- */
  /*  ÉTAT INITIAL DE LA PARTIE                                            */
  /* --------------------------------------------------------------------- */
  start: {
    resources: { energy: 120, materials: 260, science: 0, biomass: 0, water: 40 },
    globals: {
      temperature: -52,      // °C moyenne planétaire
      pressure: 1.6,         // kPa
      oxygen: 0.2,           // % du volume atmosphérique
      co2: 91,               // % du volume atmosphérique
      waterCoverage: 0.01,   // fraction de surface en eau liquide
      biomass: 0,            // indice 0..100
      stability: 82,         // %
      insolation: 1.0,       // multiplicateur d'ensoleillement (miroirs orbitaux)
      population: 0,         // habitants (dérivé des colonies)
    },
    probes: 3,
  },

  /* --------------------------------------------------------------------- */
  /*  STOCKAGE DES RESSOURCES                                              */
  /* --------------------------------------------------------------------- */
  storage: {
    energy: 400,      // capacité de batterie de base
    materials: 1200,
    water: 600,
    /** Bonus de capacité par dépôt construit. */
    perDepot: { energy: 350, materials: 900, water: 500 },
    /** La science et la biomasse ne sont pas plafonnées. */
  },

  /* --------------------------------------------------------------------- */
  /*  ÉNERGIE                                                              */
  /* --------------------------------------------------------------------- */
  power: {
    /** Sous ce ratio production/consommation, les bâtiments tournent au ralenti. */
    brownoutFloor: 0.25,
    /** Vitesse de lissage de la satisfaction énergétique. */
    smoothing: 0.35,
  },

  /* --------------------------------------------------------------------- */
  /*  CLIMAT — modèle à équilibre radiatif simplifié                       */
  /* --------------------------------------------------------------------- */
  climate: {
    /** Température d'équilibre = base + solaire + effet de serre. */
    baseTemperature: -108,      // °C : planète nue, sans atmosphère
    solarGain: 78,              // °C apportés par l'étoile à albédo nul
    /** Albédo : réflexion de l'énergie stellaire. */
    albedoBase: 0.16,
    albedoIce: 0.46,            // contribution max de la couverture glaciaire
    albedoCloud: 0.20,          // contribution max de la couverture nuageuse
    albedoVegetation: -0.07,    // la végétation assombrit la surface
    albedoOcean: -0.05,
    /** Effet de serre : saturation logarithmique du CO₂ + effet de la pression. */
    greenhouseCO2: 34,          // °C max via le CO₂
    greenhouseCO2Half: 22,      // « demi-effet » atteint à ce % de CO₂ x pression
    greenhousePressure: 32,     // °C max via la pression totale
    greenhousePressureHalf: 40, // kPa pour la moitié de l'effet
    greenhouseVapor: 15,        // °C max via la vapeur d'eau (rétroaction)
    /** Inertie thermique : fraction de l'écart comblée par jour. */
    inertia: 0.0022,
    /** Amplitude du gradient latitudinal (équateur chaud / pôles froids). */
    latitudeSwing: 42,
    /** Refroidissement par kilomètre d'altitude équivalent (unité relief). */
    altitudeLapse: 55,
    /** Plafond de sécurité de l'ensoleillement (miroirs orbitaux). */
    maxInsolation: 2.0,
    /** Bruit climatique local (°C). */
    localVariance: 3.5,
  },

  /* --------------------------------------------------------------------- */
  /*  ATMOSPHÈRE                                                           */
  /* --------------------------------------------------------------------- */
  /*  L'atmosphère est modélisée en PRESSIONS PARTIELLES (kPa) : pCO2, pO2 et
   *  pInert. `pressure`, `co2` (%) et `oxygen` (%) en sont dérivés — voir
   *  src/sim/ClimateSystem.js. Toutes les valeurs ci-dessous sont donc en
   *  kPa/jour, jamais en points de pourcentage.                             */
  atmosphere: {
    /** Fuite atmosphérique : fraction perdue par jour, sur les TROIS réservoirs. */
    leak: 0.000045,
    /** Sublimation des calottes (glace carbonique) → réservoir de CO₂. */
    sublimationPressure: 0.0010,   // kPa/jour à fonte maximale
    /**
     * PHOTOSYNTHÈSE — c'est une CONVERSION CO₂ → O₂, en kPa/jour et par point
     * d'indice de biomasse (0..100), limitée par le CO₂ réellement disponible.
     * `oxygenPerBiomass` est volontairement INFÉRIEUR à `co2PerBiomass` : le
     * carbone part dans la biomasse (séquestration), il n'est pas rendu à
     * l'atmosphère. Conséquence de design : une biosphère mûre refroidit la
     * planète en mangeant son effet de serre — le joueur doit anticiper.
     */
    co2PerBiomass: 0.000055,
    oxygenPerBiomass: 0.000040,
    /** Plancher/plafond de sécurité sur la pression TOTALE (répartis au prorata). */
    minPressure: 0.2,
    maxPressure: 140,
    /**
     * Saturation du dégazage du régolithe : rendement plein tant que la
     * pression reste sous `degassingSoft`, nul au-delà de `degassingCeiling`.
     * C'est ce qui remplace l'ancien écrêtage brutal à 140 kPa : la pression
     * converge naturellement vers une valeur jouable au lieu de saturer.
     */
    degassingSoft: 40,
    degassingCeiling: 64,
    /**
     * Mêmes freins pour les deux autres réservoirs, exprimés sur la PRESSION
     * PARTIELLE concernée (kPa) :
     *  - les halocarbures se photodissocient d'autant plus vite que le CO₂ est
     *    abondant → l'effet de serre plafonne au lieu de s'emballer ;
     *  - le craquage du CO₂ travaille contre la contre-pression d'O₂ → la
     *    teneur en oxygène converge vers ~18–22 % au lieu de filer à 100 %.
     * Ces trois saturations donnent à l'atmosphère un ATTRACTEUR jouable
     * (≈ 70–85 kPa, ~20 % de CO₂, ~18 % d'O₂) sans le moindre écrêtage brutal.
     */
    co2Soft: 10,
    co2Ceiling: 19,
    o2Soft: 12,
    o2Ceiling: 22,
  },

  /* --------------------------------------------------------------------- */
  /*  HYDROSPHÈRE                                                          */
  /* --------------------------------------------------------------------- */
  water: {
    /** Température à laquelle la glace commence à fondre en surface. */
    meltPoint: -2,
    /** Vitesse de fonte / de gel (fraction par jour et par °C d'écart). */
    meltRate: 0.0025,
    freezeRate: 0.0035,
    /** L'eau liquide n'est stable qu'au-dessus de cette pression (kPa). */
    minPressureForLiquid: 6.1,
    /** Évaporation → humidité. */
    evaporation: 0.004,
    /** Diffusion de l'humidité vers les régions voisines. */
    moistureDiffusion: 0.06,
    /** Couverture d'eau maximale atteignable par région (bassins). */
    basinDepth: 0.35,
  },

  /* --------------------------------------------------------------------- */
  /*  BIOSPHÈRE                                                            */
  /* --------------------------------------------------------------------- */
  biosphere: {
    /** Conditions de croissance idéales. */
    idealTemp: 16,
    tempTolerance: 26,        // largeur de la cloche de tolérance (°C)
    minOxygenForGrowth: 0.0,  // les organismes pionniers n'en ont pas besoin
    minPressure: 8,
    minMoisture: 0.12,
    /** Vitesse de croissance de la végétation par jour dans une région idéale. */
    growthRate: 0.0060,
    /** Vitesse de dépérissement en conditions hostiles. */
    decayRate: 0.014,
    /** Propagation vers les régions voisines (fraction par jour). */
    spreadRate: 0.0030,
    /** Seuil de végétation à partir duquel une région essaime. */
    spreadThreshold: 0.25,
    /** Conversion végétation régionale → indice de biomasse global (0..100). */
    globalScale: 100,
    /** Pénalité de croissance due à la pollution. */
    pollutionPenalty: 1.4,
    /** Choc d'introduction : une biosphère implantée trop vite déstabilise. */
    shockThreshold: 0.9,      // points de biomasse globale gagnés par an au-delà desquels…
    shockStability: 6.0,      // …on perd ce nombre de points de stabilité par an
  },

  /* --------------------------------------------------------------------- */
  /*  STABILITÉ CLIMATIQUE                                                 */
  /* --------------------------------------------------------------------- */
  stability: {
    /** Récupération naturelle par jour. */
    recovery: 0.020,
    /** Pénalité pour variation rapide de température (par °C/an au-delà du seuil). */
    tempRateThreshold: 1.2,
    tempRatePenalty: 3.2,
    /** Pénalité pour variation rapide de pression (par kPa/an au-delà du seuil). */
    pressureRateThreshold: 1.6,
    pressureRatePenalty: 1.5,
    /** Pénalité de pollution globale. */
    pollutionPenalty: 9.0,
    /** Bonus apporté par la biomasse (écosystème tampon). */
    biomassBonus: 0.05,
    /** Bonus par stabilisateur climatique et par jour. */
    min: 0,
    max: 100,
    /** Sous ce seuil, événements négatifs plus fréquents et production réduite. */
    warnThreshold: 45,
    criticalThreshold: 25,
    /** Perte de production maximale quand la stabilité est nulle. */
    productionPenalty: 0.35,
  },

  /* --------------------------------------------------------------------- */
  /*  POLLUTION                                                            */
  /* --------------------------------------------------------------------- */
  pollution: {
    /** Dissipation naturelle par jour. */
    decay: 0.0026,
    /** Absorption supplémentaire par la végétation. */
    vegetationScrub: 0.010,
    /** Impact de la pollution locale sur la croissance et la population. */
    max: 1,
  },

  /* --------------------------------------------------------------------- */
  /*  COLONISATION                                                         */
  /* --------------------------------------------------------------------- */
  colony: {
    /** Habitabilité requise pour fonder une colonie (0..1). */
    minHabitability: 0.42,
    /** Population initiale et croissance. */
    seedPopulation: 400,
    growthRate: 0.0045,          // par jour, modulé par l'habitabilité
    capacityPerColony: 15000,
    /** Consommations par 1000 habitants et par jour (besoin BRUT). */
    upkeepPer1k: { energy: 1.6, water: 0.9, biomass: 0.55 },
    /** Productions par 1000 habitants et par jour. */
    outputPer1k: { science: 0.75, materials: 0.5 },
    /**
     * AUTOSUFFISANCE LOCALE — la cause de l'effondrement démographique était
     * là : une colonie était nourrie et abreuvée exclusivement par les stocks
     * planétaires, dont la production (bio-dômes, extracteurs) ne suivait pas
     * la croissance de la population. Résultat : famine permanente dès
     * ~20 000 habitants, puis extinction.
     *
     * Désormais une colonie exploite d'abord SA région :
     *  - `farmPer1k` : biomasse cultivée sur place par millier d'habitants et
     *    par jour, multipliée par la végétation locale. Sur une région verte,
     *    la colonie est excédentaire (1,25 × 0,7 > 0,55) ; sur un désert elle
     *    reste entièrement à la charge des stocks. La colonisation devient donc
     *    une récompense de la biosphère, pas une course parallèle.
     *  - `localWaterRelief` : fraction du besoin en eau couverte par l'eau
     *    libre et l'humidité de la région (lacs, nappes).
     */
    farmPer1k: { biomass: 1.25 },
    /* À 1, une colonie posée sur une région réellement humide (eau libre +
       humidité ≥ 1) est TOTALEMENT indépendante des stocks planétaires. C'est
       volontaire : le bon emplacement d'une colonie, c'est le bord d'un lac. */
    localWaterRelief: 1.0,
    /** Une famine fait chuter la population de ce taux par jour. */
    starvationRate: 0.008,
  },

  /* --------------------------------------------------------------------- */
  /*  HABITABILITÉ (indice composite affiché au joueur)                    */
  /* --------------------------------------------------------------------- */
  habitability: {
    /**
     * Les facteurs sont combinés en MOYENNE GÉOMÉTRIQUE pondérée, pas en somme :
     * la température, la pression et l'oxygène sont des nécessités, pas des
     * qualités échangeables. Un seul facteur nul rend la région inhabitable —
     * sinon une banquise à −42 °C atteignait le seuil de colonisation.
     */
    idealTemp: 15,
    tempTolerance: 24,
    minPressure: 30,
    idealPressure: 80,
    /**
     * Les habitats sont pressurisés : l'oxygène ATMOSPHÉRIQUE n'a pas besoin
     * d'être respirable pour qu'une colonie tienne, il doit seulement exister
     * en quantité exploitable. Avec l'ancien minOxygen = 12 %, aucune colonie
     * n'était constructible avant la toute fin de partie — la population
     * n'avait alors plus le temps d'atteindre l'objectif de victoire.
     */
    minOxygen: 5,
    idealOxygen: 18,
    weights: { temperature: 0.3, pressure: 0.22, oxygen: 0.22, water: 0.13, stability: 0.13 },
  },

  /* --------------------------------------------------------------------- */
  /*  EXPLORATION                                                          */
  /* --------------------------------------------------------------------- */
  exploration: {
    /** Durée d'un scan orbital, en jours. */
    scanDays: 14,
    /** Coût d'un scan. */
    scanCost: { energy: 25 },
    /** Nombre de scans simultanés par sonde. */
    scansPerProbe: 1,
    /** Science gagnée par région révélée. */
    sciencePerScan: 4,
    /** Probabilité qu'un scan révèle une anomalie exploitable. */
    anomalyScienceBonus: 30,
    /** Rayon de révélation : le scan révèle aussi les voisins avec cette proba. */
    neighborRevealChance: 0.35,
  },

  /* --------------------------------------------------------------------- */
  /*  RECHERCHE                                                            */
  /* --------------------------------------------------------------------- */
  research: {
    /**
     * Multiplicateur global du coût des technologies. À 1, l'arbre entier
     * tombait en cinq ans : la partie n'avait plus aucune progression et le
     * joueur disposait de tous les leviers avant même d'avoir un climat.
     */
    costScale: 12,
    /** Science produite passivement par la station de commandement. */
    baseScience: 0.35,
  },

  /* --------------------------------------------------------------------- */
  /*  ÉVÉNEMENTS                                                           */
  /* --------------------------------------------------------------------- */
  events: {
    /** Intervalle minimum entre deux événements, en jours. */
    minInterval: 90,
    /** Chance journalière de déclenchement une fois l'intervalle écoulé. */
    dailyChance: 0.014,
    /** Jours de grâce au début de la partie. */
    graceDays: 120,
    /** Multiplicateur de fréquence quand la stabilité est basse. */
    instabilityFactor: 2.2,
  },

  /* --------------------------------------------------------------------- */
  /*  CONDITIONS DE VICTOIRE                                               */
  /* --------------------------------------------------------------------- */
  victory: {
    temperature: { min: 0, max: 30 },
    pressure: { min: 60 },
    oxygen: { min: 16 },
    /* 0,18 et non 0,25 : la géométrie des bassins (BALANCE.water.basinDepth et
       la fraction de cellules sous le niveau de mer) plafonne la couverture
       atteignable autour de 22 %. L'ancienne cible était inatteignable. */
    waterCoverage: { min: 0.18 },
    biomass: { min: 45 },
    population: { min: 15000 },
    stability: { min: 75 },
    /** Toutes les conditions doivent tenir ce nombre de jours consécutifs. */
    sustainDays: 180,
  },

  /* --------------------------------------------------------------------- */
  /*  PHASES DE PROGRESSION (indicatif pour l'UI et le tutoriel)           */
  /* --------------------------------------------------------------------- */
  phases: [
    { id: 1, name: 'Reconnaissance', desc: 'Cartographier la surface et repérer les ressources.',
      goal: (s, ctx) => ctx.discoveredRatio >= 0.18 },
    { id: 2, name: 'Industrialisation', desc: 'Installer une chaîne de production autonome.',
      goal: (s) => s.buildings.length >= 8 },
    { id: 3, name: 'Terraformation', desc: 'Réchauffer la planète et épaissir son atmosphère.',
      goal: (s) => s.globals.temperature > -15 && s.globals.pressure > 18 },
    { id: 4, name: 'Biosphère', desc: 'Implanter et propager une vie autonome.',
      goal: (s) => s.globals.biomass >= 12 },
    { id: 5, name: 'Colonisation', desc: 'Accueillir une population humaine permanente.',
      goal: (s) => s.globals.population >= 5000 },
  ],

  /* --------------------------------------------------------------------- */
  /*  RENDU / PERFORMANCE                                                  */
  /* --------------------------------------------------------------------- */
  render: {
    maxPixelRatio: 2,
    cameraMinDistance: 1.35,
    cameraMaxDistance: 6.0,
    cameraStartDistance: 3.2,
    rotationDamping: 0.90,
    rotationSpeed: 0.0055,
    zoomSpeed: 0.0016,
    autoRotateSpeed: 0.008,
    /** Rafraîchissement des attributs de couleur : au maximum n fois par seconde. */
    dataRefreshHz: 12,
    starCount: 2600,
  },

  /* --------------------------------------------------------------------- */
  /*  SAUVEGARDE                                                           */
  /* --------------------------------------------------------------------- */
  save: {
    storageKey: 'terranova.save.v1',
    autosaveEveryDays: 365,
    maxSlots: 3,
  },
};

export default BALANCE;

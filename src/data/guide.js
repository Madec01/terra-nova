/**
 * TERRA NOVA — CONTENU DU MANUEL DE BORD.
 *
 * Ce fichier contient TOUT le texte du guide consultable en cours de partie.
 * `src/ui/Guide.js` ne fait que le mettre en page : il ne connaît aucune
 * chaîne de caractères et aucune valeur de gameplay.
 *
 * ---------------------------------------------------------------------------
 *  RÈGLE ABSOLUE : AUCUN NOMBRE DE GAMEPLAY N'EST ÉCRIT À LA MAIN.
 * ---------------------------------------------------------------------------
 *  Tous les seuils, coûts, productions et prérequis affichés sont LUS depuis
 *  `balance.js`, `buildings.js` et `technologies.js` au moment de l'import.
 *  Ré-équilibrer le jeu suffit donc à corriger le manuel : il ne peut pas
 *  mentir après coup. `tools/guide-check.mjs` vérifie cette propriété dans un
 *  vrai navigateur, en comparant l'affichage à `BALANCE`.
 *
 * ---------------------------------------------------------------------------
 *  FORME D'UNE SECTION
 * ---------------------------------------------------------------------------
 *  { id, icon, title, lead, blocks: [...] }
 *
 *  Types de blocs reconnus par Guide.js :
 *    { kind: 'p',      text }                        paragraphe
 *    { kind: 'steps',  items: [{ title, why, how }] } étapes numérotées
 *    { kind: 'defs',   items: [{ term, text }] }     liste de définitions
 *    { kind: 'keys',   groups: [{ title, rows }] }   commandes
 *    { kind: 'note',   text }                        encadré discret
 *    { kind: 'victory' } { kind: 'buildings' } { kind: 'tech' }
 *                                                    tableaux GÉNÉRÉS
 */
import { BALANCE } from './balance.js';
import { BUILDING_LIST, BUILDING_CATEGORIES } from './buildings.js';
import { TECH_LIST, TECH_BRANCHES, TECHNOLOGIES } from './technologies.js';

/* --------------------------------------------------------------------- */
/*  Typographie française                                                */
/* --------------------------------------------------------------------- */

/** Espace insécable, et espace fine insécable (avant : ; ! ?). */
const NB = ' ';
const NNB = ' ';

/** Signe moins typographique (U+2212), et non le trait d'union. */
const dec = (v, d = 1) => Number(v).toFixed(d).replace('-', '−');
/**
 * Nombre « propre » : on retire les zéros de fin, mais UNIQUEMENT après une
 * virgule décimale — sinon 100 deviendrait 1.
 */
const num = (v, d = 2) => {
  let s = dec(v, d);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
};
/** Pourcentage à partir d'une fraction 0..1. */
const pct = (v, d = 0) => dec(v * 100, d) + NB + '%';
/** Grand entier lisible : 35000 → « 35 000 ». */
const big = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NB);
/** Valeur par jour ramenée à l'année : les réservoirs se lisent à cette échelle. */
const perYear = (v) => v * 365;

export { NB, NNB };

/* --------------------------------------------------------------------- */
/*  1. LES HUIT CONDITIONS DE VICTOIRE — entièrement générées             */
/* --------------------------------------------------------------------- */

/**
 * Une entrée par condition, dans l'ordre du rapport de `VictorySystem`.
 *
 *   key      identifiant partagé avec `game.victoryReport()`
 *   target   texte de l'exigence, construit depuis BALANCE.victory
 *   nums     les mêmes valeurs, sous forme de nombres — c'est le CONTRAT
 *            vérifié par tools/guide-check.mjs
 *   value    lecture de la valeur courante dans `state.globals`
 *   raise    ce qui la fait monter
 *   lower    ce qui la fait baisser
 */
export function victoryEntries() {
  const V = BALANCE.victory;
  const A = BALANCE.atmosphere;
  const W = BALANCE.water;
  const B = BALANCE.biosphere;
  const S = BALANCE.stability;
  const C = BALANCE.colony;

  return [
    {
      key: 'temperature',
      label: 'Température moyenne',
      target: `${num(V.temperature.min)} à ${num(V.temperature.max)}${NB}°C`,
      nums: [V.temperature.min, V.temperature.max],
      unit: '°C', digits: 1,
      value: (g) => g.temperature,
      raise: `L’effet de serre du CO₂ (jusqu’à ${num(BALANCE.climate.greenhouseCO2)}${NB}°C) `
        + `et de la pression totale (jusqu’à ${num(BALANCE.climate.greenhousePressure)}${NB}°C), `
        + `les miroirs orbitaux, et la fonte des calottes — qui assombrit le sol et fait entrer plus de lumière.`,
      lower: `Démonter des miroirs orbitaux ou des usines à gaz (effet immédiat), `
        + `craquer le CO₂ en oxygène — ce qui retire l’effet de serre — et la photosynthèse, `
        + `qui séquestre le carbone dans la biomasse.`,
    },
    {
      key: 'pressure',
      label: 'Pression atmosphérique',
      target: `≥${NB}${num(V.pressure.min)}${NB}kPa`,
      nums: [V.pressure.min],
      unit: 'kPa', digits: 1,
      value: (g) => g.pressure,
      raise: `Les processeurs atmosphériques (gaz inertes), les usines à gaz, `
        + `la fonte polaire et la sublimation naturelle des calottes.`,
      lower: `La fuite atmosphérique, lente mais permanente. Surtout, le dégazage du régolithe `
        + `s’essouffle au-delà de ${num(A.degassingSoft)}${NB}kPa et s’annule à ${num(A.degassingCeiling)}${NB}kPa`
        + `${NNB}: passé ce seuil, ajouter des processeurs ne sert plus à rien.`,
    },
    {
      key: 'oxygen',
      label: 'Oxygène',
      target: `≥${NB}${num(V.oxygen.min)}${NB}%`,
      nums: [V.oxygen.min],
      unit: '%', digits: 2,
      value: (g) => g.oxygen,
      raise: `Les générateurs d’oxygène, qui craquent le CO₂, et la photosynthèse de la végétation `
        + `(${num(A.oxygenPerBiomass * B.globalScale, 4)}${NB}kPa par jour lorsque l’indice de biomasse `
        + `atteint son maximum de ${num(B.globalScale)}).`,
      lower: `C’est un POURCENTAGE${NNB}: épaissir l’atmosphère en gaz inertes fait baisser le taux `
        + `d’oxygène sans en retirer un gramme. Le craquage s’annule par ailleurs vers `
        + `${num(A.o2Ceiling)}${NB}kPa de pression partielle d’O₂.`,
    },
    {
      key: 'waterCoverage',
      label: 'Surface en eau liquide',
      target: `≥${NB}${num(V.waterCoverage.min * 100)}${NB}%`,
      nums: [V.waterCoverage.min * 100],
      unit: '%', digits: 1, scale: 100,
      value: (g) => g.waterCoverage * 100,
      raise: `Deux conditions simultanées${NNB}: une température supérieure à ${num(W.meltPoint)}${NB}°C `
        + `et une pression supérieure à ${num(W.minPressureForLiquid)}${NB}kPa. `
        + `Les stations de fonte polaire et les stations hydriques accélèrent la libération.`,
      lower: `Le gel dès que la région repasse sous ${num(W.meltPoint)}${NB}°C, et la perte de pression. `
        + `La couverture est plafonnée par la géométrie des bassins `
        + `(${pct(W.basinDepth)} d’une région au maximum)${NNB}: c’est la condition la plus dépendante du monde tiré.`,
    },
    {
      key: 'biomass',
      label: 'Biomasse',
      target: `≥${NB}${num(V.biomass.min)}`,
      nums: [V.biomass.min],
      unit: '', digits: 1,
      value: (g) => g.biomass,
      raise: `Les bio-dômes amorcent, les tours d’ensemencement propagent. La croissance est maximale `
        + `vers ${num(B.idealTemp)}${NB}°C (tolérance ±${num(B.tempTolerance)}${NB}°C), `
        + `au-dessus de ${num(B.minPressure)}${NB}kPa et de ${pct(B.minMoisture)} d’humidité.`,
      lower: `La pollution industrielle, le froid, la sécheresse. Une région mûre `
        + `(au-delà de ${pct(B.spreadThreshold)} de végétation) essaime seule${NNB}: mieux vaut soigner `
        + `quelques foyers que saupoudrer.`,
    },
    {
      key: 'population',
      label: 'Population',
      target: `≥${NB}${big(V.population.min)}${NB}hab.`,
      nums: [V.population.min],
      unit: 'hab.', digits: 0,
      value: (g) => g.population,
      raise: `Les colonies, qui exigent ${pct(C.minHabitability)} d’habitabilité locale. `
        + `Chacune démarre à ${big(C.seedPopulation)}${NB}habitants et peut en accueillir `
        + `${big(C.capacityPerColony)}. Posée sur une région verte et humide, elle se nourrit et s’abreuve seule.`,
      lower: `La famine, quand l’eau, l’énergie ou les vivres manquent${NNB}: la population fond alors de `
        + `${pct(C.starvationRate, 1)} par jour. Une colonie posée sur un désert reste à la charge des stocks planétaires.`,
    },
    {
      key: 'stability',
      label: 'Stabilité climatique',
      target: `≥${NB}${num(V.stability.min)}${NB}%`,
      nums: [V.stability.min],
      unit: '%', digits: 0,
      value: (g) => g.stability,
      raise: `La récupération naturelle (${num(S.recovery, 3)} point par jour), les stabilisateurs climatiques, `
        + `et la biomasse, qui sert de tampon.`,
      lower: `Les variations brutales${NNB}: au-delà de ${num(S.tempRateThreshold)}${NB}°C par an `
        + `ou de ${num(S.pressureRateThreshold)}${NB}kPa par an, la planète est pénalisée. `
        + `S’y ajoutent la pollution et le choc d’introduction de la biosphère `
        + `(plus de ${num(B.shockThreshold)} point de biomasse gagné par an coûte ${num(B.shockStability)} points de stabilité).`,
    },
    {
      key: 'drift',
      label: 'Dérive thermique',
      target: `≤${NB}${num(V.maxDrift.max)}${NB}°C/an`,
      nums: [V.maxDrift.max],
      unit: '°C/an', digits: 2, atMost: true,
      value: (g) => Math.abs(g.dTemperature || 0),
      raise: `Tout ce qui pousse encore le climat${NNB}: usines à gaz en service, miroirs orbitaux ajoutés, `
        + `calottes en train de fondre. Une planète qui chauffe vite échoue même si elle traverse la bonne fourchette.`,
      lower: `Couper les leviers de réchauffement une fois la cible atteinte et laisser la planète rejoindre `
        + `son équilibre${NNB}: l’inertie thermique comble ${pct(BALANCE.climate.inertia, 2)} de l’écart par jour. `
        + `Les stabilisateurs climatiques amortissent le reste.`,
    },
  ];
}

/** Nombre de jours pendant lesquels les huit conditions doivent tenir ensemble. */
export const SUSTAIN_DAYS = BALANCE.victory.sustainDays;

/* --------------------------------------------------------------------- */
/*  2. BÂTIMENTS — tableau généré depuis buildings.js                     */
/* --------------------------------------------------------------------- */

const RES_NAMES = {
  energy: 'énergie', materials: 'matériaux', science: 'science',
  biomass: 'biomasse', water: 'eau',
};

const LOCAL_NAMES = {
  pollution: 'pollution', heat: 'chaleur locale', vegetation: 'végétation',
  water: 'eau de surface', moisture: 'humidité', ice: 'glace',
};

const GLOBAL_NAMES = {
  co2: 'CO₂ ajouté', pressure: 'gaz inertes ajoutés', oxygen: 'CO₂ converti en O₂',
  temperature: 'température', stability: 'stabilité', insolation: 'ensoleillement',
};

/** « 3.2 énergie /j » : la valeur, la ressource, puis la cadence. */
function flowList(obj, suffix) {
  const out = [];
  for (const k in (obj || {})) {
    const v = obj[k];
    if (!v) continue;
    out.push({
      label: RES_NAMES[k] || k,
      value: num(v, 2),
      text: num(v, 2) + NB + (RES_NAMES[k] || k) + (suffix ? NB + suffix : ''),
    });
  }
  return out;
}

/** Conditions de placement, en clair. */
function requireList(def) {
  const r = def.requires || {};
  const out = [];
  if (r.tech) out.push('technologie' + NNB + ': ' + (TECHNOLOGIES[r.tech]?.name ?? r.tech));
  if (r.minerals != null) out.push('minerai ≥' + NB + pct(r.minerals));
  if (r.geothermal != null) out.push('géothermie ≥' + NB + pct(r.geothermal));
  if (r.ice != null) out.push('glace ≥' + NB + pct(r.ice));
  if (r.water != null) out.push('eau de surface ≥' + NB + pct(r.water));
  if (r.minTemp != null) out.push('température ≥' + NB + num(r.minTemp) + NB + '°C');
  if (r.maxTemp != null) out.push('température ≤' + NB + num(r.maxTemp) + NB + '°C');
  if (r.habitability != null) out.push('habitabilité ≥' + NB + pct(r.habitability));
  if (!out.length) out.push('aucune');
  return out;
}

/** Effets planétaires et régionaux, ramenés à une échelle lisible. */
function effectList(def) {
  const out = [];
  for (const k in (def.global || {})) {
    const v = def.global[k];
    if (!v) continue;
    const unit = (k === 'temperature') ? '°C/an' : (k === 'stability') ? 'pt/an' : 'kPa/an';
    out.push({
      label: GLOBAL_NAMES[k] || k,
      value: (v > 0 ? '+' : '−') + num(Math.abs(perYear(v)), 2) + NB + unit,
      up: v > 0,
    });
  }
  for (const k in (def.globalStatic || {})) {
    const v = def.globalStatic[k];
    if (!v) continue;
    out.push({
      label: (GLOBAL_NAMES[k] || k) + ' (niveau réversible)',
      value: (v > 0 ? '+' : '−') + num(Math.abs(v), 3),
      up: v > 0,
    });
  }
  for (const k in (def.local || {})) {
    const v = def.local[k];
    if (!v) continue;
    out.push({
      label: (LOCAL_NAMES[k] || k) + ' sur la région',
      value: (v > 0 ? '+' : '−') + num(Math.abs(v), 4) + NB + '/j',
      up: v > 0 && k !== 'pollution',
    });
  }
  if (def.spread) {
    out.push({
      label: 'végétation semée alentour',
      value: '+' + num(def.spread.vegetation, 4) + NB + '/j',
      up: true,
    });
  }
  if (def.storage) out.push({ label: 'capacité de stockage', value: 'augmentée', up: true });
  if (def.colony) out.push({ label: 'habitat humain', value: 'colonie', up: true });
  if (def.dampening) out.push({ label: 'amortissement du climat', value: num(def.dampening, 2), up: true });
  if (def.neighborBonus) {
    out.push({
      label: 'bonus aux ' + (def.neighborBonus.building === 'mine' ? 'mines' : def.neighborBonus.building) + ' voisines',
      value: '×' + num(def.neighborBonus.factor, 2), up: true,
    });
  }
  return out;
}

export function buildingEntries() {
  return BUILDING_LIST.map((def) => ({
    id: def.id,
    name: def.name,
    icon: def.icon,
    tier: def.tier,
    category: def.category,
    categoryName: BUILDING_CATEGORIES.find((c) => c.id === def.category)?.name || def.category,
    desc: def.desc || '',
    cost: flowList(def.cost, ''),
    upkeep: flowList(def.upkeep, 'par jour'),
    produces: flowList(def.produces, 'par jour'),
    requires: requireList(def),
    effects: effectList(def),
    limits: `${def.maxPerRegion ?? 1} par secteur · ${def.maxTotal ?? '∞'} sur la planète`,
  }));
}

/* --------------------------------------------------------------------- */
/*  3. TECHNOLOGIES — tableau généré depuis technologies.js               */
/* --------------------------------------------------------------------- */

function techEffectList(t) {
  const e = t.effects || {};
  const out = [];
  for (const k in (e.productionMultiplier || {})) {
    out.push(`production de ${RES_NAMES[k] || k} ×${num(e.productionMultiplier[k], 2)}`);
  }
  for (const k in (e.storageMultiplier || {})) {
    out.push(`stockage de ${RES_NAMES[k] || k} ×${num(e.storageMultiplier[k], 2)}`);
  }
  if (e.globalEffectMultiplier) out.push(`effets planétaires ×${num(e.globalEffectMultiplier, 2)}`);
  if (e.growthMultiplier) out.push(`croissance végétale ×${num(e.growthMultiplier, 2)}`);
  if (e.spreadMultiplier) out.push(`propagation végétale ×${num(e.spreadMultiplier, 2)}`);
  if (e.stabilityBonus) out.push(`stabilité +${num(e.stabilityBonus, 3)} par jour`);
  if (e.flatScience) out.push(`+${num(e.flatScience, 2)} science par station scientifique`);
  if (e.probes) out.push(`+${e.probes} sonde orbitale`);
  if (e.scanSpeed) out.push(`scans ×${num(e.scanSpeed, 2)} plus rapides`);
  if (e.minMineralOverride != null) out.push(`seuil de minerai des mines abaissé à ${pct(e.minMineralOverride)}`);
  return out;
}

export function techEntries() {
  const scale = BALANCE.research.costScale;
  return TECH_LIST.map((t) => ({
    id: t.id,
    name: t.name,
    branch: t.branch,
    branchName: TECH_BRANCHES.find((b) => b.id === t.branch)?.name || t.branch,
    branchIcon: TECH_BRANCHES.find((b) => b.id === t.branch)?.icon || '·',
    desc: t.desc || '',
    cost: big(t.cost * scale) + NB + 'points de science',
    requires: (t.requires || []).map((r) => TECHNOLOGIES[r]?.name ?? r),
    unlocks: (t.unlocks || []).map((u) => BUILDING_LIST.find((b) => b.id === u)?.name ?? u),
    effects: techEffectList(t),
  }));
}

/* --------------------------------------------------------------------- */
/*  4. LE MANUEL                                                          */
/* --------------------------------------------------------------------- */

const P = BALANCE.phases;
const EX = BALANCE.exploration;
const CL = BALANCE.climate;
const AT = BALANCE.atmosphere;
const WA = BALANCE.water;
const BI = BALANCE.biosphere;
const HA = BALANCE.habitability;
const RE = BALANCE.research;

export const GUIDE_SECTIONS = [
  /* ------------------------------------------------------------------ */
  {
    id: 'principe',
    icon: '◉',
    title: 'Le principe',
    lead: 'Ce que le jeu vous demande, en trois phrases.',
    open: true,
    blocks: [
      { kind: 'p', text: `Une planète morte tourne sous votre sonde de commandement. `
        + `Vous ne la pilotez pas directement${NNB}: vous posez des installations qui modifient `
        + `sa température, sa pression, son eau et sa vie, puis vous observez le système répondre.` },
      { kind: 'p', text: `La mission est réussie lorsque huit indicateurs planétaires se maintiennent `
        + `ENSEMBLE pendant ${SUSTAIN_DAYS}${NB}jours consécutifs. Perdre une seule condition remet `
        + `le compteur à zéro. Terraformer, ce n’est pas traverser la bonne fourchette${NNB}: c’est s’y arrêter.` },
      { kind: 'p', text: `La partie se lit en ${P.length}${NB}phases, affichées dans le panneau Planète. `
        + `Elles ne débloquent rien${NNB}: elles décrivent où vous en êtes.` },
      { kind: 'defs', items: P.map((ph) => ({ term: `${ph.id}. ${ph.name}`, text: ph.desc })) },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'habitable',
    icon: '⧗',
    title: 'Rendre une planète habitable',
    lead: 'L’enchaînement réel, et la raison de cet ordre.',
    open: true,
    blocks: [
      { kind: 'p', text: `Chaque étape ci-dessous rend la suivante POSSIBLE. Prises dans le désordre, `
        + `la plupart n’ont aucun effet mesurable — c’est la principale cause de partie bloquée.` },
      {
        kind: 'steps',
        items: [
          {
            title: 'Cartographier',
            why: `On ne construit que sur un secteur cartographié, et les bons sites sont rares. `
              + `Sans carte, vous ne choisissez pas vos emplacements${NNB}: vous subissez ceux que vous connaissez.`,
            how: `Un scan coûte ${num(EX.scanCost.energy)}${NB}énergie et ${num(EX.scanCost.materials)}${NB}matériaux, `
              + `dure ${num(EX.scanDays)}${NB}jours et révèle une ZONE — la cible, ses voisins directs, `
              + `et une partie du deuxième anneau. Vous disposez de ${BALANCE.start.probes}${NB}sondes au départ. `
              + `Inutile de tout scanner${NNB}: viser les anomalies (+${num(EX.anomalyScienceBonus)}${NB}science) `
              + `et les massifs minéralisés suffit.`,
          },
          {
            title: 'Produire de l’énergie',
            why: `Tout ce qui suit consomme de l’énergie en continu. En pénurie, les installations `
              + `tombent au ralenti — jusqu’à ${pct(BALANCE.power.brownoutFloor)} de leur rendement — `
              + `et la terraformation s’arrête sans prévenir.`,
            how: `Les champs solaires n’exigent aucune technologie mais faiblissent près des pôles et sous les nuages. `
              + `La géothermie, deux fois plus productive, n’existe que sur les failles actives. `
              + `Gardez toujours une marge${NNB}: une usine à gaz consomme à elle seule autant que plusieurs mines.`,
          },
          {
            title: 'Chercher',
            why: `La recherche donne son TEMPO à la partie. Le laboratoire ne mène qu’une technologie `
              + `à la fois, et changer d’avis coûte la moitié des points investis. C’est l’ordre choisi `
              + `qui décide de la forme de votre partie.`,
            how: `Une recherche absorbe ${pct(RE.focus)} de votre revenu de science${NNB}: le reste s’accumule `
              + `pour payer les coûts en science des bâtiments. Ordre conseillé${NNB}: gaz à effet de serre, `
              + `ingénierie polaire, ingénierie atmosphérique, organismes pionniers, capture du carbone, colonisation.`,
          },
          {
            title: 'Réchauffer',
            why: `Rien ne fond sous ${num(WA.meltPoint)}${NB}°C et rien ne pousse dans le froid. `
              + `La chaleur est la clé qui ouvre l’eau, puis la vie.`,
            how: `Les usines à gaz relâchent des halocarbures — c’est le levier le plus rapide. `
              + `Les miroirs orbitaux ajoutent de l’ensoleillement, jusqu’à ×${num(CL.maxInsolation)}. `
              + `Surveillez la dérive thermique dès maintenant${NNB}: elle est aussi une condition de victoire.`,
          },
          {
            title: 'Épaissir l’atmosphère',
            why: `La pression fait trois choses à la fois${NNB}: elle réchauffe `
              + `(jusqu’à ${num(CL.greenhousePressure)}${NB}°C), elle rend l’eau liquide stable `
              + `(au-delà de ${num(WA.minPressureForLiquid)}${NB}kPa) et elle conditionne l’habitabilité `
              + `(${num(HA.minPressure)}${NB}kPa minimum, ${num(HA.idealPressure)}${NB}kPa à l’optimum).`,
            how: `Les processeurs atmosphériques dégazent le régolithe et ajoutent des gaz INERTES${NNB}: `
              + `ils épaississent l’air sans toucher au rapport CO₂/O₂. Leur rendement s’effondre `
              + `entre ${num(AT.degassingSoft)} et ${num(AT.degassingCeiling)}${NB}kPa — au-delà, `
              + `en ajouter d’autres ne donne plus rien.`,
          },
          {
            title: 'Libérer l’eau',
            why: `L’eau liquide exige les DEUX conditions précédentes réunies${NNB}: `
              + `plus de ${num(WA.meltPoint)}${NB}°C et plus de ${num(WA.minPressureForLiquid)}${NB}kPa. `
              + `Poser des stations de fonte sur une planète à ${num(BALANCE.start.globals.pressure)}${NB}kPa `
              + `ne produit rien de durable.`,
            how: `Les stations de fonte polaire chauffent la calotte et libèrent l’eau et le CO₂ piégés. `
              + `Les stations hydriques alimentent vos stocks. L’humidité diffuse ensuite vers les régions voisines.`,
          },
          {
            title: 'Semer la vie',
            why: `La végétation a besoin d’eau, de douceur et d’un minimum de pression${NNB}: `
              + `${num(BI.minPressure)}${NB}kPa, ${pct(BI.minMoisture)} d’humidité, `
              + `et une température proche de ${num(BI.idealTemp)}${NB}°C. Semée trop tôt, elle dépérit `
              + `et vous avez payé pour rien.`,
            how: `Les bio-dômes AMORCENT un foyer, très fort, sur une seule région. `
              + `Les tours d’ensemencement PROPAGENT sur tout le voisinage. `
              + `Allez-y progressivement${NNB}: gagner plus de ${num(BI.shockThreshold)}${NB}point de biomasse `
              + `par an coûte ${num(BI.shockStability)}${NB}points de stabilité.`,
          },
          {
            title: 'Convertir le CO₂ en oxygène',
            why: `C’est l’étape la plus délicate, et elle vient EN DERNIER pour une raison précise${NNB}: `
              + `craquer le CO₂ retire l’effet de serre au moment même où l’air devient respirable. `
              + `La planète refroidit exactement quand vous la rendez habitable.`,
            how: `Les générateurs d’oxygène ne créent pas de matière${NNB}: ce qu’ils ajoutent à l’oxygène, `
              + `ils le retirent au CO₂. Compensez d’avance avec de la pression inerte et une biosphère mûre. `
              + `Le craquage s’annule vers ${num(AT.o2Ceiling)}${NB}kPa d’O₂${NNB}: l’atmosphère converge `
              + `d’elle-même vers une composition jouable.`,
          },
          {
            title: 'Coloniser',
            why: `La population est une condition de victoire, et elle met du temps à croître. `
              + `Une colonie fondée trop tard n’atteindra jamais l’objectif.`,
            how: `Une colonie exige `
              + `${pct(BUILDING_LIST.find((b) => b.colony)?.requires?.habitability ?? BALANCE.colony.minHabitability)} `
              + `d’habitabilité locale. Posez-la au BORD D’UN LAC, `
              + `sur une région verte${NNB}: elle s’y nourrit et s’y abreuve seule, alors qu’un désert la met `
              + `entièrement à la charge de vos stocks.`,
          },
          {
            title: 'Stabiliser',
            why: `Les huit conditions doivent tenir ENSEMBLE pendant ${SUSTAIN_DAYS}${NB}jours. `
              + `C’est la phase la plus tendue de la partie${NNB}: à ce stade, la plupart des défaites `
              + `viennent d’une dérive thermique qu’on n’a pas coupée à temps.`,
            how: `Démontez ce qui pousse encore le climat, posez des stabilisateurs climatiques, `
              + `laissez la pollution se dissiper. Puis attendez, en surveillant le compteur de maintien `
              + `dans le panneau Planète.`,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'victoire',
    icon: '★',
    title: 'Les huit conditions de victoire',
    lead: `Toutes ensemble, pendant ${SUSTAIN_DAYS}${NB}jours consécutifs.`,
    open: true,
    blocks: [
      { kind: 'p', text: `Perdre une seule condition remet le compteur de maintien à zéro. `
        + `Les valeurs ci-dessous sont lues dans la table d’équilibrage${NNB}: elles restent justes `
        + `après un ré-équilibrage.` },
      { kind: 'victory' },
      { kind: 'note', text: `La dérive thermique est la condition qui surprend le plus. `
        + `Une planète en pleine surchauffe traverse la bonne fourchette de température `
        + `assez lentement pour valider les autres conditions au passage — et échoue quand même.` },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'retroactions',
    icon: '⟳',
    title: 'Les rétroactions',
    lead: 'Le cœur du jeu : vous pilotez des systèmes couplés.',
    blocks: [
      { kind: 'p', text: `Aucun de ces enchaînements n’est déclenché par un bouton. `
        + `Ils naissent de la simulation, et ils se produiront que vous les ayez prévus ou non.` },
      {
        kind: 'defs',
        items: [
          {
            term: 'Glace → albédo → chaleur',
            text: `La glace renvoie la lumière (jusqu’à ${num(CL.albedoIce, 2)} d’albédo). `
              + `Elle fond, le sol nu apparaît, la planète absorbe davantage, elle chauffe, `
              + `donc il fond encore plus. C’est la rétroaction la plus puissante du jeu, `
              + `et elle est ACCÉLÉRANTE${NNB}: une fois lancée, elle travaille pour vous — puis contre vous.`,
          },
          {
            term: 'Vapeur d’eau → effet de serre',
            text: `L’eau libérée s’évapore et amplifie l’effet de serre `
              + `(jusqu’à ${num(CL.greenhouseVapor)}${NB}°C supplémentaires). Faire fondre les calottes `
              + `réchauffe donc deux fois${NNB}: par l’albédo, puis par la vapeur.`,
          },
          {
            term: 'Photosynthèse → refroidissement',
            text: `La végétation convertit le CO₂ en oxygène, mais elle en garde une part `
              + `dans sa biomasse${NNB}: le carbone est SÉQUESTRÉ, pas rendu. `
              + `Une biosphère mûre mange donc l’effet de serre de la planète et la refroidit. `
              + `C’est voulu${NNB}: il faut l’anticiper avant qu’elle n’arrive à maturité.`,
          },
          {
            term: 'Nuages → albédo',
            text: `L’évaporation forme des nuages, qui renvoient la lumière `
              + `(jusqu’à ${num(CL.albedoCloud, 2)} d’albédo) et diminuent le rendement des champs solaires. `
              + `Une planète humide est une planète moins ensoleillée.`,
          },
          {
            term: 'Biosphère trop rapide → effondrement',
            text: `Gagner plus de ${num(BI.shockThreshold)}${NB}point de biomasse par an coûte `
              + `${num(BI.shockStability)}${NB}points de stabilité par an. La stabilité chute, `
              + `les incidents se multiplient, la production baisse, la végétation dépérit. `
              + `Verdir vite est un piège${NNB}: verdir régulièrement est la bonne stratégie.`,
          },
          {
            term: 'Pollution → stabilité → production',
            text: `Mines, raffineries et usines à gaz polluent. La pollution ronge la stabilité `
              + `(jusqu’à ${num(BALANCE.stability.pollutionPenalty)}${NB}points), freine la végétation, `
              + `et sous ${num(BALANCE.stability.warnThreshold)}${NB}% de stabilité les événements négatifs `
              + `se multiplient et la production baisse. Seule la végétation nettoie vraiment `
              + `(${num(BALANCE.pollution.vegetationScrub, 3)} par jour).`,
          },
          {
            term: 'Colonies → biosphère → colonies',
            text: `Une colonie posée sur une région verte y cultive ses vivres et devient excédentaire. `
              + `Sur un désert, elle vide vos stocks et finit par mourir de faim. `
              + `La colonisation est une RÉCOMPENSE de la biosphère, pas une course parallèle.`,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'pieges',
    icon: '⚠',
    title: 'Pièges et rattrapages',
    lead: 'Ce qui se répare, et comment.',
    blocks: [
      {
        kind: 'defs',
        items: [
          {
            term: 'Surchauffer est réversible',
            text: `Les miroirs orbitaux ne s’accumulent pas${NNB}: ils fixent un NIVEAU d’ensoleillement `
              + `tant qu’ils sont actifs. En démonter un retire ses degrés dès le lendemain. `
              + `Démonter une usine à gaz arrête l’apport de CO₂ — le CO₂ déjà relâché, lui, reste. `
              + `Une démolition rend par ailleurs une partie des matériaux investis.`,
          },
          {
            term: 'Assécher le CO₂ refroidit',
            text: `Les générateurs d’oxygène retirent du CO₂ pour en faire de l’O₂. `
              + `Si l’effet de serre reposait sur ce CO₂, la température s’effondre. `
              + `Le remède${NNB}: monter la PRESSION INERTE (processeurs atmosphériques) avant de craquer, `
              + `pour que l’effet de serre ne dépende plus du seul CO₂.`,
          },
          {
            term: 'L’oxygène est un pourcentage',
            text: `${num(BALANCE.victory.oxygen.min)}${NB}% d’oxygène dans une atmosphère de `
              + `${num(BALANCE.victory.pressure.min)}${NB}kPa, ce n’est pas la même quantité de gaz que `
              + `${num(BALANCE.victory.oxygen.min)}${NB}% dans une atmosphère de 20${NB}kPa. `
              + `Ajouter des gaz inertes FAIT BAISSER le taux d’oxygène affiché sans en retirer un gramme. `
              + `Les deux conditions se poursuivent donc ensemble, jamais l’une après l’autre.`,
          },
          {
            term: 'La pression sature d’elle-même',
            text: `Le dégazage du régolithe s’essouffle à partir de ${num(AT.degassingSoft)}${NB}kPa `
              + `et s’annule à ${num(AT.degassingCeiling)}${NB}kPa. Si votre pression stagne, `
              + `ajouter des processeurs ne servira à rien${NNB}: il faut d’autres sources — fonte polaire, `
              + `sublimation des calottes, usines à gaz.`,
            },
          {
            term: 'Le stock plein est du gaspillage',
            text: `Ce qui dépasse la capacité est perdu. Les dépôts logistiques sont ce qui permet `
              + `d’ÉPARGNER${NNB}: sans eux, impossible de réunir les ${num(Math.max(...BUILDING_LIST.map((b) => b.cost?.materials || 0)))}${NB}matériaux `
              + `d’une mégastructure.`,
          },
          {
            term: 'Une seule recherche à la fois',
            text: `Abandonner une recherche en cours ne rend que ${pct(RE.refund)} des points investis. `
              + `Choisir l’ordre à l’avance vaut mieux que changer d’avis.`,
          },
          {
            term: 'La victoire ne ferme pas la partie',
            text: `Une fois la mission réussie, vous pouvez continuer à jouer librement${NNB}: `
              + `rien n’est verrouillé, la simulation continue.`,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'batiments',
    icon: '⌂',
    title: 'Les installations',
    lead: 'Coût, entretien, production, prérequis et effets.',
    blocks: [
      { kind: 'p', text: `Chaque installation est une mégastructure${NNB}: une seule par secteur, `
        + `quelques-unes par planète. Les effets planétaires sont ramenés à l’ANNÉE, `
        + `les productions et entretiens au JOUR.` },
      { kind: 'buildings' },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'technologies',
    icon: '⌬',
    title: 'Les technologies',
    lead: 'Coût, prérequis, ce que chacune ouvre.',
    blocks: [
      { kind: 'p', text: `Le coût est exprimé en points de science réellement dépensés `
        + `(coût de base × ${num(RE.costScale)}). La station de commandement produit `
        + `${num(RE.baseScience, 2)}${NB}science par jour même sans laboratoire.` },
      { kind: 'tech' },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'commandes',
    icon: '⌨',
    title: 'Les commandes',
    lead: 'Souris, clavier, tactile.',
    blocks: [
      {
        kind: 'keys',
        groups: [
          {
            title: 'La planète',
            rows: [
              ['Tourner le globe', 'glisser avec le bouton gauche', 'glisser à un doigt'],
              ['Zoomer', 'molette', 'pincer à deux doigts'],
              ['Sélectionner un secteur', 'clic gauche', 'appui'],
              ['Désélectionner', 'clic droit, ou Échap', 'appui à côté de la fiche'],
              ['Secteur voisin', 'flèches ↑ ↓ ← →', '—'],
              ['Action principale du secteur', 'Entrée', '—'],
            ],
          },
          {
            title: 'Construire',
            rows: [
              ['Poser un bâtiment', 'clic gauche sur le secteur', 'appui sur le secteur'],
              ['Enchaîner plusieurs poses', 'maintenir Maj en posant', '—'],
              ['Annuler la pose', 'clic droit, ou Échap', 'bouton « Annuler » du bandeau'],
            ],
          },
          {
            title: 'Panneaux',
            rows: [
              ['Construire', 'B', 'onglet ⌂'],
              ['Couches de visualisation', 'L', 'onglet ◈'],
              ['Couche suivante / précédente', 'C, Maj+C', '—'],
              ['Recherche', 'R', 'onglet ⌬'],
              ['Guide (ce manuel)', 'G, ou F1', 'onglet ✦'],
              ['Mode scan continu', 'S', 'panneau Planète'],
              ['Menu, sauvegardes', 'Échap', 'onglet ≡'],
              ['Panneau développeur', 'F2', '—'],
            ],
          },
          {
            title: 'Le temps',
            rows: [
              ['Pause / reprise', 'Espace', 'bouton ⏸'],
              ['Vitesses ×1 ×2 ×4', '1, 2, 3', 'boutons ×1 ×2 ×4'],
            ],
          },
        ],
      },
      { kind: 'note', text: `Au doigt, il n’y a pas de survol${NNB}: toute information disponible `
        + `en infobulle sur ordinateur — au premier rang la décomposition « pourquoi la température monte » — `
        + `s’ouvre par un appui sur l’indicateur concerné, en haut de l’écran.` },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'bac-a-sable',
    icon: '⌗',
    title: 'Le bac à sable',
    lead: 'Expérimenter sans conséquence.',
    blocks: [
      { kind: 'p', text: `Le bac à sable se choisit au démarrage d’une partie, `
        + `dans le menu principal. Il sert à comprendre${NNB}: essayer une stratégie, `
        + `voir ce que fait vraiment un bâtiment, provoquer une rétroaction pour l’observer.` },
      {
        kind: 'defs',
        items: [
          { term: 'Ressources illimitées', text: `Les réservoirs sont maintenus pleins à chaque jour simulé. `
            + `Vous ne manquerez jamais d’énergie, de matériaux, d’eau ni de science${NNB}: `
            + `les pannes de réseau ne s’y produisent donc pas.` },
          { term: 'Toutes les technologies acquises', text: `L’arbre entier est débloqué dès le premier jour. `
            + `Toutes les installations sont constructibles immédiatement.` },
          { term: 'Planète entièrement cartographiée', text: `Aucun scan n’est nécessaire${NNB}: `
            + `tous les secteurs sont visibles, avec leurs minerais, leur glace et leurs anomalies.` },
          { term: 'La simulation, elle, ne change pas', text: `Climat, biosphère, colonies et rétroactions `
            + `fonctionnent exactement comme en partie normale. Ce que vous observez ici est vrai ailleurs.` },
          { term: 'Ce n’est pas une vraie partie', text: `Un liseré et une pastille « BAC À SABLE » restent `
            + `visibles en permanence, la mention est enregistrée dans la sauvegarde, `
            + `et une réussite y est présentée comme un essai concluant — pas comme une victoire.` },
        ],
      },
      { kind: 'note', text: `À ne pas confondre avec le panneau développeur (touche F2), `
        + `qui est un outil technique de mise au point. Le bac à sable est un mode de jeu.` },
    ],
  },
];

export default GUIDE_SECTIONS;

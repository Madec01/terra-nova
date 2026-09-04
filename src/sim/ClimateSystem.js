/**
 * ClimateSystem — le cœur de la simulation.
 *
 * Modèle à équilibre radiatif « zéro dimension » enrichi d'une carte
 * régionale :
 *
 *   equilibre = base + etoile*insolation*(1-albedo) + effet_de_serre
 *   T        += (equilibre - T) * inertie * dt
 *
 * Trois rétroactions donnent au jeu sa dynamique :
 *  1. glace/albédo   : il fait chaud → la glace fond → l'albédo baisse →
 *                      il fait encore plus chaud (emballement froid→chaud) ;
 *  2. vapeur d'eau   : plus il fait chaud sur une planète humide, plus la
 *                      vapeur amplifie l'effet de serre (rétroaction positive
 *                      qui peut s'emballer) ;
 *  3. nuages         : l'humidité augmente l'albédo, seule rétroaction
 *                      négative naturelle du système.
 *
 * Tout est borné et lissé : aucune valeur ne doit pouvoir devenir NaN.
 *
 * ---------------------------------------------------------------------------
 *  MODÈLE ATMOSPHÉRIQUE — PRESSIONS PARTIELLES
 * ---------------------------------------------------------------------------
 *  L'atmosphère n'est PAS décrite par deux pourcentages indépendants (c'était
 *  le bug historique : `co2` et `oxygen` pouvaient valoir 100 % en même temps).
 *  Elle est décrite par trois réservoirs de gaz, en kPa, portés par
 *  `state.globals` (donc sauvegardés) :
 *
 *      pCO2   — dioxyde de carbone
 *      pO2    — dioxygène
 *      pInert — azote + argon (« gaz inertes »)
 *
 *  Tout le reste en est DÉRIVÉ, jamais modifié directement :
 *
 *      pressure = pCO2 + pO2 + pInert
 *      co2      = 100 * pCO2 / pressure
 *      oxygen   = 100 * pO2  / pressure
 *
 *  Par construction `co2 + oxygen <= 100` : une composition atmosphérique
 *  incohérente est devenue impossible à représenter.
 *
 *  Conséquences de game design voulues :
 *   - craquer du CO₂ en O₂ (générateur d'oxygène) DÉPLACE de la matière d'un
 *     réservoir à l'autre : rendre l'air respirable assèche l'effet de serre
 *     et refroidit la planète. C'est la tension centrale de la fin de partie ;
 *   - la photosynthèse séquestre le carbone dans la biomasse : elle retire
 *     plus de CO₂ qu'elle ne rend d'O₂, donc elle refroidit aussi ;
 *   - épaissir l'atmosphère (dégazage inerte) réchauffe sans toucher au
 *     rapport CO₂/O₂.
 */
import { BALANCE } from '../data/balance.js';
import { clamp, clamp01, smoothstep } from '../utils/math.js';

/* Constantes numériques (filtrage / classification), sans effet d'équilibrage :
   elles n'existent pas dans BALANCE et ne pilotent aucun coût de gameplay. */
/** Lissage des dérivées annuelles affichées par l'UI. */
const RATE_SMOOTH = 0.04;
/** Part de la température régionale ramenée vers la moyenne par l'océan. */
const OCEAN_TEMPERING = 0.5;
/** Amortissement maximal apporté par les stabilisateurs climatiques. */
const MAX_DAMPENING = 0.9;
/** Fraction d'eau qu'une région émergée peut retenir (lacs, marécages). */
const LAND_RETENTION = 0.08;
/** Profondeur sous le niveau de mer à partir de laquelle un bassin est « plein ». */
const BASIN_SLOPE = 0.25;

export class ClimateSystem {
  constructor(game) {
    this.game = game;
    this._count = -1;
    this._baseOffset = null;   // décalage thermique statique par région (°C)
    this._runoff = null;       // ruissellement temporaire (fraction d'eau)
    this._moist = null;        // tampon de diffusion de l'humidité
    this._prev = { t: 0, p: 0, o: 0, b: 0 };

    // Lignes de contribution réutilisées (aucune allocation par tick).
    this._rowsT = this._makeRows([
      'Fond spatial', 'Étoile', 'Miroirs orbitaux', 'Albédo glaciaire',
      'Nuages', 'Océans', 'Végétation', 'Effet de serre CO₂',
      'Pression atmosphérique', 'Vapeur d’eau', 'Chaleur industrielle',
    ], '°C');
    this._rowsP = this._makeRows([
      'Dégazage industriel', 'Sublimation des glaces', 'Séquestration biologique',
      'Fuite atmosphérique',
    ], 'kPa/an');
    this._rowsO = this._makeRows([
      'Photosynthèse', 'Craquage industriel du CO₂',
    ], 'kPa/an');
    this._rowsS = this._makeRows([
      'Récupération naturelle', 'Biomasse', 'Technologies', 'Installations',
      'Variation de température', 'Variation de pression', 'Pollution',
    ], 'pts/an');
  }

  _makeRows(labels, unit) {
    return labels.map((label) => ({ label, value: 0, unit }));
  }

  reset(ctx) {
    this._alloc(ctx);
    const g = ctx.state.globals;
    // Nouvelle partie OU sauvegarde antérieure au modèle en pressions
    // partielles : on reconstruit les trois réservoirs depuis
    // BALANCE.start.globals.pressure/co2/oxygen, qui restent la source de vérité.
    this._ensureAtmosphere(g);
    this._syncAtmosphere(g);
    this._prev.t = g.temperature;
    this._prev.p = g.pressure;
    this._prev.o = g.oxygen;
    this._prev.b = g.biomass;
  }

  /* =================================================================== */
  /*  ATMOSPHÈRE — réservoirs et dérivés                                 */
  /* =================================================================== */

  /**
   * Rétrocompatibilité : si les pressions partielles sont absentes (état
   * fraîchement créé par GameState, ou sauvegarde d'une version antérieure),
   * on les dérive de `pressure` / `co2` / `oxygen`, qui eux existent toujours.
   * L'inerte absorbe le reliquat (azote + argon).
   */
  _ensureAtmosphere(G) {
    if (Number.isFinite(G.pCO2) && Number.isFinite(G.pO2) && Number.isFinite(G.pInert)) return;
    const S = BALANCE.start.globals;
    const p = Number.isFinite(G.pressure) ? Math.max(0, G.pressure) : S.pressure;
    const co2 = Number.isFinite(G.co2) ? clamp(G.co2, 0, 100) : S.co2;
    const o2 = Number.isFinite(G.oxygen) ? clamp(G.oxygen, 0, 100) : S.oxygen;
    G.pCO2 = p * co2 / 100;
    G.pO2 = p * o2 / 100;
    G.pInert = Math.max(0, p - G.pCO2 - G.pO2);
  }

  /**
   * Recalcule les grandeurs DÉRIVÉES (`pressure`, `co2`, `oxygen`) à partir des
   * trois réservoirs, après avoir appliqué les bornes de sécurité.
   * Les bornes de BALANCE.atmosphere portent sur la pression TOTALE : on les
   * répartit proportionnellement pour ne jamais altérer la composition.
   */
  _syncAtmosphere(G) {
    const A = BALANCE.atmosphere;
    if (!Number.isFinite(G.pCO2) || G.pCO2 < 0) G.pCO2 = 0;
    if (!Number.isFinite(G.pO2) || G.pO2 < 0) G.pO2 = 0;
    if (!Number.isFinite(G.pInert) || G.pInert < 0) G.pInert = 0;

    let p = G.pCO2 + G.pO2 + G.pInert;
    if (!(p > 0)) {
      // Atmosphère intégralement perdue : on repose le plancher sur l'inerte.
      G.pCO2 = 0; G.pO2 = 0; G.pInert = A.minPressure;
      p = A.minPressure;
    } else if (p < A.minPressure || p > A.maxPressure) {
      const target = clamp(p, A.minPressure, A.maxPressure);
      const k = target / p;
      G.pCO2 *= k; G.pO2 *= k; G.pInert *= k;
      p = target;
    }
    G.pressure = p;
    G.co2 = 100 * G.pCO2 / p;
    G.oxygen = 100 * G.pO2 / p;
  }

  _alloc(ctx) {
    const R = ctx.regions;
    if (!R) return;
    if (R.count !== this._count) {
      this._count = R.count;
      this._baseOffset = new Float32Array(R.count);
      this._runoff = new Float32Array(R.count);
      this._moist = new Float32Array(R.count);
      this._buildStaticOffsets(R);
    }
  }

  /**
   * Précalcule la partie STATIQUE de la température régionale : gradient
   * latitudinal, altitude, géothermie et variance locale déterministe.
   * Recalculé uniquement quand la planète change → le tick reste O(count)
   * avec une seule lecture mémoire par région.
   */
  _buildStaticOffsets(R) {
    const C = BALANCE.climate;
    const seaLevel = BALANCE.planet.seaLevel;

    // Moyenne pondérée de sin²(lat) : centre le gradient pour que la moyenne
    // des températures régionales reste égale à la température globale.
    let sum = 0, w = 0;
    for (let i = 0; i < R.count; i++) {
      const lat = R.latitude[i];
      sum += lat * lat * R.area[i];
      w += R.area[i];
    }
    const meanLatSq = w > 0 ? sum / w : 1 / 3;

    for (let i = 0; i < R.count; i++) {
      const lat = R.latitude[i];
      const latTerm = C.latitudeSwing * (meanLatSq - lat * lat);
      const altTerm = -C.altitudeLapse * Math.max(0, R.elevation[i] - seaLevel);
      const geoTerm = C.localVariance * (R.geothermal ? R.geothermal[i] : 0);
      // Bruit déterministe reproductible (pas de RNG : dépend de l'index).
      const h = Math.sin(i * 12.9898) * 43758.5453;
      const noise = (h - Math.floor(h)) - 0.5;
      this._baseOffset[i] = latTerm + altTerm + geoTerm + noise * C.localVariance;
    }
  }

  /* =================================================================== */

  tick(ctx) {
    const { state, regions, acc, dt } = ctx;
    if (!regions) return;
    this._alloc(ctx);

    const G = state.globals;
    const C = BALANCE.climate;
    const A = BALANCE.atmosphere;

    this._ensureAtmosphere(G);

    /* --- 0. Ensoleillement : un NIVEAU, pas un taux --------------------- */
    // Les miroirs orbitaux déposent leur effet dans `acc.staticGlobal`, qui
    // est simplement la SOMME des miroirs actifs. L'ensoleillement est donc
    // recalculé de zéro à chaque tick : démonter un miroir refroidit
    // immédiatement, le levier est réversible et lisible.
    const staticIns = (acc.staticGlobal && acc.staticGlobal.insolation) || 0;
    G.insolation = clamp(1 + staticIns * ctx.tech.globalEffectMultiplier, 0, C.maxInsolation);

    /* --- 1. Effets planétaires des bâtiments ---------------------------- */
    // Sémantique (voir buildings.js) :
    //   global.co2      → kPa de CO₂ AJOUTÉS par jour (dégazage, halocarbures)
    //   global.pressure → kPa d'INERTES ajoutés par jour (dégazage du régolithe)
    //   global.oxygen   → kPa de CO₂ CONVERTIS en O₂ par jour (craquage)
    let cracked = 0, eaten = 0, released = 0;
    if (dt > 0) {
      G.pCO2 = Math.max(0, G.pCO2 + acc.global.co2 * dt);
      G.pInert = Math.max(0, G.pInert + acc.global.pressure * dt);

      // Craquage industriel : conversion STRICTE, rien n'est créé ni détruit.
      // Elle s'arrête d'elle-même quand il n'y a plus de CO₂ à craquer.
      const wanted = acc.global.oxygen * dt;
      cracked = wanted > 0 ? Math.min(wanted, G.pCO2) : 0;
      G.pCO2 -= cracked;
      G.pO2 += cracked;

      // Photosynthèse (la biomasse date du tick précédent) : conversion
      // CO₂ → O₂ elle aussi limitée par le CO₂ disponible. Le carbone étant
      // séquestré dans la biomasse, l'O₂ rendu est INFÉRIEUR au CO₂ consommé
      // (oxygenPerBiomass < co2PerBiomass) : la biosphère refroidit la planète.
      // Le rendement NET s'annule quand l'oxygène devient abondant : une
      // biosphère mûre respire et oxyde autant qu'elle photosynthétise. Sans
      // ce frein, le couple « usine à gaz → plante » était une pompe infinie
      // qui poussait la pression jusqu'à l'écrêtage.
      const bio = clamp(G.biomass, 0, BALANCE.biosphere.globalScale)
        * (1 - smoothstep(A.o2Soft, A.o2Ceiling, G.pO2));
      if (bio > 0) {
        eaten = Math.min(G.pCO2, A.co2PerBiomass * bio * dt);
        released = Math.min(eaten, A.oxygenPerBiomass * bio * dt);
        G.pCO2 -= eaten;
        G.pO2 += released;
      }

      /* --- 2. Fuite atmosphérique ---------------------------------------- */
      // Elle emporte les trois réservoirs dans les mêmes proportions.
      const keep = Math.max(0, 1 - A.leak * dt);
      G.pCO2 *= keep; G.pO2 *= keep; G.pInert *= keep;
    }
    this._syncAtmosphere(G);

    /* --- 3. Couvertures moyennes (pondérées par l'aire) ------------------ */
    let iceSum = 0, waterSum = 0, moistSum = 0, vegSum = 0, pollSum = 0, areaSum = 0;
    const basin = BALANCE.water.basinDepth;
    for (let i = 0; i < regions.count; i++) {
      const a = regions.area[i];
      areaSum += a;
      iceSum += regions.ice[i] * a;
      waterSum += clamp01(regions.water[i] / basin) * a;
      moistSum += regions.moisture[i] * a;
      vegSum += regions.vegetation[i] * a;
      pollSum += regions.pollution[i] * a;
    }
    const invArea = areaSum > 0 ? 1 / areaSum : 0;
    const iceCover = clamp01(iceSum * invArea);
    const waterCoverage = clamp01(waterSum * invArea);
    const meanMoisture = clamp01(moistSum * invArea);
    const vegCover = clamp01(vegSum * invArea);
    const meanPollution = clamp01(pollSum * invArea);

    // Les nuages ont besoin d'humidité ET d'une atmosphère pour exister.
    const cloudCover = clamp01(meanMoisture * (G.pressure / (G.pressure + C.greenhousePressureHalf)));

    G.iceCover = iceCover;
    G.waterCoverage = waterCoverage;
    G.cloudCover = cloudCover;
    G.meanPollution = meanPollution;

    /* --- 4. Albédo ------------------------------------------------------- */
    const albedoRaw = C.albedoBase
      + iceCover * C.albedoIce
      + cloudCover * C.albedoCloud
      + vegCover * C.albedoVegetation
      + waterCoverage * C.albedoOcean;
    const albedo = clamp(albedoRaw, 0.05, 0.85);
    // Facteur de conservation : garde la somme des contributions EXACTE même
    // quand l'albédo est écrêté.
    const spread = albedoRaw - C.albedoBase;
    const f = Math.abs(spread) > 1e-9 ? (albedo - C.albedoBase) / spread : 1;
    G.albedo = albedo;

    /* --- 5. Effet de serre ---------------------------------------------- */
    // C'est la MASSE de CO₂ qui compte, pas son pourcentage : `pCO2` EST déjà
    // la pression partielle en kPa, on la lit directement (saturation
    // logarithmique classique : les premiers kPa comptent beaucoup plus).
    const ghCO2 = C.greenhouseCO2 * (G.pCO2 / (G.pCO2 + C.greenhouseCO2Half));
    const ghPressure = C.greenhousePressure * (G.pressure / (G.pressure + C.greenhousePressureHalf));

    // Vapeur d'eau : nécessite de l'eau LIQUIDE (donc de la pression) et de la
    // chaleur. C'est la rétroaction positive qui peut emballer la planète.
    const liquid = G.pressure > BALANCE.water.minPressureForLiquid ? waterCoverage : 0;
    const warmth = clamp01((G.temperature - BALANCE.water.meltPoint) / BALANCE.biosphere.tempTolerance);
    const ghVapor = C.greenhouseVapor * liquid * warmth;

    /* --- 6. Équilibre et inertie ---------------------------------------- */
    const S = C.solarGain * G.insolation;
    // Chaleur industrielle : moyenne planétaire des dépôts locaux.
    const heat = acc.localHeat;
    let heatSum = 0;
    if (heat) for (let i = 0; i < regions.count; i++) heatSum += heat[i] * regions.area[i];
    const heatGlobal = heatSum * invArea;

    const equilibrium = C.baseTemperature + S * (1 - albedo) + ghCO2 + ghPressure + ghVapor + heatGlobal;
    G.equilibrium = equilibrium;

    if (dt > 0) {
      const damp = 1 - clamp(acc.dampening, 0, MAX_DAMPENING);
      const rate = clamp01(C.inertia * dt * damp);
      G.temperature += (equilibrium - G.temperature) * rate;
      G.temperature += acc.global.temperature * dt;
    }
    if (!Number.isFinite(G.temperature)) G.temperature = equilibrium;
    G.temperature = clamp(G.temperature, -300, 300);

    /* --- 7. Contributions lisibles --------------------------------------- */
    const rt = this._rowsT;
    rt[0].value = C.baseTemperature;
    rt[1].value = C.solarGain * (1 - C.albedoBase);
    rt[2].value = (S - C.solarGain) * (1 - C.albedoBase);
    rt[3].value = -S * iceCover * C.albedoIce * f;
    rt[4].value = -S * cloudCover * C.albedoCloud * f;
    rt[5].value = -S * waterCoverage * C.albedoOcean * f;
    rt[6].value = -S * vegCover * C.albedoVegetation * f;
    rt[7].value = ghCO2;
    rt[8].value = ghPressure;
    rt[9].value = ghVapor;
    rt[10].value = heatGlobal;
    const ct = state.contributions.temperature;
    ct.length = 0;
    for (let i = 0; i < rt.length; i++) if (Math.abs(rt[i].value) > 1e-4) ct.push(rt[i]);

    /* --- 9. Températures régionales (une seule passe) -------------------- */
    const base = this._baseOffset;
    const Tg = G.temperature;
    for (let i = 0; i < regions.count; i++) {
      let t = Tg + base[i];
      if (heat) t += heat[i];
      // L'eau libre tempère : forte inertie thermique.
      const w = clamp01(regions.water[i] / basin);
      if (w > 0) t += (Tg - t) * w * OCEAN_TEMPERING;
      regions.temperature[i] = t;
    }

    /* --- 10. Hydrologie -------------------------------------------------- */
    // La glace des calottes est majoritairement du CO₂ solide : ce qu'elle
    // sublime alimente donc le réservoir de CO₂ (rétroaction chaud → dégel →
    // plus d'effet de serre).
    const sublimated = this._hydrology(ctx, invArea);
    if (dt > 0 && sublimated > 0) {
      G.pCO2 += sublimated;
      this._syncAtmosphere(G);
    }

    /* --- 8. Dérivées annuelles ------------------------------------------ */
    if (dt > 0) {
      const yr = 365 / dt;
      const dT = (G.temperature - this._prev.t) * yr;
      const dP = (G.pressure - this._prev.p) * yr;
      const dO = (G.oxygen - this._prev.o) * yr;
      const dB = (G.biomass - this._prev.b) * yr;
      G.dTemperature += (dT - G.dTemperature) * RATE_SMOOTH;
      G.dPressure += (dP - G.dPressure) * RATE_SMOOTH;
      G.dOxygen += (dO - G.dOxygen) * RATE_SMOOTH;
      G.dBiomass += (dB - G.dBiomass) * RATE_SMOOTH;
      this._prev.t = G.temperature;
      this._prev.p = G.pressure;
      this._prev.o = G.oxygen;
      this._prev.b = G.biomass;
    }

    /* --- 11. Stabilité --------------------------------------------------- */
    const St = BALANCE.stability;
    const bioRatio = clamp01(G.biomass / BALANCE.biosphere.globalScale);
    const recovery = St.recovery;
    const bioBonus = St.biomassBonus * bioRatio;
    const techBonus = ctx.tech.stabilityBonus;
    const install = acc.global.stability;
    const tempPen = Math.max(0, Math.abs(G.dTemperature) - St.tempRateThreshold) * St.tempRatePenalty / 365;
    const pressPen = Math.max(0, Math.abs(G.dPressure) - St.pressureRateThreshold) * St.pressureRatePenalty / 365;
    const pollPen = St.pollutionPenalty * meanPollution / 365;

    if (dt > 0) {
      const delta = recovery + bioBonus + techBonus + install - tempPen - pressPen - pollPen;
      G.stability = clamp(G.stability + delta * dt, St.min, St.max);
    }
    if (!Number.isFinite(G.stability)) G.stability = St.max;

    const rs = this._rowsS;
    rs[0].value = recovery * 365;
    rs[1].value = bioBonus * 365;
    rs[2].value = techBonus * 365;
    rs[3].value = install * 365;
    rs[4].value = -tempPen * 365;
    rs[5].value = -pressPen * 365;
    rs[6].value = -pollPen * 365;
    const cs = state.contributions.stability;
    cs.length = 0;
    for (let i = 0; i < rs.length; i++) if (Math.abs(rs[i].value) > 1e-4) cs.push(rs[i]);

    // Bilan de PRESSION TOTALE : seuls comptent les termes qui ajoutent ou
    // retirent de la matière à l'atmosphère. Le craquage CO₂ → O₂ n'y figure
    // pas : il est neutre en pression (c'est une conversion).
    const rp = this._rowsP;
    const invDt = dt > 0 ? 1 / dt : 0;
    rp[0].value = (acc.global.pressure + acc.global.co2) * 365;
    rp[1].value = sublimated * invDt * 365;
    rp[2].value = -(eaten - released) * invDt * 365;   // carbone piégé dans le vivant
    rp[3].value = -G.pressure * A.leak * 365;
    const cp = state.contributions.pressure;
    cp.length = 0;
    for (let i = 0; i < rp.length; i++) if (Math.abs(rp[i].value) > 1e-4) cp.push(rp[i]);

    // Bilan d'OXYGÈNE, en kPa/an : les deux sources sont des conversions du CO₂.
    const ro = this._rowsO;
    ro[0].value = released * invDt * 365;
    ro[1].value = cracked * invDt * 365;
    const co = state.contributions.oxygen;
    co.length = 0;
    for (let i = 0; i < ro.length; i++) if (Math.abs(ro[i].value) > 1e-4) co.push(ro[i]);

    // La simulation vient de modifier largement la planète : le renderer se
    // charge lui-même du throttling (BALANCE.render.dataRefreshHz).
    if (dt > 0) this.game?.markAllDirty?.();
  }

  /* =================================================================== */
  /*  HYDROLOGIE                                                         */
  /* =================================================================== */

  /**
   * Fonte / gel, ruissellement vers les bassins, évaporation et diffusion de
   * l'humidité. Retourne le gain de pression par sublimation (kPa) pour ce pas.
   */
  _hydrology(ctx, invArea) {
    const { state, regions, dt } = ctx;
    const W = BALANCE.water;
    const G = state.globals;
    const seaLevel = BALANCE.planet.seaLevel;
    const runoff = this._runoff;
    const moist = this._moist;
    const count = regions.count;

    // L'eau liquide n'est stable qu'au-dessus d'une certaine pression :
    // en dessous, la glace se sublime directement en vapeur.
    const liquidOK = G.pressure > W.minPressureForLiquid;

    if (dt <= 0) {
      // dt === 0 : on se contente de recalculer les dérivés déjà faits plus haut.
      return 0;
    }

    runoff.fill(0);
    let meltTotal = 0, areaTotal = 0;

    for (let i = 0; i < count; i++) {
      const a = regions.area[i];
      areaTotal += a;
      const t = regions.temperature[i];
      let ice = regions.ice[i];
      let w = regions.water[i];
      let m = regions.moisture[i];

      if (t > W.meltPoint) {
        const melt = Math.min(ice, W.meltRate * (t - W.meltPoint) * dt);
        if (melt > 0) {
          ice -= melt;
          meltTotal += melt * a;
          if (liquidOK) {
            if (regions.elevation[i] < seaLevel) w += melt;
            else runoff[i] += melt;      // l'eau d'altitude ruisselle
          } else {
            m = clamp01(m + melt);        // sublimation directe
          }
        }
      } else {
        // Regel : l'eau libre redevient glace.
        const fr = Math.min(w, W.freezeRate * (W.meltPoint - t) * dt);
        if (fr > 0) { w -= fr; ice = clamp01(ice + fr); }
      }

      // Sans pression suffisante, l'eau de surface s'évapore et disparaît.
      if (!liquidOK && w > 0) {
        const boil = Math.min(w, W.evaporation * dt);
        w -= boil;
        m = clamp01(m + boil);
      }

      // Évaporation : l'humidité relaxe vers ce que la surface peut fournir.
      const warm = clamp01((t - W.meltPoint) / BALANCE.biosphere.tempTolerance);
      const supply = clamp01(w / W.basinDepth) * warm;
      m += (supply - m) * W.evaporation * dt;

      regions.ice[i] = clamp01(ice);
      regions.water[i] = Math.max(0, w);
      regions.moisture[i] = clamp01(m);
    }

    /* --- Ruissellement : une itération vers le voisin le plus bas -------- */
    for (let i = 0; i < count; i++) {
      let amount = runoff[i];
      // Débordement des bassins pleins.
      const cap = this._capacity(regions, i);
      const over = regions.water[i] - cap;
      if (over > 0) { regions.water[i] = cap; amount += over; }
      if (amount <= 0) continue;

      const neigh = regions.neighbors(i);
      let best = -1, bestElev = regions.elevation[i];
      for (let j = 0; j < neigh.length; j++) {
        const n = neigh[j];
        if (regions.elevation[n] < bestElev) { bestElev = regions.elevation[n]; best = n; }
      }
      const target = best >= 0 ? best : i;
      const tcap = this._capacity(regions, target);
      regions.water[target] = Math.min(tcap, regions.water[target] + amount);
    }

    /* --- Diffusion de l'humidité entre voisins --------------------------- */
    const k = clamp01(W.moistureDiffusion * dt);
    if (k > 0) {
      for (let i = 0; i < count; i++) {
        const neigh = regions.neighbors(i);
        let s = 0;
        for (let j = 0; j < neigh.length; j++) s += regions.moisture[neigh[j]];
        const avg = neigh.length > 0 ? s / neigh.length : regions.moisture[i];
        moist[i] = regions.moisture[i] + (avg - regions.moisture[i]) * k;
      }
      for (let i = 0; i < count; i++) regions.moisture[i] = clamp01(moist[i]);
    }

    /* --- Sublimation → pression ------------------------------------------ */
    // Intensité de fonte normalisée : 1 quand toute la planète fond à plein
    // régime. On libère alors BALANCE.atmosphere.sublimationPressure kPa/jour.
    const meanMelt = areaTotal > 0 ? (meltTotal / areaTotal) / dt : 0;
    const intensity = clamp01(meanMelt / W.meltRate);
    return BALANCE.atmosphere.sublimationPressure * intensity * dt;
  }

  /**
   * Capacité d'eau de surface d'une région. Une région émergée ne retient que
   * des lacs ; dès qu'on descend sous le niveau de mer, la cuvette se remplit
   * jusqu'à BALANCE.water.basinDepth (couverture totale de la cellule).
   */
  _capacity(regions, i) {
    const seaLevel = BALANCE.planet.seaLevel;
    const depth = smoothstep(seaLevel, seaLevel - BASIN_SLOPE, regions.elevation[i]);
    return BALANCE.water.basinDepth * (LAND_RETENTION + (1 - LAND_RETENTION) * depth);
  }
}

export default ClimateSystem;

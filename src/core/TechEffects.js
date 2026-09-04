/**
 * Agrège les effets passifs des technologies débloquées en un objet unique,
 * recalculé uniquement quand une technologie est acquise.
 */
import { TECHNOLOGIES } from '../data/technologies.js';

export function computeTechEffects(unlocked) {
  const eff = {
    productionMultiplier: { energy: 1, materials: 1, science: 1, biomass: 1, water: 1 },
    storageMultiplier: { energy: 1, materials: 1, water: 1 },
    globalEffectMultiplier: 1,
    growthMultiplier: 1,
    spreadMultiplier: 1,
    stabilityBonus: 0,
    flatScience: 0,
    probes: 0,
    scanSpeed: 1,
    minMineralOverride: null,
  };

  for (const id of unlocked) {
    const tech = TECHNOLOGIES[id];
    if (!tech || !tech.effects) continue;
    const e = tech.effects;
    if (e.productionMultiplier) for (const k in e.productionMultiplier) eff.productionMultiplier[k] *= e.productionMultiplier[k];
    if (e.storageMultiplier) for (const k in e.storageMultiplier) eff.storageMultiplier[k] *= e.storageMultiplier[k];
    if (e.globalEffectMultiplier) eff.globalEffectMultiplier *= e.globalEffectMultiplier;
    if (e.growthMultiplier) eff.growthMultiplier *= e.growthMultiplier;
    if (e.spreadMultiplier) eff.spreadMultiplier *= e.spreadMultiplier;
    if (e.stabilityBonus) eff.stabilityBonus += e.stabilityBonus;
    if (e.flatScience) eff.flatScience += e.flatScience;
    if (e.probes) eff.probes += e.probes;
    if (e.scanSpeed) eff.scanSpeed *= e.scanSpeed;
    if (e.minMineralOverride != null) {
      eff.minMineralOverride = eff.minMineralOverride == null
        ? e.minMineralOverride : Math.min(eff.minMineralOverride, e.minMineralOverride);
    }
  }
  return eff;
}

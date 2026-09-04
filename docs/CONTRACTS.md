# TERRA NOVA — Contrats d'API internes

Ce document fait autorité. Tout module doit s'y conformer.
Aucun module ne doit importer un fichier hors de son périmètre sans passer par ces contrats.

## 0. Règles générales

- ES modules, JavaScript moderne (ES2022), pas de TypeScript.
- Aucune valeur d'équilibrage en dur : tout vient de `src/data/balance.js` (import `BALANCE`).
- Aucun accès direct au DOM depuis `core/`, `planet/`, `sim/`.
- Aucun accès à Three.js hors de `src/render/`.
- Les systèmes de `sim/` sont purs vis-à-vis du rendu : ils modifient `state` et émettent des events.
- Langue : identifiants et commentaires de code en anglais **ou** français, mais les
  chaînes visibles par le joueur sont en **français**.

## 1. EventBus (`src/core/EventBus.js`)

```js
bus.on(name, fn) -> unsubscribe
bus.off(name, fn)
bus.emit(name, payload)
```

Événements standards (payload entre parenthèses) :

| nom | payload | émis par |
|---|---|---|
| `game:new` | `{ state }` | Game |
| `game:loaded` | `{ state }` | Game |
| `game:tick` | `{ state, dt, tickIndex }` | Game (chaque tick de simulation) |
| `game:frame` | `{ state, dtReal }` | Game (chaque frame de rendu) |
| `time:speed` | `{ speed }` | TimeManager |
| `region:selected` | `{ regionId \| null }` | Game |
| `region:discovered` | `{ regionId }` | ExplorationSystem |
| `region:changed` | `{ regionId }` | tout système modifiant une région (rendu à rafraîchir) |
| `building:placed` | `{ building }` | BuildingSystem |
| `building:removed` | `{ building }` | BuildingSystem |
| `research:started` | `{ techId }` | ResearchSystem |
| `research:completed` | `{ techId }` | ResearchSystem |
| `event:triggered` | `{ event }` | EventSystem |
| `notify` | `{ text, kind, icon }` kind: info/success/warn/danger | tous |
| `layer:changed` | `{ layer }` | UI |
| `scan:started` | `{ regionId, duration }` | ExplorationSystem |
| `victory` | `{ state }` | VictorySystem |
| `resources:changed` | `{}` | ResourceSystem (throttlé) |

## 2. RegionManager (`src/planet/RegionManager.js`)

Structure de données **SoA** (Struct of Arrays) pour la performance.
`count` régions, indices `0..count-1`. L'ID d'une région EST son index.

```js
class RegionManager {
  count            // int
  positions        // Float32Array(count*3) — centre de la cellule, sphère unité
  latitude         // Float32Array(count)  — -1 (pôle sud) .. 1 (pôle nord) = sin(lat)
  area             // Float32Array(count)  — aire relative, moyenne ~1

  // --- statiques (regénérés depuis la seed, NON sauvegardés) ---
  elevation        // Float32Array — -1..1 (0 = niveau de mer de référence)
  minerals         // Float32Array 0..1
  geothermal       // Float32Array 0..1
  iceInit          // Float32Array 0..1 (glace à la genèse)
  fertilityBase    // Float32Array 0..1 (potentiel biologique du sol)
  radiation        // Float32Array 0..1
  anomaly          // Uint8Array   0/1

  // --- dynamiques (sauvegardés) ---
  temperature      // Float32Array °C
  moisture         // Float32Array 0..1
  ice              // Float32Array 0..1
  water            // Float32Array 0..1 (eau liquide de surface)
  vegetation       // Float32Array 0..1
  pollution        // Float32Array 0..1
  population       // Float32Array (habitants)
  biome            // Uint8Array (index dans BIOMES)
  discovered       // Uint8Array 0/1
  buildingCount    // Uint8Array

  // --- dérivées (recalculées chaque tick, NON sauvegardées) ---
  habitability     // Float32Array 0..1
  energyPotential  // Float32Array 0..1 (pour la couche « énergie »)

  neighbors(i) -> Int32Array   // voisins de la cellule i (5 ou 6)
  cellCorners(i) -> Float32Array // sommets du polygone (n*3), ordre trigonométrique
  toJSON() / static fromJSON(json, generated)
  getRegionView(i) -> objet lisible { id, ...toutes les propriétés } (pour l'UI)
}
```

`Icosphere.js` expose :
```js
buildGoldberg(subdivisions) -> {
  count, positions, corners /* Float32Array plat */, cornerOffsets /* Int32Array count+1 */,
  neighbors /* Int32Array plat */, neighborOffsets /* Int32Array count+1 */,
  area, latitude
}
```

`PlanetGenerator.js` expose :
```js
generatePlanet({ seed, subdivisions, planetType }) -> RegionManager
```

## 3. État de jeu (`src/core/GameState.js`)

```js
state = {
  version, seed, planetType, createdAt,
  time: { day: 0, speed: 1 },        // speed ∈ {0,1,2,4}
  resources: { energy, materials, science, biomass, water },
  flux:      { energy, materials, science, biomass, water },  // dernier delta/jour calculé
  power:     { production, consumption, satisfaction /*0..1*/ },
  globals:   { temperature, pressure, oxygen, co2, waterCoverage, biomass, stability, insolation },
  contributions: { temperature: [{label, value}], pressure:[...], oxygen:[...], stability:[...] },
  buildings: [ { id, type, region, day, active, level } ],
  tech:      { unlocked:[techId], current: techId|null, progress: number },
  explore:   { probes, scanning: [ {region, remaining, total} ] },
  progress:  { phase: 1, victory: false, victoryAt: null, sustained: 0 },
  history:   { temperature:[], oxygen:[], biomass:[], pressure:[] },  // échantillonné
  log:       [ {day, text, kind} ],
}
```

## 4. Game (`src/core/Game.js`) — façade utilisée par l'UI

```js
game.state
game.regions              // RegionManager
game.bus                  // EventBus
game.newGame({seed, planetType})
game.save(slot) / game.load(slot) / game.deleteSave(slot) / game.listSaves()
game.setSpeed(s)
game.selectRegion(id|null) ; game.selectedRegion
game.canBuild(type, regionId) -> { ok:boolean, reason?:string }
game.build(type, regionId) -> boolean
game.demolish(buildingId) -> boolean
game.startResearch(techId) -> boolean
game.canResearch(techId) -> { ok, reason? }
game.scanRegion(regionId) -> boolean
game.availableBuildings() -> [buildingDef]  // débloqués par la recherche
game.victoryReport() -> [ { key, label, value, target, ok, format } ]
game.debug = { addResources(n), addScience(n), heat(n), addWater(n), addBiomass(n), revealAll() }
```

## 5. Renderer (`src/render/SceneManager.js`) — façade utilisée par Game/UI

```js
new SceneManager(canvas, bus)
scene.setPlanet(regions, state)     // (re)construit la planète
scene.setLayer(layerId)             // 'normal'|'temperature'|'water'|'resources'|'energy'|'biosphere'|'pollution'
scene.setSelected(regionId|null)
scene.setHovered(regionId|null)
scene.markRegionsDirty(idsOrNull)   // null = tout
scene.syncBuildings(state)          // reconstruit/anime les InstancedMesh
scene.pulse(regionId)               // feedback clic
scene.scanWave(regionId, duration)
scene.update(dtReal, state)         // appelé chaque frame
scene.resize()
scene.pick(clientX, clientY) -> regionId|null
scene.focusRegion(regionId)
scene.dispose()
scene.stats -> { fps, drawCalls, triangles }
```

## 6. UI (`src/ui/UIManager.js`)

```js
new UIManager(root /*HTMLElement*/, game, scene)
ui.mount()
ui.update(state)   // appelée à ~10 Hz, pas à chaque frame
ui.destroy()
```
L'UI ne modifie l'état que via les méthodes de `game`.

## 7. Données (`src/data/`)

- `balance.js` → `BALANCE` (toutes les constantes).
- `buildings.js` → `BUILDINGS` (objet id → def), `BUILDING_LIST`.
- `technologies.js` → `TECHNOLOGIES`, `TECH_LIST`, `TECH_BRANCHES`.
- `biomes.js` → `BIOMES` (tableau indexé), `BIOME_INDEX`.
- `events.js` → `GAME_EVENTS`.
- `layers.js` → `LAYERS`.

Définition d'un bâtiment :
```js
{
  id, name, desc, category, icon, tier,
  cost: { materials, energy, science },
  upkeep: { energy, water, materials },       // par jour
  produces: { energy, materials, science, biomass, water },  // par jour, base
  requires: { tech: 'id'|null, minerals: 0.2, geothermal: 0.4, ice: 0.3,
              maxTemp, minTemp, water: 0.1, habitability: 0.5, notBiome: [] },
  local: { pollution, heat, vegetation, water, moisture },   // par jour sur la région
  global: { co2, pressure, oxygen, temperature, stability, insolation }, // par jour
  maxPerRegion, maxTotal,
  outputScale(region, state) -> multiplicateur (optionnel, fonction pure)
}
```

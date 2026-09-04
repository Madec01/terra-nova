# TERRA NOVA

Jeu de **gestion, stratégie et terraformation** jouable dans le navigateur.
Le plateau de jeu est une **planète 3D procédurale** que l'on fait passer d'un
caillou gelé et mort à un monde habitable — et qui change à vue d'œil au fur et
à mesure de la partie.

## Lancer le jeu

```bash
cd terra-nova
npm install
npm run dev          # http://localhost:5173
```

Autres commandes :

```bash
npm run build        # build de production dans dist/
npm run preview      # sert le build
npm test             # tests unitaires (node --test)
npm run smoke        # scénario de jeu complet en navigateur headless
npm run smoke:shot   # idem + captures d'écran dans /tmp/terranova-shots
```

## Boucle de jeu

**Observer → analyser → décider → construire → attendre → constater → adapter.**

1. **Reconnaissance** — la planète est inconnue. Des sondes orbitales scannent
   les régions et révèlent minerais, glace, géothermie, anomalies.
2. **Industrialisation** — mines, champs solaires, géothermie, stations
   scientifiques : la chaîne de production démarre.
3. **Terraformation** — gaz à effet de serre, dégazage du régolithe, fonte
   polaire, miroirs orbitaux. La température et la pression montent.
4. **Biosphère** — bio-dômes puis ensemencement : la végétation apparaît, se
   propage, produit de l'oxygène et consomme du CO₂.
5. **Colonisation** — quand l'air devient respirable, les colonies s'installent.

Les systèmes **interagissent** : trop chauffer fait fondre les calottes, ce qui
baisse l'albédo, ce qui réchauffe encore (rétroaction glace-albédo) ; la vapeur
d'eau amplifie l'effet de serre ; une biosphère introduite trop vite s'effondre ;
la pollution industrielle freine la végétation et ronge la stabilité climatique.

## Contrôles

| Action | Souris / clavier | Tactile |
|---|---|---|
| Tourner la planète | glisser | glisser à un doigt |
| Zoomer | molette | pincer |
| Sélectionner une région | clic | tap |
| Pause / reprise | `Espace` | bouton ⏸ |
| Vitesses ×1 ×2 ×4 | `1` `2` `3` | boutons |
| Construire | `B` | icône ⛏ |
| Couches | `L` / `Tab` | icône ◈ |
| Recherche | `R` | icône ⌬ |
| Annuler / fermer | `Échap` | — |
| Panneau développeur | `F2` | — |

## Architecture

```
src/
  main.js              seul point où simulation, rendu et UI se rencontrent
  core/                Game (façade), TimeManager (pas fixe), SaveManager, EventBus
  planet/              Icosphere (Goldberg), PlanetGenerator (seed), RegionManager (SoA)
  sim/                 Building, Resource, Climate, Biome, Population,
                       Exploration, Research, Event, Victory
  render/              SceneManager, PlanetMesh + shaders, atmosphère, nuages,
                       étoiles, bâtiments (InstancedMesh), sélection, contrôles
  ui/                  UIManager et panneaux (vanilla DOM, zéro framework)
  data/                balance.js, buildings.js, technologies.js, biomes.js,
                       events.js, layers.js  ← tout l'équilibrage est ici
  utils/               bruit simplex, RNG déterministe, maths
```

Règles structurantes :

- **`src/data/balance.js` contient toutes les constantes de gameplay.** Aucun
  nombre magique ailleurs. Modifier ce seul fichier ré-équilibre le jeu.
- `core/`, `planet/` et `sim/` ne connaissent **ni Three.js ni le DOM** — ils
  tournent sous Node, donc ils sont testables unitairement.
- `render/` est la **seule** couche qui importe Three.js.
- `ui/` ne modifie jamais l'état directement : tout passe par la façade `Game`.
- Les contrats d'API entre couches sont figés dans [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Déterminisme

Chaque partie a une **seed**. Même seed = même planète, à l'identique. La
sauvegarde ne stocke donc que la seed plus les données réellement mutables
(températures, glace, végétation, bâtiments…), ce qui la garde très légère.

## Performance

- Une **seule** géométrie pour toute la planète (642 régions par défaut),
  attributs dynamiques mis à jour par plage plutôt que reconstruits.
- Un `InstancedMesh` par type de bâtiment.
- Boucle de rendu et boucle de simulation **séparées** : la simulation tourne à
  pas fixe, indépendamment du framerate.

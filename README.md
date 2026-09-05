# TERRA NOVA

Jeu de **gestion, stratégie et terraformation** jouable dans le navigateur.
Le plateau de jeu est une **planète 3D procédurale** que l'on fait passer d'un
caillou gelé et mort à un monde habitable — et qui change à vue d'œil au fur et
à mesure de la partie.

## Lancer le jeu

```bash
npm install
npm run dev          # http://localhost:5173
```

Aucun serveur, aucun backend : tout tourne dans le navigateur.

Autres commandes :

```bash
npm run build        # build de production dans dist/
npm run preview      # sert le build
npm test             # tests unitaires (node --test)
npm run boot         # contrôle de démarrage rapide (40 s) — le jeu se lance-t-il ?
npm run smoke        # scénario de jeu complet en navigateur headless
npm run mobile       # audit de jouabilité tactile sur trois profils d'écran
npm run pages        # le jeu est-il publiable ? (source brute ET build)
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

## Publication

Le jeu se publie de deux façons, et **les deux sont vérifiées** par
`npm run pages` :

- **Source brute.** GitHub Pages sert le dépôt tel quel. Cela fonctionne grâce
  à la table d'imports d'`index.html`, qui permet au navigateur de résoudre
  lui-même `import ... from 'three'`, et à `vendor/three.module.js` versionné
  dans le dépôt — donc sans CDN et sans dépendance extérieure.
- **Build de production.** Le workflow `.github/workflows/deploy.yml` construit
  le jeu à chaque push, lance les tests, et publie `dist/`. Plus léger et plus
  rapide à charger. Pour l'activer : *Settings → Pages → Source : GitHub
  Actions*.

Sans build, le navigateur charge une cinquantaine de modules séparés et une
bibliothèque non minifiée : c'est plus lent, mais cela marche immédiatement,
sans aucun réglage.

## Gagner

La planète doit tenir **huit conditions simultanément pendant 180 jours** :
température entre 0 et 30 °C, pression, oxygène, eau liquide, biomasse,
population, stabilité climatique — et surtout **une dérive thermique quasi
nulle**. Cette dernière condition est ce qui distingue la terraformation d'un
emballement : traverser la bonne fourchette en surchauffant ne suffit pas, il
faut y stabiliser le monde. Tout est réglable dans `BALANCE.victory`.

```bash
node tools/balance-probe.mjs                 # une partie jouée automatiquement, an par an
node tools/balance-probe.mjs --multi 6 70    # 6 seeds : la partie est-elle gagnable ?
node tools/balance-probe.mjs --bad 6 70      # joueur imprudent : doit majoritairement échouer
```

Mesures actuelles : joueur soigneux **6/6 victoires** entre l'an 22 et l'an 33 ;
joueur imprudent **1/6**, les autres finissant en surchauffe hors de la bande
habitable.

## Contrôles

| Action | Souris / clavier | Tactile |
|---|---|---|
| Tourner la planète | glisser | glisser à un doigt |
| Zoomer | molette | pincer à deux doigts |
| Sélectionner une région | clic | appui |
| Pause / reprise | `Espace` | bouton ⏸ |
| Vitesses ×1 ×2 ×4 | `1` `2` `3` | boutons |
| Construire | `B` | onglet ⛏ |
| Couches | `L` / `Tab` | onglet ◈ |
| Recherche | `R` | onglet ⌬ |
| Annuler / fermer | `Échap` | poignée de la feuille |
| Panneau développeur | `F2` | — |

### Téléphone et tablette

Le jeu est jouable au doigt seul. La planète reste l'élément principal : les
panneaux s'ouvrent en feuilles glissant depuis le bas, une seule à la fois.

Deux points méritent d'être connus, parce qu'ils ne vont pas de soi :

- **Il n'y a pas de survol au doigt.** Toute information qui n'existait qu'en
  infobulle — au premier rang la décomposition des contributions, « pourquoi la
  température monte » — dispose d'un équivalent accessible à l'appui. C'est un
  pilier du concept : le joueur doit pouvoir comprendre les conséquences de ses
  décisions, sur téléphone comme ailleurs.
- **Le cadrage de la caméra s'adapte à la forme de l'écran.** Le champ de vision
  vertical étant fixe, un écran en portrait a une ouverture horizontale bien plus
  étroite : sans compensation, la planète déborde des deux côtés. La distance de
  cadrage est calculée sur le plus petit des deux demi-angles et recalculée à
  chaque rotation de l'appareil.

Vérification : `node tools/mobile-check.mjs` audite trois profils (iPhone
390×844, Android 360×800, paysage 844×390) en contexte tactile réel — pas
seulement une fenêtre étroite — et signale débordements, cibles sous 44 px et
informations inaccessibles.

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
  audio/               AudioEngine (chaîne + réverbération), Sfx, Music, AudioManager
  data/                balance.js, buildings.js, technologies.js, biomes.js,
                       events.js, layers.js  ← tout l'équilibrage est ici
                       audio.js  ← toute la palette sonore et les morceaux
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

## Son

**Aucun fichier audio.** Tout est synthétisé par WebAudio au moment où on
l'entend : rien à télécharger, et une variété infinie — deux déclenchements du
même effet ne sont jamais strictement identiques.

La chaîne est la suivante :

```
source → enveloppe → filtre → [envoi réverb] → bus (musique | effets)
       → maître → compresseur → sortie
```

La **réverbération est une réponse impulsionnelle générée** — du bruit à
décroissance exponentielle, amorti progressivement dans l'aigu. C'est elle qui
retire l'essentiel du caractère « synthétique sec » : sans queue de salle, un
son paraît collé à l'oreille. Les autres règles tenues partout : jamais
d'attaque instantanée (elle fait « clic », c'est LA signature du son
numérique), sinus et triangle empilés en harmoniques choisies plutôt que carré
ou dents de scie, passe-bas systématique, léger désaccord entre les voix.

**Cinq morceaux d'ambiance génératifs**, un par phase de progression : de
*Poussière froide* (planète morte, presque immobile) à *Lanternes*
(colonisation, habité). Chacun a sa fondamentale, sa gamme, ses timbres et sa
densité. Un morceau n'est pas une boucle mais un bourdon continu, des nappes
tenues qui se croisent et des textures éparses — il ne se répète jamais à
l'identique et ne reste jamais figé. La musique suit l'état de la planète : la
bande-son est une récompense au même titre que la transformation visuelle.

Tout est programmé sur l'horloge de l'AudioContext, jamais avec `setTimeout` :
c'est ce qui permet de rendre et de **mesurer** la couche audio hors ligne.

```bash
npm run audio     # rend chaque son et chaque morceau dans un OfflineAudioContext
```

L'outil mesure crête, temps d'attaque, longueur de queue, part d'énergie
au-dessus de 5 kHz, centroïde spectral et variation temporelle. Personne ne peut
tester « c'est agréable » ; en revanche, ce qui rendait l'ancien son
désagréable est parfaitement mesurable. Les seuils sont dans
[`docs/AUDIO.md`](docs/AUDIO.md).

Toutes les valeurs — fréquences, enveloppes, gammes, définition des morceaux —
sont dans `src/data/audio.js`. Aucun nombre magique dans le moteur. Le jeu reste
jouable si WebAudio est indisponible : rien ne remonte au reste du code, et
aucun son ne démarre avant un geste du joueur (politique d'autoplay).

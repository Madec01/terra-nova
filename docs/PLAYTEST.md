# TERRA NOVA — Rapport de test de jouabilité

> Méthode : partie jouée **par l'interface réelle**, à la souris et au clavier,
> dans Chromium (build de production, `vite preview`), via `tools/playtest.mjs`.
> Aucune action n'est déclenchée depuis la console : chaque scan, chaque
> bâtiment, chaque recherche est le résultat d'un vrai clic sur un vrai bouton
> du DOM ou sur le canvas 3D. Deux exceptions, assumées et signalées :
> `scene.pick()` sert d'**œil** (savoir quel secteur est sous quel pixel avant
> de cliquer) et `game._tick()` sert d'**horloge** (accélérer la simulation).
> Compléments hors navigateur : `tools/balance-probe.mjs` et deux sondes
> d'ablation écrites pour ce rapport (résultats reproduits plus bas).
> Captures et mesures brutes : `/tmp/tn-playtest/` (`report.json`).

---

## 1. Verdict

**La simulation est excellente. Le jeu, lui, n'existe pas encore.**

Ce qui tourne sous le capot est remarquable : un modèle climatique en pressions
partielles, des rétroactions réelles (glace-albédo, vapeur d'eau, séquestration
du carbone par la biosphère), des saturations qui empêchent l'emballement, une
victoire qui exige de **stabiliser** et pas seulement de traverser la bonne
fourchette. Les six seeds testées se gagnent entre l'an 17 et l'an 32, le
joueur imprudent perd. C'est un vrai simulateur de terraformation, et il est
juste.

Mais entre ce modèle et le joueur, il n'y a presque pas de **jeu**. Gagner une
partie coûte, mesuré : **313 scans, 265 bâtiments, 19 recherches — environ 600
actions et 950 clics**, dont l'écrasante majorité ne comporte aucune décision.
Scanner le secteur 214 puis le secteur 215 puis le secteur 216 n'est pas un
choix : c'est une corvée administrative de plusieurs centaines de clics
imposée avant d'avoir le droit de jouer. Poser la quatorzième mine sur la
quatorzième région riche en minerai n'est pas un choix non plus.

Pendant ce temps, les vraies décisions — quand chauffer, de combien, quand
démonter les miroirs, quand lancer la biosphère — se comptent sur les doigts
de deux mains, et l'interface ne donne quasiment aucun moyen de les préparer :
la décomposition des indicateurs existe (bravo) mais elle est muette sur l'eau
et la biomasse, sans unités, et son total ne correspond pas à la valeur
affichée.

Enfin, l'économie de gestion est décorative passé le premier quart d'heure :
**le stock de matériaux est plein 92 % des jours de la partie** et la
satisfaction énergétique n'est dégradée que 2 % du temps. La seule vraie
rareté du jeu est l'énergie des toutes premières minutes (120 unités au départ,
25 par scan, aucune production tant qu'on n'a pas posé de champ solaire) — et
elle bride précisément l'activité la plus répétitive. Un jeu de gestion dont
la ressource principale déborde en permanence n'est pas un jeu de gestion.

Est-il intéressant à jouer, aujourd'hui, en l'état ? **Non — sauf pour qui
aime regarder une simulation converger.** Les vingt premières minutes sont de
la cartographie au clic ; les vingt suivantes de la pose de bâtiments au clic ;
les dix dernières une attente. La bonne nouvelle : *tous* les problèmes
recensés ci-dessous sont des problèmes d'interface, de densité d'action et
d'équilibrage — pas des problèmes de modèle. Le jeu qui manque est à quelques
jours de travail de celui qui existe.

---

## 2. Ce qui fonctionne, et qu'il ne faut surtout pas casser

1. **Le modèle climatique et ses rétroactions.** Chauffer fait fondre, fondre
   baisse l'albédo, ce qui réchauffe ; la biosphère mûre mange son propre
   effet de serre. Ces boucles se sentent en jouant. C'est le cœur du jeu.
2. **La condition de dérive thermique** (`victory.maxDrift`). Elle transforme
   « traverser 0–30 °C » en « y stabiliser un monde ». C'est l'idée de design
   la plus juste du projet.
3. **La réversibilité des miroirs orbitaux** (canal `globalStatic`). Démonter
   refroidit immédiatement : le joueur a un thermostat, pas un cliquet.
4. **Le mode placement persistant.** Une fois un type choisi dans le menu de
   construction, chaque clic supplémentaire sur la planète pose un bâtiment :
   **1 clic par bâtiment**, mesuré. C'est la seule affordance vraiment
   économe de l'interface — à répliquer partout ailleurs (voir BLOQUANT #2).
5. **Les messages de refus.** `canBuild` renvoie des raisons précises et
   chiffrées, affichées à la fois en notification et dans le bandeau du
   panneau de secteur : « Minerai insuffisant (17 % < 22 %) ». Modèle du
   genre. Le statut par carte du menu de construction (« Constructible sur le
   secteur 25 » / la raison du refus) est excellent.
6. **L'écran d'accueil** : lisible, complet, seed modifiable, cinq types de
   monde, sauvegardes visibles. Rien à y redire.
7. **Le panneau « Planète »** : les huit conditions, leur cible en infobulle,
   la barre de maintien 0/180 j et les sparklines. C'est le seul endroit où le
   joueur comprend où il en est. À mettre plus en avant, pas à retoucher.
8. **La stabilité du moteur** : 21 900 jours simulés par les sondes de ce
   rapport sans une seule valeur non finie ni ressource négative, et aucune
   erreur console pendant les sessions de jeu en navigateur.

---

## 3. Problèmes BLOQUANTS

### B1. L'exploration est une corvée de plusieurs centaines de clics

**Ce que le joueur vit.** Il commence avec 7 secteurs révélés sur 642 (1,1 %).
Presque tous les bâtiments sont limités à `maxPerRegion: 1` : pour en poser
265, il lui faut deux à trois cents secteurs cartographiés. Il doit donc
sélectionner un secteur inconnu (1 clic sur le globe), cliquer « Lancer un scan
orbital » (1 clic), attendre 14 jours, recommencer. Trois sondes en parallèle,
quatre après `orbital_survey`. Une partie gagnée = **313 scans lancés**, soit
**≈ 630 clics rien que pour la cartographie**, plus les rotations du globe
pour aller chercher les secteurs de l'autre hémisphère.
Aucune décision n'est prise pendant ces 630 clics : on scanne *tout*, parce
qu'on a besoin de *place*.

**Cause probable.** `src/sim/ExplorationSystem.js` : `startScan` prend un
secteur à la fois ; `src/ui/RegionPanel.js` : le seul point d'entrée du scan
est le bouton de la fiche d'un secteur, donc la sélection est obligatoire ;
`src/data/balance.js` : `planet.initialDiscovered = 7`,
`exploration.scansPerProbe = 1`, `neighborRevealChance = 0.35`
(mesuré : 2,03 secteurs révélés par scan).

**Corrections proposées** (par ordre d'efficacité) :
- **Mode « scan » persistant**, exactement comme le mode placement : on clique
  une fois sur l'outil, puis chaque clic sur un secteur inconnu met un scan en
  file. Coût : 1 clic par secteur au lieu de 2, et surtout plus de va-et-vient
  vers le panneau.
- **File d'attente de scans** : les sondes piochent automatiquement dans la
  file, le joueur n'a plus à revenir toutes les 14 journées.
- **Scanner une zone, pas une cellule** : une sonde couvre un secteur *et ses
  voisins* (`neighborRevealChance` → 1 sur le premier anneau). Le nombre de
  gestes est divisé par 4 sans toucher au rythme.
- Et/ou faire de la couverture orbitale une **technologie** : `orbital_survey`
  révèle une bande de latitude entière. La reconnaissance devient une décision
  (où investir mes sondes) au lieu d'un remplissage.

### B2. La pose de 265 bâtiments est un remplissage, pas une stratégie

**Ce que le joueur vit.** Le menu propose 16 bâtiments ; la partie de référence
en pose 265. Comme `maxPerRegion` vaut 1 presque partout, poser 16 mines, c'est
trouver 16 secteurs distincts au minerai ≥ 22 % — visuellement, en tournant le
globe, en couche « Ressources », un par un. Le mode placement persistant rend
le clic final peu coûteux (1 clic mesuré), mais la **recherche visuelle de la
cible** ne l'est pas, et elle recommence pour chacun des 16 types.

**Cause probable.** `src/data/buildings.js` (`maxPerRegion: 1` généralisé,
`maxTotal` élevés : 20 bio-dômes, 18 processeurs, 16 usines à gaz) combiné à
l'absence de tout outil de sélection dans `src/ui/BuildMenu.js` (pas de
surlignage des secteurs valides, pas de « meilleur emplacement », pas de
multi-sélection).

**Corrections proposées :**
- **Surligner sur le globe les secteurs valides** dès qu'un type est en main
  (le renderer sait déjà colorier par région : `scene.markRegionsDirty`).
  Un joueur qui voit ses 40 cibles clignoter ne cherche plus, il choisit.
- **Bouton « poser sur le meilleur secteur disponible »** dans la carte du
  menu : un clic, le jeu place et centre la caméra. Le joueur garde la main
  quand l'emplacement compte (colonies, bio-dômes) et délègue quand il ne
  compte pas (mines, solaire, dépôts).
- **Réduire les quantités** : diviser par deux les `maxTotal` et doubler les
  effets. 8 usines à gaz qui font le travail de 16, c'est le même climat pour
  moitié moins de clics — et chaque bâtiment redevient une décision.
- Autoriser des **niveaux** (`building.level` existe déjà dans l'état mais
  n'est jamais utilisé) : améliorer une mine sur place plutôt qu'en poser une
  quinzième ailleurs.

### B3. Les cinq premières minutes n'expliquent rien

**Ce que le joueur vit.** Après « Nouvelle partie », il a devant lui une sphère
sombre. Rien ne lui dit où sont ses 7 secteurs connus — **dans 2 parties sur 5
mesurées, la tache de départ est sur la face cachée** et il faut deviner qu'il
faut faire tourner le globe (jusqu'à 3 rotations mesurées, 25 s). Aucun
bâtiment n'est visible, aucune sonde, aucun site d'atterrissage. La barre du
bas annonce « Phase 1 · Reconnaissance » ; la description de la phase
(« Cartographier la surface ») n'est visible que si l'on pense à ouvrir le
panneau « Planète ». Aucune indication de la première action à faire.

**Cause probable.** `regions.landingSite` est calculé
(`src/planet/PlanetGenerator.js:482`) mais **n'est utilisé nulle part** : ni
par `SceneManager.setPlanet` (aucun cadrage caméra), ni par le `RegionPanel`
(aucun badge), ni par l'interface. `src/main.js` ne fait pas de
`scene.focusRegion(regions.landingSite)` sur `game:new`.

**Corrections proposées :**
- `scene.focusRegion(game.regions.landingSite)` au démarrage d'une partie
  (une ligne dans `main.js`, sur `game:new`). Coût nul, effet immédiat.
- **Poser un bâtiment de départ** — le « centre de commandement » que le
  journal mentionne (« Sonde de commandement en orbite ») — sur le site
  d'atterrissage, avec sa production de science de base. Le joueur voit
  quelque chose lui appartenir.
- **Un premier objectif explicite** dans le bandeau central : « Objectif :
  cartographier 3 secteurs · sélectionnez un secteur sombre puis lancez un
  scan ». Le composant `tn-banner` existe déjà et n'est utilisé que pour le
  mode placement.

---

## 4. Problèmes IMPORTANTS

### I1. Les infobulles de contribution n'expliquent pas ce qu'elles prétendent

`TopBar._indicatorTip` affiche les lignes de `state.contributions[…]` et un
« Total ». Trois défauts la rendent trompeuse plutôt qu'éclairante :

- **Les unités sont perdues.** Les lignes portent bien un champ `unit`
  (`ClimateSystem.js:77-92` : `°C`, `kPa/an`, `pts/an`) mais `TopBar.js` ne
  l'affiche pas : `formatSigned(c.value, 1)`, point. Dans l'infobulle Oxygène,
  la valeur d'en-tête est en **%** et les contributions en **kPa/an** — deux
  grandeurs différentes empilées sans le dire.
- **Le total ne dit pas ce qu'il semble dire.** Les contributions de
  température somment la température **d'équilibre** ; l'indicateur affiche la
  température **réelle**, qui converge vers elle à `climate.inertia` = 0,22 %
  de l'écart par jour. À l'équilibre les deux coïncident (relevé an 3 :
  indicateur −50,2 °C, Total −50,1 °C, tout va bien) — mais c'est justement
  quand le joueur agit que l'écart s'ouvre : poser huit miroirs déplace
  l'équilibre de +25 °C d'un coup alors que l'indicateur ne bougera que de
  ~0,05 °C par jour. Au moment le plus important, l'infobulle affiche un total
  que rien à l'écran ne confirme, et rien ne dit combien de temps il faudra
  pour l'atteindre.
- **Deux indicateurs n'ont aucune décomposition, par construction** :
  `waterCoverage` et `biomass` (pas de champ `contrib` dans `INDICATORS`, et
  aucun `state.contributions.water/biomass` produit par la simulation).
  Mesuré au survol : l'infobulle Température compte 19 lignes, Énergie 17,
  Stabilité 11, Pression 9 — mais Eau libre et Biomasse en comptent 5, soit
  l'en-tête, la variation et la phrase de description. Or « pourquoi ma
  biomasse stagne ? » est *la* question de la phase 4.

**Corrections :** afficher l'unité de chaque ligne ; renommer le total
« Équilibre visé » et ajouter une ligne « Écart comblé : x % par an » ;
produire `contributions.biomass` (croissance, dépérissement, pollution,
essaimage, choc d'introduction) et `contributions.water` (fonte, gel,
évaporation, ruissellement) dans `BiomeSystem` et `ClimateSystem`, sur le
modèle exact de ce qui est déjà fait pour la pression.

### I2. La barre supérieure est tronquée à 1280 px — l'indicateur de stabilité disparaît

**Mesuré** : à 1280×800, `.tn-topbar` demande **1356 px pour 1280 disponibles**
et l'indicateur **STB (stabilité) est coupé par le bord droit** (visible sur
`02-premier-regard.png`, `03-secteur-selectionne.png`, `layout-1280x800.png`).
C'est l'indicateur qui porte les alertes (`is-warn`, `is-danger`) et l'une des
huit conditions de victoire. À 1440 px et au-delà, tout rentre ; à 900 px, la
barre passe en deux rangées et tout est de nouveau lisible. **La seule taille
cassée est justement la plus courante pour un portable.**

**Cause.** `main.css:150` : `.tn-topbar` est un flex sans repli ; le
`overflow-x: auto` de secours n'est appliqué qu'en dessous de 900 px
(`main.css:333-341`). Entre 901 px et ~1400 px, les 11 cellules débordent
silencieusement.

**Correction :** appliquer `overflow-x: auto` (ou `flex-wrap: wrap`) à
`.tn-res`/`.tn-ind` à toutes les tailles, ou basculer en deux rangées dès
1400 px.

### I3. La recherche est une liste de courses, pas un arbre de décisions

`Game.startResearch` **achète** la technologie instantanément. Il n'y a ni
durée, ni file, ni coût d'opportunité : la science s'accumule, et tôt ou tard
on achète *tout* (19/19 dans toutes les parties mesurées). Les champs
`state.tech.current` et `state.tech.progress`, décrits dans
`docs/CONTRACTS.md`, ne sont **lus nulle part** — la notion de « recherche en
cours » est morte.

Conséquence : l'ordre de recherche est la seule décision, et elle est
verrouillée par les prérequis (les branches sont des chaînes linéaires).

**Corrections :** soit assumer l'achat instantané et **supprimer** les champs
morts ; soit — bien mieux — rendre la recherche progressive (une techno à la
fois, `progress += flux.science * dt`), ce qui recrée un vrai arbitrage
« j'accélère l'atmosphère ou la biologie ? » à chaque palier. Un bonus/malus
mutuellement exclusif par branche (une seule branche « maîtrisée ») donnerait
de la rejouabilité.

### I4. Quatre bâtiments et une branche technologique ne servent à rien

Ablation mesurée (même joueur, même seed, 60 ans, un type retiré à la fois) :

| Scénario | Victoire | An | Écart |
|---|---|---|---|
| référence | oui | 28,2 | — |
| **sans dépôt logistique** | oui | 28,1 | aucun |
| **sans raffinerie** | oui | 27,8 | aucun |
| **sans réacteur à fusion** | oui | 28,0 | aucun |
| **sans centrale géothermique** | oui | 29,5 | aucun (418 bâtiments au lieu de 263) |
| sans station de fonte polaire | oui | 32,1 | retard modéré |
| sans stabilisateur climatique | oui | 36,9 | retard net, stabilité 83 |
| **sans miroirs orbitaux** | non | — | −12 °C : perdu |
| **sans usines à gaz** | non | — | perdu |
| **sans tours d'ensemencement** | non | — | population insuffisante |
| sans mines ni raffineries | non | — | effondrement total |

Le dépôt, la raffinerie, la fusion et la géothermie sont donc **du décor** :
retirés du jeu, la partie se gagne à la même date. La raison est la même pour
tous : ils optimisent des ressources qui ne manquent jamais (voir I5). La
branche « Industrie » entière (métallurgie → automatisation → forage profond)
n'a d'effet mesurable sur rien.

**Correction :** ne pas les supprimer, mais leur donner une contrainte à
résoudre — voir I5. Sans rareté, aucun bâtiment de production ne peut compter.

### I5. L'économie ne contraint jamais rien

Mesuré sur la partie de référence : **le stock de matériaux est à son plafond
92 % des journées** (la production est donc jetée), et la satisfaction
énergétique tombe sous 95 % pendant **2 %** des journées seulement. Le joueur
n'attend jamais d'avoir de quoi construire ; il n'arbitre jamais entre deux
achats. La seule ressource réellement limitante en début de partie est
l'énergie du **scan** (120 d'énergie initiale = 4 scans), et cette contrainte
disparaît dès le premier champ solaire.

**Cause.** `balance.js` : `storage.materials = 1200` avec 16 mines à
~2,4/jour × 1,25, contre un coût moyen de bâtiment de ~200 ; la production
excédentaire est écrêtée en silence.

**Corrections :** augmenter fortement les coûts des mégastructures
(processeurs, miroirs, générateurs d'O₂ : ×3) et/ou leur donner un **entretien
en matériaux**, pour que l'industrie doive suivre la terraformation ; afficher
le gaspillage (« stock plein : 14 matériaux/j perdus ») — l'infobulle le dit
déjà, mais seulement au survol.

### I6. Les objectifs de victoire sont dépassés d'un facteur 2 à 7

À la victoire de référence : 85 kPa pour 60 exigés, 27 % d'O₂ pour 16,
biomasse 76 pour 45, **population 105 021 pour 15 000 exigés**. Les huit
conditions ne se referment donc pas ensemble : la partie se gagne quand la
plus lente d'entre elles arrive, les autres étant validées depuis longtemps.
La tension de fin de partie annoncée (« stabiliser, pas traverser ») n'est
portée que par la dérive thermique.

**Correction :** relever les seuils (population 60 000, biomasse 60,
pression 75) *ou* — plus intéressant — resserrer la fourchette de température
(5–20 °C) et ajouter une condition « pas plus de X % de la surface polluée ».
La cible doit être une fenêtre étroite qu'on vise, pas un plancher qu'on
enjambe.

### I7. La moitié de la planète est illisible dans la vue par défaut

En couche « Normal », l'hémisphère non éclairé est **noir**. Comme le jeu
consiste à comparer des secteurs pour choisir où poser 265 bâtiments, la
moitié de la surface est inexploitable à tout instant : il faut tourner le
globe pour amener la cible dans la lumière, ou basculer en couche de données.
Sur les captures `02-premier-regard.png` et `09-infobulle-temperature.png`, on
distingue à peine les secteurs cartographiés du fond spatial.

**Correction :** relever le plancher d'éclairement de la face nocturne dans
`src/render/shaders/planet.glsl.js` (une lueur ambiante suffit), ou passer
automatiquement en éclairage plat dès qu'un mode placement/scan est actif.
*(Le rendu appartient à une autre équipe : à traiter avec elle.)*

### I8. Impossible de jouer sans souris

Il n'existe **aucun moyen de sélectionner un secteur au clavier** :
`UIManager._bindKeys` gère les panneaux, les vitesses et les couches, mais la
sélection passe exclusivement par `scene.onRegionClick`. Comme la totalité du
jeu consiste à désigner des secteurs, le clavier seul ne permet pas de jouer.
`Tab` est en outre détourné pour cycler les couches tant que le focus est
hors des panneaux (`UIManager._bindKeys`) : le premier `Tab` depuis la vue
change de couche au lieu d'entrer dans l'interface. Une fois le focus dans la
barre d'outils, la navigation clavier redevient normale (mesuré : focus sur
`tn-tool` après 8 `Tab`).

**Correction :** flèches = secteur voisin (le graphe de voisinage existe :
`regions.neighbors(i)`), `Entrée` = action principale du panneau,
`Maj+Tab`/`Tab` rendus à la navigation, cycle des couches sur une autre touche.

### I9. Une avalanche de notifications noie les informations importantes

Chaque secteur découvert produit **deux** notifications : celle émise par
`ExplorationSystem._reveal` (`bus.emit('notify', …)`) et celle que
`UIManager` construit en réaction à `region:discovered`
(`src/ui/UIManager.js`, `sub('region:discovered', …)`). Chaque bâtiment posé
en produit une (`Game.build`). Sur une partie : 313 scans → ~626 bulles,
plus 265 pour les bâtiments. La pile n'en affiche que 5, pendant 6 s : les
événements planétaires et les avertissements (« Stabilisation interrompue »,
famine, pénurie) passent au milieu de ce flot et disparaissent.

**Correction :** supprimer le doublon ; regrouper (« 4 secteurs
cartographiés ») ; réserver les bulles aux `warn`/`danger` et aux événements,
et router le reste vers le journal, qui est déjà là et sous-utilisé.

---

## 5. Problèmes de CONFORT

- **C1. Cliquer une carte de bâtiment verrouillée ne fait rien du tout.**
  `BuildMenu._card` : `if (card.classList.contains('is-locked')) return;`.
  Aucun message, aucun son. Le statut sous la carte indique bien « Requiert :
  Fusion contrôlée », mais un bouton qui ne réagit pas est perçu comme cassé.
  → Émettre la raison en notification, ou ouvrir l'arbre de recherche sur la
  techno manquante (ce serait même une excellente affordance).
- **C2. Le curseur de visée ne s'affiche pas là où l'on vise.**
  `main.css:120` met `cursor: crosshair` sur `.tn-ui`, qui est en
  `pointer-events: none` (`main.css:112`) : au-dessus de la planète, c'est le
  curseur du canvas qui s'applique. Le seul retour du mode placement est le
  bandeau du haut. → Mettre la règle sur le canvas.
- **C3. La planète tourne toute seule au bout de 4 s** d'inactivité
  (`OrbitControls.js:26`, `IDLE_BEFORE_AUTOROTATE`). Mesuré sur 134 clics
  visés : **8 cibles (6 %) avaient bougé** entre le repérage et le clic, d'une
  moyenne de 4 px — gênant sans être rédhibitoire tant qu'on clique vite, mais
  la cellule ne fait que ~25 px et une hésitation de quelques secondes suffit
  à sortir de la cible. → Suspendre l'auto-rotation dès qu'un secteur est
  sélectionné ou qu'un mode placement/scan est actif.
- **C4. Démolir coûte 4 gestes** (sélectionner le secteur, trouver la carte du
  bâtiment, cliquer ⨯, confirmer ✓) alors que démonter des miroirs est une
  action de pilotage courante en fin de partie. → Une commande « retirer un
  miroir » directement dans le panneau Planète, à côté du thermostat.
- **C5. Aucune vue d'ensemble de ses installations.** Impossible de savoir où
  sont ses 12 usines à gaz sans tourner le globe. → Une liste par type dans le
  panneau de construction, avec compteur `n/maxTotal` et clic pour centrer.
- **C6. La pile de notifications recouvre le panneau de secteur.**
  Mesuré à 1280×800 avec une fiche de secteur complète : `.tn-notifs` et
  `.tn-region` se chevauchent sur **300×291 px**, soit tout le bas du panneau —
  dont le bouton « Construire ici » et les boutons de démolition. Comme les
  bulles sont cliquables (`pointer-events: auto`, elles centrent la caméra),
  elles **volent les clics** destinés au panneau pendant six secondes. C'est le
  seul chevauchement relevé, mais il touche les deux commandes les plus
  utilisées. → Décaler la pile vers la gauche quand le panneau de secteur est
  ouvert, ou l'ancrer en bas au centre.
- **C7. Deux couches sur huit n'ont pas de légende** (`normal` et `energy`
  n'ont pas de `scale` dans `src/data/layers.js`) : le panneau affiche
  « Aucune échelle pour cette couche. » — l'aveu d'un trou.
- **C8. Les libellés de la barre d'outils sont tronqués** (« CONSTR… »,
  « RECHER… », « SAUVEG… ») dès 1280 px. Le rail fait 56 px pour des mots de
  10 caractères.
- **C9. La génération de la planète gèle la page** 1,1 à 7,4 s selon la charge
  (mesuré), sans aucun indicateur : l'écran de démarrage a déjà été retiré à
  ce stade. → Réafficher `#boot` (ou une barre) pendant `newGame`.
- **C10. Les événements ne sont que subis.** `GAME_EVENTS` applique un effet et
  affiche un texte ; le joueur n'a jamais de choix à faire. Un événement sur
  deux pourrait proposer une alternative (« évacuer le secteur / renforcer les
  structures »), ce qui les rendrait mémorables au lieu d'être du bruit.
- **C11. Une unité passe à la moulinette des majuscules** : le titre de
  l'infobulle Pression s'affiche « PRESSION 1.5 KPA » (`TopBar._indicatorTip`
  met le nom en majuscules, la règle CSS `text-transform` emporte l'unité avec).
  Relevé brut : `'PRESSION\n1.5 KPA\nVariation\n−0.02 kPa/an\nFuite
  atmosphérique\n−0.0\nTotal\n−0.0'` — on y voit aussi, en clair, les lignes
  de contribution sans unité décrites en I1.
- **C12. Le journal ne consigne pas les constructions ni les scans** (seuls
  les découvertes, recherches et événements y passent). C'est pourtant le
  seul endroit où retrouver ce qu'on a fait.

---

## 6. Mesures

### Coût en gestes des actions courantes (1280×800, mesuré par le harnais)

| Action | Clics | Détail |
|---|---|---|
| Démarrer une partie depuis l'accueil | 1 | + 1,1 à 7,4 s de gel |
| Sélectionner un secteur | 1 | + 0 à 3 rotations si le site de départ est caché |
| Scanner un secteur | **2** | sélection + « Lancer un scan orbital » |
| Construire le 1ᵉʳ bâtiment d'un type | **3** | outil ⛏ + carte + secteur |
| Construire les suivants (même type) | **1** | le mode placement persiste ✔ |
| Lancer une recherche | **2** | outil ⌬ (ou touche R) + carte |
| Changer de couche | **2** | outil ◈ + couche — ou **1 touche** (`Tab`) |
| Démolir un bâtiment | **4** | secteur + carte + ⨯ + ✓ |

### Coût d'une partie gagnée (seed 20260904, joueur soigneux)

| | |
|---|---|
| Victoire | an 28 (jour 10 210) |
| Scans lancés | **313** |
| Bâtiments construits | **265** |
| Recherches | **19** (soit 19/19) |
| Secteurs révélés | **642/642** |
| Total d'actions | ~600 |
| **Clics estimés** | **~950** |
| Temps réel à ×4 (vitesse maximale) | **10,6 min** |
| Temps réel à ×1 | 42,5 min |

→ Environ **1,5 clic par seconde pendant dix minutes** si l'on joue à la
vitesse maximale. La densité d'action est très élevée ; la densité de
*décision* est très faible.

### Partie réellement jouée par l'interface (extrait, 5 tours)

Le harnais a joué une partie complète au clic (recherche, scans, construction) :
**146 clics pour atteindre l'an 10,4** avec 24 bâtiments posés, 1 technologie
et 17 secteurs cartographiés au bout du premier tour — un rythme cohérent avec
l'estimation de ~950 clics pour une victoire à l'an 28.

Sur l'ensemble de la session : **190 clics, 43 touches, 2 glissers**, dont
**20 clics (10,5 %) sans aucun effet** (bouton désactivé faute d'énergie,
carte verrouillée, bouton disparu pendant la reconstruction d'un panneau).

### Temps avant la première décision intéressante

- Le premier bâtiment est constructible **immédiatement** (260 matériaux au
  départ), mais sans information : les secteurs connus n'ont pas encore été
  comparés.
- Les 120 unités d'énergie initiales financent **4 scans** (25 chacun) ;
  ensuite il faut un champ solaire. C'est la première vraie décision, elle
  arrive dans la première minute — mais rien ne l'annonce.
- La première **technologie** coûte 45 × 12 = **540 science** pour un revenu
  passif de 0,35/jour. Mesuré, en jouant normalement mais sans avoir deviné
  qu'il fallait des stations scientifiques : la première techno n'est payable
  qu'au **jour 1106 (an 3)**, soit 69 s de temps réel à ×4 et 277 s à ×1.
  Rien dans l'interface ne dit que la station scientifique est le levier.

### Mise en page (mesurée sur le DOM, panneaux construction + secteur ouverts)

| Taille | Chevauchements | Panneaux hors écran | Indicateurs coupés | Textes tronqués |
|---|---|---|---|---|
| 1280×800 | **1** : `.tn-notifs` × `.tn-region` (300×291 px) | aucun | **Stabilité** (barre : 1356 px pour 1280) | 13 |
| 900×700 | aucun | aucun | aucun (barre repliée en 2 rangées) | 16 |
| 1440×900 | aucun | aucun | aucun | 12 |
| 1920×1080 | aucun | aucun | aucun | 12 |

Bonne nouvelle : **aucun panneau ne sort de l'écran**, à aucune taille, et le
seul chevauchement est celui des notifications sur la fiche de secteur (C6).
Les troncatures restantes sont de deux familles :
- les libellés de la barre d'outils (« Construire » : 46 px dans 34 px) —
  présents à *toutes* les tailles ;
- les lignes d'effet des cartes de construction (« Entretien −6.5 énergie ·
  −0.60 matériaux /j » : 252 px dans 240 px à 900 px de large) — c'est
  l'information de coût, il ne faut pas la couper.

À 900×700, un autre problème apparaît, qui n'est pas une troncature : avec le
panneau de construction **et** la fiche de secteur ouverts, il ne reste
qu'environ **250 px de large de planète visible** entre les deux. Le joueur doit
fermer un panneau pour pouvoir cliquer sur le globe — donc perdre l'information
qu'il vient de lire.

### Santé technique

- **Aucune erreur console** sur la session complète (chargement, partie de
  10 ans jouée au clic, changements de couches, redimensionnements) ; les 404
  audio sont attendus et filtrés.
- Rendu logiciel SwiftShader : 4 à 8 i/s ; c'est le plancher du harnais, pas
  une mesure de performance réelle (sur GPU, `tools/smoke.mjs` mesure le
  budget de rendu).
- 21 900 jours simulés (60 ans × 6 scénarios d'ablation) sans valeur non finie
  ni ressource négative.

---

## 7. Ce que je corrigerais en trois heures, dans cet ordre

1. **(20 min) Cadrer la caméra sur le site d'atterrissage** au démarrage et
   afficher un badge « Site d'atterrissage » dans la fiche du secteur.
   `main.js` sur `game:new` → `scene.focusRegion(game.regions.landingSite)`.
   *Supprime le pire moment du jeu : les trente premières secondes.*
2. **(45 min) Mode « scan » persistant + file d'attente de sondes.**
   Un outil dans la barre, chaque clic sur un secteur inconnu empile un scan,
   les sondes se servent toutes seules. *Divise par deux à quatre le nombre de
   clics de la phase la plus longue.*
3. **(20 min) Surligner les secteurs valides pendant le placement.**
   `canBuild` est déjà pur et rapide ; il suffit d'un attribut de rendu.
   *Transforme la recherche visuelle en choix.*
4. **(15 min) Réparer la barre supérieure** (`overflow-x: auto` sur
   `.tn-res`/`.tn-ind` à toutes les tailles) et les libellés tronqués.
   *L'indicateur de stabilité redevient lisible.*
5. **(20 min) Dégonfler les notifications** : supprimer le doublon
   `region:discovered`, router les constructions vers le journal, ne garder en
   bulle que `warn`/`danger` et les événements — et décaler la pile pour
   qu'elle cesse de recouvrir le bas de la fiche de secteur (C6), qui porte
   « Construire ici » et les boutons de démolition.
6. **(30 min) Unités et honnêteté des infobulles** : afficher `unit` sur
   chaque ligne de contribution, renommer « Total » en « Équilibre visé »,
   ajouter la vitesse de convergence.
7. **(30 min) Suspendre l'auto-rotation** dès qu'un secteur est sélectionné ou
   qu'un mode est actif, et déplacer le `cursor: crosshair` sur le canvas.

Ensuite, dans l'ordre, pour que le jeu devienne un jeu : la recherche
progressive (I3), le resserrement des `maxTotal` avec des effets doublés (B2),
et une économie qui pique (I5). Ce sont trois changements de `balance.js` et
d'une centaine de lignes de code, pour un gain de densité de décision
considérable.

---

## 8. L'instrument

`tools/playtest.mjs` — build de production, `vite preview` sur port aléatoire,
Chromium (`/opt/pw-browsers/chromium`, SwiftShader). Il joue par le DOM et le
canvas, compte chaque clic, chaque touche et chaque glisser, mesure les coûts
par action, relève les messages de refus, le contenu des infobulles, la
jouabilité au clavier, les chevauchements et troncatures à 1280×800 et
900×700, et écrit `/tmp/tn-playtest/report.json` avec les captures d'écran.

```bash
node tools/playtest.mjs            # scénario complet
node tools/playtest.mjs --fast     # version courte
```

Les deux sondes d'ablation citées en I4 et I5 (retrait d'un type de bâtiment,
comptage des actions d'une partie gagnée) ont été écrites hors dépôt pour ce
rapport ; elles se reconstruisent en quelques lignes au-dessus de
`tools/balance-probe.mjs`, dont elles reprennent le joueur automatique.

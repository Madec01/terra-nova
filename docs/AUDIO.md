# Contrat de la couche audio

## Pourquoi ce document

Le son initial du jeu sonnait « numérique » : oscillateurs carrés et dents de
scie, attaques instantanées, aucune réverbération, aucune harmonique douce.
Ce document fige l'architecture qui le remplace, et surtout les **critères
mesurables** auxquels elle doit satisfaire — personne ne pouvant garantir
« c'est agréable » par un test, on mesure les causes objectives du désagrément.

## Architecture

```
src/audio/
  AudioEngine.js    chaîne maître, réverbération, bus musique / effets
  Sfx.js            synthèse des effets ponctuels
  Music.js          moteur de musique d'ambiance génératif
  AudioManager.js   façade historique (API inchangée pour main.js)
src/data/audio.js   définition des sons et des morceaux (aucune valeur en dur ailleurs)
```

## Chaîne de traitement

```
source → enveloppe → filtre → [envoi réverb] → bus (musique | effets) → maître → compresseur → sortie
```

La réverbération est une **réponse impulsionnelle générée** (bruit filtré à
décroissance exponentielle) : aucun fichier à télécharger, et c'est elle qui
retire l'essentiel du caractère « synthétique sec ».

## API

```js
new AudioEngine({ ctx, destination })   // ctx peut être un OfflineAudioContext
engine.ready                            // booléen
engine.playSfx(key, { volume, rate, when })   // programme à `when` (défaut : maintenant)
engine.music.start(trackId?)            // démarre ou change de morceau (fondu enchaîné)
engine.music.next()                     // morceau suivant
engine.music.stop()
engine.music.current                    // identifiant du morceau en cours
engine.setVolumes({ master, music, sfx })
engine.dispose()
```

`AudioManager` conserve son API publique : `unlock()`, `play(key)`,
`startAmbient()`, `stopAmbient()`, `setEnabled(v)`, `setVolume(v)`.
`main.js` ne doit pas avoir à changer.

**Contrainte essentielle** : le moteur doit pouvoir être instancié sur un
`OfflineAudioContext` pour être rendu et mesuré hors ligne. Aucun accès au DOM,
aucun `window.*` obligatoire dans `AudioEngine`, `Sfx` et `Music`.

Le moteur est exposé en `window.TERRA.AudioEngine` (la classe) pour l'outil de
mesure.

## Critères mesurables (vérifiés par `npm run audio`)

### Effets
| critère | seuil | pourquoi |
|---|---|---|
| crête | < 0,99 | pas d'écrêtage |
| attaque | ≥ 6 ms | une attaque instantanée fait « clic » : c'est LA signature du son numérique |
| queue | ≥ 120 ms | sans réverbération ni relâchement, un son paraît collé à l'oreille |
| énergie > 5 kHz | ≤ 12 % | l'aigu agressif est la seconde cause de fatigue |
| centroïde spectral | ≤ 4 000 Hz | mesure objective de la « brillance » |
| non silencieux | RMS > 0,0005 | un son inaudible n'est pas un son doux |

### Musique
| critère | seuil |
|---|---|
| au moins 4 morceaux distincts | — |
| crête | < 0,99 |
| centroïde spectral | ≤ 2 500 Hz (nappes chaudes, pas de scie) |
| évolution sur 20 s | l'énergie doit varier (≥ 8 % d'écart-type relatif) : une nappe figée n'est pas de la musique |
| morceaux distincts | leurs profils spectraux doivent différer |
| démarrage | fondu d'entrée ≥ 1 s, pas d'irruption |

Ces seuils sont des garde-fous contre des défauts objectifs. Ils ne garantissent
pas que le résultat est beau — seulement qu'il n'a pas les défauts qui rendaient
l'ancien son désagréable.

# Ressources audio

Ce dossier est volontairement vide.

`src/audio/AudioManager.js` tente de charger les fichiers ci-dessous ; s'ils sont
absents (cas par défaut), il **retombe silencieusement sur une synthèse WebAudio**
et le jeu fonctionne sans la moindre erreur.

Déposez simplement les fichiers pour remplacer les sons de synthèse :

| fichier | usage |
|---|---|
| `ui_click.mp3` | clic d'interface |
| `ui_select.mp3` | ouverture de panneau |
| `region.mp3` | sélection d'une région |
| `build.mp3` | construction |
| `scan.mp3` | scan orbital |
| `research.mp3` | technologie acquise |
| `discovery.mp3` | région révélée |
| `event.mp3` | événement planétaire |
| `error.mp3` | action refusée |
| `victory.mp3` | victoire |

Une nappe d'ambiance spatiale est également synthétisée en continu
(`AudioManager.startAmbient`).

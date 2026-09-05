# Ressources audio

Ce dossier est vide, et il le restera : **TERRA NOVA n'utilise aucun fichier
audio**. Effets et musique sont entièrement synthétisés par WebAudio au moment
où on les entend.

Ce n'est pas un pis-aller mais un choix : rien à télécharger, aucun décodage,
et deux déclenchements du même effet ne sont jamais strictement identiques.
Le chargement de fichiers a été retiré de `AudioManager` — y déposer des `.mp3`
n'aurait aucun effet.

Tout se règle ailleurs :

- `src/data/audio.js` — la palette d'effets et la définition des cinq morceaux ;
- `src/audio/AudioEngine.js` — la chaîne (réverbération, bus, compresseur) ;
- `src/audio/Sfx.js` et `src/audio/Music.js` — les deux générateurs ;
- `docs/AUDIO.md` — le contrat et les critères mesurables (`npm run audio`).

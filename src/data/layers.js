/** Couches de visualisation de la planète. L'index est envoyé au shader. */

export const LAYERS = [
  { id: 'normal',      index: 0, name: 'Normal',      icon: '◉', desc: 'Vue naturelle de la planète.' },
  { id: 'temperature', index: 1, name: 'Température',  icon: '🌡', desc: 'Bleu = froid, rouge = chaud.', scale: [
      { color: '#2b4c8c', label: '−80 °C' }, { color: '#4aa3c7', label: '−30 °C' },
      { color: '#e8e0a8', label: '0 °C' },  { color: '#e08a3c', label: '30 °C' }, { color: '#b03030', label: '60 °C' } ] },
  { id: 'water',       index: 2, name: 'Eau',          icon: '≋', desc: 'Glace, humidité et eau liquide.', scale: [
      { color: '#cfe6f5', label: 'Glace' }, { color: '#6b5a44', label: 'Sec' }, { color: '#1d6fa5', label: 'Eau libre' } ] },
  { id: 'resources',   index: 3, name: 'Ressources',   icon: '⛏', desc: 'Richesse minérale et géothermie.', scale: [
      { color: '#2a2a2a', label: 'Stérile' }, { color: '#c9a227', label: 'Minerai' }, { color: '#e05a2b', label: 'Géothermie' } ] },
  { id: 'energy',      index: 4, name: 'Énergie',      icon: '⚡', desc: 'Potentiel et production énergétiques.' },
  { id: 'biosphere',   index: 5, name: 'Biosphère',    icon: '❋', desc: 'Couverture végétale.', scale: [
      { color: '#3a3a3a', label: 'Stérile' }, { color: '#7fd08a', label: 'Pionnier' }, { color: '#146b28', label: 'Dense' } ] },
  { id: 'pollution',   index: 6, name: 'Pollution',    icon: '☣', desc: 'Contamination industrielle.', scale: [
      { color: '#243040', label: 'Propre' }, { color: '#a8622a', label: 'Modérée' }, { color: '#b1263a', label: 'Critique' } ] },
  { id: 'habitability',index: 7, name: 'Habitabilité', icon: '⌂', desc: 'Aptitude à accueillir une colonie.', scale: [
      { color: '#4a2030', label: 'Mortel' }, { color: '#8a7a30', label: 'Marginal' }, { color: '#4fd08a', label: 'Habitable' } ] },
];

export const LAYER_INDEX = Object.fromEntries(LAYERS.map((l) => [l.id, l.index]));
export const DEFAULT_LAYER = 'normal';

/**
 * ============================================================================
 *  TERRA NOVA — Shaders de la surface planétaire + nappe d'eau
 * ============================================================================
 *  Écrit en GLSL « style ShaderMaterial Three.js » : on utilise la syntaxe
 *  GLSL ES 1.0 (attribute / varying / gl_FragColor) que Three réécrit
 *  automatiquement en GLSL ES 3.0 pour WebGL2. Les dérivées (`fwidth`,
 *  `dFdx`) sont donc disponibles sans extension.
 *
 *  --- ENCODAGE DES ATTRIBUTS DYNAMIQUES (voir PlanetMesh.js) ---------------
 *   aData.x  température normalisée : (T°C + 120) / 200, clampée 0..1
 *   aData.y  humidité (moisture) 0..1
 *   aData.z  végétation 0..1
 *   aData.w  pollution 0..1
 *
 *   aInfo.x  index de biome (0..11, entier exact stocké en float)
 *   aInfo.y  pack6(glace, eau liquide NORMALISÉE 0..1)  — deux canaux 6 bits
 *   aInfo.z  révélation 0..1 (interpolée côté CPU pour une apparition douce)
 *   aInfo.w  pack6(minerais, géothermie)                — deux canaux 6 bits
 *
 *   aAux.x   densité de lumières nocturnes (population + bâtiments) 0..1
 *   aAux.y   habitabilité 0..1
 *   aAux.z   potentiel énergétique 0..1
 *   aAux.w   réservé (0)
 *
 *   aCenter  centre de la cellule (déplacé par le relief), espace objet
 *   aCell    identifiant de cellule (float)
 *   aEdge    0 au centre de la cellule, 1 sur le bord du polygone
 *
 *  pack6(a,b) = floor(a*63)*64 + floor(b*63)  →  entier 0..4095, exact en f32.
 *
 *  --- PRINCIPE ANTI-ALIASING ----------------------------------------------
 *  Tous les motifs procéduraux (grille des zones inexplorées, grain de
 *  surface, lumières de colonies) sont bornés par la taille du pixel à
 *  l'écran, estimée avec `fwidth()`. Dès qu'un motif devient plus fin que le
 *  pixel, on le fond vers sa valeur moyenne au lieu de le laisser scintiller.
 *  C'est ce qui évite le « moutonnement » d'un motif à haute fréquence.
 * ============================================================================
 */

/* -------------------------------------------------------------------------- */
/*  Bruit procédural partagé (value noise 3D + fbm)                           */
/* -------------------------------------------------------------------------- */

export const NOISE_GLSL = /* glsl */ `
float tnHash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float tnValueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = tnHash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = tnHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = tnHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = tnHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = tnHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = tnHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = tnHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = tnHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

// 3 octaves : suffisant pour casser l'aspect plat sans coûter cher.
float tnFbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * tnValueNoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

// 4 octaves : réservé aux nuages.
float tnFbm4(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * tnValueNoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

/**
 * fbm dont CHAQUE octave s'éteint dès qu'elle passe sous la taille du pixel.
 * Un fbm ordinaire garde ses octaves hautes quoi qu'il arrive : à 3 octaves,
 * la dernière est 4 fois plus fine que la première et c'est elle qui crépite.
 * Ici le poids d'une octave tombe à zéro quand sa longueur d'onde devient
 * comparable au pixel, et la normalisation par la somme des poids préserve la
 * moyenne : le motif se fond proprement vers l'uni au lieu de moutonner.
 *   px = length(fwidth(p)), la taille du pixel mesurée dans l'espace de p.
 */
float tnFbmAA(vec3 p, float freq, float px) {
  float v = 0.0, a = 0.5, norm = 0.0, f = freq;
  for (int i = 0; i < 4; i++) {
    float w = a * (1.0 - smoothstep(0.30, 0.95, px * f));
    if (w > 0.001) { v += w * tnValueNoise(p * f); norm += w; }
    f *= 2.03;
    a *= 0.5;
  }
  return norm > 1e-4 ? v / norm : 0.5;
}

/**
 * Décodage du couple 6 bits.
 *
 * ATTENTION : « v » arrive par un varying. Même si les trois sommets du triangle
 * portent le même entier, l'interpolateur le restitue à un ulp près — donc
 * 64.0 peut arriver en 63.9999924. floor(63.9999924/64.0) vaut alors 0 au lieu
 * de 1, et le couple décodé bascule de (glace=1/63, eau=0) à (glace=0, eau=1) :
 * un pixel sur deux se retrouvait peint en océan profond au milieu d'une
 * calotte. C'était l'origine du moutonnement de points bleus et orange sur
 * certaines cellules. On recale donc d'abord sur l'entier exact.
 */
vec2 tnUnpack6(float v) {
  float t = floor(v + 0.5);
  float hi = floor(t / 64.0);
  float lo = t - hi * 64.0;
  return vec2(hi / 63.0, lo / 63.0);
}
`;

/* -------------------------------------------------------------------------- */
/*  Surface : vertex                                                          */
/* -------------------------------------------------------------------------- */

export const planetVertexShader = /* glsl */ `
attribute vec3 aCenter;
attribute float aCell;
attribute float aEdge;
attribute vec4 aData;
attribute vec4 aInfo;
attribute vec4 aAux;

uniform float uRadius;
uniform float uLimbBulge;

varying vec3 vWorld;
varying vec3 vObject;
varying vec3 vNormalW;
varying vec3 vRadialW;
varying vec3 vCenterW;
varying float vEdge;
varying float vCell;
varying vec4 vData;
varying vec4 vInfo;
varying vec4 vAux;

void main() {
  float reveal = clamp(aInfo.z, 0.0, 1.0);

  // Les régions non découvertes sont à peine « aplaties ». Deux cellules
  // voisines partagent leurs coins mais chacune écrit les siens : si l'une est
  // révélée et l'autre non, l'écart de déplacement OUVRE une fissure dans le
  // maillage, qu'on voit comme une falaise noire. On garde donc 85 % du relief
  // partout : la fissure devient sous-pixellique et la révélation se joue
  // presque entièrement sur la couleur.
  vec3 dir = normalize(position);
  vec3 flatPos = dir * uRadius;
  float shape = 0.85 + 0.15 * reveal;
  vec3 pos = mix(flatPos, position, shape);
  vec3 nrm = normalize(mix(dir, normal, shape));

  vec3 centerFlat = normalize(aCenter) * uRadius;
  vec3 centerPos = mix(centerFlat, aCenter, shape);

  vObject = pos;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vec3 radial = normalize(mat3(modelMatrix) * dir);

  // ANTI-FACETTES. Le contour d'un pavage de 642 cellules est un polygone
  // parfaitement visible sur le fond noir. On repousse très légèrement, le
  // long du rayon, les sommets vus au limbe : cela comble la corde entre deux
  // coins voisins et arrondit la silhouette. Le coût est nul (une puissance
  // par sommet) et rien ne bouge au centre du disque, où rim ≈ 0.
  vec3 toCam = normalize(cameraPosition - wp.xyz);
  float rim = 1.0 - abs(dot(radial, toCam));
  wp.xyz += radial * (uRadius * uLimbBulge * pow(rim, 6.0));

  vWorld = wp.xyz;
  vRadialW = radial;
  vCenterW = (modelMatrix * vec4(centerPos, 1.0)).xyz;
  vNormalW = normalize(mat3(modelMatrix) * nrm);

  vEdge = aEdge;
  vCell = aCell;
  vData = aData;
  vInfo = aInfo;
  vAux = aAux;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* -------------------------------------------------------------------------- */
/*  Surface : fragment                                                        */
/* -------------------------------------------------------------------------- */

export const planetFragmentShader = /* glsl */ `
${NOISE_GLSL}

uniform vec3  uBiomePalette[12];
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform vec3  uNightAmbient;
uniform float uInsolation;
uniform float uTime;
uniform float uRadius;
uniform float uRelief;
uniform int   uLayerFrom;
uniform int   uLayerTo;
uniform float uLayerBlend;
uniform float uSelected;
uniform float uHovered;
uniform float uEdgeStrength;
/**
 * Moyenne des températures RÉGIONALES (°C), lissée, fournie par SceneManager.
 * Elle sert de CENTRE à la rampe thermique : voir layerColor(), couche 1.
 */
uniform float uTempMean;

varying vec3 vWorld;
varying vec3 vObject;
varying vec3 vNormalW;
varying vec3 vRadialW;
varying vec3 vCenterW;
varying float vEdge;
varying float vCell;
varying vec4 vData;
varying vec4 vInfo;
varying vec4 vAux;

/* --- rampes de couleur des couches de données --------------------------- */

/** Demi-fenêtre de la rampe thermique, en °C autour de la moyenne. */
const float TEMP_WINDOW = 20.0;

/**
 * tanh() n'est garanti qu'à partir de GLSL ES 3.00 ; on l'écrit à la main pour
 * ne dépendre d'aucune version. Le clamp évite l'explosion de exp().
 */
float tnTanh(float x) {
  x = clamp(x, -8.0, 8.0);
  float e = exp(2.0 * x);
  return (e - 1.0) / (e + 1.0);
}

/** Température de la cellule en °C, telle qu'encodée dans aData.x. */
float tnCelsius(float packed) { return packed * 200.0 - 120.0; }

vec3 ramp5(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c = mix(c0, c1, clamp(t, 0.0, 1.0));
  c = mix(c, c2, clamp(t - 1.0, 0.0, 1.0));
  c = mix(c, c3, clamp(t - 2.0, 0.0, 1.0));
  c = mix(c, c4, clamp(t - 3.0, 0.0, 1.0));
  return c;
}

vec3 ramp3(float t, vec3 c0, vec3 c1, vec3 c2) {
  t = clamp(t, 0.0, 1.0) * 2.0;
  vec3 c = mix(c0, c1, clamp(t, 0.0, 1.0));
  return mix(c, c2, clamp(t - 1.0, 0.0, 1.0));
}

/**
 * Grille procédurale anti-aliasée.
 * « uv » est exprimé en cellules de grille : la ligne passe par fract(uv) = 0.
 * On divise la distance à la ligne par la taille du pixel (fwidth), donc le
 * trait garde une épaisseur constante à l'écran quelle que soit la distance ;
 * et dès que le pas de grille devient plus petit que ~1,5 px, « fade » éteint
 * complètement le motif au lieu de le laisser crépiter.
 */
float tnGrid(vec2 uv, float widthPx) {
  vec2 w = fwidth(uv);
  vec2 d = abs(fract(uv - 0.5) - 0.5) / max(w * widthPx, vec2(1e-5));
  float line = 1.0 - min(min(d.x, d.y), 1.0);
  float fade = 1.0 - smoothstep(0.20, 0.65, max(w.x, w.y));
  return line * fade;
}

/**
 * Perturbe un facteur de mélange par le grain, MAIS uniquement dans sa zone de
 * transition : le terme t·(1−t) s'annule à 0 et à 1. Une cellule sans glace ne
 * gagne donc jamais de taches de givre, une cellule entièrement verte ne se
 * troue pas — seule la frontière entre deux cellules devient une frange
 * organique au lieu d'un bord d'hexagone net.
 */
float tnRagged(float t, float grain, float amount) {
  return clamp(t + (grain - 0.5) * amount * t * (1.0 - t) * 4.0, 0.0, 1.0);
}

/* --- couleur « naturelle » ---------------------------------------------- */

vec3 naturalColor(float ice, float water, float grain, float ragged, float macro, float seed, float alt) {
  int bi = int(vInfo.x + 0.5);
  vec3 base = uBiomePalette[0];
  // Sélection sans indexation dynamique douteuse : boucle déroulée courte.
  for (int i = 0; i < 12; i++) {
    if (i == bi) base = uBiomePalette[i];
  }

  // La palette de biomes (src/data/biomes.js) est écrite en valeurs très
  // claires : la calotte glaciaire y est à 0,88 et la toundra à 0,45.
  // Multipliées par le soleil puis passées dans ACES, elles ressortent
  // au-dessus de 0,9 : la planète gelée devenait une boule blanche uniforme,
  // sans aucun contraste. Compression douce des hautes lumières — les tons
  // sombres (océan, forêt) sont préservés, les tons clairs sont ramenés dans
  // une plage exploitable.
  base = base / (1.0 + base * 1.7);

  // Variation de teinte d'une cellule à l'autre : deux cellules voisines du
  // même biome ne doivent JAMAIS avoir exactement la même couleur, sinon la
  // planète ressemble à une balle de golf peinte d'un seul aplat. Amplitude
  // volontairement faible : au-delà, sur une surface claire (calotte), le
  // pavage vire à l'œuf de Pâques.
  base *= vec3(0.96 + 0.08 * fract(seed * 3.13),
               0.96 + 0.08 * fract(seed * 5.71),
               0.96 + 0.08 * fract(seed * 7.37));

  // Végétation : verdissement progressif. Seuil bas (0.03) pour que la
  // première mousse se VOIE — c'est la récompense du joueur.
  vec3 vegCol = mix(vec3(0.24, 0.38, 0.15), vec3(0.06, 0.22, 0.09), vData.z);
  vegCol *= 0.78 + 0.46 * ragged;   // texture visible jusqu'en vue rapprochée
  // Le seuil est BRUITÉ : la limite entre une cellule verte et sa voisine nue
  // devient une frange organique au lieu d'un bord d'hexagone. C'est ce qui
  // enlève l'aspect « balle de golf » sans changer une seule donnée du jeu.
  base = mix(base, vegCol, tnRagged(smoothstep(0.03, 0.62, vData.z), ragged, 0.85) * 0.92);

  // Eau liquide : assombrit et sature en bleu. Seuil bas également : dès que
  // l'eau apparaît quelque part, elle doit se lire depuis l'orbite.
  vec3 seaCol = mix(vec3(0.055, 0.185, 0.335), vec3(0.010, 0.055, 0.155), water);
  base = mix(base, seaCol, tnRagged(smoothstep(0.02, 0.30, water), ragged, 0.70));

  // Glace : blanchit (par-dessus l'eau : banquise). Légèrement bleutée et pas
  // blanc pur, sinon les calottes brûlent tout le contraste de l'image.
  // Glace franchement plus sombre et plus froide qu'un blanc de neige : un
  // monde gelé doit rester lugubre, sinon il brûle tout le contraste de
  // l'image et le passage au monde vivant ne se voit plus.
  vec3 iceCol = vec3(0.34, 0.40, 0.51) * (0.86 + grain * 0.28);
  base = mix(base, iceCol, tnRagged(smoothstep(0.06, 0.62, ice), ragged, 0.85));

  // Pollution : désature et vire au brun.
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 dirty = mix(vec3(lum), vec3(0.26, 0.19, 0.12), 0.60);
  base = mix(base, dirty, smoothstep(0.05, 0.8, vData.w) * 0.8);

  // Modulation finale, appliquée APRÈS tous les mélanges : elle survit donc à
  // la végétation comme à la glace, au lieu d'être écrasée par elles.
  //   · macro  : nappes continentales très basse fréquence ;
  //   · alt    : crêtes éclaircies, cuvettes assombries ;
  //   · grain  : texture de surface ;
  //   · seed   : chaque cellule a sa propre valeur moyenne.
  // Somme et non produit : quatre facteurs multiplicatifs de moyenne 1 ont un
  // maximum à 1,6 — la surface saturait alors dans le tone mapping et tout
  // virait au blanc pastel. Une somme d'écarts reste centrée sur 1.
  float modul = 1.0
    + (macro - 0.5) * 0.34
    + alt * 0.14
    + (mix(grain, ragged, 0.45) - 0.5) * 0.38
    + (fract(seed * 11.71) - 0.5) * 0.14;
  base *= clamp(modul, 0.55, 1.32);

  return base;
}

/* --- couleur d'une couche de visualisation ------------------------------- */

vec3 layerColor(int layer, float ice, float water, float minerals, float geo,
                float grain, float ragged, float macro, float seed, float alt) {
  if (layer == 1) {
    // TEMPÉRATURE — fenêtre glissante autour de la moyenne planétaire.
    //
    // aData.x code clamp01((T + 120) / 200) : la rampe brute couvrait donc
    // 200 °C alors qu'un monde en cours de terraformation tient dans une
    // vingtaine de degrés. Résultat : une carte uniformément bleue, qui
    // n'apprenait rien. On reconstruit ici les °C, puis on lit l'ÉCART à la
    // moyenne à travers une tanh : les contrastes régionaux occupent toute la
    // rampe à toutes les époques (planète gelée à −52 °C comme monde tempéré
    // à +21 °C), sans jamais saturer complètement.
    float tC = tnCelsius(vData.x);
    float dev = tnTanh((tC - uTempMean) / TEMP_WINDOW);
    // Une part d'ABSOLU (faible) conserve l'information « ce monde est
    // globalement glacé / globalement tempéré » d'une époque à l'autre.
    float bias = tnTanh(uTempMean / 55.0);
    float t = 0.5 + 0.5 * clamp(dev * 0.80 + bias * 0.20, -1.0, 1.0);
    return ramp5(t,
      vec3(0.07, 0.13, 0.34),
      vec3(0.14, 0.32, 0.62),
      vec3(0.30, 0.68, 0.74),
      vec3(0.94, 0.84, 0.46),
      vec3(0.76, 0.15, 0.12));
  } else if (layer == 2) {
    // Eau : sec → humide → eau libre, blanchi par la glace
    vec3 c = ramp3(vData.y, vec3(0.34, 0.27, 0.20), vec3(0.26, 0.40, 0.42), vec3(0.10, 0.42, 0.66));
    c = mix(c, vec3(0.05, 0.30, 0.62), smoothstep(0.02, 0.45, water));
    c = mix(c, vec3(0.78, 0.88, 0.95), smoothstep(0.03, 0.6, ice));
    return c;
  } else if (layer == 3) {
    // Ressources : minerai (or) + géothermie (orange)
    vec3 c = vec3(0.115, 0.120, 0.135);
    c = mix(c, vec3(0.82, 0.66, 0.16), smoothstep(0.05, 0.95, minerals));
    c = mix(c, vec3(0.90, 0.34, 0.15), smoothstep(0.15, 0.95, geo) * 0.85);
    return c;
  } else if (layer == 4) {
    // Énergie
    return ramp3(vAux.z, vec3(0.07, 0.07, 0.10), vec3(0.55, 0.40, 0.10), vec3(1.0, 0.82, 0.29));
  } else if (layer == 5) {
    // Biosphère
    return ramp3(vData.z, vec3(0.16, 0.17, 0.18), vec3(0.44, 0.78, 0.46), vec3(0.05, 0.40, 0.14));
  } else if (layer == 6) {
    // Pollution
    return ramp3(vData.w, vec3(0.11, 0.15, 0.20), vec3(0.68, 0.38, 0.14), vec3(0.72, 0.13, 0.20));
  } else if (layer == 7) {
    // Habitabilité
    return ramp3(vAux.y, vec3(0.28, 0.10, 0.16), vec3(0.55, 0.48, 0.16), vec3(0.28, 0.82, 0.52));
  }
  return naturalColor(ice, water, grain, ragged, macro, seed, alt);
}

void main() {
  vec2 iw = tnUnpack6(vInfo.y);
  float ice = iw.x;
  float water = iw.y;
  vec2 mg = tnUnpack6(vInfo.w);
  float minerals = mg.x;
  float geo = mg.y;
  float reveal = clamp(vInfo.z, 0.0, 1.0);

  vec3 N = normalize(vNormalW);
  vec3 Nr = normalize(vRadialW);      // normale de la sphère parfaite
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDirection);

  // Taille du pixel courant mesurée sur la surface, en unités objet. C'est
  // l'étalon de tous les motifs procéduraux ci-dessous.
  float px = length(fwidth(vObject));

  // Chaque cellule tire sa propre graine de son IDENTIFIANT, arrondi à l'entier.
  //
  // ATTENTION, piège coûteux : cette graine était auparavant hachée depuis
  // vCenterW, un varying. Même quand les trois sommets d'un triangle portent
  // la même valeur, l'interpolateur la restitue à un ulp près — et le facteur
  // 43758 du hash amplifie ce bruit de 1e-7 en un décalage de l'ordre de 0,3.
  // La graine devenait donc ALÉATOIRE PAR PIXEL sur certaines cellules, d'où
  // le moutonnement de points saturés qui dominait toute l'image. floor() sur
  // un identifiant entier rend la graine rigoureusement constante par cellule.
  float cellId = floor(vCell + 0.5);
  float cellSeed = fract(sin(cellId * 12.9898 + 78.233) * 43758.5453);

  // Altitude normalisée -1..1, relue depuis la géométrie : sert au ton de la
  // roche et à une occlusion « de fond de vallée ».
  float alt = clamp((length(vObject) / uRadius - 1.0) / max(uRelief, 1e-4), -1.0, 1.0);

  /* --- grain de surface, chaque octave bornée par la taille du pixel ---- */
  // Quatre octaves à partir d'une fréquence BASSE : la première dessine des
  // reliefs de la taille d'une région (c'est elle qui donne du modelé au
  // terrain), les dernières le grain de roche. Une seule fonction couvre donc
  // toute la gamme, et chaque octave s'éteint proprement à sa distance.
  const float GRAIN_FREQ = 7.0;
  float grainFade = 1.0 - smoothstep(0.30, 0.95, px * GRAIN_FREQ * 4.0);
  float grain = tnFbmAA(vObject + vec3(cellSeed * 9.0), GRAIN_FREQ, px);
  // Nappe très basse fréquence : jamais aliasée, toujours active.
  float macro = tnValueNoise(vObject * 4.3 + vec3(2.7, 8.1, 5.3));

  // Bruit HAUTE fréquence dédié aux frontières de biome. Le fbm ci-dessus est
  // dominé par sa première octave (poids 0,5) : utilisé pour dentelér les
  // limites, il les déplaçait en bloc au lieu de les découper. Il faut une
  // fréquence franchement plus fine, éteinte dès qu'elle passe sous le pixel.
  float edgeFade = 1.0 - smoothstep(0.30, 0.95, px * 40.0);
  float ragged = grain;
  if (edgeFade > 0.002) {
    ragged = mix(grain, mix(0.5, tnValueNoise(vObject * 40.0 + 21.7), edgeFade), 0.65);
  }

  // Distance normalisée au centre de la cellule, mesurée géométriquement
  // depuis aCenter : sert au liseré de bord conjointement à vEdge.
  float radial = clamp(length(vWorld - vCenterW) / max(length(vWorld) * 0.09, 1e-4), 0.0, 1.0);

  // Couleur : fondu animé entre deux couches.
  vec3 colA = layerColor(uLayerFrom, ice, water, minerals, geo, grain, ragged, macro, cellSeed, alt);
  vec3 colB = layerColor(uLayerTo, ice, water, minerals, geo, grain, ragged, macro, cellSeed, alt);
  vec3 albedo = mix(colA, colB, clamp(uLayerBlend, 0.0, 1.0));

  // En mode couche de données, les liserés de cellule deviennent lisibles.
  float dataMode = max(
    uLayerFrom == 0 ? 0.0 : 1.0 - clamp(uLayerBlend, 0.0, 1.0),
    uLayerTo == 0 ? 0.0 : clamp(uLayerBlend, 0.0, 1.0));

  /* --- liseré de bord de cellule --------------------------------------- */
  // vEdge est exact (0 au centre, 1 sur le bord) ; radial le renforce sur les
  // cellules très allongées, où l'interpolation barycentrique seule triche un peu.
  // En vue naturelle il est presque éteint : c'est un monde, pas un plateau de jeu.
  float border = smoothstep(0.80, 0.995, max(vEdge, radial * 0.92));
  float borderAmount = uEdgeStrength * mix(0.07, 1.0, dataMode) * border;
  albedo *= 1.0 - borderAmount * 0.55;

  /* --- REPÈRE 0 °C de la couche température ---------------------------- */
  // La rampe est RELATIVE (fenêtre glissante) : sans repère absolu, le joueur
  // ne saurait plus où passe le gel. Une cellule est constante en couleur, donc
  // aucune isotherme ne peut être tracée dans son intérieur ; on marque donc
  // les cellules sous 0 °C d'une hachure d'écran — la convention cartographique
  // du gel, et le seul motif qui ne crépite jamais puisqu'il est en pixels.
  float tempMode = max(
    uLayerFrom == 1 ? 1.0 - clamp(uLayerBlend, 0.0, 1.0) : 0.0,
    uLayerTo == 1 ? clamp(uLayerBlend, 0.0, 1.0) : 0.0);
  if (tempMode > 0.002) {
    float frozen = 1.0 - smoothstep(-1.0, 1.0, tnCelsius(vData.x));
    float h = fract((gl_FragCoord.x + gl_FragCoord.y) * 0.0715);   // ~14 px
    float stripe = smoothstep(0.40, 0.48, h) * (1.0 - smoothstep(0.52, 0.60, h));
    albedo *= 1.0 - 0.34 * stripe * frozen * tempMode;
  }

  /* --- régions non découvertes ----------------------------------------- */
  // « Données manquantes » sur un écran de contrôle : gris-bleu très sombre,
  // quadrillage technique fin, rien de saturé et surtout rien qui scintille.
  vec3 gd = normalize(vObject);
  float glat = asin(clamp(gd.y, -1.0, 1.0));
  float glon = atan(gd.z, gd.x);
  vec2 guv = vec2(glon, glat) * 13.0;
  float minor = tnGrid(guv, 0.9);
  float major = tnGrid(guv * 0.25, 1.3);
  vec3 unknown = vec3(0.017, 0.023, 0.032);
  unknown += vec3(0.016, 0.026, 0.036) * minor;
  unknown += vec3(0.032, 0.050, 0.068) * major;
  // Balayage de cartographie : très basse fréquence, donc jamais aliasé.
  unknown += vec3(0.006, 0.011, 0.016) * (0.5 + 0.5 * sin(glat * 3.0 - uTime * 0.55));
  // Léger flash à l'instant de la révélation.
  float revealPulse = smoothstep(0.0, 0.35, reveal) * (1.0 - smoothstep(0.35, 1.0, reveal));
  albedo = mix(unknown, albedo, smoothstep(0.0, 0.9, reveal));

  /* --- relief : normale perturbée par le grain -------------------------- */
  // Bump mapping « sans paramétrisation » (Mikkelsen) : le gradient du grain
  // est obtenu par dérivées d'écran, donc sans un seul échantillon de bruit
  // supplémentaire. L'amplitude est bornée pour ne jamais retourner la normale.
  if (grainFade > 0.002) {
    vec3 dpx = dFdx(vWorld);
    vec3 dpy = dFdy(vWorld);
    vec3 r1 = cross(dpy, N);
    vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = (dFdx(grain) * r1 + dFdy(grain) * r2) * (det < 0.0 ? -1.0 : 1.0)
              / max(abs(det), 1e-9);
    vec3 gt = grad - N * dot(N, grad);
    float gl = length(gt);
    if (gl > 1e-5) {
      float amp = min(gl * 0.014, 0.55) * grainFade * (1.0 - water * 0.8) * reveal;
      N = normalize(N - (gt / gl) * amp);
    }
  }

  // Au limbe, on ramène la normale vers celle de la sphère parfaite : les
  // facettes du pavage ne se lisent plus sur le contour.
  float limb = 1.0 - abs(dot(Nr, V));
  N = normalize(mix(N, Nr, smoothstep(0.70, 1.0, limb) * 0.85));

  /* --- éclairage -------------------------------------------------------- */
  float ndl = dot(N, L);
  // Lambert « wrap » resserré : le terminateur est net, la lumière rasante
  // sculpte le relief au lieu de tout aplatir.
  float wrap = clamp((ndl + 0.16) / 1.16, 0.0, 1.0);
  wrap *= wrap * (3.0 - 2.0 * wrap);
  float dayMask = smoothstep(-0.10, 0.12, dot(Nr, L));

  // Occlusion d'altitude : les fonds de vallée reçoivent moins de ciel.
  float ao = 0.70 + 0.30 * smoothstep(-0.85, 0.65, alt);
  ao = mix(1.0, ao, reveal);

  vec3 color = albedo * uSunColor * wrap * uInsolation * ao;
  // Appoint bleuté très faible : la silhouette reste lisible côté nuit.
  color += albedo * uNightAmbient * ao;

  // Spéculaire discret : eau liquide et glace uniquement.
  vec3 H = normalize(V + L);
  float shininess = mix(24.0, 96.0, water);
  float spec = pow(max(dot(N, H), 0.0), shininess);
  spec *= (water * 0.85 + ice * 0.25) * dayMask * reveal;
  color += uSunColor * spec * 0.60;

  /* --- lumières de colonies côté nuit ---------------------------------- */
  // Seuil resserré et décalé après le terminateur : sinon les lumières
  // bavaient sur le crépuscule en confettis khaki au milieu de la végétation.
  float night = 1.0 - smoothstep(-0.22, 0.01, dot(Nr, L));
  float density = clamp(vAux.x, 0.0, 1.0);
  if (night > 0.001 && density > 0.001) {
    // Amas de lumières, atténués dès qu'ils deviennent plus fins que le pixel
    // (sinon : confettis clignotants). Un halo diffus prend le relais.
    const float LIGHT_FREQ = 70.0;
    float lightFade = 1.0 - smoothstep(0.25, 0.85, px * LIGHT_FREQ);
    float dots = 0.0;
    if (lightFade > 0.002) {
      float lp = tnValueNoise(vObject * LIGHT_FREQ + 13.0);
      // Seuil haut : peu de points, mais francs. Un semis dense et tiède se lit
      // comme une tache de sable, pas comme une ville.
      dots = smoothstep(0.70, 0.86, lp + density * 0.16) * lightFade;
    }
    // Halo diffus : c'est lui qui porte la lecture « ville » quand le grain
    // devient trop fin ; les points ne font qu'ajouter le scintillement.
    float glow = smoothstep(0.05, 0.75, density);
    float flicker = 0.92 + 0.08 * sin(uTime * 1.7 + cellId * 1.7);
    color += vec3(1.00, 0.64, 0.30) * (dots * 5.0 + glow * 0.22) * density * night * flicker;
  }

  /* --- flash de révélation + surbrillance ------------------------------ */
  color += vec3(0.20, 0.55, 0.70) * revealPulse * 0.35;

  float isSel = step(abs(vCell - uSelected), 0.5);
  float isHov = step(abs(vCell - uHovered), 0.5);
  color += vec3(0.10, 0.42, 0.50) * isSel * (0.10 + 0.14 * border);
  color += vec3(0.30, 0.34, 0.38) * isHov * 0.05;

  // Assombrissement de limbe : le contour se fond dans l'espace au lieu de
  // découper un polygone net sur le fond étoilé.
  color *= 1.0 - smoothstep(0.88, 1.0, limb) * 0.45;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/*  Nappe d'eau : sphère translucide au niveau de la mer                      */
/* -------------------------------------------------------------------------- */

export const oceanVertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vObject;

void main() {
  vObject = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const oceanFragmentShader = /* glsl */ `
${NOISE_GLSL}

uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform vec3  uShallowColor;
uniform vec3  uDeepColor;
uniform vec3  uNightAmbient;
uniform float uTime;
uniform float uOpacity;
uniform float uInsolation;

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vObject;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDirection);

  // Légère houle : perturbation de la normale par un bruit animé, éteinte
  // quand elle passe sous la taille du pixel (sinon elle crépite).
  float px = length(fwidth(vObject));
  float rippleFade = 1.0 - smoothstep(0.25, 0.9, px * 26.0);
  if (rippleFade > 0.002) {
    float w1 = tnFbm3(vObject * 26.0 + vec3(0.0, uTime * 0.045, 0.0));
    float w2 = tnFbm3(vObject * 61.0 - vec3(uTime * 0.03, 0.0, uTime * 0.02));
    vec3 ripple = normalize(vec3(w1 - 0.5, w2 - 0.5, (w1 * w2) - 0.25));
    N = normalize(N + ripple * 0.055 * rippleFade);
  }

  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.18) / 1.18, 0.0, 1.0);
  wrap *= wrap * (3.0 - 2.0 * wrap);
  float dayMask = smoothstep(-0.10, 0.12, ndl);

  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

  vec3 base = mix(uDeepColor, uShallowColor, fres * 0.8 + 0.15);
  vec3 color = base * uSunColor * wrap * uInsolation + base * uNightAmbient;

  vec3 H = normalize(V + L);
  float spec = pow(max(dot(N, H), 0.0), 110.0) * dayMask;
  color += uSunColor * spec * 0.85;

  float alpha = uOpacity * (0.55 + 0.45 * fres);
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default { planetVertexShader, planetFragmentShader, oceanVertexShader, oceanFragmentShader, NOISE_GLSL };

/**
 * ============================================================================
 *  TERRA NOVA — Shaders de la surface planétaire + nappe d'eau
 * ============================================================================
 *  Écrit en GLSL « style ShaderMaterial Three.js » : on utilise la syntaxe
 *  GLSL ES 1.0 (attribute / varying / gl_FragColor) que Three réécrit
 *  automatiquement en GLSL ES 3.0 pour WebGL2.
 *
 *  --- ENCODAGE DES ATTRIBUTS DYNAMIQUES (voir PlanetMesh.js) ---------------
 *   aData.x  température normalisée : (T°C + 120) / 200, clampée 0..1
 *   aData.y  humidité (moisture) 0..1
 *   aData.z  végétation 0..1
 *   aData.w  pollution 0..1
 *
 *   aInfo.x  index de biome (0..11, entier exact stocké en float)
 *   aInfo.y  pack6(glace, eau liquide)      — deux canaux 6 bits
 *   aInfo.z  révélation 0..1 (interpolée côté CPU pour une apparition douce)
 *   aInfo.w  pack6(minerais, géothermie)    — deux canaux 6 bits
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

// Décodage du couple 6 bits.
vec2 tnUnpack6(float v) {
  float hi = floor(v / 64.0);
  float lo = v - hi * 64.0;
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

varying vec3 vWorld;
varying vec3 vObject;
varying vec3 vNormalW;
varying vec3 vCenterW;
varying vec3 vCenterO;
varying float vEdge;
varying float vCell;
varying vec4 vData;
varying vec4 vInfo;
varying vec4 vAux;

void main() {
  float reveal = clamp(aInfo.z, 0.0, 1.0);

  // Les régions non découvertes sont « aplaties » : on les ramène vers la
  // sphère parfaite, le relief n'apparaît qu'à la révélation.
  vec3 dir = normalize(position);
  vec3 flatPos = dir * uRadius;
  float shape = 0.12 + 0.88 * reveal;
  vec3 pos = mix(flatPos, position, shape);
  vec3 nrm = normalize(mix(dir, normal, shape));

  vec3 centerFlat = normalize(aCenter) * uRadius;
  vec3 centerPos = mix(centerFlat, aCenter, shape);

  vObject = pos;
  vCenterO = centerPos;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorld = wp.xyz;
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
uniform int   uLayerFrom;
uniform int   uLayerTo;
uniform float uLayerBlend;
uniform float uSelected;
uniform float uHovered;
uniform float uEdgeStrength;

varying vec3 vWorld;
varying vec3 vObject;
varying vec3 vNormalW;
varying vec3 vCenterW;
varying vec3 vCenterO;
varying float vEdge;
varying float vCell;
varying vec4 vData;
varying vec4 vInfo;
varying vec4 vAux;

/* --- rampes de couleur des couches de données --------------------------- */

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

/* --- couleur « naturelle » ---------------------------------------------- */

vec3 naturalColor(float ice, float water, float surfNoise) {
  int bi = int(vInfo.x + 0.5);
  vec3 base = uBiomePalette[0];
  // Sélection sans indexation dynamique douteuse : boucle déroulée courte.
  for (int i = 0; i < 12; i++) {
    if (i == bi) base = uBiomePalette[i];
  }

  // Grain de surface : module la luminosité, plus marqué sur la roche nue.
  float rough = mix(0.35, 1.0, 1.0 - vData.z);
  base *= 1.0 + (surfNoise - 0.5) * 0.30 * rough;

  // Végétation : verdissement progressif, teinte plus sombre quand elle est dense.
  vec3 vegCol = mix(vec3(0.30, 0.46, 0.20), vec3(0.10, 0.31, 0.13), vData.z);
  base = mix(base, vegCol, smoothstep(0.02, 0.85, vData.z) * 0.85);

  // Eau liquide : assombrit et sature en bleu.
  vec3 seaCol = mix(vec3(0.08, 0.26, 0.44), vec3(0.02, 0.11, 0.26), water);
  base = mix(base, seaCol, smoothstep(0.03, 0.55, water));

  // Glace : blanchit (par-dessus l'eau : banquise).
  vec3 iceCol = vec3(0.80, 0.87, 0.94) * (0.9 + surfNoise * 0.2);
  base = mix(base, iceCol, smoothstep(0.05, 0.7, ice));

  // Pollution : désature et vire au brun.
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 dirty = mix(vec3(lum), vec3(0.30, 0.22, 0.14), 0.55);
  base = mix(base, dirty, smoothstep(0.05, 0.8, vData.w) * 0.8);

  return base;
}

/* --- couleur d'une couche de visualisation ------------------------------- */

vec3 layerColor(int layer, float ice, float water, float minerals, float geo, float surfNoise) {
  if (layer == 1) {
    // Température
    return ramp5(vData.x,
      vec3(0.169, 0.298, 0.549) * 0.55,
      vec3(0.169, 0.298, 0.549),
      vec3(0.290, 0.639, 0.780),
      vec3(0.910, 0.878, 0.659),
      vec3(0.690, 0.188, 0.188));
  } else if (layer == 2) {
    // Eau : sec → humide → eau libre, blanchi par la glace
    vec3 c = ramp3(vData.y, vec3(0.42, 0.35, 0.27), vec3(0.30, 0.45, 0.45), vec3(0.114, 0.435, 0.647));
    c = mix(c, vec3(0.113, 0.435, 0.647), smoothstep(0.02, 0.5, water));
    c = mix(c, vec3(0.812, 0.902, 0.961), smoothstep(0.03, 0.6, ice));
    return c;
  } else if (layer == 3) {
    // Ressources : minerai (or) + géothermie (orange)
    vec3 c = vec3(0.165, 0.165, 0.165);
    c = mix(c, vec3(0.788, 0.635, 0.153), smoothstep(0.05, 0.95, minerals));
    c = mix(c, vec3(0.878, 0.353, 0.169), smoothstep(0.15, 0.95, geo) * 0.85);
    return c;
  } else if (layer == 4) {
    // Énergie
    return ramp3(vAux.z, vec3(0.10, 0.10, 0.13), vec3(0.55, 0.42, 0.12), vec3(1.0, 0.82, 0.29));
  } else if (layer == 5) {
    // Biosphère
    return ramp3(vData.z, vec3(0.227, 0.227, 0.227), vec3(0.498, 0.816, 0.541), vec3(0.078, 0.420, 0.157));
  } else if (layer == 6) {
    // Pollution
    return ramp3(vData.w, vec3(0.141, 0.188, 0.251), vec3(0.659, 0.384, 0.165), vec3(0.694, 0.149, 0.227));
  } else if (layer == 7) {
    // Habitabilité
    return ramp3(vAux.y, vec3(0.290, 0.125, 0.188), vec3(0.541, 0.478, 0.188), vec3(0.310, 0.816, 0.541));
  }
  return naturalColor(ice, water, surfNoise);
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
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDirection);

  // Grain de surface (espace objet : stable quand la planète tourne)
  float surfNoise = tnFbm3(vObject * 34.0 + vec3(11.3, 4.7, 19.1));

  // Couleur : fondu animé entre deux couches.
  vec3 colA = layerColor(uLayerFrom, ice, water, minerals, geo, surfNoise);
  vec3 colB = layerColor(uLayerTo, ice, water, minerals, geo, surfNoise);
  vec3 albedo = mix(colA, colB, clamp(uLayerBlend, 0.0, 1.0));

  // En mode couche de données, les liserés de cellule deviennent lisibles.
  float dataMode = max(
    uLayerFrom == 0 ? 0.0 : 1.0 - clamp(uLayerBlend, 0.0, 1.0),
    uLayerTo == 0 ? 0.0 : clamp(uLayerBlend, 0.0, 1.0));

  /* --- liseré de bord de cellule --------------------------------------- */
  float border = smoothstep(0.80, 0.995, vEdge);
  float borderAmount = uEdgeStrength * mix(0.16, 1.0, dataMode) * border;
  albedo *= 1.0 - borderAmount * 0.55;

  /* --- régions non découvertes ----------------------------------------- */
  // Gris-bleu très sombre + grille technique « données manquantes ».
  vec3 unknown = vec3(0.055, 0.070, 0.098);
  vec3 gridDir = normalize(vObject);
  float g1 = abs(fract(gridDir.y * 46.0) - 0.5);
  float g2 = abs(fract(atan(gridDir.z, gridDir.x) * 12.0) - 0.5);
  float grid = smoothstep(0.47, 0.5, max(g1, g2));
  unknown += vec3(0.10, 0.16, 0.22) * grid * 0.55;
  // Balayage lent pour signaler que la zone est « à cartographier ».
  float sweep = 0.5 + 0.5 * sin(gridDir.y * 9.0 - uTime * 0.7);
  unknown += vec3(0.03, 0.06, 0.09) * sweep;
  // Léger flash à l'instant de la révélation.
  float revealPulse = smoothstep(0.0, 0.35, reveal) * (1.0 - smoothstep(0.35, 1.0, reveal));
  albedo = mix(unknown, albedo, smoothstep(0.0, 0.9, reveal));

  /* --- éclairage -------------------------------------------------------- */
  float ndl = dot(N, L);
  // Lambert « wrap » : terminateur adouci, jamais de coupure franche.
  float wrap = clamp((ndl + 0.28) / 1.28, 0.0, 1.0);
  wrap *= wrap * (3.0 - 2.0 * wrap);
  float dayMask = smoothstep(-0.12, 0.10, ndl);

  vec3 color = albedo * uSunColor * wrap * uInsolation;
  // Appoint bleuté très faible : la silhouette reste lisible côté nuit.
  color += albedo * uNightAmbient;

  // Spéculaire discret : eau liquide et glace uniquement.
  vec3 H = normalize(V + L);
  float shininess = mix(24.0, 96.0, water);
  float spec = pow(max(dot(N, H), 0.0), shininess);
  spec *= (water * 0.75 + ice * 0.30) * dayMask * reveal;
  color += uSunColor * spec * 0.55;

  /* --- lumières de colonies côté nuit ---------------------------------- */
  float night = 1.0 - dayMask;
  float density = clamp(vAux.x, 0.0, 1.0);
  if (night > 0.001 && density > 0.001) {
    float lp = tnValueNoise(vObject * 260.0);
    float dots = smoothstep(0.62, 0.86, lp + density * 0.30);
    float flicker = 0.85 + 0.15 * sin(uTime * 2.1 + vCell * 1.7);
    color += vec3(1.0, 0.58, 0.24) * dots * density * night * 1.35 * flicker;
  }

  /* --- flash de révélation + surbrillance ------------------------------ */
  color += vec3(0.20, 0.55, 0.70) * revealPulse * 0.35;

  float isSel = step(abs(vCell - uSelected), 0.5);
  float isHov = step(abs(vCell - uHovered), 0.5);
  color += vec3(0.10, 0.42, 0.50) * isSel * (0.10 + 0.10 * border);
  color += vec3(0.30, 0.34, 0.38) * isHov * 0.05;

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

  // Légère houle : perturbation de la normale par un bruit animé.
  float w1 = tnFbm3(vObject * 26.0 + vec3(0.0, uTime * 0.045, 0.0));
  float w2 = tnFbm3(vObject * 61.0 - vec3(uTime * 0.03, 0.0, uTime * 0.02));
  vec3 ripple = normalize(vec3(w1 - 0.5, w2 - 0.5, (w1 * w2) - 0.25));
  N = normalize(N + ripple * 0.055);

  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.22) / 1.22, 0.0, 1.0);
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

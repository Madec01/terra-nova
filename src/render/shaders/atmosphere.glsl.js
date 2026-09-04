/**
 * ============================================================================
 *  TERRA NOVA — Halo atmosphérique
 * ============================================================================
 *  Sphère légèrement plus grande que la planète, rendue en BackSide avec un
 *  blending additif : on ne voit donc que la « tranche » d'atmosphère au limbe.
 *
 *  L'intensité est pilotée par la pression (kPa) et l'oxygène (%). Au début de
 *  la partie (1,6 kPa) le halo est quasi invisible : la planète est nue.
 *  À mesure que l'atmosphère s'épaissit, un halo bleuté apparaît.
 *
 *  Diffusion Rayleigh simplifiée : la lumière qui traverse une grande épaisseur
 *  d'atmosphère (près du terminateur) perd ses courtes longueurs d'onde et vire
 *  à l'orange ; le limbe éclairé de face reste bleu.
 * ============================================================================
 */

export const atmosphereVertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  // Normale sortante de la sphère (on est en BackSide : « normal » pointe encore
  // vers l'extérieur en espace objet, c'est ce qu'on veut).
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const atmosphereFragmentShader = /* glsl */ `
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uPressure;     // kPa
uniform float uOxygen;       // % du volume
uniform float uInsolation;
uniform float uTime;

varying vec3 vWorld;
varying vec3 vNormalW;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDirection);

  // Densité perçue : saturation douce de la pression (0 kPa → 0, ~100 kPa → ~1).
  float density = 1.0 - exp(-uPressure / 42.0);
  // L'oxygène affine la teinte : plus il est présent, plus le ciel « terrestre ».
  float o2 = clamp(uOxygen / 21.0, 0.0, 1.4);

  // Fresnel : l'épaisseur optique explose au limbe.
  float rim = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  float limb = pow(rim, 3.2);

  float ndl = dot(N, L);
  // Face éclairée (avec un débordement au-delà du terminateur : la lumière
  // continue de se diffuser dans l'atmosphère un peu après le terminateur).
  float lit = smoothstep(-0.35, 0.25, ndl);

  // Angle de diffusion : plus la direction de vue est rasante par rapport au
  // soleil, plus le trajet dans l'atmosphère est long → rougissement.
  float grazing = 1.0 - smoothstep(0.0, 0.55, abs(ndl));

  vec3 blue   = mix(vec3(0.28, 0.46, 0.86), vec3(0.32, 0.55, 0.95), clamp(o2, 0.0, 1.0));
  vec3 warm   = vec3(0.98, 0.55, 0.28);
  vec3 tint   = mix(blue, warm, grazing * 0.80);

  // Rayleigh simplifié : le bleu s'atténue moins vite que le rouge en incidence
  // normale, l'inverse près du terminateur.
  vec3 scatter = tint * (0.55 + 0.45 * pow(rim, 1.4));

  float intensity = limb * lit * density * (0.55 + 0.55 * uInsolation);
  // Halo interne très léger même hors du limbe, pour « poser » la planète.
  intensity += pow(rim, 1.1) * lit * density * 0.10;

  // Un souffle très lent évite l'aspect figé.
  intensity *= 0.94 + 0.06 * sin(uTime * 0.25);

  vec3 color = scatter * uSunColor * intensity * 1.6;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default { atmosphereVertexShader, atmosphereFragmentShader };

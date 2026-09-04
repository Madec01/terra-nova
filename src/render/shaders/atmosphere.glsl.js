/**
 * ============================================================================
 *  TERRA NOVA — Halo atmosphérique
 * ============================================================================
 *  Sphère légèrement plus grande que la planète, rendue en BackSide avec un
 *  blending additif : on ne voit donc que la « tranche » d'atmosphère au limbe.
 *
 *  RÈGLE DE CALAGE : l'intensité doit être VRAIMENT proportionnelle à la
 *  pression. Au début de la partie (1,6 kPa) la planète est nue : il ne doit
 *  RIEN y avoir, pas même une frange brunâtre. Le halo ne commence à exister
 *  qu'au-delà de ~5 kPa et n'atteint sa pleine force qu'autour de la pression
 *  terrestre (~100 kPa).
 *
 *  TEINTE : une atmosphère riche en oxygène diffuse en bleu franc (Rayleigh
 *  d'un ciel « terrestre ») ; une atmosphère pauvre reste terne et grisée.
 *  L'orangé n'apparaît QUE près du terminateur, en fine frange, là où la
 *  lumière traverse réellement une grande épaisseur d'air.
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

  // Densité perçue. Le premier facteur coupe net sous ~5 kPa (planète nue :
  // aucun halo), le second sature vers la pression terrestre.
  float onset = smoothstep(4.0, 26.0, uPressure);
  float density = onset * (1.0 - exp(-uPressure / 55.0));
  if (density < 0.002) discard;

  // Richesse en oxygène : 0 = atmosphère morte (grise), 1 = ciel terrestre.
  float o2 = clamp(uOxygen / 20.0, 0.0, 1.15);

  // Fresnel : l'épaisseur optique explose au limbe.
  float rim = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  float limb = pow(rim, 3.0);

  float ndl = dot(N, L);
  // Face éclairée, avec un léger débordement au-delà du terminateur.
  float lit = smoothstep(-0.30, 0.20, ndl);

  // Frange chaude : UNIQUEMENT dans la bande étroite du terminateur, là où le
  // trajet dans l'atmosphère est le plus long. Puissance élevée = frange fine.
  float grazing = pow(1.0 - smoothstep(0.0, 0.42, abs(ndl)), 3.0);

  // Atmosphère pauvre : bleu délavé vers un gris froid. Riche : bleu franc.
  vec3 dull = vec3(0.30, 0.34, 0.40);
  vec3 blue = vec3(0.26, 0.46, 0.92);
  vec3 tint = mix(dull, blue, clamp(o2, 0.0, 1.0));
  vec3 warm = vec3(0.95, 0.48, 0.22);
  tint = mix(tint, warm, grazing * 0.55 * density);

  // Rayleigh simplifié : le bleu domine en incidence normale, il s'affaiblit
  // au profit du rouge quand l'épaisseur traversée augmente.
  vec3 scatter = tint * (0.50 + 0.50 * pow(rim, 1.5));

  float intensity = limb * lit * density * (0.45 + 0.35 * uInsolation);
  // Halo interne très léger, pour « poser » la planète sur le fond noir.
  intensity += pow(rim, 1.6) * lit * density * 0.07;

  // Un souffle très lent évite l'aspect figé.
  intensity *= 0.95 + 0.05 * sin(uTime * 0.25);

  vec3 color = scatter * uSunColor * intensity * 1.15;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default { atmosphereVertexShader, atmosphereFragmentShader };

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
uniform float uPressure;      // kPa
uniform float uOxygen;        // % du volume
uniform float uInsolation;
uniform float uTime;
uniform float uPlanetRadius;  // rayon de la surface, monde
uniform float uShellRadius;   // rayon de la coquille d'atmosphère, monde

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

  // Fresnel : utile pour la teinte, pas pour l'intensité.
  float rim = 1.0 - clamp(dot(N, V), 0.0, 1.0);

  // ÉPAISSEUR TRAVERSÉE, calculée analytiquement. Un simple pow(fresnel) place
  // le maximum d'intensité sur le bord EXTÉRIEUR de la coquille : on obtient
  // un anneau à bord franc, qui ne ressemble à rien. Ici on mesure la vraie
  // longueur du segment de rayon compris entre la coquille et la surface :
  // elle vaut 0 au bord extérieur, elle est maximale juste au ras du limbe de
  // la planète, et elle décroît doucement sur le disque. La planète est
  // centrée à l'origine du monde, d'où le calcul direct.
  vec3 D = normalize(vWorld - cameraPosition);
  float tca = dot(-cameraPosition, D);
  float b2 = max(dot(cameraPosition, cameraPosition) - tca * tca, 0.0);
  float Ra2 = uShellRadius * uShellRadius;
  float Rp2 = uPlanetRadius * uPlanetRadius;
  float da = sqrt(max(Ra2 - b2, 0.0));
  float dp = sqrt(max(Rp2 - b2, 0.0));
  // Devant la planète on ne voit que la moitié avant de la coquille ; à côté
  // d'elle, le rayon traverse l'atmosphère de part en part.
  float path = (b2 < Rp2) ? (da - dp) : (2.0 * da);
  // Normalisation par le trajet MAXIMAL possible, celui qui rase exactement le
  // limbe de la planète. Normaliser par l'épaisseur de la coquille saturait le
  // rapport sur toute une large bande et redonnait un anneau uniforme.
  float maxPath = 2.0 * sqrt(max(Ra2 - Rp2, 1e-6));
  float limb = clamp(path / maxPath, 0.0, 1.0);
  // Décroissance cubique : le halo doit s'éteindre vite en s'éloignant du
  // limbe, sinon la coquille se lit comme une bulle de verre autour du globe.
  limb = limb * limb * limb;

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

  float intensity = limb * lit * density * (0.60 + 0.28 * uInsolation);
  // Voile interne très léger, pour « poser » la planète sur le fond noir.
  intensity += smoothstep(0.0, 0.45, limb) * lit * density * 0.05;

  // Un souffle très lent évite l'aspect figé.
  intensity *= 0.95 + 0.05 * sin(uTime * 0.25);

  vec3 color = scatter * uSunColor * intensity * 1.10;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export default { atmosphereVertexShader, atmosphereFragmentShader };

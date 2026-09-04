/**
 * ============================================================================
 *  TERRA NOVA — Géométrie de la planète (polyèdre de Goldberg)
 * ============================================================================
 *  Pourquoi ce pavage plutôt qu'une grille lat/lon : une grille sphérique
 *  classique concentre ses cellules aux pôles (distorsion énorme, cellules
 *  dégénérées) alors que le dual d'une icosphère donne des cellules d'aire
 *  quasi constante partout — indispensable pour que la simulation climatique
 *  soit juste et que le joueur ne voie pas de « couture ».
 *
 *  Principe : on subdivise un icosaèdre, puis on prend son DUAL. Chaque SOMMET
 *  de l'icosphère devient une CELLULE dont les coins sont les centres des faces
 *  triangulaires qui l'entourent. Un sommet d'ordre 5 (les 12 sommets d'origine)
 *  donne un pentagone, les autres (ordre 6) donnent des hexagones.
 * ============================================================================
 */

const PHI = (1 + Math.sqrt(5)) / 2;

/** Icosaèdre de référence (winding CCW vu de l'extérieur). */
const BASE_VERTICES = [
  -1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI, 0,
  0, -1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI,
  PHI, 0, -1, PHI, 0, 1, -PHI, 0, -1, -PHI, 0, 1,
];

const BASE_FACES = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

/** Degré maximum d'un sommet d'icosphère : 6 (5 pour les 12 sommets d'origine). */
const MAX_DEGREE = 6;

/**
 * Cache module : la géométrie ne dépend QUE du niveau de subdivision.
 * La regénérer à chaque nouvelle partie serait du gaspillage pur.
 */
const CACHE = new Map();

/* ------------------------------------------------------------------ */
/*  Subdivision de l'icosaèdre                                         */
/* ------------------------------------------------------------------ */

/**
 * Subdivise `n` fois par milieu d'arête. Le cache d'arêtes est essentiel :
 * sans lui chaque arête partagée créerait deux sommets distincts et le dual
 * serait troué.
 */
function subdivide(n) {
  const px = [], py = [], pz = [];
  for (let i = 0; i < 12; i++) {
    const x = BASE_VERTICES[i * 3], y = BASE_VERTICES[i * 3 + 1], z = BASE_VERTICES[i * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z);
    px.push(x / l); py.push(y / l); pz.push(z / l);
  }

  let faces = Int32Array.from(BASE_FACES);

  for (let step = 0; step < n; step++) {
    const edgeCache = new Map();
    const out = new Int32Array(faces.length * 4);
    let o = 0;

    const midpoint = (a, b) => {
      // Clé symétrique : l'arête (a,b) et (b,a) sont la même arête.
      const key = a < b ? a * 1048576 + b : b * 1048576 + a;
      const hit = edgeCache.get(key);
      if (hit !== undefined) return hit;
      let x = px[a] + px[b], y = py[a] + py[b], z = pz[a] + pz[b];
      const l = Math.sqrt(x * x + y * y + z * z);
      const id = px.length;
      px.push(x / l); py.push(y / l); pz.push(z / l);
      edgeCache.set(key, id);
      return id;
    };

    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      out[o++] = a; out[o++] = ab; out[o++] = ca;
      out[o++] = b; out[o++] = bc; out[o++] = ab;
      out[o++] = c; out[o++] = ca; out[o++] = bc;
      out[o++] = ab; out[o++] = bc; out[o++] = ca;
    }
    faces = out;
  }

  return { px, py, pz, faces };
}

/* ------------------------------------------------------------------ */
/*  Construction du dual                                               */
/* ------------------------------------------------------------------ */

/**
 * Construit le polyèdre de Goldberg dual d'une icosphère subdivisée `n` fois.
 * Résultat mis en cache : rappeler avec le même `n` est instantané.
 */
export function buildGoldberg(subdivisions = 3) {
  const n = Math.max(0, subdivisions | 0);
  const cached = CACHE.get(n);
  if (cached) return cached;

  const { px, py, pz, faces } = subdivide(n);
  const count = px.length;              // 10 * 4^n + 2
  const faceCount = faces.length / 3;

  /* --- centres des faces triangulaires = coins des cellules --- */
  const fc = new Float64Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    let x = (px[a] + px[b] + px[c]) / 3;
    let y = (py[a] + py[b] + py[c]) / 3;
    let z = (pz[a] + pz[b] + pz[c]) / 3;
    const l = Math.sqrt(x * x + y * y + z * z);
    fc[f * 3] = x / l; fc[f * 3 + 1] = y / l; fc[f * 3 + 2] = z / l;
  }

  /* --- table sommet -> faces incidentes (CSR) --- */
  const cornerOffsets = new Int32Array(count + 1);
  for (let i = 0; i < faces.length; i++) cornerOffsets[faces[i] + 1]++;
  for (let i = 0; i < count; i++) cornerOffsets[i + 1] += cornerOffsets[i];
  const vertexFaces = new Int32Array(faces.length);
  const cursor = cornerOffsets.slice(0, count);
  for (let f = 0; f < faceCount; f++) {
    vertexFaces[cursor[faces[f * 3]]++] = f;
    vertexFaces[cursor[faces[f * 3 + 1]]++] = f;
    vertexFaces[cursor[faces[f * 3 + 2]]++] = f;
  }

  /* --- adjacence sommet -> sommets (= cellules voisines) --- */
  const adj = new Int32Array(count * MAX_DEGREE).fill(-1);
  const degree = new Int32Array(count);
  const link = (a, b) => {
    const base = a * MAX_DEGREE, d = degree[a];
    for (let k = 0; k < d; k++) if (adj[base + k] === b) return;
    adj[base + d] = b; degree[a] = d + 1;
  };
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    link(a, b); link(b, a); link(b, c); link(c, b); link(c, a); link(a, c);
  }

  const neighborOffsets = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) neighborOffsets[i + 1] = neighborOffsets[i] + degree[i];
  const neighbors = new Int32Array(neighborOffsets[count]);

  /* --- sortie --- */
  const positions = new Float32Array(count * 3);
  const latitude = new Float32Array(count);
  const corners = new Float32Array(cornerOffsets[count] * 3);
  const area = new Float32Array(count);

  // Scratch réutilisé : trier 5-6 éléments ne doit rien allouer.
  const sAngle = new Float64Array(MAX_DEGREE);
  const sItem = new Int32Array(MAX_DEGREE);

  let totalArea = 0;

  for (let i = 0; i < count; i++) {
    const cx = px[i], cy = py[i], cz = pz[i];
    positions[i * 3] = cx; positions[i * 3 + 1] = cy; positions[i * 3 + 2] = cz;
    latitude[i] = cy;

    /* Base tangente : (t, bt, centre) est directe, donc un atan2 croissant
       dans cette base = sens trigonométrique vu de l'EXTÉRIEUR de la sphère.
       Sans ce tri, les polygones seraient croisés au rendu. */
    let ax = 0, ay = 0, az = 0;
    const axc = Math.abs(cx), ayc = Math.abs(cy), azc = Math.abs(cz);
    if (axc <= ayc && axc <= azc) ax = 1; else if (ayc <= azc) ay = 1; else az = 1;
    let tx = ay * cz - az * cy, ty = az * cx - ax * cz, tz = ax * cy - ay * cx;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    tx /= tl; ty /= tl; tz /= tl;
    const bx = cy * tz - cz * ty, by = cz * tx - cx * tz, bz = cx * ty - cy * tx;

    /* --- coins triés --- */
    const cs = cornerOffsets[i], ce = cornerOffsets[i + 1], k = ce - cs;
    for (let j = 0; j < k; j++) {
      const f = vertexFaces[cs + j];
      const dx = fc[f * 3] - cx, dy = fc[f * 3 + 1] - cy, dz = fc[f * 3 + 2] - cz;
      sAngle[j] = Math.atan2(dx * bx + dy * by + dz * bz, dx * tx + dy * ty + dz * tz);
      sItem[j] = f;
    }
    insertionSort(sAngle, sItem, k);
    for (let j = 0; j < k; j++) {
      const f = sItem[j], o = (cs + j) * 3;
      corners[o] = fc[f * 3]; corners[o + 1] = fc[f * 3 + 1]; corners[o + 2] = fc[f * 3 + 2];
    }

    /* --- voisins triés dans le même sens angulaire --- */
    const ns = neighborOffsets[i], d = degree[i];
    for (let j = 0; j < d; j++) {
      const v = adj[i * MAX_DEGREE + j];
      const dx = px[v] - cx, dy = py[v] - cy, dz = pz[v] - cz;
      sAngle[j] = Math.atan2(dx * bx + dy * by + dz * bz, dx * tx + dy * ty + dz * tz);
      sItem[j] = v;
    }
    insertionSort(sAngle, sItem, d);
    for (let j = 0; j < d; j++) neighbors[ns + j] = sItem[j];

    /* --- aire : |somme des produits vectoriels| / 2 (polygone quasi plan) --- */
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < k; j++) {
      const o1 = (cs + j) * 3, o2 = (cs + ((j + 1) % k)) * 3;
      const x1 = corners[o1], y1 = corners[o1 + 1], z1 = corners[o1 + 2];
      const x2 = corners[o2], y2 = corners[o2 + 1], z2 = corners[o2 + 2];
      nx += y1 * z2 - z1 * y2; ny += z1 * x2 - x1 * z2; nz += x1 * y2 - y1 * x2;
    }
    const a = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    area[i] = a;
    totalArea += a;
  }

  // Normalisation : moyenne = 1, pour que l'aire serve directement de poids.
  const scale = totalArea > 0 ? count / totalArea : 1;
  for (let i = 0; i < count; i++) area[i] *= scale;

  const result = {
    subdivisions: n, count, positions, corners, cornerOffsets,
    neighbors, neighborOffsets, area, latitude,
  };
  CACHE.set(n, result);
  return result;
}

/** Tri par insertion sur deux tableaux parallèles (n <= 6 : imbattable). */
function insertionSort(keys, values, n) {
  for (let i = 1; i < n; i++) {
    const kk = keys[i], vv = values[i];
    let j = i - 1;
    while (j >= 0 && keys[j] > kk) { keys[j + 1] = keys[j]; values[j + 1] = values[j]; j--; }
    keys[j + 1] = kk; values[j + 1] = vv;
  }
}

/** Nombre de cellules pour un niveau donné, sans rien construire. */
export function goldbergCellCount(subdivisions) {
  return 10 * Math.pow(4, Math.max(0, subdivisions | 0)) + 2;
}

/** Vide le cache (tests / rechargement à chaud). */
export function clearGoldbergCache() { CACHE.clear(); }

export default buildGoldberg;

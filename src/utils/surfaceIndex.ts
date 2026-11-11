import * as THREE from "three";

/** Result of {@link SurfaceIndex.nearest}. Normal is the unit outward pseudonormal at the closest point. */
export interface SurfaceHit {
  distanceSq: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  triangle: number;
  /** Barycentric weights of the closest point on the triangle's three vertices. */
  u: number;
  v: number;
  w: number;
}

export const createSurfaceHit = (): SurfaceHit => ({
  distanceSq: Infinity, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, triangle: -1, u: 0, v: 0, w: 0,
});

const MAX_CELLS_PER_AXIS = 64;

// Closest-point scratch, written by closestOnTriangle.
let cx = 0, cy = 0, cz = 0, bu = 0, bv = 0, bw = 0;
// 0 face, 1..3 vertex a/b/c, 4 edge ab, 5 edge bc, 6 edge ca
let region = 0;

/** Ericson, Real-Time Collision Detection 5.1.5, also reporting the closest feature. */
function closestOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  qx: number, qy: number, qz: number
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = qx - ax, acy = qy - ay, acz = qz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { cx = ax; cy = ay; cz = az; bu = 1; bv = 0; bw = 0; region = 1; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { cx = bx; cy = by; cz = bz; bu = 0; bv = 1; bw = 0; region = 2; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    cx = ax + abx * t; cy = ay + aby * t; cz = az + abz * t; bu = 1 - t; bv = t; bw = 0; region = 4; return;
  }
  const cpx = px - qx, cpy = py - qy, cpz = pz - qz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { cx = qx; cy = qy; cz = qz; bu = 0; bv = 0; bw = 1; region = 3; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    cx = ax + acx * t; cy = ay + acy * t; cz = az + acz * t; bu = 1 - t; bv = 0; bw = t; region = 6; return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    cx = bx + (qx - bx) * t; cy = by + (qy - by) * t; cz = bz + (qz - bz) * t; bu = 0; bv = 1 - t; bw = t; region = 5; return;
  }
  const sum = va + vb + vc;
  if (!(sum > 0)) { cx = ax; cy = ay; cz = az; bu = 1; bv = 0; bw = 0; region = 1; return; } // degenerate triangle
  const v = vb / sum, w = vc / sum;
  cx = ax + abx * v + acx * w; cy = ay + aby * v + acy * w; cz = az + abz * v + acz * w;
  bu = 1 - v - w; bv = v; bw = w; region = 0;
}

/**
 * Nearest-point and inside/outside queries on a triangle mesh whose vertices move but whose
 * topology does not. Positions are owned by the caller: write them, call `markDirty()`, query.
 * Inside tests use angle-weighted pseudonormals (Bærentzen & Aanæs), exact for closed manifolds.
 */
export class SurfaceIndex {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  /** Every edge is shared by an even number of triangles (two, or four at a pinched seam). */
  readonly closed: boolean;
  /** Unit angle-weighted vertex normals in winding order; valid after `ensureNormals()`. */
  readonly vertexNormals: Float32Array;
  readonly min = new Float64Array(3);
  readonly max = new Float64Array(3);
  private readonly faceNormals: Float32Array;
  private readonly edgeNormals: Float32Array;
  private readonly triangleEdges: Uint32Array;
  /** +1 when the winding encloses positive volume, -1 when it is inverted. */
  private orientation = 1;
  private normalsDirty = true;
  private gridDirty = true;
  private cellSize = 1;
  private readonly dims = new Int32Array(3);
  private cellStart = new Uint32Array(0);
  private cellItems = new Uint32Array(0);
  private readonly stamp: Uint32Array;
  private query = 0;

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.positions = positions;
    this.indices = indices;
    this.triangleCount = Math.floor(indices.length / 3);
    const vertexCount = positions.length / 3;
    const edgeIds = new Map<number, number>();
    const uses: number[] = [];
    this.triangleEdges = new Uint32Array(this.triangleCount * 3);
    for (let t = 0; t < this.triangleCount; t += 1) {
      for (let e = 0; e < 3; e += 1) {
        const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
        const key = Math.min(a, b) * vertexCount + Math.max(a, b);
        let id = edgeIds.get(key);
        if (id === undefined) {
          id = uses.length;
          edgeIds.set(key, id);
          uses.push(0);
        }
        uses[id] += 1;
        this.triangleEdges[t * 3 + e] = id;
      }
    }
    this.closed = this.triangleCount > 0 && uses.every((count) => count > 0 && count % 2 === 0);
    this.faceNormals = new Float32Array(this.triangleCount * 3);
    this.edgeNormals = new Float32Array(uses.length * 3);
    this.vertexNormals = new Float32Array(positions.length);
    this.stamp = new Uint32Array(this.triangleCount);
  }

  markDirty() {
    this.normalsDirty = true;
    this.gridDirty = true;
  }

  ensureNormals() {
    if (!this.normalsDirty) return;
    this.normalsDirty = false;
    const p = this.positions, idx = this.indices, fn = this.faceNormals, vn = this.vertexNormals, en = this.edgeNormals;
    vn.fill(0);
    en.fill(0);
    this.min.fill(Infinity);
    this.max.fill(-Infinity);
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        if (p[i + k] < this.min[k]) this.min[k] = p[i + k];
        if (p[i + k] > this.max[k]) this.max[k] = p[i + k];
      }
    }
    let sixVolume = 0;
    for (let t = 0; t < this.triangleCount; t += 1) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
      const bcx = p[c] - p[b], bcy = p[c + 1] - p[b + 1], bcz = p[c + 2] - p[b + 2];
      let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      sixVolume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
      const length = Math.hypot(nx, ny, nz);
      if (length > 0) { nx /= length; ny /= length; nz /= length; }
      fn[t * 3] = nx; fn[t * 3 + 1] = ny; fn[t * 3 + 2] = nz;
      const lab = Math.hypot(abx, aby, abz), lac = Math.hypot(acx, acy, acz), lbc = Math.hypot(bcx, bcy, bcz);
      const angle = (dot: number, l1: number, l2: number) => l1 > 0 && l2 > 0 ? Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2)))) : 0;
      const angleA = angle(abx * acx + aby * acy + abz * acz, lab, lac);
      const angleB = angle(-abx * bcx - aby * bcy - abz * bcz, lab, lbc);
      const angleC = Math.max(0, Math.PI - angleA - angleB);
      vn[a] += nx * angleA; vn[a + 1] += ny * angleA; vn[a + 2] += nz * angleA;
      vn[b] += nx * angleB; vn[b + 1] += ny * angleB; vn[b + 2] += nz * angleB;
      vn[c] += nx * angleC; vn[c + 1] += ny * angleC; vn[c + 2] += nz * angleC;
      for (let e = 0; e < 3; e += 1) {
        const edge = this.triangleEdges[t * 3 + e] * 3;
        en[edge] += nx; en[edge + 1] += ny; en[edge + 2] += nz;
      }
    }
    normalize(vn);
    normalize(en);
    this.orientation = this.closed && sixVolume < 0 ? -1 : 1;
  }

  private ensureGrid() {
    this.ensureNormals();
    if (!this.gridDirty) return;
    this.gridDirty = false;
    const p = this.positions, idx = this.indices, dims = this.dims;
    const extent = Math.max(this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]);
    const perAxis = Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.ceil(Math.cbrt(this.triangleCount) * 1.5)));
    this.cellSize = extent > 0 ? extent / perAxis : 1;
    let cellCount = 1;
    for (let k = 0; k < 3; k += 1) {
      dims[k] = Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.ceil((this.max[k] - this.min[k]) / this.cellSize)));
      cellCount *= dims[k];
    }
    if (this.cellStart.length !== cellCount + 1) this.cellStart = new Uint32Array(cellCount + 1);
    const start = this.cellStart;
    start.fill(0);
    const range = new Int32Array(6);
    const triangleRange = (t: number) => {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      for (let k = 0; k < 3; k += 1) {
        range[k] = this.cell(Math.min(p[a + k], p[b + k], p[c + k]), k);
        range[k + 3] = this.cell(Math.max(p[a + k], p[b + k], p[c + k]), k);
      }
    };
    for (let t = 0; t < this.triangleCount; t += 1) {
      triangleRange(t);
      for (let x = range[0]; x <= range[3]; x += 1)
        for (let y = range[1]; y <= range[4]; y += 1)
          for (let z = range[2]; z <= range[5]; z += 1) start[(x * dims[1] + y) * dims[2] + z + 1] += 1;
    }
    for (let i = 1; i <= cellCount; i += 1) start[i] += start[i - 1];
    if (this.cellItems.length < start[cellCount]) this.cellItems = new Uint32Array(start[cellCount]);
    const fill = start.slice(0, cellCount);
    for (let t = 0; t < this.triangleCount; t += 1) {
      triangleRange(t);
      for (let x = range[0]; x <= range[3]; x += 1)
        for (let y = range[1]; y <= range[4]; y += 1)
          for (let z = range[2]; z <= range[5]; z += 1) this.cellItems[fill[(x * dims[1] + y) * dims[2] + z]++] = t;
    }
  }

  private cell(value: number, axis: number) {
    const c = Math.floor((value - this.min[axis]) / this.cellSize);
    return c < 0 ? 0 : c >= this.dims[axis] ? this.dims[axis] - 1 : c;
  }

  /**
   * Finds the closest surface point within `maxDistanceSq`. Returns false when there is none.
   * `dot(point - closest, normal) < 0` means the point is inside a closed surface.
   */
  nearest(px: number, py: number, pz: number, hit: SurfaceHit, maxDistanceSq = Infinity): boolean {
    if (this.triangleCount === 0) return false;
    this.ensureGrid();
    this.query += 1;
    if (this.query === 0xffffffff) { this.stamp.fill(0); this.query = 1; }
    const dims = this.dims, h = this.cellSize, min = this.min, p = this.positions, idx = this.indices;
    const ci = this.cell(px, 0), cj = this.cell(py, 1), ck = this.cell(pz, 2);
    let best = maxDistanceSq;
    let bestTriangle = -1, bestRegion = 0;
    let hx = 0, hy = 0, hz = 0, hu = 0, hv = 0, hw = 0;
    const visit = (cellIndex: number) => {
      for (let i = this.cellStart[cellIndex], end = this.cellStart[cellIndex + 1]; i < end; i += 1) {
        const t = this.cellItems[i];
        if (this.stamp[t] === this.query) continue;
        this.stamp[t] = this.query;
        const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
        closestOnTriangle(px, py, pz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]);
        const dx = px - cx, dy = py - cy, dz = pz - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) {
          best = d2; bestTriangle = t; bestRegion = region;
          hx = cx; hy = cy; hz = cz; hu = bu; hv = bv; hw = bw;
        }
      }
    };
    for (let r = 0; ; r += 1) {
      const x0 = Math.max(0, ci - r), x1 = Math.min(dims[0] - 1, ci + r);
      const y0 = Math.max(0, cj - r), y1 = Math.min(dims[1] - 1, cj + r);
      const z0 = Math.max(0, ck - r), z1 = Math.min(dims[2] - 1, ck + r);
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const row = (x * dims[1] + y) * dims[2];
          if (Math.abs(x - ci) === r || Math.abs(y - cj) === r) {
            for (let z = z0; z <= z1; z += 1) visit(row + z);
          } else {
            if (ck - r >= 0) visit(row + ck - r);
            if (r > 0 && ck + r < dims[2]) visit(row + ck + r);
          }
        }
      }
      // Stop once the searched block covers the grid or provably holds the nearest triangle.
      let margin = Infinity;
      const lows = [ci - r, cj - r, ck - r], highs = [ci + r, cj + r, ck + r], point = [px, py, pz];
      for (let k = 0; k < 3; k += 1) {
        if (lows[k] > 0) margin = Math.min(margin, point[k] - (min[k] + lows[k] * h));
        if (highs[k] < dims[k] - 1) margin = Math.min(margin, min[k] + (highs[k] + 1) * h - point[k]);
      }
      if (margin === Infinity || (margin > 0 && margin * margin >= best)) break;
    }
    if (bestTriangle < 0) return false;

    const fn = this.faceNormals, vn = this.vertexNormals, en = this.edgeNormals;
    let source: Float32Array, at: number;
    if (bestRegion === 0) { source = fn; at = bestTriangle * 3; }
    else if (bestRegion <= 3) { source = vn; at = idx[bestTriangle * 3 + bestRegion - 1] * 3; }
    else { source = en; at = this.triangleEdges[bestTriangle * 3 + bestRegion - 4] * 3; }
    const o = this.orientation;
    hit.distanceSq = best;
    hit.x = hx; hit.y = hy; hit.z = hz;
    hit.nx = source[at] * o; hit.ny = source[at + 1] * o; hit.nz = source[at + 2] * o;
    hit.triangle = bestTriangle;
    hit.u = hu; hit.v = hv; hit.w = hw;
    return true;
  }
}

function normalize(values: Float32Array) {
  for (let i = 0; i < values.length; i += 3) {
    const length = Math.hypot(values[i], values[i + 1], values[i + 2]);
    if (length > 0) { values[i] /= length; values[i + 1] /= length; values[i + 2] /= length; }
  }
}

interface GeometrySurface {
  index: SurfaceIndex;
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  version: number;
  sourceToWelded: Uint32Array;
}

const geometrySurfaces = new WeakMap<THREE.BufferGeometry, GeometrySurface>();
const registeredSurfaces = new WeakMap<THREE.Object3D, () => SurfaceIndex>();

/** Lets a mesh supply its own up-to-date surface (SoftBody uses its physics vertices). */
export function registerSurface(mesh: THREE.Object3D, provide: () => SurfaceIndex) {
  registeredSurfaces.set(mesh, provide);
}

export function unregisterSurface(mesh: THREE.Object3D) {
  registeredSurfaces.delete(mesh);
}

/**
 * The surface of a mesh in its local space: a registered provider, or the geometry welded
 * by position (so UV and normal seams do not split the topology), refreshed when it changes.
 */
export function getSurfaceIndex(mesh: THREE.Mesh): SurfaceIndex | null {
  const provide = registeredSurfaces.get(mesh);
  if (provide) return provide();
  const geometry = mesh.geometry;
  const attribute = geometry.getAttribute("position");
  if (!attribute || attribute.count < 3) return null;
  let entry = geometrySurfaces.get(geometry);
  if (!entry || entry.attribute !== attribute || entry.index.positions.length === 0) {
    entry = weldGeometry(geometry, attribute);
    geometrySurfaces.set(geometry, entry);
  }
  const version = "version" in attribute ? attribute.version : -1;
  if (entry.version !== version) {
    entry.version = version;
    const positions = entry.index.positions;
    for (let i = 0; i < attribute.count; i += 1) {
      const target = entry.sourceToWelded[i] * 3;
      positions[target] = attribute.getX(i);
      positions[target + 1] = attribute.getY(i);
      positions[target + 2] = attribute.getZ(i);
    }
    entry.index.markDirty();
  }
  return entry.index;
}

function weldGeometry(
  geometry: THREE.BufferGeometry,
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
): GeometrySurface {
  const ids = new Map<string, number>();
  const sourceToWelded = new Uint32Array(attribute.count);
  const welded: number[] = [];
  for (let i = 0; i < attribute.count; i += 1) {
    const x = attribute.getX(i), y = attribute.getY(i), z = attribute.getZ(i);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      ids.set(key, id);
      welded.push(x, y, z);
    }
    sourceToWelded[i] = id;
  }
  const source = geometry.getIndex();
  const count = source?.count ?? attribute.count;
  const triangles: number[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const a = sourceToWelded[source?.getX(i) ?? i];
    const b = sourceToWelded[source?.getX(i + 1) ?? i + 1];
    const c = sourceToWelded[source?.getX(i + 2) ?? i + 2];
    if (a !== b && b !== c && c !== a) triangles.push(a, b, c);
  }
  const version = "version" in attribute ? attribute.version : -1;
  return {
    index: new SurfaceIndex(new Float32Array(welded), new Uint32Array(triangles)),
    attribute,
    version,
    sourceToWelded,
  };
}

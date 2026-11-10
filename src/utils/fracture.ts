import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { analyzeMeshTopology } from "./meshTopology";

export interface FractureShard {
  geometry: THREE.BufferGeometry;
  offset: THREE.Vector3;
  volume: number;
}

function volumeOf(geometry: THREE.BufferGeometry): number {
  const p = geometry.getAttribute("position");
  const index = geometry.getIndex();
  let volume = 0;
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    const a = index?.getX(i) ?? i, b = index?.getX(i + 1) ?? i + 1, c = index?.getX(i + 2) ?? i + 2;
    const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
    const bx = p.getX(b), by = p.getY(b), bz = p.getZ(b);
    const cx = p.getX(c), cy = p.getY(c), cz = p.getZ(c);
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return Math.abs(volume / 6);
}

function pointsOf(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const p = geometry.getAttribute("position");
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i));
}

function uniquePoints(points: THREE.Vector3[]): THREE.Vector3[] {
  const unique: THREE.Vector3[] = [];
  for (const point of points) if (!unique.some((other) => other.distanceToSquared(point) < 1e-12)) unique.push(point);
  return unique;
}

/** A convex geometry can be split along a plane without losing its original surface. */
function splitConvex(geometry: THREE.BufferGeometry, plane: THREE.Plane): [THREE.BufferGeometry, THREE.BufferGeometry] | null {
  const vertices = pointsOf(geometry);
  const index = geometry.getIndex();
  const positive: THREE.Vector3[] = [];
  const negative: THREE.Vector3[] = [];
  for (const p of vertices) {
    const distance = plane.distanceToPoint(p);
    if (distance >= -1e-6) positive.push(p);
    if (distance <= 1e-6) negative.push(p);
  }
  for (let i = 0; i < (index?.count ?? vertices.length); i += 3) {
    const tri = [index?.getX(i) ?? i, index?.getX(i + 1) ?? i + 1, index?.getX(i + 2) ?? i + 2];
    for (let e = 0; e < 3; e += 1) {
      const a = vertices[tri[e]], b = vertices[tri[(e + 1) % 3]];
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
      if (da * db < -1e-12) {
        const point = a.clone().lerp(b, da / (da - db));
        positive.push(point);
        negative.push(point);
      }
    }
  }
  const positivePoints = uniquePoints(positive);
  const negativePoints = uniquePoints(negative);
  if (positivePoints.length < 4 || negativePoints.length < 4) return null;
  const a = new ConvexGeometry(positivePoints);
  const b = new ConvexGeometry(negativePoints);
  if (volumeOf(a) < 1e-7 || volumeOf(b) < 1e-7) {
    a.dispose(); b.dispose();
    return null;
  }
  return [a, b];
}

function isConvex(geometry: THREE.BufferGeometry): boolean {
  const vertices = pointsOf(geometry);
  const index = geometry.getIndex();
  const welded: number[] = [];
  const mapping: number[] = [];
  const keys = new Map<string, number>();
  for (const vertex of vertices) {
    const key = `${Math.round(vertex.x * 1e6)},${Math.round(vertex.y * 1e6)},${Math.round(vertex.z * 1e6)}`;
    let id = keys.get(key);
    if (id == null) {
      id = welded.length / 3;
      keys.set(key, id);
      welded.push(vertex.x, vertex.y, vertex.z);
    }
    mapping.push(id);
  }
  const triangles = Array.from({ length: index?.count ?? vertices.length }, (_, i) => mapping[index?.getX(i) ?? i]);
  if (!analyzeMeshTopology(welded, triangles).closed) return false;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const orientation = Math.sign(signedVolume(geometry));
  if (!orientation) return false;
  for (let i = 0; i < (index?.count ?? vertices.length); i += 3) {
    a.copy(vertices[index?.getX(i) ?? i]);
    b.copy(vertices[index?.getX(i + 1) ?? i + 1]);
    c.copy(vertices[index?.getX(i + 2) ?? i + 2]);
    normal.subVectors(b, a).cross(c.sub(a)).multiplyScalar(orientation);
    for (const v of vertices) if (normal.dot(v.clone().sub(a)) > 1e-5) return false;
  }
  return true;
}

function signedVolume(geometry: THREE.BufferGeometry): number {
  const p = geometry.getAttribute("position"), index = geometry.getIndex();
  let sum = 0;
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    const a = index?.getX(i) ?? i, b = index?.getX(i + 1) ?? i + 1, c = index?.getX(i + 2) ?? i + 2;
    sum += p.getX(a) * (p.getY(b) * p.getZ(c) - p.getZ(b) * p.getY(c))
      + p.getY(a) * (p.getZ(b) * p.getX(c) - p.getX(b) * p.getZ(c))
      + p.getZ(a) * (p.getX(b) * p.getY(c) - p.getY(b) * p.getX(c));
  }
  return sum / 6;
}

/** Precompute convex shards once; pass authored shards for concave or textured assets. */
export function fractureGeometry(geometry: THREE.BufferGeometry, pieces = 8): FractureShard[] {
  if (!Number.isInteger(pieces) || pieces < 2 || pieces > 64) throw new Error("pieces must be an integer from 2 to 64");
  if (!isConvex(geometry)) throw new Error("Automatic fracture needs a sealed convex mesh; supply authored shards for concave meshes");
  const fragments: THREE.BufferGeometry[] = [geometry];
  while (fragments.length < pieces) {
    let largest = 0;
    for (let i = 1; i < fragments.length; i += 1) if (volumeOf(fragments[i]) > volumeOf(fragments[largest])) largest = i;
    const source = fragments[largest];
    source.computeBoundingBox();
    const center = source.boundingBox!.getCenter(new THREE.Vector3());
    const n = fragments.length;
    const normal = new THREE.Vector3(Math.sin(n * 2.4), Math.cos(n * 1.7), Math.sin(n * 3.1)).normalize();
    const split = splitConvex(source, new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center));
    if (!split) break;
    fragments.splice(largest, 1, ...split);
    if (source !== geometry) source.dispose();
  }
  const shards = prepareShards(fragments);
  for (const fragment of fragments) if (fragment !== geometry) fragment.dispose();
  return shards;
}

export function prepareShards(geometries: readonly THREE.BufferGeometry[]): FractureShard[] {
  return geometries.map((source) => {
    if (!isConvex(source)) throw new Error("Every fracture shard must be a sealed convex mesh");
    const geometry = source.clone();
    geometry.computeBoundingBox();
    const offset = geometry.boundingBox!.getCenter(new THREE.Vector3());
    geometry.translate(-offset.x, -offset.y, -offset.z);
    const volume = volumeOf(geometry);
    if (volume <= 0) throw new Error("Fracture shards must be closed triangle meshes");
    return { geometry, offset, volume };
  });
}

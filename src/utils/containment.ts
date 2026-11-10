import * as THREE from "three";

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const closest = new THREE.Vector3();
const nearest = new THREE.Vector3();
const localPoint = new THREE.Vector3();
const normal = new THREE.Vector3();
const triangle = new THREE.Triangle();
const matrix = new THREE.Matrix3();
const cross = new THREE.Vector3();
const scale = new THREE.Vector3();

/** Project a sphere center into a deformed, consistently wound, closed shell. */
export function containSphere(
  mesh: THREE.Mesh,
  worldPoint: THREE.Vector3,
  worldRadius: number
): { position: THREE.Vector3; inwardNormal: THREE.Vector3 } | null {
  const positions = mesh.geometry.getAttribute("position");
  if (!positions || positions.count < 4) return null;
  mesh.updateWorldMatrix(true, false);
  localPoint.copy(worldPoint);
  mesh.worldToLocal(localPoint);
  const index = mesh.geometry.getIndex();
  const count = index?.count ?? positions.count;
  let winding = 0;
  let sixVolume = 0;
  let nearestDistanceSq = Infinity;
  mesh.getWorldScale(scale);
  const minimumScale = Math.min(scale.x, scale.y, scale.z);
  if (minimumScale <= 0) throw new Error("Container mesh scale must be positive");
  const localRadius = worldRadius / minimumScale;

  for (let i = 0; i < count; i += 3) {
    const ia = index?.getX(i) ?? i;
    const ib = index?.getX(i + 1) ?? i + 1;
    const ic = index?.getX(i + 2) ?? i + 2;
    a.fromBufferAttribute(positions, ia);
    b.fromBufferAttribute(positions, ib);
    c.fromBufferAttribute(positions, ic);
    triangle.set(a, b, c);
    triangle.closestPointToPoint(localPoint, closest);
    const distanceSq = closest.distanceToSquared(localPoint);
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest.copy(closest);
      triangle.getNormal(normal);
    }
    sixVolume += a.dot(cross.crossVectors(b, c));
    a.sub(localPoint);
    b.sub(localPoint);
    c.sub(localPoint);
    const la = a.length(), lb = b.length(), lc = c.length();
    const numerator = a.dot(cross.crossVectors(b, c));
    const denominator = la * lb * lc + a.dot(b) * lc + b.dot(c) * la + c.dot(a) * lb;
    winding += 2 * Math.atan2(numerator, denominator);
  }

  const inside = Math.abs(winding) > 2 * Math.PI;
  if (inside && nearestDistanceSq >= localRadius * localRadius) return null;
  if (sixVolume > 0) normal.negate();
  const position = mesh.localToWorld(nearest.addScaledVector(normal, localRadius + 1e-4).clone());
  const inwardNormal = normal.applyMatrix3(matrix.getNormalMatrix(mesh.matrixWorld)).normalize().clone();
  return { position, inwardNormal };
}

import * as THREE from "three";
import { createSurfaceHit, getSurfaceIndex } from "./surfaceIndex";

const localPoint = new THREE.Vector3();
const scale = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();
const hit = createSurfaceHit();

/**
 * Project a sphere center into a deformed, closed shell. Uses the mesh's cached surface index,
 * so each query only visits triangles near the point.
 */
export function containSphere(
  mesh: THREE.Mesh,
  worldPoint: THREE.Vector3,
  worldRadius: number
): { position: THREE.Vector3; inwardNormal: THREE.Vector3 } | null {
  const surface = getSurfaceIndex(mesh);
  if (!surface || surface.triangleCount < 4) return null;
  mesh.updateWorldMatrix(true, false);
  mesh.getWorldScale(scale);
  const minimumScale = Math.min(scale.x, scale.y, scale.z);
  if (minimumScale <= 0) throw new Error("Container mesh scale must be positive");
  const localRadius = worldRadius / minimumScale;
  localPoint.copy(worldPoint);
  mesh.worldToLocal(localPoint);
  if (!surface.nearest(localPoint.x, localPoint.y, localPoint.z, hit)) return null;

  const side = (localPoint.x - hit.x) * hit.nx + (localPoint.y - hit.y) * hit.ny + (localPoint.z - hit.z) * hit.nz;
  if (side < 0 && hit.distanceSq >= localRadius * localRadius) return null;
  const offset = localRadius + 1e-4;
  const position = mesh.localToWorld(new THREE.Vector3(hit.x - hit.nx * offset, hit.y - hit.ny * offset, hit.z - hit.nz * offset));
  const inwardNormal = new THREE.Vector3(-hit.nx, -hit.ny, -hit.nz)
    .applyMatrix3(normalMatrix.getNormalMatrix(mesh.matrixWorld))
    .normalize();
  return { position, inwardNormal };
}

import * as THREE from 'three';
import type Jolt from 'jolt-physics';

// Assuming Jolt instance is passed or available globally if you prefer
export const toJoltVec3 = (jolt: typeof Jolt, v: THREE.Vector3 | [number, number, number]) => {
  if (Array.isArray(v)) return new jolt.Vec3(v[0], v[1], v[2]);
  return new jolt.Vec3(v.x, v.y, v.z);
};

export const toJoltRVec3 = (jolt: typeof Jolt, v: THREE.Vector3 | [number, number, number]) => {
  if (Array.isArray(v)) return new jolt.RVec3(v[0], v[1], v[2]);
  return new jolt.RVec3(v.x, v.y, v.z);
};

export const toJoltQuat = (jolt: typeof Jolt, q: THREE.Quaternion | [number, number, number, number]) => {
  if (Array.isArray(q)) return new jolt.Quat(q[0], q[1], q[2], q[3]);
  return new jolt.Quat(q.x, q.y, q.z, q.w);
};

export const LAYER_NON_MOVING = 0;
export const LAYER_MOVING = 1;

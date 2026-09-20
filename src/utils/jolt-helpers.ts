import * as THREE from 'three';
import type Jolt from 'jolt-physics';
import { getJolt } from './joltLoader';

// Helper types
export type anyVec3 = Jolt.Vec3 | Jolt.RVec3 | THREE.Vector3 | [number, number, number] | number[];
export type anyQuat = Jolt.Quat | THREE.Quaternion | [number, number, number, number];

export const vec3 = {
    threeToJolt: (jolt: typeof Jolt, vector: THREE.Vector3): Jolt.Vec3 => 
        new jolt.Vec3(vector.x, vector.y, vector.z),

    threeToJoltR: (jolt: typeof Jolt, vector: THREE.Vector3): Jolt.RVec3 => 
        new jolt.RVec3(vector.x, vector.y, vector.z),
    
    joltToThree: (vec: Jolt.Vec3, out = new THREE.Vector3()): THREE.Vector3 =>
        out.set(vec.GetX(), vec.GetY(), vec.GetZ()),

    tupleToJolt: (jolt: typeof Jolt, tuple: [number, number, number]): Jolt.Vec3 =>
        new jolt.Vec3(tuple[0], tuple[1], tuple[2]),

    // Polymorphic converter
    jolt: (jolt: typeof Jolt, vec: anyVec3): Jolt.Vec3 => {
        if (Array.isArray(vec)) return new jolt.Vec3(vec[0], vec[1], vec[2]);
        if (vec instanceof THREE.Vector3) return new jolt.Vec3(vec.x, vec.y, vec.z);
        // Assuming it's already a Jolt Vec3 if it has GetX
        if ((vec as Jolt.Vec3).GetX) return vec as Jolt.Vec3;
        return new jolt.Vec3(0, 0, 0);
    },

    three: (vec: anyVec3): THREE.Vector3 => {
        if (Array.isArray(vec)) return new THREE.Vector3(vec[0], vec[1], vec[2]);
        if ((vec as Jolt.Vec3).GetX) return new THREE.Vector3((vec as Jolt.Vec3).GetX(), (vec as Jolt.Vec3).GetY(), (vec as Jolt.Vec3).GetZ());
        return vec as THREE.Vector3;
    }
};

export const quat = {
    threeToJolt: (jolt: typeof Jolt, q: THREE.Quaternion): Jolt.Quat =>
        new jolt.Quat(q.x, q.y, q.z, q.w),

    joltToThree: (q: Jolt.Quat, out = new THREE.Quaternion()): THREE.Quaternion =>
        out.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW()),
    
    jolt: (jolt: typeof Jolt, q: anyQuat): Jolt.Quat => {
        if (Array.isArray(q)) return new jolt.Quat(q[0], q[1], q[2], q[3]);
        if (q instanceof THREE.Quaternion) return new jolt.Quat(q.x, q.y, q.z, q.w);
        if ((q as Jolt.Quat).GetX) return q as Jolt.Quat;
        return new jolt.Quat(0, 0, 0, 1);
    },

    three: (q: anyQuat): THREE.Quaternion => {
        if (Array.isArray(q)) return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
        if ((q as Jolt.Quat).GetX) return new THREE.Quaternion((q as Jolt.Quat).GetX(), (q as Jolt.Quat).GetY(), (q as Jolt.Quat).GetZ(), (q as Jolt.Quat).GetW());
        return q as THREE.Quaternion;
    }
};

export const LAYER_NON_MOVING = 0;
export const LAYER_MOVING = 1;
export const LAYER_RIG = 2; // Adding RIG layer if needed later

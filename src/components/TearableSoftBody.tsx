import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type Jolt from "jolt-physics";
import { SoftBody, type SoftBodyProps } from "./SoftBody";
import { tearSurface } from "../utils/tearSurface";

interface Fragment {
  id: number;
  geometry: THREE.BufferGeometry;
  position: [number, number, number];
  rotation: [number, number, number, number];
  velocity?: [number, number, number];
}

export interface TearableSoftBodyHandle {
  /** The plane is in world coordinates. Returns false when it misses the surface. */
  tear(plane: THREE.Plane, fragmentIndex?: number): boolean;
}

export interface TearableSoftBodyProps extends Omit<SoftBodyProps, "geometry" | "type" | "pressure" | "initialLinearVelocity" | "onBodyCreated" | "children"> {
  /** An open surface, such as cloth; closed pressurized shells are not supported. */
  geometry: THREE.BufferGeometry;
  /** Stretch ratio at which an edge tears. Omit for manual tearing only. */
  tearStrain?: number;
  maxTears?: number;
  onTear?: (fragmentCount: number) => void;
}

export const TearableSoftBody = React.forwardRef<TearableSoftBodyHandle, TearableSoftBodyProps>(function TearableSoftBody({
  geometry,
  position = [0, 0, 0],
  rotation = [0, 0, 0, 1],
  tearStrain,
  maxTears = 1,
  onTear,
  ...softProps
}, ref) {
  if (tearStrain != null && (!Number.isFinite(tearStrain) || tearStrain <= 1)) throw new Error("tearStrain must be finite and exceed 1");
  if (!Number.isInteger(maxTears) || maxTears < 0) throw new Error("maxTears must be a nonnegative integer");
  const [fragments, setFragments] = useState<Fragment[]>(() => [{ id: 0, geometry, position, rotation }]);
  const live = useRef(new Map<number, { mesh: THREE.Mesh | null; body: Jolt.Body | null }>());
  const owned = useRef(new Set<THREE.BufferGeometry>());
  const nextId = useRef(1);
  const pending = useRef(false);
  const frame = useRef(0);
  useEffect(() => () => { owned.current.forEach((item) => item.dispose()); }, []);
  useEffect(() => { pending.current = false; }, [fragments]);

  const tear = useCallback((plane: THREE.Plane, fragmentIndex = 0) => {
    if (pending.current || fragments.length - 1 >= maxTears) return false;
    const fragment = fragments[fragmentIndex];
    const current = fragment && live.current.get(fragment.id);
    if (!current?.mesh || !current.body) return false;
    const mesh = current.mesh;
    mesh.updateWorldMatrix(true, false);
    const localPlane = plane.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const split = tearSurface(mesh.geometry, localPlane);
    if (!split) return false;
    const worldPosition = mesh.getWorldPosition(new THREE.Vector3()).toArray() as [number, number, number];
    const worldRotation = mesh.getWorldQuaternion(new THREE.Quaternion()).toArray() as [number, number, number, number];
    const v = current.body.GetLinearVelocity();
    const velocity: [number, number, number] = [v.GetX(), v.GetY(), v.GetZ()];
    const replacements = split.map((part) => {
      owned.current.add(part);
      return { id: nextId.current++, geometry: part, position: worldPosition, rotation: worldRotation, velocity };
    });
    pending.current = true;
    setFragments([...fragments.slice(0, fragmentIndex), ...replacements, ...fragments.slice(fragmentIndex + 1)]);
    onTear?.(fragments.length + 1);
    return true;
  }, [fragments, maxTears, onTear]);
  useImperativeHandle(ref, () => ({ tear }), [tear]);

  useFrame(() => {
    if (tearStrain == null || pending.current || fragments.length - 1 >= maxTears || ++frame.current % 4 !== 0) return;
    let largest = tearStrain * tearStrain;
    let target = -1;
    const from = new THREE.Vector3(), to = new THREE.Vector3();
    fragments.forEach((fragment, fragmentIndex) => {
      const mesh = live.current.get(fragment.id)?.mesh;
      if (!mesh) return;
      const rest = fragment.geometry.getAttribute("position");
      const current = mesh.geometry.getAttribute("position");
      const index = fragment.geometry.getIndex();
      if (!rest || !current || rest.count !== current.count) return;
      for (let i = 0; i < (index?.count ?? rest.count); i += 3) {
        const ia = index?.getX(i) ?? i, ib = index?.getX(i + 1) ?? i + 1, ic = index?.getX(i + 2) ?? i + 2;
        for (let e = 0; e < 3; e += 1) {
          const a = e === 0 ? ia : e === 1 ? ib : ic;
          const b = e === 0 ? ib : e === 1 ? ic : ia;
          const rx = rest.getX(a) - rest.getX(b), ry = rest.getY(a) - rest.getY(b), rz = rest.getZ(a) - rest.getZ(b);
          const r = rx * rx + ry * ry + rz * rz;
          if (r < 1e-10) continue;
          const px = current.getX(a), py = current.getY(a), pz = current.getZ(a);
          const qx = current.getX(b), qy = current.getY(b), qz = current.getZ(b);
          const dx = px - qx, dy = py - qy, dz = pz - qz;
          const strain = (dx * dx + dy * dy + dz * dz) / r;
          if (strain > largest) {
            largest = strain;
            target = fragmentIndex;
            from.set(px, py, pz);
            to.set(qx, qy, qz);
          }
        }
      }
    });
    if (target >= 0) {
      const mesh = live.current.get(fragments[target].id)?.mesh;
      if (!mesh) return;
      const midpoint = from.clone().add(to).multiplyScalar(0.5);
      const normal = to.sub(from).normalize();
      mesh.localToWorld(midpoint);
      normal.transformDirection(mesh.matrixWorld);
      tear(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, midpoint), target);
    }
  }, -40);

  return <>
    {fragments.map((fragment) => <SoftBody
      key={fragment.id}
      {...softProps}
      geometry={fragment.geometry}
      position={fragment.position}
      rotation={fragment.rotation}
      pressure={0}
      initialLinearVelocity={fragment.velocity}
      ref={(mesh) => {
        const entry = live.current.get(fragment.id) ?? { mesh: null, body: null };
        entry.mesh = mesh;
        live.current.set(fragment.id, entry);
      }}
      onBodyCreated={(body) => {
        const entry = live.current.get(fragment.id) ?? { mesh: null, body: null };
        entry.body = body;
        live.current.set(fragment.id, entry);
      }}
    />)}
  </>;
});

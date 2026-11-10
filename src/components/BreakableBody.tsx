import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type Jolt from "jolt-physics";
import { RigidBody, type RigidBodyProps, type RigidImpact } from "./RigidBody";
import { fractureGeometry, prepareShards } from "../utils/fracture";

export interface BreakableBodyHandle {
  fracture(): void;
}

export interface BreakableBodyProps extends Omit<RigidBodyProps, "children" | "shape" | "type" | "onImpact" | "onBodyCreated"> {
  /** Sealed convex geometry for automatic fracture. */
  geometry: THREE.BufferGeometry;
  /** Authored closed shards in original object coordinates, for concave or textured meshes. */
  shards?: readonly THREE.BufferGeometry[];
  material?: THREE.Material | THREE.Material[];
  /** Approximate impulse in N*s needed to break. */
  breakingImpulse?: number;
  /** Number of generated convex shards, between 2 and 64. */
  pieces?: number;
  onFracture?: (impact: RigidImpact) => void;
}

function snapshot(body: Jolt.Body): RigidImpact {
  const p = body.GetPosition(), q = body.GetRotation();
  const v = body.GetLinearVelocity(), w = body.GetAngularVelocity();
  return {
    impulse: 0,
    position: [p.GetX(), p.GetY(), p.GetZ()],
    rotation: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
    velocity: [v.GetX(), v.GetY(), v.GetZ()],
    angularVelocity: [w.GetX(), w.GetY(), w.GetZ()],
  };
}

export const BreakableBody = React.forwardRef<BreakableBodyHandle, BreakableBodyProps>(function BreakableBody({
  geometry,
  shards,
  material,
  breakingImpulse = 8,
  pieces = 8,
  onFracture,
  position = [0, 0, 0],
  rotation = [0, 0, 0, 1],
  mass = 1,
  ...rigidProps
}, ref) {
  if (!Number.isFinite(mass) || mass <= 0) throw new Error("BreakableBody mass must be positive");
  if (!Number.isFinite(breakingImpulse) || breakingImpulse < 0) throw new Error("breakingImpulse must be finite and nonnegative");
  const bodyRef = useRef<Jolt.Body | null>(null);
  const [impact, setImpact] = useState<RigidImpact | null>(null);
  const fragments = useMemo(
    () => shards ? prepareShards(shards) : fractureGeometry(geometry, pieces),
    [geometry, pieces, shards]
  );
  useEffect(() => () => fragments.forEach((fragment) => fragment.geometry.dispose()), [fragments]);
  const handleBodyCreated = useCallback((body: Jolt.Body | null) => { bodyRef.current = body; }, []);
  const breakBody = useCallback((nextImpact: RigidImpact) => {
    if (impact) return;
    setImpact(nextImpact);
    onFracture?.(nextImpact);
  }, [impact, onFracture]);
  useImperativeHandle(ref, () => ({
    fracture: () => {
      if (bodyRef.current) breakBody(snapshot(bodyRef.current));
    },
  }), [breakBody]);

  if (!impact) {
    return <RigidBody
      {...rigidProps}
      position={position}
      rotation={rotation}
      mass={mass}
      shape="convex"
      onBodyCreated={handleBodyCreated}
      onImpact={breakBody}
      impactThreshold={breakingImpulse}
    >
      <mesh geometry={geometry} material={material} castShadow receiveShadow />
    </RigidBody>;
  }

  const origin = new THREE.Vector3(...impact.position);
  const orientation = new THREE.Quaternion(...impact.rotation);
  const linear = new THREE.Vector3(...impact.velocity);
  const angular = new THREE.Vector3(...impact.angularVelocity);
  const totalVolume = fragments.reduce((sum, fragment) => sum + fragment.volume, 0);

  return <>
    {fragments.map((fragment, index) => {
      const rotatedOffset = fragment.offset.clone().applyQuaternion(orientation);
      const worldPosition = origin.clone().add(rotatedOffset);
      const worldVelocity = linear.clone().add(new THREE.Vector3().crossVectors(angular, rotatedOffset));
      return <RigidBody
        key={index}
        {...rigidProps}
        position={worldPosition.toArray() as [number, number, number]}
        rotation={impact.rotation}
        initialLinearVelocity={worldVelocity.toArray() as [number, number, number]}
        initialAngularVelocity={impact.angularVelocity}
        mass={mass * fragment.volume / totalVolume}
        shape="convex"
      >
        <mesh geometry={fragment.geometry} material={material} castShadow receiveShadow />
      </RigidBody>;
    })}
  </>;
});

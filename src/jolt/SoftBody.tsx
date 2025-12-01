import React, { useLayoutEffect, useRef } from "react";
import { Mesh, BufferAttribute } from "three";
import { useFrame } from "@react-three/fiber";
import { usePhysics } from "./PhysicsProvider";

interface SoftbodyProps {
  settings: any;
  children?: React.ReactNode;
}

export const Softbody: React.FC<SoftbodyProps> = ({ settings, children }) => {
  const { jolt, physicsSystem, bodyInterface } = usePhysics();
  const meshRef = useRef<Mesh>(null);
  const bodyIDRef = useRef<any>(null);

  useLayoutEffect(() => {
    if (!jolt || !physicsSystem || !bodyInterface || !settings) return;

    const body = bodyInterface.CreateSoftBody(settings);
    if (!body) return;

    const id = body.GetID();
    bodyIDRef.current = id;
    bodyInterface.AddBody(id, jolt.EActivation_Activate);

    return () => {
      if (bodyIDRef.current) {
        bodyInterface.RemoveBody(bodyIDRef.current);
        bodyInterface.DestroyBody(bodyIDRef.current);
        bodyIDRef.current = null;
      }
    };
  }, [jolt, physicsSystem, bodyInterface, settings]);

  useFrame(() => {
    if (!meshRef.current || !bodyIDRef.current || !physicsSystem) return;

    // Use BodyLockRead to safely access the body from the physics system
    const lock = new jolt.BodyLockRead(
      physicsSystem.GetBodyLockInterface(),
      bodyIDRef.current
    );

    if (lock.Succeeded()) {
      try {
        const body = lock.GetBody();
        const soft = body.GetSoftBody();
        const geom = meshRef.current.geometry;
        const posAttr = geom.attributes.position as BufferAttribute;
        const count = soft.GetVertexCount();

        if (posAttr.count === count) {
          for (let i = 0; i < count; i++) {
            const v = soft.GetVertexPosition(i); // Returns Vec3 copy
            posAttr.setXYZ(i, v.GetX(), v.GetY(), v.GetZ());
            jolt.destroy(v);
          }
          posAttr.needsUpdate = true;
          geom.computeVertexNormals();
        }
      } catch (e) {}
      lock.ReleaseLock();
    }
    jolt.destroy(lock);
  });

  return <mesh ref={meshRef}>{children}</mesh>;
};

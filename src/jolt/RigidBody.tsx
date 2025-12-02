import React, { useRef, useLayoutEffect } from "react";
import { Group } from "three";
import { useFrame } from "@react-three/fiber";
import { usePhysics } from "./PhysicsProvider";
import { wrapVec3, wrapQuat } from "./utils";

interface RigidBodyProps {
  children: React.ReactNode;
  getSettings: (Jolt: any) => any;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
}

export const RigidBody: React.FC<RigidBodyProps> = ({
  children,
  getSettings,
  position = [0, 0, 0],
  rotation = [0, 0, 0, 1],
}) => {
  const { jolt, bodyInterface } = usePhysics();
  const objectRef = useRef<Group>(null);
  const bodyIDRef = useRef<any>(null);

  // References for reuseable temporary objects to avoid GC/Memory leaks
  const tempsRef = useRef<{ pos: any; rot: any } | null>(null);

  useLayoutEffect(() => {
    // Initialize temps exactly once
    tempsRef.current = {
      pos: new jolt.RVec3(),
      rot: new jolt.Quat(),
    };

    return () => {
      // Cleanup temps exactly once
      if (tempsRef.current) {
        jolt.destroy(tempsRef.current.pos);
        jolt.destroy(tempsRef.current.rot);
        tempsRef.current = null;
      }
    };
  }, [jolt]);

  useLayoutEffect(() => {
    if (!jolt || !bodyInterface) return;

    // 1. Get settings
    const bodySettings = getSettings(jolt);

    // 2. Override Position/Rotation
    // Create wrappers
    const p = wrapVec3(jolt, position[0], position[1], position[2]);
    const q = wrapQuat(
      jolt,
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3]
    );

    // Assign (Jolt copies the value, so wrappers can be destroyed after creation)
    bodySettings.mPosition = p;
    bodySettings.mRotation = q;

    // 3. Create Body
    const body = bodyInterface.CreateBody(bodySettings);
    const id = body.GetID();
    bodyIDRef.current = id;

    // 4. Add Body
    bodyInterface.AddBody(id, jolt.EActivation_Activate);

    // 5. Cleanup
    // Destroy wrappers and settings. The body now owns the physics data.
    jolt.destroy(p);
    jolt.destroy(q);
    jolt.destroy(bodySettings);

    return () => {
      if (bodyIDRef.current) {
        bodyInterface.RemoveBody(bodyIDRef.current);
        bodyInterface.DestroyBody(bodyIDRef.current);
        bodyIDRef.current = null;
      }
    };
  }, [jolt, bodyInterface, getSettings]); // Intentionally omitting position/rotation to prevent re-creation on every prop change

  useFrame(() => {
    if (!bodyIDRef.current || !objectRef.current || !tempsRef.current) return;

    // Use the temporary objects to fill data directly from WASM (Zero allocation)
    // Note: Assuming 'GetPositionAndRotation' is bound in your specific Jolt build.
    // If this errors, fall back to individual body.GetPosition() / body.GetRotation() calls.
    bodyInterface.GetPositionAndRotation(
      bodyIDRef.current,
      tempsRef.current.pos,
      tempsRef.current.rot
    );

    // Update ThreeJS object
    objectRef.current.position.set(
      tempsRef.current.pos.GetX(),
      tempsRef.current.pos.GetY(),
      tempsRef.current.pos.GetZ()
    );
    objectRef.current.quaternion.set(
      tempsRef.current.rot.GetX(),
      tempsRef.current.rot.GetY(),
      tempsRef.current.rot.GetZ(),
      tempsRef.current.rot.GetW()
    );
  });

  return <group ref={objectRef}>{children}</group>;
};

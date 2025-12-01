import React, { useRef, useLayoutEffect } from "react";
import { Object3D } from "three";
import { useFrame } from "@react-three/fiber";
import { usePhysics } from "./PhysicsProvider";
import { updateThreeObjectFromJoltBody, createJoltVec3 } from "./utils";

interface RigidbodyProps {
  children: React.ReactNode;
  settings: any;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
}

export const Rigidbody: React.FC<RigidbodyProps> = ({
  children,
  settings,
  position,
  rotation,
}) => {
  const { jolt, bodyInterface } = usePhysics();
  const objectRef = useRef<Object3D>(null);
  const bodyIDRef = useRef<any>(null);

  useLayoutEffect(() => {
    if (!jolt || !bodyInterface || !objectRef.current || !settings) return;

    let body = null;
    try {
      body = bodyInterface.CreateBody(settings);
    } catch (e) {
      console.error("Failed to create body", e);
      return;
    }

    const id = body.GetID();
    bodyIDRef.current = id;
    bodyInterface.AddBody(id, jolt.EActivation_Activate);

    if (position) {
      // Safe creation of position vector (RVec3 or Vec3)
      const v = createJoltVec3(jolt, position[0], position[1], position[2]);
      bodyInterface.SetPosition(id, v, jolt.EActivation_DontActivate);
      jolt.destroy(v);
    }

    if (rotation) {
      const q = new jolt.Quat(...rotation);
      bodyInterface.SetRotation(id, q, jolt.EActivation_DontActivate);
      jolt.destroy(q);
    }

    return () => {
      if (bodyIDRef.current) {
        bodyInterface.RemoveBody(bodyIDRef.current);
        bodyInterface.DestroyBody(bodyIDRef.current);
        bodyIDRef.current = null;
      }
    };
  }, [jolt, bodyInterface, settings]);

  useFrame(() => {
    if (!bodyIDRef.current || !objectRef.current) return;
    updateThreeObjectFromJoltBody(
      jolt,
      bodyInterface,
      bodyIDRef.current,
      objectRef.current
    );
  });

  return <group ref={objectRef}>{children}</group>;
};

import React, { useRef, useLayoutEffect, useState } from "react";
import { Mesh, BufferAttribute } from "three";
import { useFrame } from "@react-three/fiber";
import { usePhysics } from "./PhysicsProvider";
import {
  createSoftBodySettingsFromGeometry,
  wrapVec3,
  wrapQuat,
  LAYER_MOVING,
} from "./utils";

interface SoftBodyProps {
  children: React.ReactElement<any>;
  pressure?: number;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
}

export const SoftBody: React.FC<SoftBodyProps> = ({
  children,
  pressure = 0,
  position = [0, 10, 0],
  rotation = [0, 0, 0, 1],
}) => {
  const { jolt, bodyInterface, physicsSystem } = usePhysics();
  const meshRef = useRef<Mesh>(null);
  const bodyIDRef = useRef<any>(null);
  const [isReady, setIsReady] = useState(false);

  const memoryConfigRef = useRef({
    basePtr: 0,
    stride: 0,
    posOffset: 0,
    count: 0,
  });

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const geometry = meshRef.current.geometry;

    // 1. Create Shared Settings using the optimized utils
    // NOTE: This object is passed to the body creation settings.
    // The physics system will take ownership of the data.
    const sharedSettings = createSoftBodySettingsFromGeometry(jolt, geometry);

    const p = wrapVec3(jolt, position[0], position[1], position[2]);
    const q = wrapQuat(
      jolt,
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3]
    );

    const creationSettings = new jolt.SoftBodyCreationSettings(
      sharedSettings,
      p,
      q,
      LAYER_MOVING
    );
    creationSettings.mPressure = pressure;
    creationSettings.mUpdatePosition = false;

    // 2. Create Body
    const body = bodyInterface.CreateSoftBody(creationSettings);
    const bodyID = body.GetID();
    bodyIDRef.current = bodyID;
    bodyInterface.AddBody(bodyID, jolt.EActivation_Activate);

    // 3. Inspect Memory Layout for Updates
    const lockInterface = physicsSystem.GetBodyLockInterfaceNoLock();
    const lockedBody = lockInterface.TryGetBody(bodyID);

    if (lockedBody) {
      const softProps = jolt.castObject(
        lockedBody.GetMotionProperties(),
        jolt.SoftBodyMotionProperties
      );

      const vertices = softProps.GetVertices();
      const count = vertices.size();

      if (count > 0) {
        const p0 = jolt.getPointer(vertices.at(0));
        let stride = 0;

        if (count > 1) {
          const p1 = jolt.getPointer(vertices.at(1));
          stride = p1 - p0;
        }

        let posOffset = 0;
        if (
          jolt.SoftBodyVertexTraits &&
          (jolt.SoftBodyVertexTraits.prototype as any).mPositionOffset !==
            undefined
        ) {
          posOffset = (jolt.SoftBodyVertexTraits.prototype as any)
            .mPositionOffset;
        }

        memoryConfigRef.current = { basePtr: p0, stride, posOffset, count };
      }
    }

    // 4. Cleanup Wrappers
    jolt.destroy(p);
    jolt.destroy(q);
    jolt.destroy(creationSettings);
    // IMPORTANT: Do NOT destroy sharedSettings here. The Body holds a reference to it.
    // It will be cleaned up when the body is destroyed.

    setIsReady(true);

    return () => {
      if (bodyIDRef.current) {
        bodyInterface.RemoveBody(bodyIDRef.current);
        bodyInterface.DestroyBody(bodyIDRef.current);
      }
    };
  }, [jolt, bodyInterface, physicsSystem, pressure, position, rotation]);

  useFrame(() => {
    if (!isReady || !meshRef.current || !bodyIDRef.current) return;

    const { basePtr, stride, posOffset, count } = memoryConfigRef.current;
    if (count === 0) return;

    const geometry = meshRef.current.geometry;
    const posAttr = geometry.attributes.position as BufferAttribute;
    const heapF32 = jolt.HEAPF32;

    // Update Vertex Loop
    for (let i = 0; i < count; i++) {
      const byteAddress = basePtr + i * stride + posOffset;
      const f32Index = byteAddress >> 2;

      posAttr.setXYZ(
        i,
        heapF32[f32Index],
        heapF32[f32Index + 1],
        heapF32[f32Index + 2]
      );
    }

    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  });

  return React.cloneElement(children, { ref: meshRef });
};

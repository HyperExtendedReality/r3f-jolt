import React, { useEffect, useState, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { PhysicsProvider, usePhysics } from "./jolt/PhysicsProvider";
import { Rigidbody } from "./jolt/RigidBody";
import { Softbody } from "./jolt/SoftBody";
import { LAYER_MOVING, LAYER_NON_MOVING, createJoltVec3 } from "./jolt/utils";
import * as THREE from "three";

// --- Components (Floor, FallingBox, FallingCloth) as defined in previous answers ---
// Copy them here (Floor, FallingBox, FallingCloth) ...
// Ensure you do NOT destroy 'shape' or 'shared' in their cleanups!

const Floor = () => {
  const { jolt } = usePhysics();
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    if (!jolt) return;
    const size = new jolt.Vec3(15, 1, 15);
    const shapeSettings = new jolt.BoxShapeSettings(size);
    const shapeResult = shapeSettings.Create();
    const shape = shapeResult.Get();
    const pos = createJoltVec3(jolt, 0, -1, 0);
    const rot = new jolt.Quat(0, 0, 0, 1);

    const bodySettings = new jolt.BodyCreationSettings(
      shape,
      pos,
      rot,
      jolt.EMotionType_Static,
      LAYER_NON_MOVING
    );
    bodySettings.mFriction = 0.5;

    setSettings(bodySettings);

    jolt.destroy(size);
    jolt.destroy(shapeSettings);
    jolt.destroy(shapeResult);
    jolt.destroy(pos);
    jolt.destroy(rot);

    return () => {
      if (bodySettings) jolt.destroy(bodySettings);
    };
  }, [jolt]);

  if (!settings) return null;
  return (
    <Rigidbody settings={settings}>
      <mesh receiveShadow>
        <boxGeometry args={[30, 2, 30]} />
        <meshStandardMaterial color="#444" />
      </mesh>
    </Rigidbody>
  );
};

const FallingBox = () => {
  const { jolt } = usePhysics();
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    if (!jolt) return;
    const size = new jolt.Vec3(1, 1, 1);
    const shapeSettings = new jolt.BoxShapeSettings(size);
    const shapeResult = shapeSettings.Create();
    const shape = shapeResult.Get();

    const pos = createJoltVec3(jolt, 0, 10, 0);
    const rot = new jolt.Quat(0, 0, 0, 1);

    const bodySettings = new jolt.BodyCreationSettings(
      shape,
      pos,
      rot,
      jolt.EMotionType_Dynamic,
      LAYER_MOVING
    );
    bodySettings.mRestitution = 0.5;

    setSettings(bodySettings);

    jolt.destroy(size);
    jolt.destroy(shapeSettings);
    jolt.destroy(shapeResult);
    jolt.destroy(pos);
    jolt.destroy(rot);

    return () => {
      if (bodySettings) jolt.destroy(bodySettings);
    };
  }, [jolt]);

  if (!settings) return null;
  return (
    <Rigidbody settings={settings}>
      <mesh castShadow>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color="orange" />
      </mesh>
    </Rigidbody>
  );
};

// ... FallingCloth (use previous safe version) ...

export default function App() {
  return (
    // Ensure the container has explicit size and background
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#111",
        overflow: "hidden",
      }}
    >
      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[12, 12, 12]} fov={50} />
        <OrbitControls target={[0, 2, 0]} />

        <ambientLight intensity={0.5} />
        <pointLight position={[10, 20, 10]} castShadow intensity={800} />

        {/* PhysicsProvider inside Canvas allows using Html overlay for loading */}
        <PhysicsProvider>
          <Floor />
          <FallingBox />
          {/* <FallingCloth /> Uncomment this once basics work */}
        </PhysicsProvider>
      </Canvas>
    </div>
  );
}

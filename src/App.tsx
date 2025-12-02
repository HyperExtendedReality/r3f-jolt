import React, { useMemo, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

import { PhysicsProvider } from "./jolt/PhysicsProvider";
import { RigidBody } from "./jolt/RigidBody";
import { SoftBody } from "./jolt/SoftBody";
import { LAYER_NON_MOVING, LAYER_MOVING } from "./jolt/utils";

// Optional: Import threaded WASM if you have COOP/COEP headers set up
// import initJoltMulti from 'jolt-physics/wasm-multithread';

const Floor = () => {
  // We pass a callback to RigidBody which creates the settings.
  // RigidBody handles the lifecycle: create body -> destroy settings.
  const getSettings = useCallback((jolt: any) => {
    const size = new jolt.Vec3(15, 1, 15);
    const shapeSettings = new jolt.BoxShapeSettings(size, 0.05); // 0.05 convex radius
    const shapeResult = shapeSettings.Create();
    const shape = shapeResult.Get();
    shapeResult.Clear(); // Release result reference

    const settings = new jolt.BodyCreationSettings(
      shape,
      jolt.RVec3.prototype.sZero(),
      jolt.Quat.prototype.sIdentity(),
      jolt.EMotionType_Static,
      LAYER_NON_MOVING
    );
    settings.mFriction = 1.0;

    // Cleanup temporary objects used during creation
    jolt.destroy(size);
    jolt.destroy(shapeSettings);
    // Note: 'shape' is now owned by 'settings' (and later the body),
    // we don't destroy it manually if we used the Settings -> Create pattern correctly.
    // However, shapeResult.Clear() handled the result wrapper.

    return settings;
  }, []);

  return (
    <RigidBody getSettings={getSettings} position={[0, -1, 0]}>
      <mesh receiveShadow>
        <boxGeometry args={[30, 2, 30]} />
        <meshStandardMaterial color="#333" />
      </mesh>
    </RigidBody>
  );
};

const FallingBox = () => {
  const getSettings = useCallback((jolt: any) => {
    // Simple shape creation pattern
    const size = new jolt.Vec3(1, 1, 1);

    // Direct Shape creation (careful with refs)
    // BoxShape(halfExtent, convexRadius, material)
    const shape = new jolt.BoxShape(size, 0.05, null);

    const settings = new jolt.BodyCreationSettings(
      shape,
      jolt.RVec3.prototype.sZero(),
      jolt.Quat.prototype.sIdentity(),
      jolt.EMotionType_Dynamic,
      LAYER_MOVING
    );
    settings.mRestitution = 0.5;

    jolt.destroy(size);
    // We don't destroy 'shape' because 'settings' takes a pointer.
    // When 'settings' is destroyed in RigidBody, it decrements shape ref.

    return settings;
  }, []);

  return (
    <RigidBody getSettings={getSettings} position={[0, 10, 0]}>
      <mesh castShadow>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color="orange" />
      </mesh>
    </RigidBody>
  );
};

const JellySphere = () => {
  // Use a highly detailed geometry for the soft body so it looks good
  const geometry = useMemo(() => new THREE.IcosahedronGeometry(2, 5), []);

  return (
    <SoftBody pressure={5000} position={[0, 15, 0]}>
      <mesh geometry={geometry} castShadow>
        <meshPhysicalMaterial
          color="hotpink"
          transmission={0.2}
          thickness={2}
          roughness={0.2}
          clearcoat={1}
        />
      </mesh>
    </SoftBody>
  );
};

export default function App() {
  return (
    <div style={{ width: "100vw", height: "100vh", background: "#111" }}>
      <Canvas shadows camera={{ position: [0, 5, 20], fov: 50 }}>
        <ambientLight intensity={0.5} />
        <spotLight
          position={[10, 20, 10]}
          angle={0.3}
          penumbra={1}
          castShadow
          intensity={50}
          shadow-mapSize={[2048, 2048]}
        />

        <PhysicsProvider>
          <Floor />
          <FallingBox />
          <JellySphere />
        </PhysicsProvider>

        <OrbitControls />
      </Canvas>
    </div>
  );
}

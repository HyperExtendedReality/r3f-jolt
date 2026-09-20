import { Canvas } from "@react-three/fiber";
import {
  Environment,
  Lightformer,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";
import { PhysicsProvider } from "../context/JoltContext";
import { RigidBody } from "../components/RigidBody";
import { SoftBody } from "../components/SoftBody";
import { MetallicChipBagMaterial } from "../materials/MetallicChipBagMaterial";

const laysChipsUrl = new URL("../assets/lays_chips.glb", import.meta.url).href;

function LaysChipsSoftBody() {
  const gltf = useGLTF(laysChipsUrl);
  const { geometry, texture } = useMemo(() => {
    gltf.scene.updateWorldMatrix(true, true);
    let sourceMesh: THREE.Mesh | undefined;

    gltf.scene.traverse((object) => {
      if (!sourceMesh && object instanceof THREE.Mesh) {
        sourceMesh = object;
      }
    });

    if (!sourceMesh) {
      throw new Error("lays_chips.glb does not contain a mesh");
    }

    const nextGeometry = sourceMesh.geometry.clone();
    nextGeometry.applyMatrix4(sourceMesh.matrixWorld);
    nextGeometry.center();
    nextGeometry.computeBoundingBox();

    const size = new THREE.Vector3();
    nextGeometry.boundingBox?.getSize(size);
    const maxDimension = Math.max(size.x, size.y, size.z);
    if (maxDimension > 0) {
      const scale = 4.5 / maxDimension;
      nextGeometry.scale(scale, scale, scale);
    }

    const sourceMaterial = Array.isArray(sourceMesh.material)
      ? sourceMesh.material[0]
      : sourceMesh.material;
    const map =
      sourceMaterial instanceof THREE.MeshStandardMaterial
        ? sourceMaterial.map ?? undefined
        : undefined;

    return { geometry: nextGeometry, texture: map };
  }, [gltf.scene]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <SoftBody
      geometry={geometry}
      position={[0, 12, 6]}
      pressure={40}
      iterations={12}
      friction={0.8}
      doubleSided
      castShadow
      config={{
        compliance: 2.0e-5,
        shearCompliance: 2.0e-5,
        bendCompliance: 5.0e-4,
      }}
    >
      <MetallicChipBagMaterial
        map={texture}
        crinkleScale={15}
        crinkleStrength={0.06}
        roughnessVariation={0.18}
      />
    </SoftBody>
  );
}

useGLTF.preload(laysChipsUrl);

export default function App() {
  return (
    <Canvas
      shadows
      camera={{ position: [18, 14, 24], fov: 45 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={["#101215"]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        castShadow
        position={[12, 18, 8]}
        intensity={1.4}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <Environment resolution={256}>
        <Lightformer
          form="rect"
          intensity={3.5}
          position={[0, 10, -8]}
          scale={[12, 8, 1]}
        />
        <Lightformer
          form="ring"
          color="#ffd7a3"
          intensity={2}
          position={[-8, 4, 6]}
          rotation={[0, Math.PI / 2, 0]}
          scale={5}
        />
      </Environment>

      <PhysicsProvider gravity={[0, -9.81, 0]}>
        <RigidBody
          type="Box"
          args={[60, 1, 60]}
          position={[0, -0.5, 0]}
          motionType={0}
          friction={0.9}
        >
          <mesh receiveShadow>
            <boxGeometry args={[60, 1, 60]} />
            <meshStandardMaterial color="#3a3f46" />
          </mesh>
        </RigidBody>

        <RigidBody
          type="Box"
          args={[1.5, 1.5, 1.5]}
          position={[0, 14, 2]}
          restitution={0.2}
          friction={0.7}
        >
          <mesh castShadow>
            <boxGeometry args={[1.5, 1.5, 1.5]} />
            <meshStandardMaterial color="#f6ad55" />
          </mesh>
        </RigidBody>

        <SoftBody
          type="Sphere"
          position={[-7, 10, 0]}
          pressure={1400}
          iterations={12}
          friction={0.6}
          config={{ radius: 2, numTheta: 12, numPhi: 24 }}
        >
          <meshPhysicalMaterial
            color="#ff7a18"
            roughness={0.22}
            metalness={0.05}
            clearcoat={0.4}
            side={THREE.DoubleSide}
          />
        </SoftBody>

        <SoftBody
          type="Cloth"
          position={[7, 11, 0]}
          iterations={10}
          friction={0.9}
          doubleSided
          config={{
            gridSizeX: 18,
            gridSizeZ: 18,
            gridSpacing: 0.45,
            fixatedCorners: true,
            bendCompliance: 1.0e-6,
          }}
          color="#8be9fd"
        />

        <SoftBody
          type="Cube"
          position={[0, 18, -6]}
          pressure={2}
          iterations={10}
          config={{
            gridSize: 6,
            gridSpacing: 0.35,
            edgeCompliance: 1.0e-6,
            volumeCompliance: 1.0e-7,
          }}
          color="#a3ff99"
        />

        <Suspense fallback={null}>
          <LaysChipsSoftBody />
        </Suspense>
      </PhysicsProvider>

      <OrbitControls makeDefault />
    </Canvas>
  );
}

import { Canvas } from "@react-three/fiber";
import {
  Environment,
  Lightformer,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { PhysicsProvider } from "../context/JoltContext";
import { RigidBody } from "../components/RigidBody";
import { SoftBody } from "../components/SoftBody";
import { BreakableBody } from "../components/BreakableBody";
import { MetallicChipBagMaterial } from "../materials/MetallicChipBagMaterial";

const laysChipsUrl = new URL("../assets/lays_chips.glb", import.meta.url).href;

function LaysChipsSoftBody() {
  const gltf = useGLTF(laysChipsUrl);
  const inflatedBag = useRef<THREE.Mesh>(null);
  const chipGeometry = useMemo(() => {
    // A potato chip: a thin disc bent into a saddle.
    const disc = new THREE.CircleGeometry(0.16, 14);
    const p = disc.getAttribute("position");
    for (let i = 0; i < p.count; i += 1) p.setZ(i, 2.2 * (p.getX(i) ** 2 - p.getY(i) ** 2));
    disc.computeVertexNormals();
    return disc;
  }, []);
  useEffect(() => () => chipGeometry.dispose(), [chipGeometry]);
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
    <>
    <SoftBody
      geometry={geometry}
      position={[-3, 12, 6]}
      physicsMaterial="chipBagDeflated"
      doubleSided
      castShadow
    >
      <MetallicChipBagMaterial map={texture} />
    </SoftBody>
    <SoftBody
      ref={inflatedBag}
      geometry={geometry}
      position={[3, 12, 6]}
      physicsMaterial="chipBagInflated"
      castShadow
    >
      <MetallicChipBagMaterial map={texture} />
    </SoftBody>
    {Array.from({ length: 5 }, (_, i) => (
      <RigidBody
        key={i}
        shape="convex"
        position={[3 + (i - 2) * 0.22, 12 + i * 0.17, 6]}
        rotation={new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(i * 1.7), i, Math.cos(i * 2.3))).toArray() as [number, number, number, number]}
        containedBy={inflatedBag}
        containmentRadius={0.17}
        mass={0.004}
        friction={0.65}
      >
        <mesh castShadow geometry={chipGeometry}>
          <meshStandardMaterial color="#e9b949" roughness={0.6} side={THREE.DoubleSide} />
        </mesh>
      </RigidBody>
    ))}
    </>
  );
}

useGLTF.preload(laysChipsUrl);

export default function App() {
  const breakableGeometry = useMemo(() => new THREE.BoxGeometry(1.5, 1.5, 1.5), []);
  const breakableMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: "#f6ad55" }), []);
  useEffect(() => () => { breakableGeometry.dispose(); breakableMaterial.dispose(); }, [breakableGeometry, breakableMaterial]);
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
        {/* A neutral studio dome; without it, mirror-like foil reflects black and looks dark. */}
        <color attach="background" args={["#6b7079"]} />
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
        {/* Softbox ceiling and side strips: foil is a mirror, so it needs something to reflect. */}
        <Lightformer form="rect" intensity={1.5} position={[0, 14, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[30, 30, 1]} />
        <Lightformer form="rect" intensity={2.5} position={[10, 5, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[3, 14, 1]} />
        <Lightformer form="rect" color="#cfe3ff" intensity={1.2} position={[0, 4, 14]} rotation={[0, Math.PI, 0]} scale={[16, 4, 1]} />
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

        <BreakableBody
          geometry={breakableGeometry}
          position={[0, 14, 2]}
          restitution={0.2}
          friction={0.7}
          material={breakableMaterial}
          breakingImpulse={8}
        />

        <SoftBody
          type="Sphere"
          position={[-7, 10, 0]}
          physicsMaterial="bouncySlime"
          pressure={1400}
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
          physicsMaterial="slime"
          config={{
            gridSize: 6,
            gridSpacing: 0.35,
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

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
// @ts-ignore
import initJolt from "jolt-physics";
import { setupCollisionFiltering } from "./utils";

type PhysicsContextType = {
  jolt: any;
  joltInterface: any;
  physicsSystem: any;
  bodyInterface: any;
};

const PhysicsContext = createContext<PhysicsContextType | null>(null);

let joltPromise: Promise<any> | null = null;

export const usePhysics = () => {
  const context = useContext(PhysicsContext);
  if (!context)
    throw new Error("usePhysics must be used within a PhysicsProvider");
  return context;
};

export const PhysicsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [jolt, setJolt] = useState<any>(null);
  const [joltInterface, setJoltInterface] = useState<any>(null);
  const [physicsSystem, setPhysicsSystem] = useState<any>(null);
  const [bodyInterface, setBodyInterface] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unmounted = false;

    const load = async () => {
      try {
        if (!joltPromise) joltPromise = initJolt();
        const Jolt = await joltPromise;
        if (unmounted) return;

        const settings = new Jolt.JoltSettings();

        // Setup collision filtering
        // We do NOT store these in a ref for cleanup anymore.
        // JoltInterface takes ownership of them.
        const filters = setupCollisionFiltering(Jolt);

        settings.mObjectLayerPairFilter = filters.objectFilter;
        settings.mBroadPhaseLayerInterface = filters.bpInterface;
        settings.mObjectVsBroadPhaseLayerFilter =
          filters.objectVsBroadphaseFilter;

        // Initialize Jolt Interface
        // This copies the settings and takes ownership of the filters
        const iface = new Jolt.JoltInterface(settings);

        // Cleanup settings object immediately (interface has its own copy)
        Jolt.destroy(settings);

        setJolt(Jolt);
        setJoltInterface(iface);
        setPhysicsSystem(iface.GetPhysicsSystem());
        setBodyInterface(iface.GetPhysicsSystem().GetBodyInterface());
      } catch (e: any) {
        console.error("Jolt Init Error", e);
        setError(e.message);
      }
    };

    load();

    return () => {
      unmounted = true;
      if (joltInterface) {
        // Destroying the interface destroys the physics system and the filters it owns
        jolt.destroy(joltInterface);
        setJoltInterface(null);
        setPhysicsSystem(null);
        setBodyInterface(null);
      }
    };
  }, []);

  useFrame((state, delta) => {
    if (!joltInterface) return;
    // Cap delta time to prevent instability
    const dt = Math.min(delta, 1 / 30);
    // Step the simulation
    // 1 / 60.0 is the fixed step, 1 is collision steps
    joltInterface.Step(dt, 1);
  });

  if (error)
    return (
      <Html center>
        <div style={{ background: "white", color: "red" }}>Error: {error}</div>
      </Html>
    );
  if (!jolt || !physicsSystem)
    return (
      <Html center>
        <div style={{ color: "white" }}>Initializing Physics...</div>
      </Html>
    );

  return (
    <PhysicsContext.Provider
      value={{ jolt, joltInterface, physicsSystem, bodyInterface }}
    >
      {children}
    </PhysicsContext.Provider>
  );
};

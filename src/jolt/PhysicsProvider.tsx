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

// Singleton promise to prevent multiple WASM inits
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

  // Keep references to filters to prevent JS Garbage Collection
  const filtersRef = useRef<any>(null);

  useEffect(() => {
    let unmounted = false;

    const load = async () => {
      try {
        console.log("🚀 Starting Jolt Physics init...");

        if (!joltPromise) {
          // Locate the WASM file if needed, usually initJolt handles it.
          joltPromise = initJolt();
        }

        const Jolt = await joltPromise;
        if (unmounted) return;

        console.log("✅ Jolt Module Loaded");

        const settings = new Jolt.JoltSettings();
        const filters = setupCollisionFiltering(Jolt);
        filtersRef.current = filters;

        // Pass pointers to settings
        settings.mObjectLayerPairFilter = filters.objectFilter;
        settings.mBroadPhaseLayerInterface = filters.bpInterface;
        settings.mObjectVsBroadPhaseLayerFilter =
          filters.objectVsBroadphaseFilter;

        console.log("⚙️ Creating Jolt Interface...");
        const iface = new Jolt.JoltInterface(settings);
        Jolt.destroy(settings);

        console.log("✅ Physics System Ready");

        setJolt(Jolt);
        setJoltInterface(iface);
        setPhysicsSystem(iface.GetPhysicsSystem());
        setBodyInterface(iface.GetPhysicsSystem().GetBodyInterface());
      } catch (e: any) {
        console.error("❌ Jolt Init Error:", e);
        setError(e.message || "Unknown Jolt Error");
      }
    };

    load();

    return () => {
      unmounted = true;
      if (joltInterface) {
        console.log("🧹 Cleaning up Jolt Interface");
        // NOTE: Destroying joltInterface handles the filters internally in C++
        // if ownership was transferred.
        jolt.destroy(joltInterface);
        setJoltInterface(null);
        setPhysicsSystem(null);
        setBodyInterface(null);
      }
    };
  }, []);

  useFrame((state, delta) => {
    if (!joltInterface) return;
    try {
      // Step the physics world
      // Limit delta time to prevent spirals on lag spikes
      const dt = Math.min(delta, 1 / 30);
      const steps = 1;
      joltInterface.Step(dt, steps);
    } catch (e) {
      console.error("💥 Physics Step Error:", e);
    }
  });

  // Render Error if Failed
  if (error) {
    return (
      <Html center>
        <div style={{ color: "red", background: "white", padding: "20px" }}>
          <h3>Physics Error</h3>
          <p>{error}</p>
        </div>
      </Html>
    );
  }

  // Render Loading State if Initializing
  if (!jolt || !physicsSystem) {
    return (
      <Html center>
        <div style={{ color: "white", fontFamily: "monospace" }}>
          Initializing Physics...
        </div>
      </Html>
    );
  }

  return (
    <PhysicsContext.Provider
      value={{ jolt, joltInterface, physicsSystem, bodyInterface }}
    >
      {children}
    </PhysicsContext.Provider>
  );
};

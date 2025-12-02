import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react";
import { useFrame } from "@react-three/fiber";
// @ts-ignore
import defaultInitJolt from "jolt-physics/wasm-multithread";
import { setupCollisionFiltering } from "./utils";
import { Jolt } from "./types";

interface PhysicsContextValue {
  jolt: Jolt;
  physicsSystem: any;
  bodyInterface: any;
  debug: boolean;
}

const PhysicsContext = createContext<PhysicsContextValue | null>(null);

export const usePhysics = () => {
  const ctx = useContext(PhysicsContext);
  if (!ctx) throw new Error("usePhysics must be used within PhysicsProvider");
  return ctx;
};

interface PhysicsProviderProps {
  children: React.ReactNode;
  loader?: (opts?: any) => Promise<Jolt>;
  debug?: boolean;
}

let globalJoltPromise: Promise<Jolt> | null = null;

export const PhysicsProvider: React.FC<PhysicsProviderProps> = ({
  children,
  loader,
  debug = false,
}) => {
  const [ready, setReady] = useState(false);

  const joltRef = useRef<Jolt | null>(null);
  const physicsSystemRef = useRef<any>(null);
  const bodyInterfaceRef = useRef<any>(null);
  const memoryBeforeRef = useRef<number>(0);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      if (!globalJoltPromise) {
        const initFn = loader || defaultInitJolt;
        globalJoltPromise = initFn({
          allowMemoryGrowth: true,
          INITIAL_MEMORY: 128 * 1024 * 1024,
        });
      }

      const jolt = await globalJoltPromise;
      if (!isMounted) return;

      if (jolt.JoltInterface && jolt.JoltInterface.prototype.sGetFreeMemory) {
        memoryBeforeRef.current = jolt.JoltInterface.prototype.sGetFreeMemory();
      }

      const settings = new jolt.JoltSettings();

      // Prevent browser freeze
      settings.mMaxWorkerThreads = 3;

      settings.mMaxBodies = 4096;
      settings.mMaxBodyPairs = 4096;
      settings.mMaxContactConstraints = 4096;
      // Fixed: Increased to 64MB to prevent TempAllocator errors during softbody optimization
      settings.mTempAllocatorSize = 64 * 1024 * 1024;

      const { objectFilter, bpInterface, objectVsBroadphaseFilter } =
        setupCollisionFiltering(jolt);

      settings.mObjectLayerPairFilter = objectFilter;
      settings.mBroadPhaseLayerInterface = bpInterface;
      settings.mObjectVsBroadPhaseLayerFilter = objectVsBroadphaseFilter;

      const joltInterface = new jolt.JoltInterface(settings);

      jolt.destroy(settings);

      joltRef.current = jolt;

      (joltInterface as any)._cleanupUserData = {
        objectFilter,
        bpInterface,
        objectVsBroadphaseFilter,
      };

      physicsSystemRef.current = joltInterface.GetPhysicsSystem();
      bodyInterfaceRef.current = physicsSystemRef.current.GetBodyInterface();

      (joltRef.current as any).interface = joltInterface;

      setReady(true);
    };

    init();

    return () => {
      isMounted = false;
      const jolt = joltRef.current;
      const iface = (jolt as any)?.interface;

      if (jolt && iface) {
        jolt.destroy(iface);

        if (iface._cleanupUserData) {
          jolt.destroy(iface._cleanupUserData.objectVsBroadphaseFilter);
          jolt.destroy(iface._cleanupUserData.bpInterface);
          jolt.destroy(iface._cleanupUserData.objectFilter);
        }

        if (jolt.JoltInterface && jolt.JoltInterface.prototype.sGetFreeMemory) {
          const memoryAfter = jolt.JoltInterface.prototype.sGetFreeMemory();
          console.log(
            `[Jolt] Cleanup. Leaked: ${
              memoryBeforeRef.current - memoryAfter
            } bytes`
          );
        }
      }
    };
  }, [loader]);

  useFrame((state, delta) => {
    const iface = (joltRef.current as any)?.interface;
    if (!iface) return;

    // Prevent spiral of death
    const deltaTime = Math.min(delta, 1.0 / 30.0);
    const numSteps = deltaTime > 1.0 / 55.0 ? 2 : 1;

    iface.Step(deltaTime, numSteps);
  });

  if (!ready) return null;

  return (
    <PhysicsContext.Provider
      value={{
        jolt: joltRef.current!,
        physicsSystem: physicsSystemRef.current,
        bodyInterface: bodyInterfaceRef.current,
        debug,
      }}
    >
      {children}
    </PhysicsContext.Provider>
  );
};

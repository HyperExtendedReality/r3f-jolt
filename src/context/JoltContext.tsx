import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { getJolt } from "../utils/joltLoader";
import type Jolt from "jolt-physics";
import { LAYER_MOVING, LAYER_NON_MOVING, toJoltVec3 } from "../utils/joltUtils";

export interface JoltContextValue {
  jolt: typeof Jolt;
  joltInterface: Jolt.JoltInterface;
  physicsSystem: Jolt.PhysicsSystem;
  bodyInterface: Jolt.BodyInterface;
}

const JoltContext = createContext<JoltContextValue | null>(null);

export const useJolt = () => {
  const context = useContext(JoltContext);
  if (!context)
    throw new Error("useJolt must be used within a Physics provider");
  return context;
};

export interface PhysicsProviderProps {
  children: React.ReactNode;
  gravity?: [number, number, number];
  paused?: boolean;
  /** Fixed simulation interval in seconds. */
  timeStep?: number;
  /** Maximum fixed steps consumed in one rendered frame. */
  maxSubSteps?: number;
  /** Caps a rendered frame delta before it enters the accumulator. */
  maxDelta?: number;
  timeScale?: number;
}

export const PhysicsProvider: React.FC<PhysicsProviderProps> = ({
  children,
  gravity,
  paused = false,
  timeStep = 1 / 60,
  maxSubSteps = 4,
  maxDelta = 0.1,
  timeScale = 1,
}) => {
  const [contextValue, setContextValue] = useState<JoltContextValue | null>(null);
  const worldRef = useRef<JoltContextValue | null>(null);
  const accumulatorRef = useRef(0);

  useEffect(() => {
    let active = true;
    let joltInterface: Jolt.JoltInterface | null = null;
    let joltModule: typeof Jolt | null = null;

    const init = async () => {
      const Jolt = await getJolt();
      joltModule = Jolt;
      if (!active) return;

      const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
      objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
      objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);

      const BP_LAYER_NON_MOVING = new Jolt.BroadPhaseLayer(0);
      const BP_LAYER_MOVING = new Jolt.BroadPhaseLayer(1);
      const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
      bpInterface.MapObjectToBroadPhaseLayer(
        LAYER_NON_MOVING,
        BP_LAYER_NON_MOVING
      );
      bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, BP_LAYER_MOVING);
      Jolt.destroy(BP_LAYER_NON_MOVING);
      Jolt.destroy(BP_LAYER_MOVING);

      const bpFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
        bpInterface,
        2,
        objectFilter,
        2
      );

      const settings = new Jolt.JoltSettings();
      settings.mObjectLayerPairFilter = objectFilter;
      settings.mBroadPhaseLayerInterface = bpInterface;
      settings.mObjectVsBroadPhaseLayerFilter = bpFilter;

      joltInterface = new Jolt.JoltInterface(settings);
      Jolt.destroy(settings);

      const physicsSystem = joltInterface.GetPhysicsSystem();
      const bodyInterface = physicsSystem.GetBodyInterface();

      const nextValue: JoltContextValue = {
        jolt: Jolt,
        joltInterface,
        physicsSystem,
        bodyInterface,
      };

      if (!active) {
        Jolt.destroy(joltInterface);
        return;
      }

      worldRef.current = nextValue;
      setContextValue(nextValue);
    };

    void init();

    return () => {
      active = false;
      setContextValue(null);

      const world = worldRef.current;
      worldRef.current = null;

      if (world) {
        world.jolt.destroy(world.joltInterface);
        return;
      }

      if (joltInterface && joltModule) {
        joltModule.destroy(joltInterface);
      }
    };
  }, []);

  useEffect(() => {
    if (!contextValue || !gravity) return;

    const gravityVector = toJoltVec3(contextValue.jolt, gravity);
    contextValue.physicsSystem.SetGravity(gravityVector);
    contextValue.jolt.destroy(gravityVector);
  }, [contextValue, gravity]);

  useEffect(() => {
    accumulatorRef.current = 0;
  }, [paused, timeScale, timeStep]);

  useFrame((_, delta) => {
    const world = worldRef.current;
    if (!world || paused) return;

    const fixedTimeStep = Math.max(1 / 240, timeStep);
    const stepLimit = Math.max(1, Math.floor(maxSubSteps));
    const scaledDelta = Math.min(
      Math.max(0, delta * timeScale),
      Math.max(0, maxDelta)
    );
    const accumulated = accumulatorRef.current + scaledDelta;
    const numSteps = Math.min(
      Math.floor(accumulated / fixedTimeStep),
      stepLimit
    );

    if (numSteps === 0) {
      accumulatorRef.current = accumulated;
      return;
    }

    accumulatorRef.current = accumulated - numSteps * fixedTimeStep;
    if (numSteps === stepLimit && accumulatorRef.current >= fixedTimeStep) {
      accumulatorRef.current %= fixedTimeStep;
    }

    // Jolt subdivides this interval internally, keeping the JS/WASM boundary
    // to one call per rendered frame even when catching up.
    world.joltInterface.Step(fixedTimeStep * numSteps, numSteps);
  }, -100);

  if (!contextValue) return null;

  return (
    <JoltContext.Provider value={contextValue}>{children}</JoltContext.Provider>
  );
};

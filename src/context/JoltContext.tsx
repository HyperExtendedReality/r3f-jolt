import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { getJolt } from "../utils/joltLoader";
import type Jolt from "jolt-physics";
import { LAYER_MOVING, LAYER_NON_MOVING, toJoltVec3 } from "../utils/joltUtils";
import { collideSoftBodies, type SoftSurface, type StepClock } from "../utils/softBodyCollision";

export interface JoltContextValue {
  jolt: typeof Jolt;
  joltInterface: Jolt.JoltInterface;
  physicsSystem: Jolt.PhysicsSystem;
  bodyInterface: Jolt.BodyInterface;
  /** False once the provider has destroyed the world; bodies must not touch Jolt after that. */
  alive: boolean;
  /** Fixed-step counter and render interpolation factor, updated before bodies sync. */
  clock: StepClock;
  /** Soft bodies taking part in soft-vs-soft collision. */
  softSurfaces: Set<SoftSurface>;
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
  /**
   * Loads the Jolt module, e.g. `() => import("jolt-physics/wasm-multithread").then((m) => m.default())`.
   * Defaults to `jolt-physics/wasm-compat`. The first provider to load Jolt decides the build.
   */
  init?: () => Promise<typeof Jolt>;
  /** Draw bodies between the last two fixed steps for smooth motion at any frame rate. Default true. */
  interpolate?: boolean;
  /** Collide soft bodies with each other (Jolt does not). Default true. */
  softBodyCollisions?: boolean;
  /** Minimum separation kept between colliding soft bodies, in metres. Default 0.02. */
  softBodyThickness?: number;
}

export const PhysicsProvider: React.FC<PhysicsProviderProps> = ({
  children,
  gravity,
  paused = false,
  timeStep = 1 / 60,
  maxSubSteps = 4,
  maxDelta = 0.1,
  timeScale = 1,
  init,
  interpolate = true,
  softBodyCollisions = true,
  softBodyThickness = 0.02,
}) => {
  const [contextValue, setContextValue] = useState<JoltContextValue | null>(null);
  const worldRef = useRef<JoltContextValue | null>(null);
  const accumulatorRef = useRef(0);

  useEffect(() => {
    let active = true;
    let joltInterface: Jolt.JoltInterface | null = null;
    let joltModule: typeof Jolt | null = null;

    const createWorld = async () => {
      const Jolt = await getJolt(init);
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
        alive: true,
        clock: { count: 0, alpha: 1 },
        softSurfaces: new Set(),
      };

      if (!active) {
        Jolt.destroy(joltInterface);
        return;
      }

      worldRef.current = nextValue;
      setContextValue(nextValue);
    };

    void createWorld();

    return () => {
      active = false;
      setContextValue(null);

      const world = worldRef.current;
      worldRef.current = null;

      if (world) {
        // Parent effect cleanups run before children's, so bodies check this flag.
        world.alive = false;
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
    if (!world) return;
    if (paused) {
      world.clock.alpha = 1;
      return;
    }

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

    accumulatorRef.current = accumulated - numSteps * fixedTimeStep;
    if (numSteps === stepLimit && accumulatorRef.current >= fixedTimeStep) {
      accumulatorRef.current %= fixedTimeStep;
    }

    const collide = softBodyCollisions && world.softSurfaces.size > 1;
    for (let i = 0; i < numSteps; i += 1) {
      world.joltInterface.Step(fixedTimeStep, 1);
      world.clock.count += 1;
      if (collide) {
        collideSoftBodies(world.jolt, world.bodyInterface, world.softSurfaces, softBodyThickness);
      }
    }
    world.clock.alpha = interpolate ? accumulatorRef.current / fixedTimeStep : 1;
  }, -100);

  if (!contextValue) return null;

  return (
    <JoltContext.Provider value={contextValue}>{children}</JoltContext.Provider>
  );
};

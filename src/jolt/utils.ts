import { Object3D } from "three";

export const LAYER_NON_MOVING = 0;
export const LAYER_MOVING = 1;
export const NUM_OBJECT_LAYERS = 2;

// Helper to safely create a Vec3 or RVec3 depending on what the WASM supports
export const createJoltVec3 = (Jolt: any, x: number, y: number, z: number) => {
  if (Jolt.RVec3) return new Jolt.RVec3(x, y, z);
  return new Jolt.Vec3(x, y, z);
};

export const updateThreeObjectFromJoltBody = (
  jolt: any,
  bodyInterface: any,
  bodyId: any,
  object: Object3D
) => {
  // FIX: Use GetPosition() instead of GetCenterOfMassPosition()
  // GetPosition returns the visual origin (matching Three.js position)
  const pos = bodyInterface.GetPosition(bodyId);
  const rot = bodyInterface.GetRotation(bodyId);

  object.position.set(pos.GetX(), pos.GetY(), pos.GetZ());
  object.quaternion.set(rot.GetX(), rot.GetY(), rot.GetZ(), rot.GetW());

  jolt.destroy(pos);
  jolt.destroy(rot);
};

export const setupCollisionFiltering = (Jolt: any) => {
  const objectFilter = new Jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);

  const BP_LAYER_NON_MOVING = new Jolt.BroadPhaseLayer(0);
  const BP_LAYER_MOVING = new Jolt.BroadPhaseLayer(1);
  const NUM_BROAD_PHASE_LAYERS = 2;

  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(
    NUM_OBJECT_LAYERS,
    NUM_BROAD_PHASE_LAYERS
  );
  
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, BP_LAYER_NON_MOVING);
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, BP_LAYER_MOVING);
  
  // Note: We deliberately do NOT destroy BP_LAYER_* here because 
  // Jolt's BroadPhaseLayerInterfaceTable might hold references depending on version.

  const objectVsBroadphaseFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface,
    NUM_BROAD_PHASE_LAYERS,
    objectFilter,
    NUM_OBJECT_LAYERS
  );

  return { objectFilter, bpInterface, objectVsBroadphaseFilter };
};
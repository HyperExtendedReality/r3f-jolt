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
  // Allocate temporary Jolt objects to retrieve data
  // Using RVec3 for position ensures double precision compatibility
  const p = new jolt.RVec3();
  const q = new jolt.Quat();

  // Retrieve data from Jolt
  bodyInterface.GetPositionAndRotation(bodyId, p, q);

  // Apply to Three.js object
  object.position.set(p.GetX(), p.GetY(), p.GetZ());
  object.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());

  // Clean up Jolt objects immediately
  jolt.destroy(p);
  jolt.destroy(q);
};

export const setupCollisionFiltering = (Jolt: any) => {
  // 1. Create ObjectLayerPairFilter
  const objectFilter = new Jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);

  // 2. Create BroadPhaseLayerInterface
  const BP_LAYER_NON_MOVING = new Jolt.BroadPhaseLayer(0);
  const BP_LAYER_MOVING = new Jolt.BroadPhaseLayer(1);
  const NUM_BROAD_PHASE_LAYERS = 2;

  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(
    NUM_OBJECT_LAYERS,
    NUM_BROAD_PHASE_LAYERS
  );
  
  // Map layers
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, BP_LAYER_NON_MOVING);
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, BP_LAYER_MOVING);

  // FIX: Destroy BP_LAYER objects immediately after mapping (as per HelloWorld.js)
  // They are copied into the interface table.
  Jolt.destroy(BP_LAYER_NON_MOVING);
  Jolt.destroy(BP_LAYER_MOVING);

  // 3. Create ObjectVsBroadPhaseLayerFilter
  const objectVsBroadphaseFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface,
    NUM_BROAD_PHASE_LAYERS,
    objectFilter,
    NUM_OBJECT_LAYERS
  );

  return { objectFilter, bpInterface, objectVsBroadphaseFilter };
};
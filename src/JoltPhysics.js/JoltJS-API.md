# Jolt Physics JS API Documentation

## Table of Contents
1.  [Overview & Memory Management](#overview--memory-management)
2.  [Core Systems & Initialization](#core-systems--initialization)
3.  [Math Types](#math-types)
4.  [Bodies & Properties](#bodies--properties)
5.  [Shapes](#shapes)
6.  [Constraints](#constraints)
7.  [Collision Queries (Casting)](#collision-queries-casting)
8.  [Character Virtual](#character-virtual)
9.  [Vehicles](#vehicles)
10. [Soft Bodies](#soft-bodies)
11. [Listeners & Callbacks](#listeners--callbacks)

---

## Overview & Memory Management

JoltJS is a WebAssembly port. JavaScript uses Garbage Collection (GC), but WebAssembly (C++) uses manual memory management.

**Crucial Rule:** Any object created via `new Jolt.ClassName()` **must** be manually destroyed when no longer needed using `.destroy()`, otherwise memory leaks will occur.

```javascript
// Example
const vec = new Jolt.Vec3(0, 1, 0);
// ... use vec ...
Jolt.destroy(vec); // Free memory
```

**Exceptions:**
*   **Structs/primitives returned by value** often do not need manual destruction if they are transient, but if they are bound objects (like `Body`), consult the specific creation pattern.
*   **[Value] attributes**: Properties marked with `[Value]` in IDL return a copy. You own that copy and must destroy it.
*   **[Const, Ref]**: Do not destroy references owned by the physics system.

---

## Core Systems & Initialization

### `JoltInterface`
The main entry point. Initializes the physics system, thread pool, and memory allocators.

*   **Constructor:** `new JoltInterface(JoltSettings settings)`
*   **Methods:**
    *   `Step(float deltaTime, int collisionSteps)`: Advances the physics simulation.
    *   `GetPhysicsSystem()`: Returns the `PhysicsSystem` instance.
    *   `GetTempAllocator()`: Returns the `TempAllocator`.
    *   `destroy()`: Shuts down the engine.

### `JoltSettings`
Configuration object passed to `JoltInterface`.

*   **Attributes:**
    *   `mMaxBodies`: (uint) Max rigid/soft bodies.
    *   `mMaxBodyPairs`: (uint) Max broadphase pairs.
    *   `mMaxWorkerThreads`: (uint) Thread pool size.
    *   `mBroadPhaseLayerInterface`: (Ptr) Custom layer interface.
    *   `mObjectVsBroadPhaseLayerFilter`: (Ptr) Custom collision filter.
    *   `mObjectLayerPairFilter`: (Ptr) Custom pair filter.

### `PhysicsSystem`
The heart of the simulation.

*   **Key Methods:**
    *   `SetGravity(Vec3)` / `GetGravity()`
    *   `GetBodyInterface()` / `GetBodyInterfaceNoLock()`: For manipulating bodies.
    *   `OptimizeBroadPhase()`
    *   `AddConstraint(Constraint)` / `RemoveConstraint(Constraint)`
    *   `SetContactListener(ContactListener)`
    *   `GetNumBodies()`

---

## Math Types

### `Vec3` (Float3) & `RVec3` (Double3)
Jolt supports double precision positions (`RVec3`) and single precision vectors (`Vec3`).

*   **Constructor:** `new Vec3(x, y, z)`
*   **Static Helpers:** `sZero()`, `sOne()`, `sAxisX()`, `sAxisY()`, `sAxisZ()`.
*   **Methods:** `Length()`, `Normalized()`, `Dot(v)`, `Cross(v)`, `Add(v)`, `Sub(v)`, `Mul(float)`.
*   *Note: Arithmetic methods usually have in-place versions (e.g., `Add`) and value-return versions (e.g., `AddVec3`).*

### `Quat` (Quaternion)
*   **Constructor:** `new Quat(x, y, z, w)`
*   **Static Helpers:** `sIdentity()`, `sRotation(Vec3 axis, float angle)`, `sEulerAngles(Vec3)`.
*   **Methods:** `MulQuat(q)`, `MulVec3(v)`, `Inversed()`, `Normalized()`.

### `Mat44` & `RMat44` (Matrix 4x4)
*   **Static Helpers:** `sIdentity()`, `sRotation(Quat)`, `sTranslation(Vec3)`.
*   **Methods:** `Multiply3x3(Vec3)`, `GetTranslation()`, `SetTranslation(Vec3)`.

---

## Bodies & Properties

### `BodyCreationSettings`
Describes a body before it is created.

*   **Constructor:** `new BodyCreationSettings(Shape shape, RVec3 pos, Quat rot, EMotionType type, int layer)`
*   **Attributes:**
    *   `mLinearVelocity`, `mAngularVelocity`
    *   `mFriction`, `mRestitution`
    *   `mAllowedDOFs` (Degrees of Freedom)
    *   `mIsSensor`
    *   `mMotionType`: `EMotionType_Static`, `EMotionType_Dynamic`, `EMotionType_Kinematic`.

### `BodyInterface`
Used to manipulate bodies in the system.

*   **Creation/Destruction:**
    *   `CreateBody(BodyCreationSettings)` -> `Body`
    *   `AddBody(BodyID, EActivation)`
    *   `RemoveBody(BodyID)`
    *   `DestroyBody(BodyID)`
*   **Manipulation:**
    *   `SetLinearVelocity(BodyID, Vec3)`
    *   `SetPosition(BodyID, RVec3, EActivation)`
    *   `AddForce(BodyID, Vec3)`
    *   `SetMotionType(BodyID, EMotionType, EActivation)`

### `Body`
A rigid body handle.
*   `GetID()`: Returns `BodyID`.
*   `GetPosition()`, `GetRotation()`.
*   `IsActive()`, `IsSensor()`, `IsStatic()`.

### `BodyID`
A lightweight identifier for a body.
*   `GetIndex()`, `GetIndexAndSequenceNumber()`.

---

## Shapes

Shapes are usually created via `ShapeSettings` classes, which produce `ShapeResult`, from which you extract the `Shape`.

### `ShapeSettings` (Base)
*   `Create()`: Returns `ShapeResult`.

### Common Shapes
1.  **Box:** `BoxShapeSettings(Vec3 halfExtent)`
2.  **Sphere:** `SphereShapeSettings(float radius)`
3.  **Capsule:** `CapsuleShapeSettings(float halfHeight, float radius)`
4.  **Cylinder:** `CylinderShapeSettings(float halfHeight, float radius)`
5.  **ConvexHull:** `ConvexHullShapeSettings` (Use `mPoints.push_back(v)`).
6.  **Mesh:** `MeshShapeSettings(VertexList, IndexedTriangleList)`.
7.  **HeightField:** `HeightFieldShapeSettings`.
8.  **StaticCompound / MutableCompound:** For combining multiple shapes.

### `ShapeResult`
*   `IsValid()`: Check success.
*   `Get()`: Returns the `Shape`.
*   `GetError()`: Returns string error if failed.

---

## Constraints

Joints connecting two bodies. Created via `ConstraintSettings`.

### Common Constraints
*   **FixedConstraint:** Locks two bodies together.
*   **PointConstraint:** Ball-and-socket joint.
*   **HingeConstraint:** Rotates around an axis (door, wheel).
*   **SliderConstraint:** Slides along an axis (piston).
*   **DistanceConstraint:** Keeps bodies within a distance range.
*   **SixDOFConstraint:** Configurable degrees of freedom.

### Usage
```javascript
let settings = new Jolt.HingeConstraintSettings();
// ... config settings ...
let constraint = bodyInterface.CreateConstraint(settings, body1.GetID(), body2.GetID());
physicsSystem.AddConstraint(constraint);
```

---

## Collision Queries (Casting)

Accessed via `PhysicsSystem.GetNarrowPhaseQuery()` or `GetBroadPhaseQuery()`.

### `RayCast`
*   **Structure:** `new RayCast(Vec3 origin, Vec3 direction)`
*   **Execution:** `CastRay(RayCast, RayCastResult, ...)`
*   **Result:** `RayCastResult` contains `mBodyID`, `mFraction`, `mSubShapeID2`.

### `ShapeCast`
*   **Structure:** `new ShapeCast(Shape, Vec3 scale, Mat44 comStart, Vec3 direction)`
*   **Execution:** `CastShape(...)`

### Collectors
You must provide a collector to receive results.
*   `CastRayClosestHitCollisionCollector`: Finds only the nearest hit.
*   `CastRayAllHitCollisionCollector`: Finds all hits.

---

## Character Virtual

A kinematic character controller (e.g., for FPS games).

### `CharacterVirtualSettings`
*   `mMass`, `mMaxSlopeAngle`, `mMaxStrength`.
*   `mShape`: The collision shape (usually a Capsule).

### `CharacterVirtual`
*   **Constructor:** `new CharacterVirtual(CharacterVirtualSettings, RVec3 pos, Quat rot, PhysicsSystem)`
*   **Update:** `Update(deltaTime, gravity, layerFilters...)`
*   **Movement:** `SetLinearVelocity(Vec3)`
*   **State:** `GetPosition()`, `GetGroundState()`, `CanWalkStairs()`.

---

## Vehicles

Jolt provides Raycast and CastSphere vehicle simulations.

### `VehicleConstraintSettings`
*   `mWheels`: `ArrayWheelSettings`.
*   `mController`: `WheeledVehicleControllerSettings`, `MotorcycleControllerSettings`, or `TrackedVehicleControllerSettings`.

### `VehicleConstraint`
*   `GetController()`: Access engine/transmission.
*   `GetWheel(index)`: Access specific wheel state.

---

## Soft Bodies

Simulation of cloth or pressurized soft volumes.

### `SoftBodyCreationSettings`
*   **Constructor:** `new SoftBodyCreationSettings(SoftBodySharedSettings, RVec3 pos, Quat rot, int layer)`
*   `mPressure`: For inflated objects.

### `SoftBodySharedSettings`
Defines the mesh and constraints (Edges, Volume, etc.) of the soft body.
*   `mVertices`: `ArraySoftBodySharedSettingsVertex`.
*   `mFaces`: `ArraySoftBodySharedSettingsFace`.
*   `CreateConstraints(...)`: Helper to auto-generate constraints from geometry.

---

## Listeners & Callbacks

To receive callbacks in JavaScript, you must instantiate the specific `...JS` class provided by the binding.

### `ContactListenerJS`
Listens for rigid body collisions.
*   **Override:**
    *   `OnContactValidate(body1, body2, offset, result)`: Return `ValidateResult`.
    *   `OnContactAdded(body1, body2, manifold, settings)`
    *   `OnContactPersisted(...)`
    *   `OnContactRemoved(...)`

### `PhysicsStepListenerJS`
Callback fired every physics step.
*   **Override:** `OnStep(context)`

### `BodyActivationListenerJS`
Listens for bodies going to sleep or waking up.
*   **Override:** `OnBodyActivated(bodyID, userData)`, `OnBodyDeactivated(...)`.

### Implementation Example
```javascript
const contactListener = new Jolt.ContactListenerJS();
contactListener.OnContactAdded = (body1, body2, manifold, settings) => {
    console.log("Collision detected!");
};
physicsSystem.SetContactListener(contactListener);
```

### Filters (JS Implementations)
Custom collision logic can be implemented via:
*   `ObjectLayerPairFilterJS`
*   `ObjectVsBroadPhaseLayerFilterJS`
*   `BroadPhaseLayerInterfaceJS`
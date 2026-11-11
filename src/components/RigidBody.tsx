import React, { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useJolt } from "../context/JoltContext";
import { ShapeSystem, type AutoShape } from "../systems/ShapeSystem";
import {
  toJoltQuat,
  toJoltRVec3,
  LAYER_MOVING,
  LAYER_NON_MOVING,
} from "../utils/joltUtils";
import type Jolt from "jolt-physics";
import { containSphere } from "../utils/containment";

export interface RigidImpact {
  impulse: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
}

export interface RigidBodyProps {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  type?: "Box" | "Sphere" | "Capsule" | "Cylinder" | "convex" | "trimesh";
  shape?: "Box" | "Sphere" | "Capsule" | "Cylinder" | "convex" | "trimesh";
  args?: number[];
  motionType?: number;
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityFactor?: number;
  /** A sealed SoftBody mesh that keeps this rigid body inside it. */
  containedBy?: React.RefObject<THREE.Mesh | null>;
  /** Radius of the item in world units for containment; defaults to zero. */
  containmentRadius?: number;
  initialLinearVelocity?: [number, number, number];
  initialAngularVelocity?: [number, number, number];
  /** Approximate impact impulse, measured from rigid body velocity change. */
  onImpact?: (impact: RigidImpact) => void;
  impactThreshold?: number;
  onBodyCreated?: (body: Jolt.Body | null) => void;
  children?: React.ReactNode;
}

const DEFAULT_POSITION: [number, number, number] = [0, 0, 0];
const DEFAULT_ROTATION: [number, number, number, number] = [0, 0, 0, 1];
const DEFAULT_ARGS = [1, 1, 1];
// Per-frame scratch values; useFrame callbacks run one at a time.
const velocity = new THREE.Vector3();
const gravity = new THREE.Vector3();
const bodyPosition = new THREE.Vector3();

const findFirstMesh = (root: THREE.Object3D): THREE.Mesh | null => {
  let mesh: THREE.Mesh | null = null;

  root.traverse((child) => {
    if (!mesh && child instanceof THREE.Mesh) {
      mesh = child;
    }
  });

  return mesh;
};

/** Body pose at the last two fixed steps, for render interpolation. */
interface Pose {
  previousPosition: THREE.Vector3;
  previousRotation: THREE.Quaternion;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  step: number;
}

const createPose = (): Pose => ({
  previousPosition: new THREE.Vector3(),
  previousRotation: new THREE.Quaternion(),
  position: new THREE.Vector3(),
  rotation: new THREE.Quaternion(),
  step: -1,
});

const readPose = (body: Jolt.Body, pose: Pose) => {
  const p = body.GetPosition(), q = body.GetRotation();
  pose.position.set(p.GetX(), p.GetY(), p.GetZ());
  pose.rotation.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
};

/** Jump to the body's pose with no blend, e.g. after creation or a teleport. */
const snapPose = (body: Jolt.Body, pose: Pose, group: THREE.Group, step: number) => {
  readPose(body, pose);
  pose.previousPosition.copy(pose.position);
  pose.previousRotation.copy(pose.rotation);
  pose.step = step;
  group.position.copy(pose.position);
  group.quaternion.copy(pose.rotation);
};

const normalizeShape = (
  shape?: RigidBodyProps["shape"] | RigidBodyProps["type"]
): AutoShape | undefined => {
  switch (shape) {
    case "Box":
      return "box";
    case "Sphere":
      return "sphere";
    case "Capsule":
      return "capsule";
    case "Cylinder":
      return "cylinder";
    case "convex":
      return "convex";
    case "trimesh":
      return "trimesh";
    default:
      return undefined;
  }
};

const createShapeSettings = (
  jolt: typeof Jolt,
  root: THREE.Group,
  shape: RigidBodyProps["shape"] | RigidBodyProps["type"],
  args: number[]
) => {
  const shapeSystem = new ShapeSystem(jolt);
  const normalizedShape = normalizeShape(shape);

  switch (normalizedShape) {
    case "box":
      if (args.length >= 3) return shapeSystem.box(new THREE.Vector3(args[0], args[1], args[2]));
      break;
    case "sphere":
      if (args.length >= 1) return new jolt.SphereShapeSettings(args[0]);
      break;
    case "capsule":
      if (args.length >= 2) return new jolt.CapsuleShapeSettings(args[1] / 2, args[0]);
      break;
    case "cylinder":
      if (args.length >= 2) return shapeSystem.cylinder(args[1] / 2, args[0]);
      break;
  }

  const targetMesh = findFirstMesh(root);
  if (!targetMesh) return shapeSystem.box(new THREE.Vector3(1, 1, 1));
  // The mesh relative to the body, so child scale/offset reach convex and trimesh shapes.
  root.updateWorldMatrix(true, true);
  const meshToBody = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(targetMesh.matrixWorld);
  return shapeSystem.getShapeSettingsFromObject(targetMesh, normalizedShape, meshToBody);
};

export const RigidBody: React.FC<RigidBodyProps> = ({
  position = DEFAULT_POSITION,
  rotation = DEFAULT_ROTATION,
  type,
  shape,
  args = DEFAULT_ARGS,
  motionType,
  mass,
  friction,
  restitution,
  linearDamping,
  angularDamping,
  gravityFactor,
  containedBy,
  containmentRadius = 0,
  initialLinearVelocity,
  initialAngularVelocity,
  onImpact,
  impactThreshold = 1,
  onBodyCreated,
  children,
}) => {
  if (!Number.isFinite(containmentRadius) || containmentRadius < 0) throw new Error("containmentRadius must be finite and nonnegative");
  const world = useJolt();
  const { jolt, bodyInterface, physicsSystem, clock } = world;
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<Jolt.Body | null>(null);
  const bodyIdRef = useRef<Jolt.BodyID | null>(null);
  const previousVelocity = useRef<THREE.Vector3 | null>(null);
  const wasActive = useRef(true);
  const [pose] = useState(createPose);

  const argsKey = JSON.stringify(args);
  const positionKey = position.join(",");
  const rotationKey = rotation.join(",");

  useEffect(() => {
    if (!groupRef.current) return;

    const shapeSettings = createShapeSettings(
      jolt,
      groupRef.current,
      shape ?? type,
      args
    );
    const shapeResult = shapeSettings.Create();

    if (!shapeResult.IsValid()) {
      const error = shapeResult.HasError()
        ? shapeResult.GetError().c_str()
        : "Unknown Jolt shape creation error";
      console.error(`[r3f-jolt] Failed to create rigid body shape: ${error}`);
      shapeResult.Clear();
      jolt.destroy(shapeSettings);
      return;
    }

    const initialPosition = toJoltRVec3(jolt, position);
    const initialRotation = toJoltQuat(jolt, rotation);
    const resolvedMotionType = motionType ?? jolt.EMotionType_Dynamic;
    const objectLayer =
      resolvedMotionType === jolt.EMotionType_Static
        ? LAYER_NON_MOVING
        : LAYER_MOVING;
    const activationMode =
      resolvedMotionType === jolt.EMotionType_Static
        ? jolt.EActivation_DontActivate
        : jolt.EActivation_Activate;
    const creationSettings = new jolt.BodyCreationSettings(
      shapeResult.Get(),
      initialPosition,
      initialRotation,
      resolvedMotionType,
      objectLayer
    );

    if (mass != null) {
      creationSettings.mOverrideMassProperties =
        jolt.EOverrideMassProperties_CalculateInertia;
      creationSettings.mMassPropertiesOverride.mMass = mass;
    }

    if (friction != null) {
      creationSettings.mFriction = friction;
    }

    if (restitution != null) {
      creationSettings.mRestitution = restitution;
    }

    if (linearDamping != null) {
      creationSettings.mLinearDamping = linearDamping;
    }

    if (angularDamping != null) {
      creationSettings.mAngularDamping = angularDamping;
    }

    if (gravityFactor != null) {
      creationSettings.mGravityFactor = gravityFactor;
    }

    const body = bodyInterface.CreateBody(creationSettings);
    const bodyId = body.GetID();
    const bodyKey = bodyId.GetIndexAndSequenceNumber();

    bodyInterface.AddBody(bodyId, activationMode);
    if (initialLinearVelocity && resolvedMotionType === jolt.EMotionType_Dynamic) {
      const v = new jolt.Vec3(...initialLinearVelocity);
      bodyInterface.SetLinearVelocity(bodyId, v);
      jolt.destroy(v);
    }
    if (initialAngularVelocity && resolvedMotionType === jolt.EMotionType_Dynamic) {
      const v = new jolt.Vec3(...initialAngularVelocity);
      bodyInterface.SetAngularVelocity(bodyId, v);
      jolt.destroy(v);
    }
    bodyRef.current = body;
    bodyIdRef.current = bodyId;
    onBodyCreated?.(body);
    previousVelocity.current = null;
    wasActive.current = true;
    snapPose(body, pose, groupRef.current, clock.count);

    jolt.destroy(initialPosition);
    jolt.destroy(initialRotation);
    jolt.destroy(creationSettings);
    shapeResult.Clear();
    jolt.destroy(shapeSettings);

    return () => {
      if (
        !world.alive ||
        !bodyIdRef.current ||
        bodyIdRef.current.GetIndexAndSequenceNumber() !== bodyKey
      ) {
        return;
      }

      bodyRef.current = null;
      bodyIdRef.current = null;
      onBodyCreated?.(null);
      previousVelocity.current = null;
      bodyInterface.RemoveBody(bodyId);
      bodyInterface.DestroyBody(bodyId);
    };
  }, [argsKey, bodyInterface, jolt, mass, motionType, shape, type]);

  useEffect(() => {
    const bodyId = bodyIdRef.current;
    const body = bodyRef.current;
    if (!bodyId || !body) return;

    const nextPosition = toJoltRVec3(jolt, position);
    const nextRotation = toJoltQuat(jolt, rotation);
    const activationMode =
      body.GetMotionType() === jolt.EMotionType_Static
        ? jolt.EActivation_DontActivate
        : jolt.EActivation_Activate;

    bodyInterface.SetPositionAndRotation(
      bodyId,
      nextPosition,
      nextRotation,
      activationMode
    );

    if (groupRef.current) {
      snapPose(body, pose, groupRef.current, clock.count);
    }

    jolt.destroy(nextPosition);
    jolt.destroy(nextRotation);
  }, [bodyInterface, jolt, positionKey, rotationKey]);

  useEffect(() => {
    const bodyId = bodyIdRef.current;
    const body = bodyRef.current;
    if (!bodyId || !body) return;

    if (friction != null) {
      bodyInterface.SetFriction(bodyId, friction);
    }

    if (restitution != null) {
      bodyInterface.SetRestitution(bodyId, restitution);
    }

    if (gravityFactor != null) {
      bodyInterface.SetGravityFactor(bodyId, gravityFactor);
    }

    if (body.GetMotionType() !== jolt.EMotionType_Static) {
      const motionProperties = body.GetMotionProperties();

      if (linearDamping != null) {
        motionProperties.SetLinearDamping(linearDamping);
      }

      if (angularDamping != null) {
        motionProperties.SetAngularDamping(angularDamping);
      }
    }
  }, [
    angularDamping,
    bodyInterface,
    friction,
    gravityFactor,
    jolt,
    linearDamping,
    restitution,
  ]);

  useFrame((_, delta) => {
    if (!bodyRef.current || !groupRef.current) return;
    const container = containedBy?.current;
    const body = bodyRef.current;
    const bodyId = bodyIdRef.current;
    const isActive = body.IsActive();
    // Sleeping bodies don't move: sync once after they fall asleep, then skip.
    // Contained items keep checking, because their container can move around them.
    if (!isActive && !wasActive.current && !container) return;
    const fellAsleep = !isActive && wasActive.current;
    wasActive.current = isActive;
    if (onImpact && body.GetMotionType() === jolt.EMotionType_Dynamic) {
      const v = body.GetLinearVelocity();
      velocity.set(v.GetX(), v.GetY(), v.GetZ());
      const previous = previousVelocity.current;
      const inverseMass = body.GetMotionProperties().GetInverseMass();
      if (previous && inverseMass > 0) {
        const g = physicsSystem.GetGravity();
        const impulse = gravity.set(g.GetX(), g.GetY(), g.GetZ())
          .multiplyScalar(-delta).add(velocity).sub(previous)
          .length() / inverseMass;
        if (impulse >= impactThreshold) {
          const p = body.GetPosition(), q = body.GetRotation(), w = body.GetAngularVelocity();
          onImpact({
            impulse,
            position: [p.GetX(), p.GetY(), p.GetZ()],
            rotation: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
            velocity: [velocity.x, velocity.y, velocity.z],
            angularVelocity: [w.GetX(), w.GetY(), w.GetZ()],
          });
        }
      }
      previousVelocity.current = (previous ?? new THREE.Vector3()).copy(velocity);
    }
    if (container && bodyId && body.GetMotionType() === jolt.EMotionType_Dynamic) {
      const p = body.GetPosition();
      const constrained = containSphere(
        container,
        bodyPosition.set(p.GetX(), p.GetY(), p.GetZ()),
        containmentRadius
      );
      if (constrained) {
        const nextPosition = toJoltRVec3(jolt, constrained.position);
        bodyInterface.SetPositionAndRotation(bodyId, nextPosition, body.GetRotation(), jolt.EActivation_Activate);
        jolt.destroy(nextPosition);
        const currentVelocity = body.GetLinearVelocity();
        velocity.set(currentVelocity.GetX(), currentVelocity.GetY(), currentVelocity.GetZ());
        const outwardSpeed = velocity.dot(constrained.inwardNormal);
        if (outwardSpeed < 0) {
          velocity.addScaledVector(constrained.inwardNormal, -(1 + (restitution ?? 0)) * outwardSpeed);
          const nextVelocity = new jolt.Vec3(velocity.x, velocity.y, velocity.z);
          bodyInterface.SetLinearVelocity(bodyId, nextVelocity);
          jolt.destroy(nextVelocity);
        }
      }
    }
    if (pose.step !== clock.count) {
      pose.previousPosition.copy(pose.position);
      pose.previousRotation.copy(pose.rotation);
      pose.step = clock.count;
    }
    readPose(body, pose);
    if (fellAsleep) {
      pose.previousPosition.copy(pose.position);
      pose.previousRotation.copy(pose.rotation);
    }
    // shortcut: when one frame runs several fixed steps, the blend starts from the pose two or
    // more steps back; only visible while the frame rate is far below the step rate.
    groupRef.current.position.lerpVectors(pose.previousPosition, pose.position, clock.alpha);
    groupRef.current.quaternion.slerpQuaternions(pose.previousRotation, pose.rotation, clock.alpha);
  }, -25);

  return <group ref={groupRef}>{children}</group>;
};

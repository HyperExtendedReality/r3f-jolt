import React, { useEffect, useRef } from "react";
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
  children?: React.ReactNode;
}

const DEFAULT_POSITION: [number, number, number] = [0, 0, 0];
const DEFAULT_ROTATION: [number, number, number, number] = [0, 0, 0, 1];
const DEFAULT_ARGS = [1, 1, 1];
const CONVEX_RADIUS = 0.05;

const findFirstMesh = (root: THREE.Object3D): THREE.Mesh | null => {
  let mesh: THREE.Mesh | null = null;

  root.traverse((child) => {
    if (!mesh && child instanceof THREE.Mesh) {
      mesh = child;
    }
  });

  return mesh;
};

const syncGroupFromBody = (body: Jolt.Body, group: THREE.Group) => {
  const position = body.GetPosition();
  const rotation = body.GetRotation();

  group.position.set(position.GetX(), position.GetY(), position.GetZ());
  group.quaternion.set(
    rotation.GetX(),
    rotation.GetY(),
    rotation.GetZ(),
    rotation.GetW()
  );
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

const createDefaultBoxShape = (jolt: typeof Jolt) => {
  const halfExtent = new jolt.Vec3(0.5, 0.5, 0.5);
  const shapeSettings = new jolt.BoxShapeSettings(halfExtent, CONVEX_RADIUS);
  jolt.destroy(halfExtent);
  return shapeSettings;
};

const createShapeSettings = (
  jolt: typeof Jolt,
  root: THREE.Group,
  shape: RigidBodyProps["shape"] | RigidBodyProps["type"],
  args: number[]
) => {
  const shapeSystem = new ShapeSystem(jolt);
  const normalizedShape = normalizeShape(shape);
  const targetMesh = findFirstMesh(root);

  switch (normalizedShape) {
    case "box": {
      if (args.length >= 3) {
        const halfExtent = new jolt.Vec3(args[0] / 2, args[1] / 2, args[2] / 2);
        const shapeSettings = new jolt.BoxShapeSettings(
          halfExtent,
          CONVEX_RADIUS
        );
        jolt.destroy(halfExtent);
        return shapeSettings;
      }
      break;
    }
    case "sphere":
      if (args.length >= 1) {
        return new jolt.SphereShapeSettings(args[0]);
      }
      break;
    case "capsule":
      if (args.length >= 2) {
        return new jolt.CapsuleShapeSettings(args[1] / 2, args[0]);
      }
      break;
    case "cylinder":
      if (args.length >= 2) {
        return new jolt.CylinderShapeSettings(
          args[1] / 2,
          args[0],
          CONVEX_RADIUS
        );
      }
      break;
    case "convex":
    case "trimesh":
      if (targetMesh) {
        return shapeSystem.getShapeSettingsFromObject(targetMesh, normalizedShape);
      }
      break;
    default:
      break;
  }

  if (targetMesh) {
    return (
      shapeSystem.getShapeSettingsFromGeometry(targetMesh.geometry, normalizedShape) ??
      createDefaultBoxShape(jolt)
    );
  }

  return createDefaultBoxShape(jolt);
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
  children,
}) => {
  const { jolt, bodyInterface } = useJolt();
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<Jolt.Body | null>(null);
  const bodyIdRef = useRef<Jolt.BodyID | null>(null);

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
    bodyRef.current = body;
    bodyIdRef.current = bodyId;
    syncGroupFromBody(body, groupRef.current);

    jolt.destroy(initialPosition);
    jolt.destroy(initialRotation);
    jolt.destroy(creationSettings);
    shapeResult.Clear();
    jolt.destroy(shapeSettings);

    return () => {
      if (
        !bodyIdRef.current ||
        bodyIdRef.current.GetIndexAndSequenceNumber() !== bodyKey
      ) {
        return;
      }

      bodyRef.current = null;
      bodyIdRef.current = null;
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
      syncGroupFromBody(body, groupRef.current);
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

  useFrame(() => {
    if (!bodyRef.current || !groupRef.current) return;
    syncGroupFromBody(bodyRef.current, groupRef.current);
  });

  return <group ref={groupRef}>{children}</group>;
};

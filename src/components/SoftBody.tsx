import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useLoader, type ThreeElements } from "@react-three/fiber";
import * as THREE from "three";
import { useJolt } from "../context/JoltContext";
import { SoftBodyCreator } from "../utils/SoftBodyCreator";
import { toJoltQuat, toJoltRVec3, LAYER_MOVING } from "../utils/joltUtils";
import type Jolt from "jolt-physics";
import { softBodyMaterials, type SoftBodyPhysicsMaterial } from "../materials/SoftBodyPhysicsMaterial";
import { SoftSurface, type StepClock } from "../utils/softBodyCollision";
import { registerSurface, unregisterSurface } from "../utils/surfaceIndex";

type SoftBodyType = "Sphere" | "Cloth" | "Cube";

export interface SoftBodyConfig {
  inverseMass?: number;
  radius?: number;
  numTheta?: number;
  numPhi?: number;
  gridSize?: number;
  gridSizeX?: number;
  gridSizeZ?: number;
  gridSpacing?: number;
  edgeCompliance?: number;
  volumeCompliance?: number;
  compliance?: number;
  shearCompliance?: number;
  bendCompliance?: number;
  bendType?: number;
  lraType?: number;
  fixatedCorners?: boolean;
  fixedCorners?: boolean;
  vertexGetInvMass?: (x: number, z: number) => number;
  vertexPerturbation?: (x: number, z: number) => {
    x: number;
    y: number;
    z: number;
  };
}

type SoftBodyMeshProps = Omit<
  ThreeElements["mesh"],
  "children" | "geometry" | "material" | "position" | "ref" | "rotation"
>;

export interface SoftBodyProps extends SoftBodyMeshProps {
  /** Procedural shape used when geometry is not provided. */
  type?: SoftBodyType;
  /** Triangle geometry used to create a custom soft body. */
  geometry?: THREE.BufferGeometry;
  config?: SoftBodyConfig;
  /** Physical behavior, independent of the Three.js visual material. */
  physicsMaterial?: keyof typeof softBodyMaterials | SoftBodyPhysicsMaterial;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  pressure?: number;
  iterations?: number;
  vertexRadius?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  gravityFactor?: number;
  initialLinearVelocity?: [number, number, number];
  onBodyCreated?: (body: Jolt.Body | null) => void;
  doubleSided?: boolean;
  color?: string | number;
  /** A preloaded Three.js texture or an image URL for the default material. */
  texture?: THREE.Texture | string;
  /** Color space applied to URL-loaded color textures. */
  textureColorSpace?: THREE.ColorSpace;
  /** A Three.js material, including ShaderMaterial and custom materials. */
  material?: THREE.Material;
  /**
   * Rebuild smooth vertex normals once per fixed step. By default this happens only when the
   * material reads normals (not for MeshBasicMaterial, flatShading, or shaders that ignore them).
   */
  updateNormals?: boolean;
  children?: React.ReactNode;
}

interface SoftBodyCreationData {
  settings: Jolt.SoftBodySharedSettings;
  uvs: Float32Array | null;
  renderIndices?: Uint16Array | Uint32Array;
  renderToPhysics?: Uint32Array;
  closed: boolean;
}

interface SoftBodyRuntime {
  settings: Jolt.SoftBodySharedSettings;
  closed: boolean;
  body: Jolt.Body;
  bodyId: Jolt.BodyID;
  motionProperties: Jolt.SoftBodyMotionProperties;
  surface: SoftSurface;
  positionAttribute: THREE.BufferAttribute;
  positionValues: Float32Array;
  normalAttribute: THREE.BufferAttribute;
  normalValues: Float32Array;
  indexValues: Uint16Array | Uint32Array;
  /** Physics vertex for each render vertex; null when they are the same. */
  renderToPhysics: Uint32Array | null;
  /** Surface revision the normals were last built from; -1 forces a rebuild. */
  normalRevision: number;
  wasActive: boolean;
}

const DEFAULT_POSITION: [number, number, number] = [0, 0, 0];
const DEFAULT_ROTATION: [number, number, number, number] = [0, 0, 0, 1];
const DEFAULT_CONFIG: SoftBodyConfig = {};

interface DefaultMaterialProps {
  color: string | number;
  texture?: THREE.Texture | string;
  textureColorSpace: THREE.ColorSpace;
}

const UrlTextureMaterial: React.FC<
  DefaultMaterialProps & { texture: string }
> = ({ color, texture, textureColorSpace }) => {
  const sourceMap = useLoader(THREE.TextureLoader, texture);
  const map = useMemo(() => {
    const clone = sourceMap.clone();
    clone.colorSpace = textureColorSpace;
    clone.needsUpdate = true;
    return clone;
  }, [sourceMap, textureColorSpace]);

  useEffect(() => () => map.dispose(), [map]);

  return (
    <meshStandardMaterial color={color} map={map} side={THREE.DoubleSide} />
  );
};

const DefaultMaterial: React.FC<DefaultMaterialProps> = ({
  color,
  texture,
  textureColorSpace,
}) => {
  if (typeof texture === "string") {
    return (
      <UrlTextureMaterial
        color={color}
        texture={texture}
        textureColorSpace={textureColorSpace}
      />
    );
  }

  return (
    <meshStandardMaterial
      color={color}
      map={texture}
      side={THREE.DoubleSide}
    />
  );
};

const syncMeshTransform = (body: Jolt.Body, mesh: THREE.Mesh) => {
  const position = body.GetPosition();
  const rotation = body.GetRotation();

  mesh.position.set(position.GetX(), position.GetY(), position.GetZ());
  mesh.quaternion.set(
    rotation.GetX(),
    rotation.GetY(),
    rotation.GetZ(),
    rotation.GetW()
  );
};

const createVertexAttributes = (
  jolt: typeof Jolt,
  config: SoftBodyConfig,
  defaults: {
    compliance: number;
    shearCompliance: number;
    bendCompliance: number;
  }
) => {
  const hasCustomValues =
    config.compliance != null ||
    config.shearCompliance != null ||
    config.bendCompliance != null ||
    config.lraType != null;

  if (!hasCustomValues) {
    return null;
  }

  const attributes = new jolt.SoftBodySharedSettingsVertexAttributes();
  attributes.mCompliance = config.compliance ?? defaults.compliance;
  attributes.mShearCompliance =
    config.shearCompliance ?? defaults.shearCompliance;
  attributes.mBendCompliance =
    config.bendCompliance ?? defaults.bendCompliance;

  if (config.lraType != null) {
    attributes.mLRAType = config.lraType;
  }

  return attributes;
};

const createClothData = (
  jolt: typeof Jolt,
  config: SoftBodyConfig
): SoftBodyCreationData => {
  const gridSizeX = config.gridSizeX ?? config.gridSize ?? 30;
  const gridSizeZ = config.gridSizeZ ?? config.gridSize ?? 30;
  const gridSpacing = config.gridSpacing ?? 0.75;
  const bendType =
    config.bendType ?? jolt.SoftBodySharedSettings_EBendType_None;
  const shouldFixCorners = config.fixatedCorners ?? config.fixedCorners ?? false;
  const invMass =
    config.vertexGetInvMass ??
    ((x: number, z: number) => {
      if (!shouldFixCorners) {
        return config.inverseMass ?? 1;
      }

      const isCorner =
        (x === 0 && z === 0) ||
        (x === gridSizeX - 1 && z === 0) ||
        (x === 0 && z === gridSizeZ - 1) ||
        (x === gridSizeX - 1 && z === gridSizeZ - 1);

      return isCorner ? 0 : config.inverseMass ?? 1;
    });
  const perturbation =
    config.vertexPerturbation ?? (() => ({ x: 0, y: 0, z: 0 }));
  const attributes = createVertexAttributes(jolt, config, {
    compliance: 1.0e-5,
    shearCompliance: 1.0e-5,
    bendCompliance: 1.0e-5,
  });

  try {
    return SoftBodyCreator.CreateCloth(
      jolt,
      gridSizeX,
      gridSizeZ,
      gridSpacing,
      invMass,
      perturbation,
      bendType,
      attributes ?? undefined
    );
  } finally {
    if (attributes) {
      jolt.destroy(attributes);
    }
  }
};

const createSphereData = (
  jolt: typeof Jolt,
  config: SoftBodyConfig
): SoftBodyCreationData => {
  const attributes = createVertexAttributes(jolt, config, {
    compliance: 1.0e-4,
    shearCompliance: 1.0e-4,
    bendCompliance: 1.0e-3,
  });

  try {
    return SoftBodyCreator.CreateSphere(
      jolt,
      config.radius ?? 1,
      config.numTheta ?? 10,
      config.numPhi ?? 20,
      config.bendType ?? jolt.SoftBodySharedSettings_EBendType_None,
      attributes ?? undefined,
      config.inverseMass ?? 1
    );
  } finally {
    if (attributes) {
      jolt.destroy(attributes);
    }
  }
};

const createCubeData = (
  jolt: typeof Jolt,
  config: SoftBodyConfig
): SoftBodyCreationData => {
  return SoftBodyCreator.CreateCube(
    jolt,
    config.gridSize ?? 5,
    config.gridSpacing ?? 0.5,
    config.edgeCompliance ?? 0,
    config.volumeCompliance ?? 0,
    config.inverseMass ?? 1
  );
};

const createGeometryData = (
  jolt: typeof Jolt,
  geometry: THREE.BufferGeometry,
  config: SoftBodyConfig
): SoftBodyCreationData => {
  const attributes = createVertexAttributes(jolt, config, {
    compliance: 1.0e-4,
    shearCompliance: 1.0e-4,
    bendCompliance: 1.0e-3,
  });

  try {
    return SoftBodyCreator.CreateFromGeometry(
      jolt,
      geometry,
      attributes ?? undefined,
      config.bendType ?? jolt.SoftBodySharedSettings_EBendType_Dihedral,
      1e-5,
      config.inverseMass ?? 1
    );
  } finally {
    if (attributes) {
      jolt.destroy(attributes);
    }
  }
};

const createSoftBodyData = (
  jolt: typeof Jolt,
  type: SoftBodyType | undefined,
  config: SoftBodyConfig,
  geometry?: THREE.BufferGeometry
) => {
  if (geometry) {
    return createGeometryData(jolt, geometry, config);
  }

  switch (type) {
    case "Cloth":
      return createClothData(jolt, config);
    case "Cube":
      return createCubeData(jolt, config);
    case "Sphere":
    default:
      return createSphereData(jolt, config);
  }
};

const validateSoftBody = (config: SoftBodyConfig, pressure: number, iterations?: number) => {
  for (const key of ["inverseMass", "compliance", "shearCompliance", "bendCompliance", "edgeCompliance", "volumeCompliance"] as const) {
    const value = config[key];
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error(`SoftBody ${key} must be finite and nonnegative`);
  }
  if (!Number.isFinite(pressure) || pressure < 0) throw new Error("SoftBody pressure must be finite and nonnegative");
  if (iterations != null && (!Number.isInteger(iterations) || iterations < 1)) throw new Error("SoftBody iterations must be a positive integer");
  if (config.radius != null && (!Number.isFinite(config.radius) || config.radius <= 0)) throw new Error("SoftBody radius must be positive");
  if (config.gridSpacing != null && (!Number.isFinite(config.gridSpacing) || config.gridSpacing <= 0)) throw new Error("SoftBody gridSpacing must be positive");
  for (const key of ["gridSize", "gridSizeX", "gridSizeZ", "numTheta", "numPhi"] as const) {
    const value = config[key];
    const minimum = key === "numTheta" || key === "numPhi" ? 3 : 2;
    if (value != null && (!Number.isInteger(value) || value < minimum)) throw new Error(`SoftBody ${key} must be an integer of at least ${minimum}`);
  }
};

const buildSoftBodyRuntime = (
  jolt: typeof Jolt,
  body: Jolt.Body,
  geometry: THREE.BufferGeometry,
  creationData: SoftBodyCreationData,
  clock: StepClock
): SoftBodyRuntime => {
  const motionProperties = jolt.castObject(
    body.GetMotionProperties(),
    jolt.SoftBodyMotionProperties
  );
  const surface = new SoftSurface(jolt, body, motionProperties, clock);
  const renderToPhysics = creationData.renderToPhysics ?? null;
  const renderVertexCount = renderToPhysics?.length ?? surface.vertexCount;
  const positionValues = new Float32Array(renderVertexCount * 3);
  const positionAttribute = new THREE.BufferAttribute(positionValues, 3);
  const normalValues = new Float32Array(positionValues.length);
  const normalAttribute = new THREE.BufferAttribute(normalValues, 3);
  const IndexArray = renderVertexCount > 65_535 ? Uint32Array : Uint16Array;
  const indexValues = new IndexArray(creationData.renderIndices ?? surface.index.indices);

  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  normalAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("normal", normalAttribute);
  geometry.setIndex(new THREE.BufferAttribute(indexValues, 1));

  if (creationData.uvs) {
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(creationData.uvs, 2)
    );
  } else {
    geometry.deleteAttribute("uv");
  }

  const runtime: SoftBodyRuntime = {
    settings: creationData.settings,
    closed: creationData.closed,
    body,
    bodyId: body.GetID(),
    motionProperties,
    surface,
    positionAttribute,
    positionValues,
    normalAttribute,
    normalValues,
    indexValues,
    renderToPhysics,
    normalRevision: -1,
    wasActive: true,
  };

  updateSoftBodyBuffers(runtime, 1, true);
  geometry.computeBoundingSphere();

  return runtime;
};

/** Whether a material reads vertex normals; unlit and flat-shaded ones do not. */
const materialUsesNormals = (material: THREE.Material | THREE.Material[]): boolean =>
  (Array.isArray(material) ? material : [material]).some((item) => {
    if (item instanceof THREE.MeshBasicMaterial || (item as { flatShading?: boolean }).flatShading) return false;
    if (item instanceof THREE.ShaderMaterial && !item.lights) return /\bnormal\b/.test(item.vertexShader);
    return true;
  });

/** Blend the last two fixed-step vertex sets into the render buffers. */
const updateSoftBodyBuffers = (
  runtime: SoftBodyRuntime,
  alpha: number,
  wantNormals: boolean
) => {
  const current = runtime.surface.index.positions;
  const previous = runtime.surface.previous;
  const positions = runtime.positionValues;
  const map = runtime.renderToPhysics;
  const vertexCount = positions.length / 3;

  for (let i = 0, target = 0; i < vertexCount; i += 1, target += 3) {
    const source = (map ? map[i] : i) * 3;
    positions[target] = previous[source] + (current[source] - previous[source]) * alpha;
    positions[target + 1] = previous[source + 1] + (current[source + 1] - previous[source + 1]) * alpha;
    positions[target + 2] = previous[source + 2] + (current[source + 2] - previous[source + 2]) * alpha;
  }
  runtime.positionAttribute.needsUpdate = true;

  // Normals change only when the physics vertices do, so rebuild them once per fixed step.
  if (!wantNormals || runtime.normalRevision === runtime.surface.revision) return;
  runtime.normalRevision = runtime.surface.revision;
  runtime.surface.index.ensureNormals();
  const vertexNormals = runtime.surface.index.vertexNormals;
  const normals = runtime.normalValues;
  for (let i = 0, target = 0; i < vertexCount; i += 1, target += 3) {
    const source = (map ? map[i] : i) * 3;
    normals[target] = vertexNormals[source];
    normals[target + 1] = vertexNormals[source + 1];
    normals[target + 2] = vertexNormals[source + 2];
  }
  runtime.normalAttribute.needsUpdate = true;
};

const SoftBodyImpl = (
  {
  type,
  geometry,
  config = DEFAULT_CONFIG,
  physicsMaterial,
  position = DEFAULT_POSITION,
  rotation = DEFAULT_ROTATION,
  pressure,
  iterations,
  vertexRadius,
  friction,
  restitution,
  linearDamping,
  gravityFactor,
  initialLinearVelocity,
  onBodyCreated,
  doubleSided,
  color,
  texture,
  textureColorSpace = THREE.SRGBColorSpace,
  material,
  updateNormals,
  children,
  frustumCulled = false,
  ...meshProps
  }: SoftBodyProps,
  forwardedRef: React.ForwardedRef<THREE.Mesh>
) => {
  const world = useJolt();
  const { jolt, bodyInterface, clock, softSurfaces } = world;
  const meshRef = useRef<THREE.Mesh>(null);
  const [renderGeometry] = useState(() => new THREE.BufferGeometry());
  const runtimeRef = useRef<SoftBodyRuntime | null>(null);

  const materialSettings: SoftBodyPhysicsMaterial | undefined = typeof physicsMaterial === "string"
    ? softBodyMaterials[physicsMaterial]
    : physicsMaterial;
  const materialKey = JSON.stringify(materialSettings);
  const resolvedConfig = useMemo<SoftBodyConfig>(() => ({
    ...config,
    inverseMass: config.inverseMass ?? materialSettings?.inverseMass,
    compliance: config.compliance ?? materialSettings?.compliance,
    shearCompliance: config.shearCompliance ?? materialSettings?.shearCompliance,
    bendCompliance: config.bendCompliance ?? materialSettings?.bendCompliance,
    edgeCompliance: config.edgeCompliance ?? materialSettings?.compliance,
    volumeCompliance: config.volumeCompliance ?? materialSettings?.volumeCompliance,
  }), [config, materialKey]);
  const resolvedPressure = pressure ?? materialSettings?.pressure ?? 0;
  const resolvedIterations = iterations ?? materialSettings?.iterations;
  const resolvedVertexRadius = vertexRadius ?? materialSettings?.vertexRadius;
  const resolvedFriction = friction ?? materialSettings?.friction;
  const resolvedRestitution = restitution ?? materialSettings?.restitution;
  const resolvedLinearDamping = linearDamping ?? materialSettings?.linearDamping;
  const resolvedGravityFactor = gravityFactor ?? materialSettings?.gravityFactor;

  const setMeshRef = useCallback(
    (mesh: THREE.Mesh | null) => {
      meshRef.current = mesh;
      if (typeof forwardedRef === "function") {
        forwardedRef(mesh);
      } else if (forwardedRef) {
        forwardedRef.current = mesh;
      }
    },
    [forwardedRef]
  );

  const configKey = JSON.stringify(resolvedConfig);
  const geometryKey = geometry?.uuid ?? "";
  const positionKey = position.join(",");
  const rotationKey = rotation.join(",");

  useEffect(() => {
    return () => {
      renderGeometry.dispose();
    };
  }, []);

  useEffect(() => {
    validateSoftBody(resolvedConfig, resolvedPressure, resolvedIterations);
    const creationData = createSoftBodyData(jolt, type, resolvedConfig, geometry);
    const pressureFor = (closed: boolean) => {
      if (resolvedPressure > 0 && !closed) {
        // Logged, not thrown: a throw in an effect would unmount the whole canvas.
        console.error("[r3f-jolt] SoftBody pressure requires a sealed, consistently oriented triangle mesh; simulating without pressure.");
        return 0;
      }
      return resolvedPressure;
    };
    const initialPosition = toJoltRVec3(jolt, position);
    const initialRotation = toJoltQuat(jolt, rotation);
    const creationSettings = new jolt.SoftBodyCreationSettings(
      creationData.settings,
      initialPosition,
      initialRotation,
      LAYER_MOVING
    );

    creationSettings.mPressure = pressureFor(creationData.closed);
    creationSettings.mUpdatePosition = false;
    creationSettings.mFacesDoubleSided =
      doubleSided ?? (type === "Cloth" || Boolean(geometry));

    if (resolvedIterations != null) {
      creationSettings.mNumIterations = resolvedIterations;
    }

    if (resolvedVertexRadius != null) {
      creationSettings.mVertexRadius = resolvedVertexRadius;
    }

    if (resolvedFriction != null) {
      creationSettings.mFriction = resolvedFriction;
    }

    if (resolvedRestitution != null) {
      creationSettings.mRestitution = resolvedRestitution;
    }

    if (resolvedLinearDamping != null) {
      creationSettings.mLinearDamping = resolvedLinearDamping;
    }

    if (resolvedGravityFactor != null) {
      creationSettings.mGravityFactor = resolvedGravityFactor;
    }

    const body = bodyInterface.CreateSoftBody(creationSettings);
    const bodyId = body.GetID();
    const bodyKey = bodyId.GetIndexAndSequenceNumber();
    const runtime = buildSoftBodyRuntime(
      jolt,
      body,
      renderGeometry,
      creationData,
      clock
    );
    if (initialLinearVelocity) {
      const vertices = runtime.motionProperties.GetVertices();
      for (let i = 0; i < vertices.size(); i += 1) {
        const velocity = vertices.at(i).mVelocity;
        velocity.Set(...initialLinearVelocity);
      }
    }

    bodyInterface.AddBody(bodyId, jolt.EActivation_Activate);
    runtimeRef.current = runtime;
    softSurfaces.add(runtime.surface);
    onBodyCreated?.(body);

    const mesh = meshRef.current;
    if (mesh) {
      syncMeshTransform(body, mesh);
      // Containment queries read the physics vertices, not the interpolated render ones.
      registerSurface(mesh, () => {
        runtime.surface.sync();
        return runtime.surface.index;
      });
    }

    jolt.destroy(initialPosition);
    jolt.destroy(initialRotation);
    jolt.destroy(creationSettings);

    return () => {
      softSurfaces.delete(runtime.surface);
      if (mesh) unregisterSurface(mesh);
      if (
        !world.alive ||
        !runtimeRef.current ||
        runtimeRef.current.bodyId.GetIndexAndSequenceNumber() !== bodyKey
      ) {
        return;
      }

      runtimeRef.current = null;
      onBodyCreated?.(null);
      bodyInterface.RemoveBody(bodyId);
      // The body holds the only reference to its shared settings, so Jolt frees them here.
      bodyInterface.DestroyBody(bodyId);
    };
  }, [
    bodyInterface,
    resolvedConfig.vertexGetInvMass,
    resolvedConfig.vertexPerturbation,
    configKey,
    doubleSided,
    geometryKey,
    initialLinearVelocity?.join(","),
    jolt,
    type,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    const nextPosition = toJoltRVec3(jolt, position);
    const nextRotation = toJoltQuat(jolt, rotation);

    bodyInterface.SetPositionAndRotation(
      runtime.bodyId,
      nextPosition,
      nextRotation,
      jolt.EActivation_Activate
    );

    if (meshRef.current) {
      syncMeshTransform(runtime.body, meshRef.current);
    }

    jolt.destroy(nextPosition);
    jolt.destroy(nextRotation);
  }, [bodyInterface, jolt, positionKey, rotationKey]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    validateSoftBody(resolvedConfig, resolvedPressure, resolvedIterations);
    if (resolvedPressure > 0 && !runtime.closed) console.error("[r3f-jolt] SoftBody pressure requires a sealed, consistently oriented triangle mesh; simulating without pressure.");

    runtime.motionProperties.SetPressure(runtime.closed ? resolvedPressure : 0);
    runtime.motionProperties.SetUpdatePosition(false);

    if (resolvedIterations != null) {
      runtime.motionProperties.SetNumIterations(resolvedIterations);
    }

    if (resolvedVertexRadius != null) {
      runtime.motionProperties.SetVertexRadius(resolvedVertexRadius);
    }

    if (resolvedLinearDamping != null) {
      runtime.motionProperties.SetLinearDamping(resolvedLinearDamping);
    }

    if (resolvedGravityFactor != null) {
      runtime.motionProperties.SetGravityFactor(resolvedGravityFactor);
    }

    bodyInterface.ActivateBody(runtime.bodyId);
  }, [
    bodyInterface,
    resolvedGravityFactor,
    resolvedIterations,
    resolvedLinearDamping,
    resolvedPressure,
    resolvedVertexRadius,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    if (resolvedFriction != null) {
      bodyInterface.SetFriction(runtime.bodyId, resolvedFriction);
    }

    if (resolvedRestitution != null) {
      bodyInterface.SetRestitution(runtime.bodyId, resolvedRestitution);
    }
  }, [bodyInterface, resolvedFriction, resolvedRestitution]);

  useFrame(() => {
    const runtime = runtimeRef.current;
    const mesh = meshRef.current;
    if (!runtime || !mesh) return;

    const isActive = runtime.body.IsActive();
    if (!isActive && !runtime.wasActive) return;
    runtime.wasActive = isActive;

    runtime.surface.sync();
    // Asleep: settle on the final pose so the skipped frames show no half-blend.
    if (!isActive) runtime.surface.previous.set(runtime.surface.index.positions);
    updateSoftBodyBuffers(
      runtime,
      clock.alpha,
      updateNormals ?? materialUsesNormals(mesh.material)
    );
    syncMeshTransform(runtime.body, mesh);
  }, -50);

  const materialColor = color ?? (texture ? "white" : "hotpink");

  return (
    <mesh
      {...meshProps}
      ref={setMeshRef}
      geometry={renderGeometry}
      material={material}
      frustumCulled={frustumCulled}
    >
      {children ? (
        children
      ) : material ? null : (
        <DefaultMaterial
          color={materialColor}
          texture={texture}
          textureColorSpace={textureColorSpace}
        />
      )}
    </mesh>
  );
};

/** A deformable Jolt soft body rendered as a regular R3F mesh. */
export const SoftBody = React.forwardRef<THREE.Mesh, SoftBodyProps>(
  SoftBodyImpl
);

SoftBody.displayName = "SoftBody";

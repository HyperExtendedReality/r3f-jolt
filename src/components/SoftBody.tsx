import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useLoader, type ThreeElements } from "@react-three/fiber";
import * as THREE from "three";
import { useJolt } from "../context/JoltContext";
import { SoftBodyCreator } from "../utils/SoftBodyCreator";
import { toJoltQuat, toJoltRVec3, LAYER_MOVING } from "../utils/joltUtils";
import type Jolt from "jolt-physics";
import { softBodyMaterials, type SoftBodyPhysicsMaterial } from "../materials/SoftBodyPhysicsMaterial";

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
   * Rebuild smooth vertex normals on the CPU after each deformation update.
   * Disable this for flat-shaded or derivative-normal shaders to reduce CPU
   * work and GPU uploads on dense soft bodies.
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
  positionAttribute: THREE.BufferAttribute;
  positionValues: Float32Array;
  normalAttribute: THREE.BufferAttribute | null;
  normalValues: Float32Array | null;
  indexValues: Uint16Array | Uint32Array;
  triangleOffsets: Uint32Array | null;
  heapFloatIndices: Uint32Array;
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
  updateNormals: boolean
): SoftBodyRuntime => {
  const motionProperties = jolt.castObject(
    body.GetMotionProperties(),
    jolt.SoftBodyMotionProperties
  );
  const vertices = motionProperties.GetVertices();
  const settings = motionProperties.GetSettings();
  const faces = settings.mFaces;
  const renderVertexCount =
    creationData.renderToPhysics?.length ?? vertices.size();
  const positionValues = new Float32Array(renderVertexCount * 3);
  const positionAttribute = new THREE.BufferAttribute(positionValues, 3);
  const normalValues = updateNormals
    ? new Float32Array(positionValues.length)
    : null;
  const normalAttribute = normalValues
    ? new THREE.BufferAttribute(normalValues, 3)
    : null;
  const IndexArray = renderVertexCount > 65_535 ? Uint32Array : Uint16Array;
  const indexValues = creationData.renderIndices
    ? new IndexArray(creationData.renderIndices)
    : new IndexArray(faces.size() * 3);

  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  normalAttribute?.setUsage(THREE.DynamicDrawUsage);

  if (!creationData.renderIndices) {
    for (let i = 0; i < faces.size(); i += 1) {
      const face = faces.at(i);
      indexValues[i * 3] = face.get_mVertex(0);
      indexValues[i * 3 + 1] = face.get_mVertex(1);
      indexValues[i * 3 + 2] = face.get_mVertex(2);
    }
  }

  geometry.setAttribute("position", positionAttribute);
  if (normalAttribute) {
    geometry.setAttribute("normal", normalAttribute);
  } else {
    geometry.deleteAttribute("normal");
  }
  geometry.setIndex(new THREE.BufferAttribute(indexValues, 1));

  if (creationData.uvs) {
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(creationData.uvs, 2)
    );
  } else {
    geometry.deleteAttribute("uv");
  }

  const positionOffsetBytes = jolt.SoftBodyVertexTraits.prototype.mPositionOffset;
  const heapFloatIndices = new Uint32Array(renderVertexCount);
  const triangleOffsets = updateNormals
    ? new Uint32Array(indexValues.length)
    : null;

  for (let i = 0; i < heapFloatIndices.length; i += 1) {
    const physicsIndex = creationData.renderToPhysics?.[i] ?? i;
    heapFloatIndices[i] =
      (jolt.getPointer(vertices.at(physicsIndex)) + positionOffsetBytes) >>> 2;
  }

  if (triangleOffsets) {
    for (let i = 0; i < indexValues.length; i += 1) {
      triangleOffsets[i] = indexValues[i] * 3;
    }
  }

  const runtime: SoftBodyRuntime = {
    settings: creationData.settings,
    closed: creationData.closed,
    body,
    bodyId: body.GetID(),
    motionProperties,
    positionAttribute,
    positionValues,
    normalAttribute,
    normalValues,
    indexValues,
    triangleOffsets,
    heapFloatIndices,
    wasActive: true,
  };

  updateSoftBodyBuffers(jolt, runtime);
  geometry.computeBoundingSphere();

  return runtime;
};

const updateSoftBodyBuffers = (
  jolt: typeof Jolt,
  runtime: SoftBodyRuntime
) => {
  const heap = jolt.HEAPF32;
  const positions = runtime.positionValues;
  const heapIndices = runtime.heapFloatIndices;

  for (let i = 0, target = 0; i < heapIndices.length; i += 1, target += 3) {
    const source = heapIndices[i];
    positions[target] = heap[source];
    positions[target + 1] = heap[source + 1];
    positions[target + 2] = heap[source + 2];
  }

  const normals = runtime.normalValues;
  const indices = runtime.triangleOffsets;
  if (!normals || !indices || !runtime.normalAttribute) {
    runtime.positionAttribute.needsUpdate = true;
    return;
  }

  normals.fill(0);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    const abX = positions[a] - positions[b];
    const abY = positions[a + 1] - positions[b + 1];
    const abZ = positions[a + 2] - positions[b + 2];
    const cbX = positions[c] - positions[b];
    const cbY = positions[c + 1] - positions[b + 1];
    const cbZ = positions[c + 2] - positions[b + 2];
    const normalX = cbY * abZ - cbZ * abY;
    const normalY = cbZ * abX - cbX * abZ;
    const normalZ = cbX * abY - cbY * abX;

    normals[a] += normalX;
    normals[a + 1] += normalY;
    normals[a + 2] += normalZ;
    normals[b] += normalX;
    normals[b + 1] += normalY;
    normals[b + 2] += normalZ;
    normals[c] += normalX;
    normals[c + 1] += normalY;
    normals[c + 2] += normalZ;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];
    const lengthSquared = x * x + y * y + z * z;

    if (lengthSquared > 0) {
      const inverseLength = 1 / Math.sqrt(lengthSquared);
      normals[i] = x * inverseLength;
      normals[i + 1] = y * inverseLength;
      normals[i + 2] = z * inverseLength;
    }
  }

  runtime.positionAttribute.needsUpdate = true;
  runtime.normalAttribute.needsUpdate = true;
};

const syncSoftBodyMesh = (
  jolt: typeof Jolt,
  runtime: SoftBodyRuntime,
  mesh: THREE.Mesh
) => {
  updateSoftBodyBuffers(jolt, runtime);

  syncMeshTransform(runtime.body, mesh);
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
  updateNormals = true,
  children,
  frustumCulled = false,
  ...meshProps
  }: SoftBodyProps,
  forwardedRef: React.ForwardedRef<THREE.Mesh>
) => {
  const world = useJolt();
  const { jolt, bodyInterface } = world;
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
    if (resolvedPressure > 0 && !creationData.closed) {
      jolt.destroy(creationData.settings);
      throw new Error("SoftBody pressure requires a sealed, consistently oriented triangle mesh");
    }
    const initialPosition = toJoltRVec3(jolt, position);
    const initialRotation = toJoltQuat(jolt, rotation);
    const creationSettings = new jolt.SoftBodyCreationSettings(
      creationData.settings,
      initialPosition,
      initialRotation,
      LAYER_MOVING
    );

    creationSettings.mPressure = resolvedPressure;
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
      updateNormals
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
    onBodyCreated?.(body);

    if (meshRef.current) {
      syncSoftBodyMesh(jolt, runtime, meshRef.current);
    }

    jolt.destroy(initialPosition);
    jolt.destroy(initialRotation);
    jolt.destroy(creationSettings);

    return () => {
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
    updateNormals,
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
      syncSoftBodyMesh(jolt, runtime, meshRef.current);
    }

    jolt.destroy(nextPosition);
    jolt.destroy(nextRotation);
  }, [bodyInterface, jolt, positionKey, rotationKey]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    validateSoftBody(resolvedConfig, resolvedPressure, resolvedIterations);
    if (resolvedPressure > 0 && !runtime.closed) throw new Error("SoftBody pressure requires a sealed, consistently oriented triangle mesh");

    runtime.motionProperties.SetPressure(resolvedPressure);
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

    syncSoftBodyMesh(jolt, runtime, mesh);
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

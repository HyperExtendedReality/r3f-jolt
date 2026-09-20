import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, type ThreeElements } from "@react-three/fiber";
import * as THREE from "three";
import { useJolt } from "../context/JoltContext";
import { SoftBodyCreator } from "../utils/SoftBodyCreator";
import { toJoltQuat, toJoltRVec3, LAYER_MOVING } from "../utils/joltUtils";
import type Jolt from "jolt-physics";

type SoftBodyType = "Sphere" | "Cloth" | "Cube";

export interface SoftBodyConfig {
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
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  pressure?: number;
  iterations?: number;
  vertexRadius?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  gravityFactor?: number;
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
}

interface SoftBodyRuntime {
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
        return 1;
      }

      const isCorner =
        (x === 0 && z === 0) ||
        (x === gridSizeX - 1 && z === 0) ||
        (x === 0 && z === gridSizeZ - 1) ||
        (x === gridSizeX - 1 && z === gridSizeZ - 1);

      return isCorner ? 0 : 1;
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
      attributes ?? undefined
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
    config.volumeCompliance ?? 0
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
      config.bendType ?? jolt.SoftBodySharedSettings_EBendType_Dihedral
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
  position = DEFAULT_POSITION,
  rotation = DEFAULT_ROTATION,
  pressure = 0,
  iterations,
  vertexRadius,
  friction,
  restitution,
  linearDamping,
  gravityFactor,
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
  const { jolt, bodyInterface } = useJolt();
  const meshRef = useRef<THREE.Mesh>(null);
  const geometryRef = useRef<THREE.BufferGeometry>(new THREE.BufferGeometry());
  const runtimeRef = useRef<SoftBodyRuntime | null>(null);

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

  const configKey = JSON.stringify(config);
  const geometryKey = geometry?.uuid ?? "";
  const positionKey = position.join(",");
  const rotationKey = rotation.join(",");

  useEffect(() => {
    return () => {
      geometryRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    const renderGeometry = geometryRef.current;
    const creationData = createSoftBodyData(jolt, type, config, geometry);
    const initialPosition = toJoltRVec3(jolt, position);
    const initialRotation = toJoltQuat(jolt, rotation);
    const creationSettings = new jolt.SoftBodyCreationSettings(
      creationData.settings,
      initialPosition,
      initialRotation,
      LAYER_MOVING
    );

    creationSettings.mPressure = pressure;
    creationSettings.mUpdatePosition = false;
    creationSettings.mFacesDoubleSided =
      doubleSided ?? (type === "Cloth" || Boolean(geometry));

    if (iterations != null) {
      creationSettings.mNumIterations = iterations;
    }

    if (vertexRadius != null) {
      creationSettings.mVertexRadius = vertexRadius;
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

    if (gravityFactor != null) {
      creationSettings.mGravityFactor = gravityFactor;
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

    bodyInterface.AddBody(bodyId, jolt.EActivation_Activate);
    runtimeRef.current = runtime;

    if (meshRef.current) {
      syncSoftBodyMesh(jolt, runtime, meshRef.current);
    }

    jolt.destroy(initialPosition);
    jolt.destroy(initialRotation);
    jolt.destroy(creationSettings);

    return () => {
      if (
        !runtimeRef.current ||
        runtimeRef.current.bodyId.GetIndexAndSequenceNumber() !== bodyKey
      ) {
        return;
      }

      runtimeRef.current = null;
      bodyInterface.RemoveBody(bodyId);
      bodyInterface.DestroyBody(bodyId);
    };
  }, [
    bodyInterface,
    config.vertexGetInvMass,
    config.vertexPerturbation,
    configKey,
    doubleSided,
    geometryKey,
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

    runtime.motionProperties.SetPressure(pressure);
    runtime.motionProperties.SetUpdatePosition(false);

    if (iterations != null) {
      runtime.motionProperties.SetNumIterations(iterations);
    }

    if (vertexRadius != null) {
      runtime.motionProperties.SetVertexRadius(vertexRadius);
    }

    if (linearDamping != null) {
      runtime.motionProperties.SetLinearDamping(linearDamping);
    }

    if (gravityFactor != null) {
      runtime.motionProperties.SetGravityFactor(gravityFactor);
    }

    bodyInterface.ActivateBody(runtime.bodyId);
  }, [
    bodyInterface,
    gravityFactor,
    iterations,
    linearDamping,
    pressure,
    vertexRadius,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    if (friction != null) {
      bodyInterface.SetFriction(runtime.bodyId, friction);
    }

    if (restitution != null) {
      bodyInterface.SetRestitution(runtime.bodyId, restitution);
    }
  }, [bodyInterface, friction, restitution]);

  useFrame(() => {
    const runtime = runtimeRef.current;
    const mesh = meshRef.current;
    if (!runtime || !mesh) return;

    const isActive = runtime.body.IsActive();
    if (!isActive && !runtime.wasActive) return;
    runtime.wasActive = isActive;

    syncSoftBodyMesh(jolt, runtime, mesh);
  });

  const materialColor = color ?? (texture ? "white" : "hotpink");

  return (
    <mesh
      {...meshProps}
      ref={setMeshRef}
      geometry={geometryRef.current}
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

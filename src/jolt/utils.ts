import * as THREE from 'three';
import { Jolt } from './types';

// Layer Constants
export const LAYER_NON_MOVING = 0;
export const LAYER_MOVING = 1;
export const NUM_OBJECT_LAYERS = 2;
export const NUM_BROAD_PHASE_LAYERS = 2;
export const BP_LAYER_NON_MOVING = 0;
export const BP_LAYER_MOVING = 1;

export const wrapVec3 = (jolt: Jolt, x: number, y: number, z: number) => {
  return new jolt.RVec3(x, y, z);
};

export const wrapQuat = (jolt: Jolt, x: number, y: number, z: number, w: number) => {
  return new jolt.Quat(x, y, z, w);
};

export const setupCollisionFiltering = (jolt: Jolt) => {
  const objectFilter = new jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);

  const bpInterface = new jolt.BroadPhaseLayerInterfaceTable(NUM_OBJECT_LAYERS, NUM_BROAD_PHASE_LAYERS);
  const bpLayerNonMoving = new jolt.BroadPhaseLayer(BP_LAYER_NON_MOVING);
  const bpLayerMoving = new jolt.BroadPhaseLayer(BP_LAYER_MOVING);

  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, bpLayerNonMoving);
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, bpLayerMoving);

  jolt.destroy(bpLayerNonMoving);
  jolt.destroy(bpLayerMoving);

  const objectVsBroadphaseFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface,
    NUM_BROAD_PHASE_LAYERS,
    objectFilter,
    NUM_OBJECT_LAYERS
  );

  return { objectFilter, bpInterface, objectVsBroadphaseFilter };
};

// --- PROCEDURAL SPHERE GENERATOR (Matches Example Code) ---
export const createSoftBodySphereSettings = (
  jolt: Jolt,
  radius: number,
  numTheta: number = 10,
  numPhi: number = 20,
  compliance: number = 1.0e-4
) => {
  const sharedSettings = new jolt.SoftBodySharedSettings();
  const v3 = new THREE.Vector3();

  // 1. Vertices
  const vertex = new jolt.SoftBodySharedSettingsVertex();
  
  // Helper to push vertices
  const sUnitSpherical = (phi: number, theta: number) => {
    v3.setFromSphericalCoords(radius, phi, theta);
    vertex.mPosition.x = v3.x;
    vertex.mPosition.y = v3.y;
    vertex.mPosition.z = v3.z;
    sharedSettings.mVertices.push_back(vertex);
  };

  sUnitSpherical(0, 0);
  sUnitSpherical(Math.PI, 0);
  
  for (let theta = 1; theta < numTheta - 1; ++theta) {
    for (let phi = 0; phi < numPhi; ++phi) {
      sUnitSpherical(Math.PI * theta / (numTheta - 1), 2.0 * Math.PI * phi / numPhi);
    }
  }
  jolt.destroy(vertex);

  // Helper indexer
  const vertex_index = (inTheta: number, inPhi: number) => {
    if (inTheta === 0) return 0;
    else if (inTheta === numTheta - 1) return 1;
    else return 2 + (inTheta - 1) * numPhi + (inPhi % numPhi);
  };

  // 2. Faces
  const face = new jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
  
  for (let phi = 0; phi < numPhi; ++phi) {
    for (let theta = 0; theta < numTheta - 2; ++theta) {
      face.set_mVertex(0, vertex_index(theta, phi));
      face.set_mVertex(1, vertex_index(theta + 1, phi));
      face.set_mVertex(2, vertex_index(theta + 1, phi + 1));
      sharedSettings.AddFace(face);

      if (theta > 0) {
        face.set_mVertex(1, vertex_index(theta + 1, phi + 1));
        face.set_mVertex(2, vertex_index(theta, phi + 1));
        sharedSettings.AddFace(face);
      }
    }
    
    face.set_mVertex(0, vertex_index(numTheta - 2, phi + 1));
    face.set_mVertex(1, vertex_index(numTheta - 2, phi));
    face.set_mVertex(2, vertex_index(numTheta - 1, 0));
    sharedSettings.AddFace(face);
  }
  jolt.destroy(face);

  // 3. Constraints
  const attr = new jolt.SoftBodySharedSettingsVertexAttributes();
  attr.mCompliance = compliance;
  attr.mShearCompliance = compliance;
  attr.mBendCompliance = 1.0e-3; // Stiffer bend for sphere shape retention

  sharedSettings.CreateConstraints(attr, 1, jolt.SoftBodySharedSettings_EBendType_Dihedral);
  
  sharedSettings.CalculateEdgeLengths();
  sharedSettings.CalculateVolumeConstraintVolumes();
  sharedSettings.Optimize();

  jolt.destroy(attr);
  return sharedSettings;
};

// --- GEOMETRY GENERATOR FROM SETTINGS ---
// This ensures the visual mesh matches the physics vertices exactly
export const createGeometryFromSoftBodySettings = (jolt: Jolt, settings: any) => {
  const vertices = settings.mVertices;
  const faces = settings.mFaces;
  
  const numVertices = vertices.size();
  const numFaces = faces.size();

  const posArray = new Float32Array(numVertices * 3);
  const indexArray = new Uint16Array(numFaces * 3);

  // Extract Vertices
  // We use the pointer to read the array directly from HEAPF32 for speed
  const vertexSize = 16; // Roughly 4 floats (x,y,z, invMass?) - check your bindings, but reading per-element is safer if size unknown
  
  for (let i = 0; i < numVertices; i++) {
    const v = vertices.at(i);
    // Directly access position (Float3)
    const pos = v.mPosition;
    posArray[i * 3] = pos.x;
    posArray[i * 3 + 1] = pos.y;
    posArray[i * 3 + 2] = pos.z;
  }

  // Extract Indices
  for (let i = 0; i < numFaces; i++) {
    const f = faces.at(i);
    indexArray[i * 3] = f.get_mVertex(0);
    indexArray[i * 3 + 1] = f.get_mVertex(1);
    indexArray[i * 3 + 2] = f.get_mVertex(2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();

  return geometry;
};

// --- GENERIC CONVERTER (Keep for generic meshes if needed) ---
export const createSoftBodySettingsFromGeometry = (
  jolt: Jolt,
  geometry: THREE.BufferGeometry,
  compliance = 1.0e-4
) => {
  const sharedSettings = new jolt.SoftBodySharedSettings();
  const posAttr = geometry.attributes.position;
  const indexAttr = geometry.index;

  const vertex = new jolt.SoftBodySharedSettingsVertex();
  vertex.mInvMass = 1.0; 

  for (let i = 0; i < posAttr.count; i++) {
    vertex.mPosition.x = posAttr.getX(i);
    vertex.mPosition.y = posAttr.getY(i);
    vertex.mPosition.z = posAttr.getZ(i);
    sharedSettings.mVertices.push_back(vertex);
  }
  jolt.destroy(vertex);

  const face = new jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i += 3) {
      face.set_mVertex(0, indexAttr.getX(i));
      face.set_mVertex(1, indexAttr.getX(i + 1));
      face.set_mVertex(2, indexAttr.getX(i + 2));
      sharedSettings.AddFace(face);
    }
  } else {
    for (let i = 0; i < posAttr.count; i += 3) {
      face.set_mVertex(0, i);
      face.set_mVertex(1, i + 1);
      face.set_mVertex(2, i + 2);
      sharedSettings.AddFace(face);
    }
  }
  jolt.destroy(face);

  const attr = new jolt.SoftBodySharedSettingsVertexAttributes();
  attr.mCompliance = compliance;
  attr.mShearCompliance = compliance;
  attr.mBendCompliance = compliance;

  sharedSettings.CreateConstraints(attr, 1, jolt.SoftBodySharedSettings_EBendType_Dihedral);
  sharedSettings.CalculateEdgeLengths();
  sharedSettings.CalculateVolumeConstraintVolumes();
  sharedSettings.Optimize();

  jolt.destroy(attr);
  return sharedSettings;
};
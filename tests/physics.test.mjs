import assert from "node:assert/strict";
import * as THREE from "three";
import initJolt from "jolt-physics/wasm-compat";
import {
  SoftBodyCreator,
  analyzeMeshTopology,
  containSphere,
  fractureGeometry,
  tearSurface,
  ShapeSystem,
} from "../dist/index.mjs";

const jolt = await initJolt();

function checkSoftBody(name, created) {
  const vertices = created.settings.mVertices;
  const faces = created.settings.mFaces;
  const positions = [];
  const triangles = [];
  for (let i = 0; i < vertices.size(); i += 1) {
    const p = vertices.at(i).mPosition;
    positions.push(p.x, p.y, p.z);
  }
  for (let i = 0; i < faces.size(); i += 1) {
    const face = faces.at(i);
    triangles.push(face.get_mVertex(0), face.get_mVertex(1), face.get_mVertex(2));
  }
  const topology = analyzeMeshTopology(positions, triangles);
  assert.equal(topology.closed, true, `${name} must be sealed`);
  assert.ok(topology.signedVolume > 0, `${name} faces must point outward`);
  jolt.destroy(created.settings);
}

checkSoftBody("sphere", SoftBodyCreator.CreateSphere(jolt, 1, 10, 20));
checkSoftBody("cube", SoftBodyCreator.CreateCube(jolt, 4, 0.5));
const joltCloth = SoftBodyCreator.CreateCloth(jolt, 3, 3, 1);
assert.ok(joltCloth.settings.mEdgeConstraints.size() > 0);
assert.ok(joltCloth.settings.mEdgeConstraints.at(0).mRestLength > 0);
jolt.destroy(joltCloth.settings);

const box = new THREE.BoxGeometry(2, 2, 2);
const shapeSystem = new ShapeSystem(jolt);
const convex = shapeSystem.getShapeSettingsFromGeometry(box, "convex");
const convexResult = convex.Create();
assert.equal(convexResult.IsValid(), true);
convexResult.Clear();
jolt.destroy(convex);

// Shapes thinner than Jolt's 5 cm default convex radius must still be valid.
for (const [name, geometry] of [
  ["4 cm box", new THREE.BoxGeometry(0.04, 0.04, 0.04)],
  ["thin cylinder", new THREE.CylinderGeometry(0.01, 0.01, 0.5)],
  ["flat cylinder", new THREE.CylinderGeometry(0.5, 0.5, 0.02)],
]) {
  const thin = shapeSystem.getShapeSettingsFromGeometry(geometry);
  const result = thin.Create();
  assert.equal(result.IsValid(), true, `${name}: ${result.HasError() ? result.GetError().c_str() : ""}`);
  result.Clear();
  jolt.destroy(thin);
  geometry.dispose();
}

// A mesh transform reaches convex hull vertices.
const scaled = shapeSystem.getShapeSettingsFromGeometry(box, "convex", new THREE.Matrix4().makeScale(2, 3, 4));
const scaledResult = scaled.Create();
const bounds = scaledResult.Get().GetLocalBounds();
assert.ok(Math.abs(bounds.mMax.GetX() - 2) < 1e-3 && Math.abs(bounds.mMax.GetY() - 3) < 1e-3 && Math.abs(bounds.mMax.GetZ() - 4) < 1e-3,
  `scaled hull bounds ${bounds.mMax.GetX()} ${bounds.mMax.GetY()} ${bounds.mMax.GetZ()}`);
scaledResult.Clear();
jolt.destroy(scaled);
const custom = SoftBodyCreator.CreateFromGeometry(jolt, box);
assert.equal(custom.closed, true);
checkSoftBody("custom box", custom);
const bag = new THREE.SphereGeometry(1, 24, 16).scale(1.35, 2.1, 0.55);
const bagData = SoftBodyCreator.CreateFromGeometry(jolt, bag);
assert.equal(bagData.closed, true, "demo inflated bag must be sealed");
jolt.destroy(bagData.settings);
bag.dispose();
const open = new THREE.PlaneGeometry(1, 1);
const openData = SoftBodyCreator.CreateFromGeometry(jolt, open);
assert.equal(openData.closed, false);
jolt.destroy(openData.settings);
open.dispose();
const cloth = new THREE.PlaneGeometry(2, 2, 4, 4);
const torn = tearSurface(cloth, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0));
assert.ok(torn);
assert.ok(torn[0].getAttribute("position").count > 0);
assert.ok(torn[1].getAttribute("position").count > 0);
assert.equal(torn[0].getAttribute("uv").count, torn[0].getAttribute("position").count);
for (const part of torn) {
  const data = SoftBodyCreator.CreateFromGeometry(jolt, part);
  assert.equal(data.closed, false);
  assert.ok(data.settings.mFaces.size() > 0);
  jolt.destroy(data.settings);
}
torn.forEach((part) => part.dispose());
cloth.dispose();

const objectFilter = new jolt.ObjectLayerPairFilterTable(2);
objectFilter.EnableCollision(0, 1);
objectFilter.EnableCollision(1, 1);
const stationaryLayer = new jolt.BroadPhaseLayer(0);
const movingLayer = new jolt.BroadPhaseLayer(1);
const broadPhase = new jolt.BroadPhaseLayerInterfaceTable(2, 2);
broadPhase.MapObjectToBroadPhaseLayer(0, stationaryLayer);
broadPhase.MapObjectToBroadPhaseLayer(1, movingLayer);
jolt.destroy(stationaryLayer);
jolt.destroy(movingLayer);
const broadPhaseFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(broadPhase, 2, objectFilter, 2);
const worldSettings = new jolt.JoltSettings();
worldSettings.mObjectLayerPairFilter = objectFilter;
worldSettings.mBroadPhaseLayerInterface = broadPhase;
worldSettings.mObjectVsBroadPhaseLayerFilter = broadPhaseFilter;
const world = new jolt.JoltInterface(worldSettings);
jolt.destroy(worldSettings);
const bodyInterface = world.GetPhysicsSystem().GetBodyInterface();
const sphere = SoftBodyCreator.CreateSphere(jolt, 1, 8, 12);
const initialPosition = new jolt.RVec3(0, 4, 0);
const initialRotation = new jolt.Quat(0, 0, 0, 1);
const settings = new jolt.SoftBodyCreationSettings(sphere.settings, initialPosition, initialRotation, 1);
settings.mPressure = 10;
const body = bodyInterface.CreateSoftBody(settings);
const id = body.GetID();
const motion = jolt.castObject(body.GetMotionProperties(), jolt.SoftBodyMotionProperties);
motion.GetVertices().at(0).mVelocity.Set(1, 0, 0);
assert.equal(motion.GetVertices().at(0).mVelocity.GetX(), 1);
bodyInterface.AddBody(id, jolt.EActivation_Activate);
jolt.destroy(settings);
jolt.destroy(initialPosition);
jolt.destroy(initialRotation);
world.Step(1 / 60, 1);
assert.ok(Number.isFinite(body.GetPosition().GetY()));
bodyInterface.RemoveBody(id);
bodyInterface.DestroyBody(id); // also frees sphere.settings (ref counted)
jolt.destroy(world);

const shards = fractureGeometry(box, 8);
assert.equal(shards.length, 8);
const totalVolume = shards.reduce((sum, shard) => sum + shard.volume, 0);
assert.ok(Math.abs(totalVolume - 8) < 1e-3, `shard volume ${totalVolume}`);
for (const shard of shards) {
  const p = shard.geometry.getAttribute("position");
  const welded = [], triangles = [], ids = new Map();
  for (let i = 0; i < p.count; i += 1) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let id = ids.get(key);
    if (id == null) {
      id = welded.length / 3;
      ids.set(key, id);
      welded.push(x, y, z);
    }
    triangles.push(id);
  }
  const topology = analyzeMeshTopology(welded, triangles);
  assert.equal(topology.closed, true);
}

const mesh = new THREE.Mesh(box);
assert.equal(containSphere(mesh, new THREE.Vector3(0, 0, 0), 0.1), null);
const corrected = containSphere(mesh, new THREE.Vector3(2, 0, 0), 0.1);
assert.ok(corrected && corrected.position.x < 1 && corrected.position.x > 0.8);
assert.ok(corrected.inwardNormal.x < -0.99);
mesh.position.set(3, 0, 0);
const translated = containSphere(mesh, new THREE.Vector3(5, 0, 0), 0.1);
assert.ok(translated && translated.position.x < 4 && translated.position.x > 3.8);

shards.forEach((shard) => shard.geometry.dispose());
box.dispose();
console.log("physics checks passed");

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
  getSurfaceIndex,
  createSurfaceHit,
  SoftSurface,
  collideSoftBodies,
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
// Surface index: grid nearest query matches brute force; pseudonormal inside test is exact.
{
  const sphereGeometry = new THREE.SphereGeometry(1, 16, 12); // has a UV seam, exercises welding
  const surface = getSurfaceIndex(new THREE.Mesh(sphereGeometry));
  assert.equal(surface.closed, true, "welded sphere must be closed");
  const hit = createSurfaceHit();
  const triangle = new THREE.Triangle(), closest = new THREE.Vector3(), point = new THREE.Vector3();
  const p = surface.positions, idx = surface.indices;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 300; i += 1) {
    point.set(random(), random(), random()).multiplyScalar(1.6);
    let brute = Infinity;
    for (let t = 0; t < surface.triangleCount; t += 1) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      triangle.a.set(p[a], p[a + 1], p[a + 2]);
      triangle.b.set(p[b], p[b + 1], p[b + 2]);
      triangle.c.set(p[c], p[c + 1], p[c + 2]);
      brute = Math.min(brute, triangle.closestPointToPoint(point, closest).distanceToSquared(point));
    }
    assert.ok(surface.nearest(point.x, point.y, point.z, hit));
    assert.ok(Math.abs(hit.distanceSq - brute) < 1e-9, `nearest ${hit.distanceSq} vs ${brute}`);
    const side = (point.x - hit.x) * hit.nx + (point.y - hit.y) * hit.ny + (point.z - hit.z) * hit.nz;
    const radius = point.length();
    if (radius < 0.9) assert.ok(side < 0, `inside point reported outside at r=${radius}`);
    if (radius > 1.05) assert.ok(side > 0, `outside point reported inside at r=${radius}`);
  }
  sphereGeometry.dispose();
}

// Soft-vs-soft: a fast sphere hitting a resting one must not end up inside it.
function softCollisionRun(collide) {
  const filter = new jolt.ObjectLayerPairFilterTable(2);
  filter.EnableCollision(1, 1);
  const layers = new jolt.BroadPhaseLayerInterfaceTable(2, 2);
  const l0 = new jolt.BroadPhaseLayer(0), l1 = new jolt.BroadPhaseLayer(1);
  layers.MapObjectToBroadPhaseLayer(0, l0);
  layers.MapObjectToBroadPhaseLayer(1, l1);
  jolt.destroy(l0); jolt.destroy(l1);
  const joltSettings = new jolt.JoltSettings();
  joltSettings.mObjectLayerPairFilter = filter;
  joltSettings.mBroadPhaseLayerInterface = layers;
  joltSettings.mObjectVsBroadPhaseLayerFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(layers, 2, filter, 2);
  const softWorld = new jolt.JoltInterface(joltSettings);
  jolt.destroy(joltSettings);
  const bodies = softWorld.GetPhysicsSystem().GetBodyInterface();
  const clock = { count: 0, alpha: 1 };
  const make = (y, speed) => {
    const data = SoftBodyCreator.CreateSphere(jolt, 1, 10, 20);
    const at = new jolt.RVec3(0, y, 0), q = new jolt.Quat(0, 0, 0, 1);
    const creation = new jolt.SoftBodyCreationSettings(data.settings, at, q, 1);
    creation.mPressure = 20;
    creation.mGravityFactor = 0;
    creation.mUpdatePosition = false;
    const body = bodies.CreateSoftBody(creation);
    jolt.destroy(creation); jolt.destroy(at); jolt.destroy(q);
    const motion = jolt.castObject(body.GetMotionProperties(), jolt.SoftBodyMotionProperties);
    const vertices = motion.GetVertices();
    for (let i = 0; i < vertices.size(); i += 1) vertices.at(i).mVelocity.Set(0, speed, 0);
    bodies.AddBody(body.GetID(), jolt.EActivation_Activate);
    return new SoftSurface(jolt, body, motion, clock);
  };
  const resting = make(0, 0), falling = make(2.4, -4);
  const surfaces = new Set([resting, falling]);
  for (let i = 0; i < 30; i += 1) {
    softWorld.Step(1 / 60, 1);
    clock.count += 1;
    if (collide) collideSoftBodies(jolt, bodies, surfaces, 0.02);
  }
  resting.sync(); falling.sync();
  assert.ok([...resting.index.positions, ...falling.index.positions].every(Number.isFinite), "soft collision produced non-finite vertices");
  resting.updateTransform(); falling.updateTransform();
  const hit = createSurfaceHit();
  const toResting = new THREE.Matrix4().multiplyMatrices(resting.inverse, falling.matrix);
  const v = new THREE.Vector3();
  let inside = 0;
  for (let k = 0; k < falling.vertexCount; k += 1) {
    v.fromArray(falling.index.positions, k * 3).applyMatrix4(toResting);
    resting.index.nearest(v.x, v.y, v.z, hit);
    if ((v.x - hit.x) * hit.nx + (v.y - hit.y) * hit.ny + (v.z - hit.z) * hit.nz < 0) inside += 1;
  }
  for (const surface of surfaces) {
    bodies.RemoveBody(surface.body.GetID());
    bodies.DestroyBody(surface.body.GetID());
  }
  jolt.destroy(softWorld);
  return inside;
}
const softOff = softCollisionRun(false), softOn = softCollisionRun(true);
console.log("soft-vs-soft vertices inside:", softOff, "->", softOn);
assert.ok(softOff > 10, "without soft collision the spheres should overlap");
assert.equal(softOn, 0, "soft collision must keep the spheres apart");

// Two tetrahedra pinched along one shared edge (like a bag's seam) still enclose a volume.
{
  const pts = [0, 0, 0, 1, 0, 0, 0.5, 1, 0.3, 0.5, 0.2, 1, 0.5, -1, 0.3, 0.5, -0.2, -1];
  const tris = [];
  for (const tet of [[0, 1, 2, 3], [0, 1, 4, 5]]) {
    const centroid = [0, 1, 2].map((k) => tet.reduce((sum, v) => sum + pts[v * 3 + k], 0) / 4);
    for (const [a, b, c] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]].map((f) => f.map((i) => tet[i]))) {
      const v = (i) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
      const [A, B, C] = [v(a), v(b), v(c)];
      const n = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])];
      const outward = n[0] * (A[0] - centroid[0]) + n[1] * (A[1] - centroid[1]) + n[2] * (A[2] - centroid[2]) > 0;
      tris.push(...(outward ? [a, b, c] : [a, c, b]));
    }
  }
  const pinched = analyzeMeshTopology(pts, tris);
  assert.equal(pinched.closed, true, "pinched seam must count as sealed");
  assert.ok(pinched.signedVolume > 0);
}

// A zero-thickness fin (a triangle plus its reversed copy) inside a box must not unseal it.
{
  const finned = new THREE.BoxGeometry(1, 1, 1);
  const p = finned.getAttribute("position"), index = [...finned.getIndex().array];
  const corner = (x, y, z) => { for (let i = 0; i < p.count; i += 1) if (p.getX(i) === x && p.getY(i) === y && p.getZ(i) === z) return i; };
  const a = corner(-0.5, -0.5, -0.5), b = corner(0.5, 0.5, -0.5), c = corner(0.5, 0.5, 0.5);
  index.push(a, b, c, a, c, b);
  finned.setIndex(index);
  const data = SoftBodyCreator.CreateFromGeometry(jolt, finned);
  assert.equal(data.closed, true, "reversed duplicate faces must cancel");
  assert.equal(data.settings.mFaces.size(), 12);
  jolt.destroy(data.settings);
  finned.dispose();
}

console.log("physics checks passed");

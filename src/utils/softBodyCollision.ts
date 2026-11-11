import * as THREE from "three";
import type Jolt from "jolt-physics";
import { SurfaceIndex, createSurfaceHit } from "./surfaceIndex";

/** Shared step clock: `count` increments after every fixed step, `alpha` is the render blend. */
export interface StepClock {
  count: number;
  alpha: number;
}

/**
 * A soft body's physics vertices as a queryable surface, in body-local space.
 * `previous` holds the vertices one fixed step earlier, for render interpolation.
 */
export class SoftSurface {
  readonly index: SurfaceIndex;
  readonly previous: Float32Array;
  readonly invMass: Float32Array;
  readonly vertexCount: number;
  /** Bumped whenever `index.positions` changes, for consumers that cache derived data. */
  revision = 0;
  private readonly positionSlots: Uint32Array;
  private readonly velocitySlots: Uint32Array;
  private syncedStep = -1;
  readonly matrix = new THREE.Matrix4();
  readonly inverse = new THREE.Matrix4();

  constructor(
    private readonly jolt: typeof Jolt,
    readonly body: Jolt.Body,
    readonly motion: Jolt.SoftBodyMotionProperties,
    private readonly clock: StepClock
  ) {
    const vertices = motion.GetVertices();
    const faces = motion.GetSettings().mFaces;
    this.vertexCount = vertices.size();
    this.positionSlots = new Uint32Array(this.vertexCount);
    this.velocitySlots = new Uint32Array(this.vertexCount);
    this.invMass = new Float32Array(this.vertexCount);
    const positionOffset = jolt.SoftBodyVertexTraits.prototype.mPositionOffset;
    const velocityOffset = jolt.SoftBodyVertexTraits.prototype.mVelocityOffset;
    for (let i = 0; i < this.vertexCount; i += 1) {
      const vertex = vertices.at(i);
      const pointer = jolt.getPointer(vertex);
      this.positionSlots[i] = (pointer + positionOffset) >>> 2;
      this.velocitySlots[i] = (pointer + velocityOffset) >>> 2;
      this.invMass[i] = vertex.mInvMass;
    }
    const indices = new Uint32Array(faces.size() * 3);
    for (let i = 0; i < faces.size(); i += 1) {
      const face = faces.at(i);
      indices[i * 3] = face.get_mVertex(0);
      indices[i * 3 + 1] = face.get_mVertex(1);
      indices[i * 3 + 2] = face.get_mVertex(2);
    }
    this.index = new SurfaceIndex(new Float32Array(this.vertexCount * 3), indices);
    this.previous = new Float32Array(this.vertexCount * 3);
    this.read();
    this.previous.set(this.index.positions);
  }

  /** Reads the vertices once per fixed step. Returns true when they were refreshed. */
  sync(): boolean {
    if (this.syncedStep === this.clock.count) return false;
    this.syncedStep = this.clock.count;
    this.previous.set(this.index.positions);
    this.read();
    return true;
  }

  /** Re-reads the vertices now, e.g. after a teleport, without keeping the old ones. */
  reset() {
    this.read();
    this.previous.set(this.index.positions);
    this.syncedStep = this.clock.count;
  }

  private read() {
    const heap = this.jolt.HEAPF32, positions = this.index.positions, slots = this.positionSlots;
    for (let i = 0, j = 0; i < slots.length; i += 1, j += 3) {
      const s = slots[i];
      positions[j] = heap[s];
      positions[j + 1] = heap[s + 1];
      positions[j + 2] = heap[s + 2];
    }
    this.index.markDirty();
    this.revision += 1;
  }

  /** Moves a vertex (body-local) in both Jolt and the cached surface. */
  displace(vertex: number, dx: number, dy: number, dz: number) {
    const heap = this.jolt.HEAPF32, s = this.positionSlots[vertex], p = this.index.positions, j = vertex * 3;
    heap[s] += dx; heap[s + 1] += dy; heap[s + 2] += dz;
    p[j] += dx; p[j + 1] += dy; p[j + 2] += dz;
  }

  velocitySlot(vertex: number) {
    return this.velocitySlots[vertex];
  }

  updateTransform() {
    const p = this.body.GetPosition(), q = this.body.GetRotation();
    this.matrix.compose(
      position.set(p.GetX(), p.GetY(), p.GetZ()),
      rotation.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW()),
      unit
    );
    this.inverse.copy(this.matrix).invert();
  }
}

const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const unit = new THREE.Vector3(1, 1, 1);
const relative = new THREE.Matrix4();
const box = new THREE.Box3();
const boxes: THREE.Box3[] = [];
const travel: number[] = [];

/** Largest distance any vertex moved during the last step. */
const maxTravel = (surface: SoftSurface) => {
  const p = surface.index.positions, q = surface.previous;
  let best = 0;
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i] - q[i], dy = p[i + 1] - q[i + 1], dz = p[i + 2] - q[i + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > best) best = d;
  }
  return Math.sqrt(best);
};
const hit = createSurfaceHit();

const worldBounds = (surface: SoftSurface, target: THREE.Box3, margin: number) => {
  surface.index.ensureNormals();
  const { min, max } = surface.index;
  box.min.set(min[0], min[1], min[2]);
  box.max.set(max[0], max[1], max[2]);
  return target.copy(box).applyMatrix4(surface.matrix).expandByScalar(margin);
};

/**
 * Jolt does not collide soft bodies with each other. After each fixed step this pushes every
 * vertex of one soft body out of the other's surface (closed shells by inside test, open
 * surfaces by a `thickness` shell, keeping each vertex on the side it was on last step), splitting the correction by inverse mass, and removes the
 * approaching normal velocity. shortcut: discrete per step, so an edge or face that crosses
 * another without a vertex inside it is not caught; reduce `timeStep` or raise `thickness` if that shows.
 */
export function collideSoftBodies(
  jolt: typeof Jolt,
  bodyInterface: Jolt.BodyInterface,
  surfaces: Iterable<SoftSurface>,
  minimumThickness: number
) {
  const list = Array.from(surfaces);
  if (list.length < 2) return;
  for (let i = 0; i < list.length; i += 1) {
    list[i].sync();
    list[i].updateTransform();
    boxes[i] ??= new THREE.Box3();
    travel[i] = maxTravel(list[i]);
    worldBounds(list[i], boxes[i], minimumThickness + travel[i]);
  }
  const touched = new Set<SoftSurface>();
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i], b = list[j];
      if (!a.body.IsActive() && !b.body.IsActive()) continue;
      if (!boxes[i].intersectsBox(boxes[j])) continue;
      const thickness = Math.max(minimumThickness, a.motion.GetVertexRadius() + b.motion.GetVertexRadius());
      const reach = thickness + travel[i] + travel[j];
      if (pushOut(jolt, a, b, thickness, reach) | pushOut(jolt, b, a, thickness, reach)) {
        touched.add(a);
        touched.add(b);
      }
    }
  }
  for (const surface of touched) {
    surface.index.markDirty();
    surface.revision += 1;
    if (!surface.body.IsActive()) bodyInterface.ActivateBody(surface.body.GetID());
  }
}

/** Pushes `mover`'s vertices out of `surface`. Returns 1 if anything moved. */
function pushOut(jolt: typeof Jolt, mover: SoftSurface, target: SoftSurface, thickness: number, reach: number): number {
  const index = target.index;
  if (index.triangleCount === 0) return 0;
  index.ensureNormals();
  const heap = jolt.HEAPF32;
  // mover-local -> target-local; both are rigid transforms.
  const e = relative.multiplyMatrices(target.inverse, mover.matrix).elements;
  const minX = index.min[0] - reach, minY = index.min[1] - reach, minZ = index.min[2] - reach;
  const maxX = index.max[0] + reach, maxY = index.max[1] + reach, maxZ = index.max[2] + reach;
  const p = mover.index.positions, q = mover.previous, tq = target.previous, idx = index.indices, closed = index.closed;
  // Open surfaces: search as far as anything moved this step, so a vertex that tunnelled through is still found.
  const limit = closed ? Infinity : reach * reach;
  let moved = 0;
  for (let k = 0; k < mover.vertexCount; k += 1) {
    const wa = mover.invMass[k];
    const lx = p[k * 3], ly = p[k * 3 + 1], lz = p[k * 3 + 2];
    const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
    const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
    const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
    if (x < minX || y < minY || z < minZ || x > maxX || y > maxY || z > maxZ) continue;
    if (!index.nearest(x, y, z, hit, limit)) continue;
    const side = (x - hit.x) * hit.nx + (y - hit.y) * hit.ny + (z - hit.z) * hit.nz;
    let nx = hit.nx, ny = hit.ny, nz = hit.nz;
    const ta = idx[hit.triangle * 3], tb = idx[hit.triangle * 3 + 1], tc = idx[hit.triangle * 3 + 2];
    if (closed) {
      if (side >= 0 && hit.distanceSq >= thickness * thickness) continue;
    } else {
      // Keep the vertex on the side it was on last step: same barycentric point on the old surface.
      const ox = e[0] * q[k * 3] + e[4] * q[k * 3 + 1] + e[8] * q[k * 3 + 2] + e[12];
      const oy = e[1] * q[k * 3] + e[5] * q[k * 3 + 1] + e[9] * q[k * 3 + 2] + e[13];
      const oz = e[2] * q[k * 3] + e[6] * q[k * 3 + 1] + e[10] * q[k * 3 + 2] + e[14];
      const sx = hit.u * tq[ta * 3] + hit.v * tq[tb * 3] + hit.w * tq[tc * 3];
      const sy = hit.u * tq[ta * 3 + 1] + hit.v * tq[tb * 3 + 1] + hit.w * tq[tc * 3 + 1];
      const sz = hit.u * tq[ta * 3 + 2] + hit.v * tq[tb * 3 + 2] + hit.w * tq[tc * 3 + 2];
      const before = (ox - sx) * nx + (oy - sy) * ny + (oz - sz) * nz;
      if ((before !== 0 ? before : side) < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }
    }
    const wu = hit.u * target.invMass[ta], wv = hit.v * target.invMass[tb], ww = hit.w * target.invMass[tc];
    const denominator = wa + hit.u * wu + hit.v * wv + hit.w * ww;
    if (denominator <= 0) continue;
    // Correction along the normal that puts the vertex `thickness` outside the surface.
    const depth = thickness - ((x - hit.x) * nx + (y - hit.y) * ny + (z - hit.z) * nz);
    if (depth <= 0) continue;
    const dx = nx * depth, dy = ny * depth, dz = nz * depth;
    const sa = wa / denominator;
    // Back to mover-local: transpose of the rotation part.
    mover.displace(k,
      (e[0] * dx + e[1] * dy + e[2] * dz) * sa,
      (e[4] * dx + e[5] * dy + e[6] * dz) * sa,
      (e[8] * dx + e[9] * dy + e[10] * dz) * sa);
    target.displace(ta, -dx * wu / denominator, -dy * wu / denominator, -dz * wu / denominator);
    target.displace(tb, -dx * wv / denominator, -dy * wv / denominator, -dz * wv / denominator);
    target.displace(tc, -dx * ww / denominator, -dy * ww / denominator, -dz * ww / denominator);

    // Remove the approaching part of the relative normal velocity (perfectly inelastic).
    const va = mover.velocitySlot(k), sa0 = target.velocitySlot(ta), sb0 = target.velocitySlot(tb), sc0 = target.velocitySlot(tc);
    const mvx = heap[va], mvy = heap[va + 1], mvz = heap[va + 2];
    const vx = e[0] * mvx + e[4] * mvy + e[8] * mvz - (hit.u * heap[sa0] + hit.v * heap[sb0] + hit.w * heap[sc0]);
    const vy = e[1] * mvx + e[5] * mvy + e[9] * mvz - (hit.u * heap[sa0 + 1] + hit.v * heap[sb0 + 1] + hit.w * heap[sc0 + 1]);
    const vz = e[2] * mvx + e[6] * mvy + e[10] * mvz - (hit.u * heap[sa0 + 2] + hit.v * heap[sb0 + 2] + hit.w * heap[sc0 + 2]);
    const approach = vx * nx + vy * ny + vz * nz;
    if (approach < 0) {
      const jx = -nx * approach / denominator, jy = -ny * approach / denominator, jz = -nz * approach / denominator;
      heap[va] += (e[0] * jx + e[1] * jy + e[2] * jz) * wa;
      heap[va + 1] += (e[4] * jx + e[5] * jy + e[6] * jz) * wa;
      heap[va + 2] += (e[8] * jx + e[9] * jy + e[10] * jz) * wa;
      for (const [slot, weight] of [[sa0, wu], [sb0, wv], [sc0, ww]] as const) {
        heap[slot] -= jx * weight;
        heap[slot + 1] -= jy * weight;
        heap[slot + 2] -= jz * weight;
      }
    }
    moved = 1;
  }
  return moved;
}

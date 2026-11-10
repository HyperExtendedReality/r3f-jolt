import * as THREE from "three";
import type Jolt from "jolt-physics";

export type AutoShape = "box" | "sphere" | "capsule" | "cylinder" | "convex" | "trimesh";

/** Jolt's default convex radius; shrunk for shapes thinner than it. */
const CONVEX_RADIUS = 0.05;
const vertex = new THREE.Vector3();

export class ShapeSystem {
  constructor(private jolt: typeof Jolt) {}

  /** `matrix` (e.g. the mesh relative to its body) is applied to convex and trimesh vertices. */
  getShapeSettingsFromObject(object: THREE.Object3D, shapeType?: AutoShape, matrix?: THREE.Matrix4): Jolt.ShapeSettings {
    if (object instanceof THREE.Mesh) {
      const settings = this.getShapeSettingsFromGeometry(object.geometry, shapeType, matrix);
      if (settings) return settings;
    }
    return this.box(new THREE.Vector3(1, 1, 1));
  }

  getShapeSettingsFromGeometry(geometry: THREE.BufferGeometry, shapeType?: AutoShape, matrix?: THREE.Matrix4): Jolt.ShapeSettings | null {
    const position = geometry.getAttribute("position");
    if (!position || position.count === 0) return null;
    const kind = shapeType ?? (
      geometry instanceof THREE.BoxGeometry ? "box" :
      geometry instanceof THREE.SphereGeometry ? "sphere" :
      geometry instanceof THREE.CapsuleGeometry ? "capsule" :
      geometry instanceof THREE.CylinderGeometry ? "cylinder" : "convex"
    );
    const size = () => {
      geometry.computeBoundingBox();
      return geometry.boundingBox!.getSize(new THREE.Vector3());
    };
    switch (kind) {
      case "box": return this.box(size());
      case "sphere": {
        geometry.computeBoundingSphere();
        return new this.jolt.SphereShapeSettings(geometry.boundingSphere!.radius);
      }
      case "capsule": {
        if (geometry instanceof THREE.CapsuleGeometry) {
          return new this.jolt.CapsuleShapeSettings(geometry.parameters.height / 2, geometry.parameters.radius);
        }
        const bounds = size();
        const radius = Math.max(bounds.x, bounds.z) / 2;
        return new this.jolt.CapsuleShapeSettings(Math.max(0, bounds.y / 2 - radius), radius);
      }
      case "cylinder": {
        if (geometry instanceof THREE.CylinderGeometry) {
          const p = geometry.parameters;
          return this.cylinder(p.height / 2, Math.max(p.radiusTop, p.radiusBottom));
        }
        const bounds = size();
        return this.cylinder(bounds.y / 2, Math.max(bounds.x, bounds.z) / 2);
      }
      case "convex": {
        const settings = new this.jolt.ConvexHullShapeSettings();
        const point = new this.jolt.Vec3(0, 0, 0);
        for (let i = 0; i < position.count; i += 1) {
          vertex.fromBufferAttribute(position, i);
          if (matrix) vertex.applyMatrix4(matrix);
          point.Set(vertex.x, vertex.y, vertex.z);
          settings.mPoints.push_back(point);
        }
        this.jolt.destroy(point);
        return settings;
      }
      case "trimesh": {
        const index = geometry.getIndex();
        const count = index?.count ?? position.count;
        if (count % 3 !== 0) throw new Error("Mesh collision geometry must contain triangles");
        const triangles = new this.jolt.TriangleList();
        triangles.resize(count / 3);
        for (let i = 0; i < count; i += 3) {
          const triangle = triangles.at(i / 3);
          for (let corner = 0; corner < 3; corner += 1) {
            const source = index?.getX(i + corner) ?? i + corner;
            const target = triangle.get_mV(corner);
            vertex.fromBufferAttribute(position, source);
            if (matrix) vertex.applyMatrix4(matrix);
            target.x = vertex.x;
            target.y = vertex.y;
            target.z = vertex.z;
          }
        }
        const materials = new this.jolt.PhysicsMaterialList();
        const settings = new this.jolt.MeshShapeSettings(triangles, materials);
        this.jolt.destroy(triangles);
        this.jolt.destroy(materials);
        return settings;
      }
    }
  }

  /** Box from full size; convex radius clamped so thin boxes stay valid. */
  box(size: THREE.Vector3): Jolt.BoxShapeSettings {
    const halfExtent = new this.jolt.Vec3(size.x / 2, size.y / 2, size.z / 2);
    const radius = Math.min(CONVEX_RADIUS, size.x / 2, size.y / 2, size.z / 2);
    const settings = new this.jolt.BoxShapeSettings(halfExtent, radius);
    this.jolt.destroy(halfExtent);
    return settings;
  }

  /** Cylinder; convex radius clamped so thin or short cylinders stay valid. */
  cylinder(halfHeight: number, radius: number): Jolt.CylinderShapeSettings {
    return new this.jolt.CylinderShapeSettings(halfHeight, radius, Math.min(CONVEX_RADIUS, halfHeight, radius));
  }
}

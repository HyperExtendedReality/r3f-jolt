import * as THREE from 'three';
import type Jolt from 'jolt-physics';
import { vec3, quat } from '../utils/jolt-helpers';

// Helper types
export type AutoShape = 
    | 'box' 
    | 'sphere' 
    | 'capsule' 
    | 'cylinder' 
    | 'convex' 
    | 'trimesh';

export class ShapeSystem {
    constructor(private jolt: typeof Jolt) {}

    // Get shape settings from a Three.js Object3D
    public getShapeSettingsFromObject(object: THREE.Object3D, shapeType?: AutoShape): Jolt.ShapeSettings {
        // Simple case: Single Mesh
        if (object instanceof THREE.Mesh) {
             const settings = this.getShapeSettingsFromGeometry(object.geometry, shapeType);
             if (settings) return settings;
        }

        // TODO: Handle Compound Shapes (recursion on children)
        // For now, fallback to box
        return new this.jolt.BoxShapeSettings(new this.jolt.Vec3(0.5, 0.5, 0.5));
    }

    public getShapeSettingsFromGeometry(geometry: THREE.BufferGeometry, shapeType?: AutoShape): Jolt.ShapeSettings | null {
         // Infer shape type if not provided
         if (!shapeType) {
            if (geometry instanceof THREE.BoxGeometry) shapeType = 'box';
            else if (geometry instanceof THREE.SphereGeometry) shapeType = 'sphere';
            else if (geometry instanceof THREE.CapsuleGeometry) shapeType = 'capsule';
            else if (geometry instanceof THREE.CylinderGeometry) shapeType = 'cylinder';
            else shapeType = 'convex'; // Default to convex for random meshes
         }

         switch (shapeType) {
            case 'box':
                geometry.computeBoundingBox();
                const box = geometry.boundingBox!;
                const size = new THREE.Vector3();
                box.getSize(size);
                return new this.jolt.BoxShapeSettings(new this.jolt.Vec3(size.x / 2, size.y / 2, size.z / 2));

            case 'sphere':
                geometry.computeBoundingSphere();
                const sphere = geometry.boundingSphere!;
                return new this.jolt.SphereShapeSettings(sphere.radius);
            
            case 'capsule':
                 // Assuming CapsuleGeometry parameters (radius, height)
                 // NOTE: Three.js CapsuleGeometry is slightly different from Jolt
                 // Might need to extract parameters if possible, or use bounding box approximation
                 if (geometry instanceof THREE.CapsuleGeometry) {
                     const { radius, height } = geometry.parameters;
                     return new this.jolt.CapsuleShapeSettings(height / 2, radius);
                 }
                 // Fallback to bounding box approx
                 geometry.computeBoundingBox();
                 const cBox = geometry.boundingBox!;
                 const cSize = new THREE.Vector3();
                 cBox.getSize(cSize);
                 return new this.jolt.CapsuleShapeSettings(cSize.y / 2 - cSize.x / 2, cSize.x / 2);

            case 'cylinder':
                if (geometry instanceof THREE.CylinderGeometry) {
                    const { radiusTop, height } = geometry.parameters;
                    return new this.jolt.CylinderShapeSettings(height / 2, radiusTop, 0.05); // 0.05 convex radius
                }
                 // Fallback
                 geometry.computeBoundingBox();
                 const cyBox = geometry.boundingBox!;
                 const cySize = new THREE.Vector3();
                 cyBox.getSize(cySize);
                 return new this.jolt.CylinderShapeSettings(cySize.y / 2, cySize.x / 2, 0.05);

            case 'convex':
                return this.createConvexHull(geometry);
            
            case 'trimesh':
                return this.createMeshShape(geometry);

            default:
                return null;
         }
    }

    private createConvexHull(geometry: THREE.BufferGeometry): Jolt.ShapeSettings {
        const positions = geometry.attributes.position.array;
        const settings = new this.jolt.ConvexHullShapeSettings();
        
        // Jolt ConvexHull can take a lot of points and optimize them
        for (let i = 0; i < positions.length; i += 3) {
            const v = new this.jolt.Vec3(positions[i], positions[i+1], positions[i+2]);
            settings.mPoints.push_back(v);
            this.jolt.destroy(v);
        }
        
        return settings;
    }

    private createMeshShape(geometry: THREE.BufferGeometry): Jolt.ShapeSettings {
        const vertices = geometry.attributes.position.array;
        const indices = geometry.index ? geometry.index.array : null;

        const triangleList = new this.jolt.TriangleList();
        
        // If indexed
        if (indices) {
             triangleList.resize(indices.length / 3);
             for (let i = 0; i < indices.length; i += 3) {
                const i1 = indices[i] * 3;
                const i2 = indices[i+1] * 3;
                const i3 = indices[i+2] * 3;

                const t = triangleList.at(i / 3);
                const v1 = t.get_mV(0);
                const v2 = t.get_mV(1);
                const v3 = t.get_mV(2);

                v1.x = vertices[i1]; v1.y = vertices[i1+1]; v1.z = vertices[i1+2];
                v2.x = vertices[i2]; v2.y = vertices[i2+1]; v2.z = vertices[i2+2];
                v3.x = vertices[i3]; v3.y = vertices[i3+1]; v3.z = vertices[i3+2];
             }
        } else {
            // Non-indexed
            triangleList.resize(vertices.length / 9);
            for (let i = 0; i < vertices.length; i += 9) {
                 const t = triangleList.at(i / 9);
                 const v1 = t.get_mV(0);
                 const v2 = t.get_mV(1);
                 const v3 = t.get_mV(2);

                 v1.x = vertices[i];   v1.y = vertices[i+1]; v1.z = vertices[i+2];
                 v2.x = vertices[i+3]; v2.y = vertices[i+4]; v2.z = vertices[i+5];
                 v3.x = vertices[i+6]; v3.y = vertices[i+7]; v3.z = vertices[i+8];
            }
        }
        
        const materials = new this.jolt.PhysicsMaterialList();
        const settings = new this.jolt.MeshShapeSettings(triangleList, materials);
        
        this.jolt.destroy(triangleList);
        this.jolt.destroy(materials);

        return settings;
    }
}

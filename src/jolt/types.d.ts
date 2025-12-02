declare module "jolt-physics" {
    export default function initJolt(settings?: any): Promise<Jolt>;
}

declare module "jolt-physics/wasm-multithread" {
    export default function initJolt(settings?: any): Promise<Jolt>;
}

export interface Jolt {
    destroy(obj: any): void;
    HEAP8: Int8Array;
    HEAP16: Int16Array;
    HEAP32: Int32Array;
    HEAPF32: Float32Array;
    
    // Core
    JoltInterface: any;
    JoltSettings: any;
    PhysicsSystem: any;
    BodyInterface: any;
    BodyLockInterface: any;
    
    // Math
    Vec3: any;
    RVec3: any;
    Quat: any;
    Float3: any;
    Mat44: any;
    
    // Layers
    ObjectLayerPairFilterTable: any;
    BroadPhaseLayerInterfaceTable: any;
    ObjectVsBroadPhaseLayerFilterTable: any;
    BroadPhaseLayer: any;
    
    // Shapes & Settings
    ShapeGetTriangles: any;
    AABox: any;
    ShapeSettings: any;
    ShapeResult: any;
    Shape: any;
    BoxShapeSettings: any;
    BoxShape: any;
    SphereShapeSettings: any;
    BodyCreationSettings: any;
    SoftBodyCreationSettings: any;
    SoftBodySharedSettings: any;
    SoftBodySharedSettingsVertex: any;
    SoftBodySharedSettingsFace: any;
    SoftBodySharedSettingsVertexAttributes: any;
    
    // Enums
    EActivation_Activate: number;
    EActivation_DontActivate: number;
    EMotionType_Static: number;
    EMotionType_Dynamic: number;
    EMotionType_Kinematic: number;
    SoftBodySharedSettings_EBendType_Dihedral: number;
    
    // Pointers & Casting
    getPointer(obj: any): number;
    castObject(obj: any, type: any): any;
    SoftBodyMotionProperties: any;
    SoftBodyVertexTraits: any;
}
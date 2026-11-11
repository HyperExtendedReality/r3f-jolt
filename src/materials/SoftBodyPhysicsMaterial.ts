/** Solver properties. Compliance is inverse stiffness in Jolt's XPBD solver. */
export interface SoftBodyPhysicsMaterial {
  /** Inverse mass of each particle. Zero pins a particle. */
  inverseMass?: number;
  /** Edge stretch compliance (m/N). */
  compliance?: number;
  shearCompliance?: number;
  bendCompliance?: number;
  /** Tetrahedral volume compliance, used by solid cubes. */
  volumeCompliance?: number;
  /** Gas amount times the gas constant and temperature (nRT). Requires a sealed mesh. */
  pressure?: number;
  iterations?: number;
  vertexRadius?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  gravityFactor?: number;
}

/** Starting points in metre/kilogram/second units; tune for mesh scale and timestep. */
export const softBodyMaterials = {
  chipBagDeflated: {
    inverseMass: 1,
    compliance: 2e-5,
    shearCompliance: 2e-5,
    bendCompliance: 5e-4,
    pressure: 0,
    iterations: 12,
    friction: 0.8,
    restitution: 0.05,
    // Enough damping and contact margin that a crumpled bag settles and sleeps instead of shimmering.
    linearDamping: 0.4,
    vertexRadius: 0.02,
  },
  chipBagInflated: {
    inverseMass: 1,
    compliance: 2e-5,
    shearCompliance: 2e-5,
    bendCompliance: 5e-4,
    pressure: 40,
    iterations: 12,
    friction: 0.8,
    restitution: 0.1,
    // Enough damping and contact margin that a crumpled bag settles and sleeps instead of shimmering.
    linearDamping: 0.4,
    vertexRadius: 0.02,
  },
  slime: {
    inverseMass: 0.5,
    // Stiffer edges than bends: with 2e-3 edges the shell sagged and its folds jittered at rest.
    compliance: 2e-4,
    shearCompliance: 2e-4,
    bendCompliance: 5e-3,
    volumeCompliance: 1e-6,
    pressure: 0,
    iterations: 16,
    friction: 1.5,
    restitution: 0,
    linearDamping: 0.3,
    vertexRadius: 0.02,
  },
  bouncySlime: {
    inverseMass: 0.5,
    compliance: 5e-4,
    shearCompliance: 5e-4,
    bendCompliance: 1e-3,
    volumeCompliance: 1e-7,
    pressure: 0,
    iterations: 16,
    friction: 0.7,
    restitution: 0.85,
    linearDamping: 0.04,
  },
} as const satisfies Record<string, SoftBodyPhysicsMaterial>;

import { BufferGeometry, Vector3 } from "three";

// Interface for the Jolt instance (using any because Jolt WASM types vary by implementation/version)
type JoltInstance = any;

interface VertexPerturbation {
  x: number;
  y: number;
  z: number;
}

export class SoftBodyCreator {
  /**
   * Creates a soft body from arbitrary triangle geometry. Render vertices are
   * kept intact for UV seams while physics vertices are welded by position.
   */
  static CreateFromGeometry(
    Jolt: JoltInstance,
    geometry: BufferGeometry,
    inVertexAttributes?: any,
    inBendType: number = Jolt.SoftBodySharedSettings_EBendType_Dihedral,
    weldTolerance: number = 1.0e-5
  ): any {
    const positions = geometry.getAttribute("position");
    const sourceIndices = geometry.getIndex();

    if (!positions || positions.itemSize < 3) {
      throw new Error("SoftBody geometry requires a position attribute");
    }

    const sharedSettings = new Jolt.SoftBodySharedSettings();
    const renderToPhysics = new Uint32Array(positions.count);
    const weldedPositions: number[] = [];
    const weldedVertices = new Map<string, number>();
    const inverseTolerance = 1 / weldTolerance;

    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const key = `${Math.round(x * inverseTolerance)},${Math.round(
        y * inverseTolerance
      )},${Math.round(z * inverseTolerance)}`;
      let physicsIndex = weldedVertices.get(key);

      if (physicsIndex == null) {
        physicsIndex = weldedPositions.length / 3;
        weldedVertices.set(key, physicsIndex);
        weldedPositions.push(x, y, z);
      }

      renderToPhysics[i] = physicsIndex;
    }

    const vertex = new Jolt.SoftBodySharedSettingsVertex();
    vertex.mInvMass = 1;
    for (let i = 0; i < weldedPositions.length; i += 3) {
      vertex.mPosition.x = weldedPositions[i];
      vertex.mPosition.y = weldedPositions[i + 1];
      vertex.mPosition.z = weldedPositions[i + 2];
      sharedSettings.mVertices.push_back(vertex);
    }
    Jolt.destroy(vertex);

    const sourceIndexCount = sourceIndices?.count ?? positions.count;
    const RenderIndexArray =
      positions.count > 65_535 ? Uint32Array : Uint16Array;
    const renderIndices = new RenderIndexArray(sourceIndexCount);
    const face = new Jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
    const physicsFaces = new Set<string>();

    for (let i = 0; i < sourceIndexCount; i += 3) {
      const renderA = sourceIndices?.getX(i) ?? i;
      const renderB = sourceIndices?.getX(i + 1) ?? i + 1;
      const renderC = sourceIndices?.getX(i + 2) ?? i + 2;
      renderIndices[i] = renderA;
      renderIndices[i + 1] = renderB;
      renderIndices[i + 2] = renderC;

      const physicsA = renderToPhysics[renderA];
      const physicsB = renderToPhysics[renderB];
      const physicsC = renderToPhysics[renderC];
      if (
        physicsA === physicsB ||
        physicsB === physicsC ||
        physicsC === physicsA
      ) {
        continue;
      }

      const faceKey = [physicsA, physicsB, physicsC]
        .sort((a, b) => a - b)
        .join(",");
      if (physicsFaces.has(faceKey)) {
        continue;
      }
      physicsFaces.add(faceKey);

      face.set_mVertex(0, physicsA);
      face.set_mVertex(1, physicsB);
      face.set_mVertex(2, physicsC);
      sharedSettings.AddFace(face);
    }
    Jolt.destroy(face);

    if (inVertexAttributes) {
      sharedSettings.CreateConstraints(inVertexAttributes, 1, inBendType);
    } else {
      const defaultAttributes =
        new Jolt.SoftBodySharedSettingsVertexAttributes();
      defaultAttributes.mCompliance = 1.0e-4;
      defaultAttributes.mShearCompliance = 1.0e-4;
      defaultAttributes.mBendCompliance = 1.0e-3;
      sharedSettings.CreateConstraints(defaultAttributes, 1, inBendType);
      Jolt.destroy(defaultAttributes);
    }

    sharedSettings.CalculateEdgeLengths();
    sharedSettings.CalculateVolumeConstraintVolumes();
    sharedSettings.Optimize();

    const sourceUvs = geometry.getAttribute("uv");
    const uvs = sourceUvs ? new Float32Array(positions.count * 2) : null;
    if (sourceUvs && uvs) {
      for (let i = 0; i < sourceUvs.count; i += 1) {
        uvs[i * 2] = sourceUvs.getX(i);
        uvs[i * 2 + 1] = sourceUvs.getY(i);
      }
    }

    return {
      settings: sharedSettings,
      uvs,
      renderIndices,
      renderToPhysics,
    };
  }

  /**
   * Creates a cloth soft body.
   */
  static CreateCloth(
    Jolt: JoltInstance,
    inGridSizeX: number = 30,
    inGridSizeZ: number = 30,
    inGridSpacing: number = 0.75,
    inVertexGetInvMass: (x: number, z: number) => number = () => 1,
    inVertexPerturbation: (
      x: number,
      z: number
    ) => VertexPerturbation = () => ({ x: 0, y: 0, z: 0 }),
    inBendType: number = Jolt.SoftBodySharedSettings_EBendType_None,
    inVertexAttributes?: any
  ): any {
    const cOffsetX = -0.5 * inGridSpacing * (inGridSizeX - 1);
    const cOffsetZ = -0.5 * inGridSpacing * (inGridSizeZ - 1);

    // Create settings
    const sharedSettings = new Jolt.SoftBodySharedSettings();

    // Reuse a single vertex object for pushing data to C++ memory
    const v = new Jolt.SoftBodySharedSettingsVertex();

    for (let z = 0; z < inGridSizeZ; ++z) {
      for (let x = 0; x < inGridSizeX; ++x) {
        const perturb = inVertexPerturbation(x, z);
        v.mPosition.x = inGridSpacing * x + cOffsetX + perturb.x;
        v.mPosition.y = 0 + perturb.y;
        v.mPosition.z = inGridSpacing * z + cOffsetZ + perturb.z;
        v.mInvMass = inVertexGetInvMass(x, z);
        sharedSettings.mVertices.push_back(v);
      }
    }
    Jolt.destroy(v);

    // Function to get the vertex index of a point on the cloth
    const vertex_index = (inX: number, inY: number) => {
      return inX + inY * inGridSizeX;
    };

    sharedSettings.CalculateEdgeLengths();

    // Create faces
    const f = new Jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
    for (let z = 0; z < inGridSizeZ - 1; ++z) {
      for (let x = 0; x < inGridSizeX - 1; ++x) {
        f.set_mVertex(0, vertex_index(x, z));
        f.set_mVertex(1, vertex_index(x, z + 1));
        f.set_mVertex(2, vertex_index(x + 1, z + 1));
        sharedSettings.AddFace(f);

        f.set_mVertex(1, vertex_index(x + 1, z + 1));
        f.set_mVertex(2, vertex_index(x + 1, z));
        sharedSettings.AddFace(f);
      }
    }
    Jolt.destroy(f);

    if (inVertexAttributes) {
      sharedSettings.CreateConstraints(inVertexAttributes, 1, inBendType);
    } else {
      const defaultAttributes =
        new Jolt.SoftBodySharedSettingsVertexAttributes();
      defaultAttributes.mCompliance = 1.0e-5;
      defaultAttributes.mShearCompliance = 1.0e-5;
      defaultAttributes.mBendCompliance = 1.0e-5;
      sharedSettings.CreateConstraints(defaultAttributes, 1, inBendType);
      Jolt.destroy(defaultAttributes);
    }

    // Optimize the settings
    sharedSettings.Optimize();
    
    // Calculate UVs
    const uvs = new Float32Array(inGridSizeX * inGridSizeZ * 2);
    for (let z = 0; z < inGridSizeZ; ++z) {
      for (let x = 0; x < inGridSizeX; ++x) {
        const index = (z * inGridSizeX + x) * 2;
        uvs[index] = x / (inGridSizeX - 1);
        uvs[index + 1] = 1.0 - z / (inGridSizeZ - 1); // Flip Y
      }
    }

    return { settings: sharedSettings, uvs };
  }

  /**
   * Creates a cloth with corners fixed (inverse mass = 0).
   */
  static CreateClothWithFixatedCorners(
    Jolt: JoltInstance,
    inGridSizeX: number = 30,
    inGridSizeZ: number = 30,
    inGridSpacing: number = 0.75
  ): any {
    const inv_mass = (inX: number, inZ: number) => {
      return (inX === 0 && inZ === 0) ||
        (inX === inGridSizeX - 1 && inZ === 0) ||
        (inX === 0 && inZ === inGridSizeZ - 1) ||
        (inX === inGridSizeX - 1 && inZ === inGridSizeZ - 1)
        ? 0.0
        : 1.0;
    };

    return this.CreateCloth(
      Jolt,
      inGridSizeX,
      inGridSizeZ,
      inGridSpacing,
      inv_mass
    );
  }

  /**
   * Creates a soft body cube.
   */
  static CreateCube(
    Jolt: JoltInstance,
    inGridSize: number = 5,
    inGridSpacing: number = 0.5,
    edgeCompliance: number = 0,
    volumeCompliance: number = 0
  ): any {
    const cOffset = -0.5 * inGridSpacing * (inGridSize - 1);

    // Create settings
    const sharedSettings = new Jolt.SoftBodySharedSettings();
    const v = new Jolt.SoftBodySharedSettingsVertex();

    for (let z = 0; z < inGridSize; ++z) {
      for (let y = 0; y < inGridSize; ++y) {
        for (let x = 0; x < inGridSize; ++x) {
          v.mPosition.x = inGridSpacing * x + cOffset;
          v.mPosition.y = inGridSpacing * y + cOffset;
          v.mPosition.z = inGridSpacing * z + cOffset;
          sharedSettings.mVertices.push_back(v);
        }
      }
    }
    Jolt.destroy(v);

    // Function to get the vertex index
    const vertex_index = (inX: number, inY: number, inZ: number) => {
      return inX + inY * inGridSize + inZ * inGridSize * inGridSize;
    };

    const sEdge = new Jolt.SoftBodySharedSettingsEdge(0, 0, 0);
    sEdge.mCompliance = edgeCompliance;

    // Create edges
    for (let z = 0; z < inGridSize; ++z) {
      for (let y = 0; y < inGridSize; ++y) {
        for (let x = 0; x < inGridSize; ++x) {
          const v0 = vertex_index(x, y, z);
          sEdge.set_mVertex(0, v0);
          if (x < inGridSize - 1) {
            const v1 = vertex_index(x + 1, y, z);
            sEdge.set_mVertex(1, v1);
            sharedSettings.mEdgeConstraints.push_back(sEdge);
          }
          if (y < inGridSize - 1) {
            const v1 = vertex_index(x, y + 1, z);
            sEdge.set_mVertex(1, v1);
            sharedSettings.mEdgeConstraints.push_back(sEdge);
          }
          if (z < inGridSize - 1) {
            const v1 = vertex_index(x, y, z + 1);
            sEdge.set_mVertex(1, v1);
            sharedSettings.mEdgeConstraints.push_back(sEdge);
          }
        }
      }
    }
    Jolt.destroy(sEdge);
    sharedSettings.CalculateEdgeLengths();

    const tetra_indices = [
      [
        [0, 0, 0],
        [0, 1, 1],
        [0, 0, 1],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [1, 0, 1],
        [1, 0, 0],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [1, 1, 1],
      ],
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
      ],
    ];

    // Create volume constraints
    const sVol = new Jolt.SoftBodySharedSettingsVolume(0, 0, 0, 0, 0);
    sVol.mCompliance = volumeCompliance;
    for (let z = 0; z < inGridSize - 1; ++z) {
      for (let y = 0; y < inGridSize - 1; ++y) {
        for (let x = 0; x < inGridSize - 1; ++x) {
          for (let t = 0; t < 6; ++t) {
            for (let i = 0; i < 4; ++i) {
              const offsets = tetra_indices[t][i];
              sVol.set_mVertex(
                i,
                vertex_index(x + offsets[0], y + offsets[1], z + offsets[2])
              );
            }
            sharedSettings.mVolumeConstraints.push_back(sVol);
          }
        }
      }
    }
    Jolt.destroy(sVol);
    sharedSettings.CalculateVolumeConstraintVolumes();

    // Create faces
    const f = new Jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
    for (let y = 0; y < inGridSize - 1; ++y) {
      for (let x = 0; x < inGridSize - 1; ++x) {
        // Face 1 (Z=0)
        f.set_mVertex(0, vertex_index(x, y, 0));
        f.set_mVertex(1, vertex_index(x, y + 1, 0));
        f.set_mVertex(2, vertex_index(x + 1, y + 1, 0));
        sharedSettings.AddFace(f);
        f.set_mVertex(1, vertex_index(x + 1, y + 1, 0));
        f.set_mVertex(2, vertex_index(x + 1, y, 0));
        sharedSettings.AddFace(f);
        // Face 2 (Z=end)
        f.set_mVertex(0, vertex_index(x, y, inGridSize - 1));
        f.set_mVertex(1, vertex_index(x + 1, y + 1, inGridSize - 1));
        f.set_mVertex(2, vertex_index(x, y + 1, inGridSize - 1));
        sharedSettings.AddFace(f);
        f.set_mVertex(1, vertex_index(x + 1, y, inGridSize - 1));
        f.set_mVertex(2, vertex_index(x + 1, y + 1, inGridSize - 1));
        sharedSettings.AddFace(f);
        // Face 3 (Y=0)
        f.set_mVertex(0, vertex_index(x, 0, y));
        f.set_mVertex(1, vertex_index(x + 1, 0, y + 1));
        f.set_mVertex(2, vertex_index(x, 0, y + 1));
        sharedSettings.AddFace(f);
        f.set_mVertex(1, vertex_index(x + 1, 0, y));
        f.set_mVertex(2, vertex_index(x + 1, 0, y + 1));
        sharedSettings.AddFace(f);
        // Face 4 (Y=end)
        f.set_mVertex(0, vertex_index(x, inGridSize - 1, y));
        f.set_mVertex(1, vertex_index(x, inGridSize - 1, y + 1));
        f.set_mVertex(2, vertex_index(x + 1, inGridSize - 1, y + 1));
        sharedSettings.AddFace(f);
        f.set_mVertex(1, vertex_index(x + 1, inGridSize - 1, y + 1));
        f.set_mVertex(2, vertex_index(x + 1, inGridSize - 1, y));
        sharedSettings.AddFace(f);
        // Face 5 (X=0)
        f.set_mVertex(0, vertex_index(0, x, y));
        f.set_mVertex(1, vertex_index(0, x, y + 1));
        f.set_mVertex(2, vertex_index(0, x + 1, y + 1));
        sharedSettings.AddFace(f);
        f.set_mVertex(1, vertex_index(0, x + 1, y + 1));
        f.set_mVertex(2, vertex_index(0, x + 1, y));
        sharedSettings.AddFace(f);
        // Face 6 (X=end)
        f.set_mVertex(0, vertex_index(inGridSize - 1, x, y));
        f.set_mVertex(1, vertex_index(inGridSize - 1, x + 1, y + 1));
        f.set_mVertex(2, vertex_index(inGridSize - 1, x, y + 1));
        sharedSettings.AddFace(f);
        f.set_mVertex(1, vertex_index(inGridSize - 1, x + 1, y));
        f.set_mVertex(2, vertex_index(inGridSize - 1, x + 1, y + 1));
        sharedSettings.AddFace(f);
      }
    }
    Jolt.destroy(f);

    // Optimize the settings
    sharedSettings.Optimize();
    
    // A shared soft-body vertex can belong to multiple cube faces, so a perfect
    // box unwrap would require duplicating render vertices. Spherical projection
    // keeps the physics/render vertex mapping one-to-one while still providing a
    // useful default UV set that users can texture without extra geometry work.
    const uvs = new Float32Array(inGridSize * inGridSize * inGridSize * 2);
    for (let z = 0; z < inGridSize; ++z) {
      for (let y = 0; y < inGridSize; ++y) {
        for (let x = 0; x < inGridSize; ++x) {
          const px = inGridSpacing * x + cOffset;
          const py = inGridSpacing * y + cOffset;
          const pz = inGridSpacing * z + cOffset;
          const radius = Math.sqrt(px * px + py * py + pz * pz);
          const index = vertex_index(x, y, z) * 2;

          uvs[index] = 0.5 + Math.atan2(pz, px) / (2 * Math.PI);
          uvs[index + 1] =
            radius > 0 ? 0.5 + Math.asin(py / radius) / Math.PI : 0.5;
        }
      }
    }

    return { settings: sharedSettings, uvs };
  }

  /**
   * Creates a soft body sphere.
   */
  static CreateSphere(
    Jolt: JoltInstance,
    inRadius: number = 1,
    inNumTheta: number = 10,
    inNumPhi: number = 20,
    inBendType: number = Jolt.SoftBodySharedSettings_EBendType_None,
    inVertexAttributes?: any
  ): any {
    const sharedSettings = new Jolt.SoftBodySharedSettings();
    const v3 = new Vector3();

    // Create settings
    const v = new Jolt.SoftBodySharedSettingsVertex();

    const sUnitSpherical = (phi: number, theta: number) => {
      // Note: Three.js setFromSphericalCoords takes (radius, phi, theta)
      // Phi = polar angle (from positive y-axis), Theta = equator angle (around y-axis)
      v3.setFromSphericalCoords(inRadius, phi, theta);
      v.mPosition.x = v3.x;
      v.mPosition.y = v3.y;
      v.mPosition.z = v3.z;
      sharedSettings.mVertices.push_back(v);
    };

    sUnitSpherical(0, 0);
    sUnitSpherical(Math.PI, 0);

    for (let theta = 1; theta < inNumTheta - 1; ++theta) {
      for (let phi = 0; phi < inNumPhi; ++phi) {
        sUnitSpherical(
          (Math.PI * theta) / (inNumTheta - 1),
          (2.0 * Math.PI * phi) / inNumPhi
        );
      }
    }
    Jolt.destroy(v);

    const vertex_index = (inTheta: number, inPhi: number) => {
      if (inTheta === 0) return 0;
      else if (inTheta === inNumTheta - 1) return 1;
      else return 2 + (inTheta - 1) * inNumPhi + (inPhi % inNumPhi);
    };

    const f = new Jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
    for (let phi = 0; phi < inNumPhi; ++phi) {
      for (let theta = 0; theta < inNumTheta - 2; ++theta) {
        f.set_mVertex(0, vertex_index(theta, phi));
        f.set_mVertex(1, vertex_index(theta + 1, phi));
        f.set_mVertex(2, vertex_index(theta + 1, phi + 1));
        sharedSettings.AddFace(f);
        if (theta > 0) {
          f.set_mVertex(1, vertex_index(theta + 1, phi + 1));
          f.set_mVertex(2, vertex_index(theta, phi + 1));
          sharedSettings.AddFace(f);
        }
      }
      f.set_mVertex(0, vertex_index(inNumTheta - 2, phi + 1));
      f.set_mVertex(1, vertex_index(inNumTheta - 2, phi));
      f.set_mVertex(2, vertex_index(inNumTheta - 1, 0));
      sharedSettings.AddFace(f);
    }
    Jolt.destroy(f);

    if (inVertexAttributes) {
      sharedSettings.CreateConstraints(inVertexAttributes, 1, inBendType);
    } else {
      const defaultAttributes =
        new Jolt.SoftBodySharedSettingsVertexAttributes();
      defaultAttributes.mCompliance = 1.0e-4;
      defaultAttributes.mShearCompliance = 1.0e-4;
      defaultAttributes.mBendCompliance = 1.0e-3;
      sharedSettings.CreateConstraints(defaultAttributes, 1, inBendType);
      Jolt.destroy(defaultAttributes);
    }

    // Optimize the settings
    sharedSettings.Optimize();

    // UV Generation for Sphere
    // This is a bit tricky AFTER the fact because indices are re-mapped.
    // However, the vertex array order should match the creation order.
    // 0: Top Pole (0, 0)
    // 1: Bottom Pole (1, 0)
    // 2..N: Rings
    
    // Total Verts = 2 + (Theta-2) * Phi
    const numVerts = 2 + (inNumTheta - 2) * inNumPhi;
    const uvs = new Float32Array(numVerts * 2);

    // Top
    uvs[0] = 0.5; uvs[1] = 1.0;
    // Bottom
    uvs[2] = 0.5; uvs[3] = 0.0;
    
    // Rings
    let offset = 4;
    for (let theta = 1; theta < inNumTheta - 1; ++theta) {
        const v = theta / (inNumTheta - 1); // 0 to 1 top to bottom
        for (let phi = 0; phi < inNumPhi; ++phi) {
            const u = phi / inNumPhi; // 0 to 1 around
            uvs[offset++] = u;
            uvs[offset++] = 1.0 - v; // Flip Y
        }
    }

    return { settings: sharedSettings, uvs };
  }
}

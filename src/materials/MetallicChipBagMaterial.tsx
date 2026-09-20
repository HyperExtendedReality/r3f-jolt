import React, { useImperativeHandle, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";

const SHADER_VERSION = "2";

export interface MetallicChipBagMaterialParameters
  extends THREE.MeshPhysicalMaterialParameters {
  /** Frequency of the procedural foil wrinkles in object space. */
  crinkleScale?: number;
  /** Strength of the procedural derivative normal. */
  crinkleStrength?: number;
  /** Amount of local roughness variation across the foil. */
  roughnessVariation?: number;
}

const shaderPreamble = /* glsl */ `
uniform float chipBagCrinkleScale;
uniform float chipBagCrinkleStrength;
uniform float chipBagRoughnessVariation;
varying vec3 vChipBagPosition;

float chipBagHeight(vec3 objectPosition) {
  vec3 p = objectPosition * chipBagCrinkleScale;
  float broadFold = sin(p.x * 0.47 + p.y * 0.31 + sin(p.z * 0.23));
  float diagonalFold = sin(p.x * 0.81 - p.y * 0.63 + p.z * 0.37);
  float fineFold = sin(p.x * 1.73 + p.y * 1.21 - p.z * 0.91);
  return broadFold * 0.52 + diagonalFold * 0.31 + fineFold * 0.17;
}

vec3 chipBagPerturbNormal(
  vec3 surfacePosition,
  vec3 surfaceNormal,
  float height,
  float strength
) {
  vec3 sigmaX = dFdx(surfacePosition);
  vec3 sigmaY = dFdy(surfacePosition);
  vec3 normalEdgeX = cross(sigmaY, surfaceNormal);
  vec3 normalEdgeY = cross(surfaceNormal, sigmaX);
  float determinant = dot(sigmaX, normalEdgeX);
  vec3 surfaceGradient = sign(determinant) *
    (dFdx(height) * normalEdgeX + dFdy(height) * normalEdgeY);

  return normalize(
    abs(determinant) * surfaceNormal - strength * surfaceGradient
  );
}
`;

/**
 * MeshPhysicalMaterial with a lightweight procedural foil layer. It keeps the
 * stock Three.js PBR pipeline, so maps, lights, shadows, tone mapping and IBL
 * continue to work normally.
 */
export class MetallicChipBagShaderMaterial extends THREE.MeshPhysicalMaterial {
  private readonly chipBagUniforms: {
    crinkleScale: { value: number };
    crinkleStrength: { value: number };
    roughnessVariation: { value: number };
  };

  constructor({
    crinkleScale = 13,
    crinkleStrength = 0.055,
    roughnessVariation = 0.16,
    ...parameters
  }: MetallicChipBagMaterialParameters = {}) {
    super({
      color: 0xffffff,
      metalness: 0.58,
      roughness: 0.3,
      clearcoat: 0.28,
      clearcoatRoughness: 0.22,
      iridescence: 0.08,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [110, 260],
      anisotropy: 0.2,
      side: THREE.DoubleSide,
      ...parameters,
    });

    this.name = "MetallicChipBagShaderMaterial";
    this.chipBagUniforms = {
      crinkleScale: { value: crinkleScale },
      crinkleStrength: { value: crinkleStrength },
      roughnessVariation: { value: roughnessVariation },
    };
  }

  get crinkleScale() {
    return this.chipBagUniforms.crinkleScale.value;
  }

  set crinkleScale(value: number) {
    this.chipBagUniforms.crinkleScale.value = value;
  }

  get crinkleStrength() {
    return this.chipBagUniforms.crinkleStrength.value;
  }

  set crinkleStrength(value: number) {
    this.chipBagUniforms.crinkleStrength.value = value;
  }

  get roughnessVariation() {
    return this.chipBagUniforms.roughnessVariation.value;
  }

  set roughnessVariation(value: number) {
    this.chipBagUniforms.roughnessVariation.value = value;
  }

  override onBeforeCompile(
    shader: THREE.WebGLProgramParametersWithUniforms,
    renderer: THREE.WebGLRenderer
  ) {
    super.onBeforeCompile(shader, renderer);

    shader.uniforms.chipBagCrinkleScale = this.chipBagUniforms.crinkleScale;
    shader.uniforms.chipBagCrinkleStrength =
      this.chipBagUniforms.crinkleStrength;
    shader.uniforms.chipBagRoughnessVariation =
      this.chipBagUniforms.roughnessVariation;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vChipBagPosition;"
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvChipBagPosition = transformed;"
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${shaderPreamble}`)
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
float chipBagHeightValue = chipBagHeight(vChipBagPosition);
float chipBagRoughnessNoise = 0.5 + 0.5 * sin(chipBagHeightValue * 4.7);
roughnessFactor = clamp(
  roughnessFactor +
    (chipBagRoughnessNoise - 0.5) * chipBagRoughnessVariation,
  0.04,
  1.0
);`
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
normal = chipBagPerturbNormal(
  -vViewPosition,
  normal,
  chipBagHeightValue,
  chipBagCrinkleStrength
);
nonPerturbedNormal = normal;`
      );
  }

  override customProgramCacheKey() {
    return `r3f-jolt-metallic-chip-bag-${SHADER_VERSION}`;
  }

  override copy(source: this): this {
    super.copy(source);
    this.crinkleScale = source.crinkleScale;
    this.crinkleStrength = source.crinkleStrength;
    this.roughnessVariation = source.roughnessVariation;
    return this;
  }
}

export const MetallicChipBagMaterial = React.forwardRef<
  MetallicChipBagShaderMaterial,
  MetallicChipBagMaterialParameters
>((props, forwardedRef) => {
  const material = useMemo(
    () => new MetallicChipBagShaderMaterial(props),
    []
  );

  useImperativeHandle(forwardedRef, () => material, [material]);

  useLayoutEffect(() => {
    const {
      crinkleScale = 13,
      crinkleStrength = 0.055,
      roughnessVariation = 0.16,
      ...parameters
    } = props;
    const hadMap = Boolean(material.map);

    material.setValues(parameters);
    material.crinkleScale = crinkleScale;
    material.crinkleStrength = crinkleStrength;
    material.roughnessVariation = roughnessVariation;

    if (hadMap !== Boolean(material.map)) {
      material.needsUpdate = true;
    }
  }, [material, props]);

  useLayoutEffect(() => () => material.dispose(), [material]);

  return <primitive attach="material" object={material} />;
});

MetallicChipBagMaterial.displayName = "MetallicChipBagMaterial";

import React, { useImperativeHandle, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";

const SHADER_VERSION = "4";

const DEFAULTS = {
  crinkleScale: 9,
  crinkleStrength: 0.08,
  roughnessVariation: 0.25,
  whiteInk: 1,
};

export interface MetallicChipBagMaterialParameters
  extends THREE.MeshPhysicalMaterialParameters {
  /** Wrinkles per UV unit. Larger values give smaller, denser wrinkles. */
  crinkleScale?: number;
  /** Wrinkle depth (normal tilt per unit slope). 0 gives a perfectly smooth film. */
  crinkleStrength?: number;
  /** Extra roughness along the creases, where the metallized layer is scuffed. */
  roughnessVariation?: number;
  /**
   * How strongly near-white areas of `map` are treated as opaque white ink (glossy plastic)
   * instead of colored ink over foil (metal). 0 makes the whole print metallic.
   */
  whiteInk?: number;
}

const shaderPreamble = /* glsl */ `
uniform float chipBagCrinkleScale;
uniform float chipBagCrinkleStrength;
uniform float chipBagRoughnessVariation;
uniform float chipBagWhiteInk;

float chipBagHash(vec2 cell) {
  return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453) * 2.0 - 1.0;
}

// C2-continuous value noise in [-1, 1]. x = value, yz = analytic gradient.
vec3 chipBagNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = chipBagHash(i);
  float b = chipBagHash(i + vec2(1.0, 0.0));
  float c = chipBagHash(i + vec2(0.0, 1.0));
  float d = chipBagHash(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2(k1, k2) + k4 * u.yx));
}

// Wrinkled foil as a smooth height field: soft-ridged noise octaves, so creases are rounded
// folds rather than flat facets. xy = height gradient in crinkle space, z = crease amount.
vec3 chipBagWrinkles(vec2 p, float footprint) {
  vec2 slope = vec2(0.0);
  float crease = 0.0;
  float amplitude = 1.0;
  mat2 frame = mat2(1.0);
  const mat2 octaveRotation = mat2(1.6, 1.2, -1.2, 1.6); // rotate ~37deg, scale 2x
  for (int octave = 0; octave < 4; octave++) {
    vec3 n = chipBagNoise(frame * p + float(octave) * 7.13);
    float frequency = exp2(float(octave));
    // Fade each octave out before it gets smaller than a pixel, to avoid shimmer.
    float detail = 1.0 - smoothstep(0.3, 0.8, footprint * frequency);
    // |n| softened: a rounded ridge where the noise crosses zero.
    float ridge = sqrt(n.x * n.x + 0.015);
    slope += amplitude * detail * (n.x / ridge) * (n.yz * frame);
    crease = max(crease, detail * amplitude * (1.0 - smoothstep(0.0, 0.25, abs(n.x))));
    amplitude *= 0.42;
    frame = octaveRotation * frame;
  }
  return vec3(slope, crease);
}
`;

/**
 * MeshPhysicalMaterial for a printed, metallized snack bag: colored inks over aluminium read as
 * metal, opaque white ink as glossy plastic, under a clear gloss film. Wrinkles are a smooth,
 * soft-ridged height field fixed to the UVs, so they travel with the film as the soft body deforms.
 * It keeps the stock Three.js PBR pipeline, so maps, lights, shadows, tone mapping and IBL work.
 */
export class MetallicChipBagShaderMaterial extends THREE.MeshPhysicalMaterial {
  private readonly chipBagUniforms: {
    crinkleScale: { value: number };
    crinkleStrength: { value: number };
    roughnessVariation: { value: number };
    whiteInk: { value: number };
  };

  constructor({
    crinkleScale = DEFAULTS.crinkleScale,
    crinkleStrength = DEFAULTS.crinkleStrength,
    roughnessVariation = DEFAULTS.roughnessVariation,
    whiteInk = DEFAULTS.whiteInk,
    ...parameters
  }: MetallicChipBagMaterialParameters = {}) {
    super({
      color: 0xffffff,
      metalness: 1,
      roughness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      side: THREE.DoubleSide,
      ...parameters,
    });

    this.name = "MetallicChipBagShaderMaterial";
    // Crumples live in UV space, so the UV varying is needed even without a map.
    this.defines = { ...this.defines, USE_UV: "" };
    this.chipBagUniforms = {
      crinkleScale: { value: crinkleScale },
      crinkleStrength: { value: crinkleStrength },
      roughnessVariation: { value: roughnessVariation },
      whiteInk: { value: whiteInk },
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

  get whiteInk() {
    return this.chipBagUniforms.whiteInk.value;
  }

  set whiteInk(value: number) {
    this.chipBagUniforms.whiteInk.value = value;
  }

  override onBeforeCompile(
    shader: THREE.WebGLProgramParametersWithUniforms,
    renderer: THREE.WebGLRenderer
  ) {
    super.onBeforeCompile(shader, renderer);

    shader.uniforms.chipBagCrinkleScale = this.chipBagUniforms.crinkleScale;
    shader.uniforms.chipBagCrinkleStrength = this.chipBagUniforms.crinkleStrength;
    shader.uniforms.chipBagRoughnessVariation = this.chipBagUniforms.roughnessVariation;
    shader.uniforms.chipBagWhiteInk = this.chipBagUniforms.whiteInk;

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${shaderPreamble}`)
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
vec2 chipBagCell = vUv * chipBagCrinkleScale;
vec2 chipBagFootprint = fwidth(chipBagCell);
vec3 chipBagSurface = chipBagWrinkles(chipBagCell, max(chipBagFootprint.x, chipBagFootprint.y));
vec2 chipBagSlope = chipBagSurface.xy;
roughnessFactor = clamp(roughnessFactor + chipBagSurface.z * chipBagRoughnessVariation, 0.04, 1.0);`
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `#include <metalnessmap_fragment>
#ifdef USE_MAP
// Opaque white ink hides the foil; colored inks are translucent over it.
float chipBagLow = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
float chipBagHigh = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
float chipBagWhite = smoothstep(0.45, 0.75, chipBagLow) * (1.0 - smoothstep(0.08, 0.2, chipBagHigh - chipBagLow));
metalnessFactor *= 1.0 - chipBagWhite * chipBagWhiteInk;
#endif`
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  // Cotangent frame from screen derivatives (no tangent attribute needed).
  vec3 dp1 = dFdx(-vViewPosition);
  vec3 dp2 = dFdy(-vViewPosition);
  vec2 duv1 = dFdx(vUv);
  vec2 duv2 = dFdy(vUv);
  vec3 dp2perp = cross(dp2, normal);
  vec3 dp1perp = cross(normal, dp1);
  vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;
  // Normalize each axis on its own: the screen-space frame is constant per triangle, and a
  // shared scale lets its length jump at triangle edges, which shows up as faceting.
  tangent -= normal * dot(normal, tangent);
  bitangent -= normal * dot(normal, bitangent);
  if (dot(tangent, tangent) > 1e-20 && dot(bitangent, bitangent) > 1e-20) {
    vec2 tilt = chipBagSlope * chipBagCrinkleStrength;
    normal = normalize(normal - tilt.x * normalize(tangent) - tilt.y * normalize(bitangent));
  }
}
// The clear film is wrinkled with the foil, so its highlights follow the wrinkles too.
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
    this.whiteInk = source.whiteInk;
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
      crinkleScale = DEFAULTS.crinkleScale,
      crinkleStrength = DEFAULTS.crinkleStrength,
      roughnessVariation = DEFAULTS.roughnessVariation,
      whiteInk = DEFAULTS.whiteInk,
      ...parameters
    } = props;
    const hadMap = Boolean(material.map);

    material.setValues(parameters);
    material.crinkleScale = crinkleScale;
    material.crinkleStrength = crinkleStrength;
    material.roughnessVariation = roughnessVariation;
    material.whiteInk = whiteInk;

    if (hadMap !== Boolean(material.map)) {
      material.needsUpdate = true;
    }
  }, [material, props]);

  useLayoutEffect(() => () => material.dispose(), [material]);

  return <primitive attach="material" object={material} />;
});

MetallicChipBagMaterial.displayName = "MetallicChipBagMaterial";

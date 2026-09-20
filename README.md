# r3f-jolt

React Three Fiber bindings for Jolt Physics with rigid bodies, deformable soft
bodies, custom triangle meshes, and shader-ready rendering.

## Soft Bodies

`SoftBody` can render a procedural sphere, cloth, cube, or any indexed or
non-indexed `BufferGeometry`. UV seams are preserved for rendering while
coincident positions are welded for simulation.

```tsx
import { SoftBody, MetallicChipBagMaterial } from "r3f-jolt";

<SoftBody
  geometry={bagGeometry}
  position={[0, 8, 0]}
  pressure={40}
  iterations={12}
  friction={0.8}
  castShadow
>
  <MetallicChipBagMaterial map={bagColorMap} />
</SoftBody>
```

Custom materials are first-class. Pass any `THREE.Material` through the
`material` prop, attach an R3F material as a child, or use a shader component.
The forwarded ref points to the rendered `THREE.Mesh`, so uniforms and render
state remain accessible without a wrapper object.

```tsx
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader,
  fragmentShader,
});

<SoftBody material={material} updateNormals={false} />;
```

`updateNormals` defaults to `true` for smooth PBR lighting. Set it to `false`
when a shader derives normals from screen-space derivatives or does not consume
normals; this skips the CPU normal pass and one dynamic GPU buffer upload.

## Stable Stepping

`PhysicsProvider` uses a fixed-step accumulator and crosses the JS/WASM boundary
once per rendered frame, including catch-up frames.

```tsx
<PhysicsProvider
  gravity={[0, -9.81, 0]}
  timeStep={1 / 60}
  maxSubSteps={4}
  maxDelta={0.1}
>
  {children}
</PhysicsProvider>
```

The metallic bag material extends Three.js `MeshPhysicalMaterial`, retaining
maps, direct lighting, image-based lighting, shadows, tone mapping, and color
management while adding procedural foil crinkles and roughness variation.

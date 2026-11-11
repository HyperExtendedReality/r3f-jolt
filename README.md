# JoltFoundry (`r3f-jolt`)

React Three Fiber bindings for Jolt Physics: rigid bodies, XPBD soft bodies, contained rigid items, impact fractured meshes, and tearable cloth. The package import remains `r3f-jolt`.

## Install

```bash
npm i r3f-jolt jolt-physics three @react-three/fiber react
```

`jolt-physics`, `three`, `@react-three/fiber` and `react` are peer dependencies, so your app owns exactly one copy of each. Two copies of Jolt mean two WASM heaps, and objects from one crash the other.

## Quick start

```tsx
import { Canvas } from "@react-three/fiber";
import { PhysicsProvider, RigidBody, SoftBody } from "r3f-jolt";

export function Scene() {
  return (
    <Canvas camera={{ position: [0, 3, 8] }}>
      <ambientLight />
      <directionalLight position={[5, 10, 5]} />
      <PhysicsProvider gravity={[0, -9.81, 0]}>
        {/* motionType 0 = Jolt EMotionType_Static */}
        <RigidBody type="Box" args={[20, 1, 20]} position={[0, -0.5, 0]} motionType={0}>
          <mesh><boxGeometry args={[20, 1, 20]} /><meshStandardMaterial /></mesh>
        </RigidBody>
        <RigidBody type="Box" args={[1, 1, 1]} position={[-1.5, 4, 0]}>
          <mesh><boxGeometry /><meshStandardMaterial color="orange" /></mesh>
        </RigidBody>
        <SoftBody type="Sphere" position={[1.5, 4, 0]} physicsMaterial="slime">
          <meshStandardMaterial color="hotpink" />
        </SoftBody>
      </PhysicsProvider>
    </Canvas>
  );
}
```

`PhysicsProvider` renders its children only after the Jolt WASM module has loaded, so bodies never see a missing world. Without `type`/`args`, a `RigidBody` builds its shape from its first child mesh, including that mesh's scale and offset for `convex` and `trimesh`.

## Choosing a Jolt build

By default the provider loads `jolt-physics/wasm-compat` (WASM inlined as base64, works everywhere, largest download). Pass `init` to pick another build:

```tsx
// Smaller and faster to load; the .wasm file is served by your bundler.
<PhysicsProvider init={() => import("jolt-physics/wasm").then((m) => m.default())}>

// Multithreaded; the page must be cross-origin isolated (see below).
<PhysicsProvider init={() => import("jolt-physics/wasm-multithread").then((m) => m.default())}>
```

The multithreaded build needs `SharedArrayBuffer`, so the server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (this repo's `vite.config.ts` does). Jolt is loaded once per page: the first provider to load it decides the build.

## Using it in another project without publishing

Build the library first. `dist/` holds the ESM (`index.mjs`), CommonJS (`index.js`) and type (`index.d.ts`) bundles; React, three, R3F and Jolt are left as imports for the app to supply.

```bash
npm install
npm run build:lib   # or `npm run build` to also typecheck and build the demo
npm test            # optional: physics checks against the built dist
```

Then install it into the other project with one of these methods:

- **Tarball (recommended):** run `npm pack` here, then `npm i ../r3f-jolt/r3f-jolt-1.0.0.tgz` in the app. This installs exactly what would be published. Repack and reinstall after each change.
- **Git URL:** `npm i github:HyperExtendedReality/r3f-jolt`. Works because the `prepare` script builds `dist` on install.
- **`npm link`:** avoid unless you need live edits. The linked folder brings its own `node_modules`, so the app ends up with two copies of React and three (invalid hook calls, `instanceof` failures). In Vite, fix it with `resolve: { dedupe: ["react", "react-dom", "three", "@react-three/fiber", "jolt-physics"] }`.

In the app, install the peer dependencies too (`npm i jolt-physics three @react-three/fiber react react-dom`) and import from `r3f-jolt` as in the quick start. Both ESM bundlers (Vite, webpack, Next.js) and CommonJS `require` resolve through the package `exports`. If you use the multithreaded Jolt build, the app's server needs the COOP/COEP headers described above.

## Publishing to npm

1. Check the name is free: `npm view r3f-jolt` (a 404 means it is available; otherwise rename or use a scope such as `@you/r3f-jolt`).
2. Fill `author` in `package.json` and add a `LICENSE` file matching the `license` field.
3. `npm login`.
4. `npm version patch` (or `minor` / `major`) to bump the version and create a git tag.
5. `npm publish --dry-run` and read the file list: it should contain only `dist`, `README.md` and `package.json`.
6. `npm publish` (add `--access public` for a scoped name). `prepublishOnly` runs the build and tests first.
7. `git push --follow-tags`.

## Soft body materials

`physicsMaterial` controls the solver independently of the Three.js visual `material`. Presets are starting points for metre, kilogram, second scenes; tune compliance and gas amount for your mesh scale. A component's explicit props and `config` take precedence over the preset.

```tsx
import { SoftBody, softBodyMaterials } from "r3f-jolt";

<SoftBody geometry={sealedBag} physicsMaterial="chipBagInflated">
  <meshPhysicalMaterial color="#e9ba36" metalness={0.8} />
</SoftBody>

<SoftBody geometry={openBag} physicsMaterial="chipBagDeflated" />

<SoftBody
  type="Cube"
  physicsMaterial={{ ...softBodyMaterials.slime, restitution: 0.85 }}
  config={{ gridSize: 6, gridSpacing: 0.25 }}
/>
```

Compliance is inverse stiffness in Jolt's XPBD constraints: smaller values stretch or bend less. `inverseMass` controls particle mass, `volumeCompliance` controls the tetrahedra of solid cubes, `friction` and `restitution` control contacts, and `linearDamping` dissipates motion. `pressure` is Jolt's gas quantity `nRT`, so it acts only on a sealed shell. Positive pressure on a custom open or inconsistently wound mesh logs a descriptive error and the body is simulated without pressure. Oppositely wound duplicate faces (zero-thickness walls) are removed before the check. Seams where two sheets pinch together along one edge (as in the bundled bag asset) still count as sealed, so the same bag model works deflated and inflated.

Custom geometry can be indexed or nonindexed. Coincident render vertices are welded for simulation while UV seams remain separate for rendering. Faces are oriented outward for pressure. The solver settings remain alive until their body is removed.

## Metallic chip bag material

`MetallicChipBagMaterial` is a `MeshPhysicalMaterial` for printed foil packaging: colored ink over aluminium renders as metal, white ink as glossy plastic, all under a clear gloss coat. Fine wrinkles come from a smooth, soft-ridged height field in UV space, so they move with the film as the soft body deforms and show no flat facets. It accepts every `MeshPhysicalMaterial` prop, plus:

| Prop | Default | Effect |
| --- | --- | --- |
| `crinkleScale` | `9` | Wrinkles per UV unit; higher means smaller, denser wrinkles. |
| `crinkleStrength` | `0.08` | Wrinkle depth; `0` gives a perfectly smooth film. |
| `roughnessVariation` | `0.25` | Extra roughness along the wrinkle ridges. |
| `whiteInk` | `1` | How strongly near-white texels in `map` become non-metallic; `0` makes the whole print metal. |

```tsx
import { SoftBody, MetallicChipBagMaterial } from "r3f-jolt";

<SoftBody geometry={bagGeometry} physicsMaterial="chipBagInflated">
  <MetallicChipBagMaterial map={bagTexture} crinkleStrength={0.1} />
</SoftBody>
```

The mesh needs UVs. Metal reflects its surroundings, so add an environment map (for example drei's `<Environment preset="city" />`) or the foil looks dark. For plain Three.js, use the `MetallicChipBagShaderMaterial` class directly.

## Items inside a soft body

Use separate sibling bodies and pass the soft body's mesh ref to each item. The container must be a sealed, consistently wound mesh. `containmentRadius` is a sphere enclosing the contained item; give it a value large enough to cover its collision shape.

```tsx
const bag = useRef<THREE.Mesh>(null);

<SoftBody ref={bag} geometry={sealedBag} physicsMaterial="chipBagInflated" />
<RigidBody
  type="Sphere"
  args={[0.12]}
  position={[0, 1, 0]}
  containedBy={bag}
  containmentRadius={0.12}
  mass={0.02}
>
  <mesh><sphereGeometry args={[0.12]} /><meshStandardMaterial color="gold" /></mesh>
</RigidBody>
```

After each Jolt step, the item is projected inside the current deformed surface and its outward velocity is reflected. Items remain regular Jolt rigid bodies, including their collisions with each other. This is a discrete, sphere based boundary constraint; very fast items and sharp or strongly concave containers may need smaller time steps or an authored interior collision proxy. Each container keeps a spatial grid of its physics triangles, rebuilt once per fixed step, so an item only tests the triangles near it; the inside test uses angle-weighted pseudonormals and needs a sealed, manifold container.

## Breakable bodies

`BreakableBody` precomputes convex fragments and replaces a rigid body when its approximate impact impulse passes `breakingImpulse`. Fragment masses follow their volumes, and their initial linear and angular motion follows the original body. Its ref also has a `fracture()` method for scripted destruction.

```tsx
<BreakableBody
  geometry={closedConvexGeometry}
  material={stoneMaterial}
  mass={3}
  breakingImpulse={12}
  pieces={10}
/>

// For a concave or textured asset, supply closed shard meshes in object coordinates:
<BreakableBody geometry={vase} shards={precutVasePieces} material={vaseMaterial} />
```

Automatic cutting supports sealed convex meshes. For concave meshes or an exact art directed crack pattern, supply prefractured `shards`. Generated cuts produce new convex faces without texture UVs; authored shards can include interior UVs. Impact detection estimates impulse from rigid body velocity change and gravity, so thresholds are scene dependent.

## Tearable cloth and open surfaces

`TearableSoftBody` cuts the current deformed surface along a plane, then rebuilds each side as an independent Jolt soft body. It can tear when a simulated edge exceeds `tearStrain`, or through its ref for a scripted cut. UVs are interpolated across the cut. Each new piece starts with the original body's average velocity.

```tsx
const clothRef = useRef<TearableSoftBodyHandle>(null);

<TearableSoftBody
  ref={clothRef}
  geometry={new THREE.PlaneGeometry(2, 2, 16, 16)}
  tearStrain={1.8}
  maxTears={3}
  material={clothMaterial}
/>

clothRef.current?.tear(new THREE.Plane(new THREE.Vector3(1, 0, 0), 0));
```

This supports open surfaces; cutting a sealed, inflated shell would also require a cap and gas loss model. Jolt's shared constraint graph cannot be edited during a step, so tearing replaces the body and recreates its constraints. Per particle momentum is approximated by average velocity at the split. Separated pieces collide with each other through the provider's soft-vs-soft collision.

## Stepping and validation

`PhysicsProvider` uses fixed steps (`timeStep`, `maxSubSteps`, `maxDelta`) and draws every body between its last two steps (`interpolate`, on by default), so motion stays smooth at any frame rate at the cost of up to one step of visual latency. Run `npm run build` and `npm test` to check TypeScript, the demo bundle, topology, pressure body lifetime, containment, surface queries, soft-vs-soft collision, fracture volume, and surface cuts.

## Soft-vs-soft collision

Jolt collides soft bodies with rigid bodies but not with each other. After every fixed step the provider pushes each soft body's vertices out of every other soft body it overlaps, splitting the correction by vertex mass and removing the approaching velocity. Closed shells use an inside test; open surfaces such as cloth keep a `softBodyThickness` gap (default 2 cm, or the sum of the bodies' `vertexRadius` if larger). Turn it off with `<PhysicsProvider softBodyCollisions={false}>`.

It is discrete: a vertex that crosses a thin open surface within a single step is not caught, so for fast cloth use a smaller `timeStep` or a larger `softBodyThickness`. Soft bodies do not collide with themselves.

## Performance notes

- Sleeping rigid and soft bodies skip their per-frame sync. Contained items keep checking, since their container may move.
- Soft body normals are rebuilt once per fixed step, not per frame, and only when the material reads them (not `MeshBasicMaterial`, `flatShading`, or a `ShaderMaterial` that ignores `normal`). Pass `updateNormals` to force either way.
- Soft-vs-soft collision costs one grid query per vertex of each overlapping pair; bodies whose bounds do not overlap cost nothing.
- The published Jolt builds use a fixed-size WASM heap, so a very large scene fails with an out-of-memory abort rather than growing; split it up or build Jolt with a larger heap and pass it through `init`.

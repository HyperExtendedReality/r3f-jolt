import type Jolt from 'jolt-physics';

let joltPromise: Promise<typeof Jolt> | null = null;

/**
 * Loads Jolt once. The first caller's `init` wins; later calls share that module.
 * Defaults to the self-contained `jolt-physics/wasm-compat` build.
 */
export const getJolt = (init?: () => Promise<typeof Jolt>) => {
  joltPromise ??= (init ?? (async () => (await import('jolt-physics/wasm-compat')).default()))();
  return joltPromise;
};

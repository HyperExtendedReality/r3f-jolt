import initJolt from 'jolt-physics/wasm-compat';
import type Jolt from 'jolt-physics';

let joltInstance: typeof Jolt | null = null;
let joltPromise: Promise<typeof Jolt> | null = null;

export const getJolt = async () => {
  if (joltInstance) return joltInstance;
  if (!joltPromise) {
    joltPromise = initJolt().then((module: typeof Jolt) => {
      joltInstance = module;
      return module;
    });
  }
  return joltPromise;
};

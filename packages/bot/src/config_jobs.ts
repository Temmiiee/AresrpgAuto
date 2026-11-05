/** Gathering jobs live in their own dependency-free module so specialized profiles can consume the
 * vocabulary without importing the process-wide frozen config (which would create a cycle). */
export const GATHERING_JOBS = Object.freeze(['FARMER', 'HERBALIST', 'MINER'] as const)

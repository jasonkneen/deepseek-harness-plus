/**
 * Build-time packer for the browser runtime's VFS image.
 * @module @deepseek-ai/dsh-experimental-webworker-packer
 */
export {
  WRAPPER_CONTRACT,
  type ImageFiles, type TransformOutcome,
} from './transform-image.ts'
export {
  CONFIG_PATH, DEFAULT_ROOT, MANIFEST_PATH, packVfsImage,
  type ConfigTree, type PackOptions, type PackResult,
} from './pack.ts'
export {
  composeProfile, configTrees, describePack, indexWorkspacePackages,
} from './repository.ts'

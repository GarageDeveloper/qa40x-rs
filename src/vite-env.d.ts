/// <reference types="vite/client" />

/** package.json version, injected by both Vite configs' `define` (issue
 * #30 export provenance). Guarded with `typeof` at the use site so plain
 * vitest/tsc runs without the define keep working. */
declare const __APP_VERSION__: string;

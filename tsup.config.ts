import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    splitting: false,
    shims: false,
  },
  {
    entry: { cli: 'src/cli/bin.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node18',
    splitting: false,
    shims: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);

// Bundle the Worker (src/index.ts) for the tests, with the Neon driver replaced by the PGlite shim.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, '..', 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: path.join(here, '.build', 'worker.mjs'),
  alias: { '@neondatabase/serverless': path.join(here, 'neon-shim.mjs') },
  logLevel: 'warning',
});

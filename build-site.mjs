// Assemble the publishable OpenSourceGraph site into ./dist:
//   dist/index.html, app.js, styles.css   (from src/)
//   dist/data/...                          (the baked JSON)
// Used for local preview; CI assembles the same layout under _site/opensourcegraph/.

import { cp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = join(HERE, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(HERE, 'src'), dist, { recursive: true });
await cp(join(HERE, 'data'), join(dist, 'data'), { recursive: true });
console.log(`Built site → ${dist}`);

import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const binPath = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));

await chmod(binPath, 0o755);

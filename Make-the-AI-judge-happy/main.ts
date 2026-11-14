import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

// ai-happy-01 entry: writes happy image to /output/entry.png
copyFileSync(new URL('./entry.png', import.meta.url), join(process.env.MAKEFUN_OUTPUT_DIR ?? '/output', 'entry.png'));

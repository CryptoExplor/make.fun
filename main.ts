import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Entrypoint for make.fun competition "ai-happy-01" (Make the AI judge happy)
// Runs standard Node 22 runtime to emit the happy image to /output/entry.png

const subfolderImage = new URL('./Make the AI judge happy/entry.png', import.meta.url);
const rootImage = new URL('./entry.png', import.meta.url);
const sourceImage = existsSync(subfolderImage) ? subfolderImage : rootImage;
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

copyFileSync(sourceImage, join(outputDir, 'entry.png'));


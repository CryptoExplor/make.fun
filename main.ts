import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runForecaster } from './polymarket-faa-attribution-02/forecaster.ts';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// 1. If input directory has .in files, execute polymarket-faa-attribution-02 forecaster
if (existsSync(inputDir)) {
  const inFiles = readdirSync(inputDir).filter((f) => f.endsWith('.in'));
  if (inFiles.length > 0) {
    runForecaster(inputDir, outputDir);
  }
}

// 2. If visual bounty entry image exists, ensure /output/entry.png is produced
const subfolderImage = new URL('./Make-the-AI-judge-happy/entry.png', import.meta.url);
const rootImage = new URL('./entry.png', import.meta.url);
const sourceImage = existsSync(subfolderImage) ? subfolderImage : (existsSync(rootImage) ? rootImage : null);

if (sourceImage) {
  try {
    copyFileSync(sourceImage, join(outputDir, 'entry.png'));
  } catch {
    // Ignore error if sandbox prohibits image write during program bounties
  }
}

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 1. If invoked with --list or within a model aggregator trial environment
if (process.argv.includes('--list') || process.env.MAKEFUN_PROMPT_FILE || process.env.MAKEFUN_ENV_URL) {
  const { runServer } = await import('./free-model-aggregator-01/main.ts');
  await runServer();
} else {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 2. If input directory has .in files, execute polymarket-faa-attribution-02 forecaster
  if (existsSync(inputDir)) {
    const inFiles = readdirSync(inputDir).filter((f) => f.endsWith('.in'));
    if (inFiles.length > 0) {
      const { runForecaster } = await import('./polymarket-faa-attribution-02/forecaster.ts');
      runForecaster(inputDir, outputDir);
    }
  }

  // 3. If visual bounty entry image exists, ensure /output/entry.png is produced
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
}


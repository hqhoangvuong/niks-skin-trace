import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

function findTestFiles(dir, suffix = '.test.ts', acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findTestFiles(full, suffix, acc);
    } else if (entry.name.endsWith(suffix)) {
      acc.push(full);
    }
  }
  return acc;
}

const outDir = '/tmp/skin-trace-tests';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const testFiles = findTestFiles('src', '.test.ts');
const scriptTestFiles = findTestFiles('scripts', '.test.mjs');
if (testFiles.length === 0 && scriptTestFiles.length === 0) {
  console.error('No test files found under src/ or scripts/');
  process.exit(1);
}

const compiled = [];
for (const file of testFiles) {
  const rel = relative('src', file).replace(/\.ts$/, '.mjs');
  const outFile = join(outDir, rel);
  buildSync({
    entryPoints: [file],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: outFile,
  });
  compiled.push(outFile);
}

execFileSync(process.execPath, ['--test', ...compiled, ...scriptTestFiles], { stdio: 'inherit' });

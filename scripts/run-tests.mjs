import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

function findTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findTestFiles(full, acc);
    } else if (entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const outDir = '/tmp/skin-trace-tests';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const testFiles = findTestFiles('src');
if (testFiles.length === 0) {
  console.error('No *.test.ts files found under src/');
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

execFileSync(process.execPath, ['--test', ...compiled], { stdio: 'inherit' });

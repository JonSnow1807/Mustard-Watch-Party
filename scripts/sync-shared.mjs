#!/usr/bin/env node
// Mirrors /shared (the canonical sync core) into both packages:
//   video-sync-backend/src/shared/   (specs included -> jest runs them)
//   video-sync-frontend/src/shared/  (specs excluded -> no jsdom double-run)
//
// Why copies instead of a workspace: CRA's ModuleScopePlugin forbids imports
// from outside src/, and symlink transpilation is CRA-hostile. A checked-in
// copy is boring and honest; --check keeps it from drifting in CI.
//
// Usage: node scripts/sync-shared.mjs [--check]

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'shared');
const HEADER = `// GENERATED FILE — do not edit here.
// Canonical source: /shared/. Regenerate: node scripts/sync-shared.mjs
`;

const targets = [
  { dest: join(root, 'video-sync-backend', 'src', 'shared'), includeSpecs: true },
  { dest: join(root, 'video-sync-frontend', 'src', 'shared'), includeSpecs: false },
];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function expected(target) {
  const files = new Map();
  for (const file of listFiles(SRC)) {
    const rel = relative(SRC, file);
    if (!target.includeSpecs && rel.endsWith('.spec.ts')) continue;
    files.set(rel, HEADER + readFileSync(file, 'utf8'));
  }
  return files;
}

const check = process.argv.includes('--check');
let dirty = false;

for (const target of targets) {
  const files = expected(target);
  if (check) {
    for (const [rel, content] of files) {
      const p = join(target.dest, rel);
      if (!existsSync(p) || readFileSync(p, 'utf8') !== content) {
        console.error(`stale copy: ${relative(root, p)}`);
        dirty = true;
      }
    }
    if (existsSync(target.dest)) {
      for (const file of listFiles(target.dest)) {
        const rel = relative(target.dest, file);
        if (!files.has(rel)) {
          console.error(`orphan copy: ${relative(root, file)}`);
          dirty = true;
        }
      }
    }
  } else {
    rmSync(target.dest, { recursive: true, force: true });
    for (const [rel, content] of files) {
      const p = join(target.dest, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    console.log(`synced ${files.size} files -> ${relative(root, target.dest)}`);
  }
}

if (check) {
  if (dirty) {
    console.error('\nshared copies are stale. Run: node scripts/sync-shared.mjs');
    process.exit(1);
  }
  console.log('shared copies are up to date');
}

// convenience: content hash for quick eyeballing in logs
const all = listFiles(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');
console.log(`shared content sha1: ${createHash('sha1').update(all).digest('hex').slice(0, 12)}`);

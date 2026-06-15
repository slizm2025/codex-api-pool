#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarioPath = path.join(repoRoot, 'test', 'real-world-scenarios.test.mjs');
const source = readFileSync(scenarioPath, 'utf8');

const declared = [...source.matchAll(/^\/\/\s+S(\d+)\s+/gm)].map((match) => `S${match[1]}`);
const implemented = [...source.matchAll(/^console\.log\('\\n(S\d+):/gm)].map((match) => match[1]);

const missing = declared.filter((scenario) => !implemented.includes(scenario));
const extra = implemented.filter((scenario) => !declared.includes(scenario));
const orderMatches = declared.length === implemented.length && declared.every((scenario, index) => implemented[index] === scenario);

if (missing.length || extra.length || !orderMatches) {
  if (missing.length) console.error(`missing implemented scenarios: ${missing.join(', ')}`);
  if (extra.length) console.error(`implemented but undeclared scenarios: ${extra.join(', ')}`);
  if (!orderMatches) {
    console.error(`scenario order mismatch: declared ${declared.join(', ')}; implemented ${implemented.join(', ')}`);
  }
  process.exit(1);
}

console.log(`real-world scenario manifest ok: ${implemented.join(', ')}`);

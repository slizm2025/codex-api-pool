#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const serverCode = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');

assert(
  !serverCode.includes('not a Discovered Model on any available Upstream'),
  'dashboard must not describe Discovered Models as a hard Model Override gate'
);

assert(
  !serverCode.includes('excluded by Model Override'),
  'dashboard must not say available upstreams are excluded only because model discovery is stale'
);

assert(
  serverCode.includes('Discovered Models are advisory'),
  'dashboard should tell operators that Discovered Models are advisory evidence'
);

console.log('dashboard model discovery advisory diagnostics passed');

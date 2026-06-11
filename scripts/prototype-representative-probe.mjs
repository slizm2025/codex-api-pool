#!/usr/bin/env node
// PROTOTYPE - throwaway terminal driver for representative model probing.
//
// Question: can a short-lived in-memory template captured from real Codex
// traffic make the dashboard Test action avoid false availability judgements?

import readline from 'node:readline';
import {
  advanceTime,
  captureRepresentativeTemplate,
  createInitialState,
  displayState,
  realCodexRequestFixture,
  runRepresentativeProbe,
  runSyntheticProbe
} from './prototype-representative-probe.logic.mjs';

const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function render(state) {
  clear();
  console.log(`${bold}Representative Model Probe Prototype${reset}`);
  console.log(`${dim}Throwaway prototype. No persistence. Fake any-like upstream requires real Codex context.${reset}\n`);
  console.log(JSON.stringify(displayState(state), null, 2));
  console.log('');
  console.log(`${bold}s${reset} ${dim}synthetic probe${reset}  ${bold}c${reset} ${dim}capture real Codex template${reset}  ${bold}r${reset} ${dim}representative probe${reset}`);
  console.log(`${bold}t${reset} ${dim}advance 5 min${reset}  ${bold}x${reset} ${dim}expire template${reset}  ${bold}d${reset} ${dim}run demo sequence${reset}  ${bold}q${reset} ${dim}quit${reset}`);
}

function demoFrames() {
  let state = createInitialState();
  const frames = [];
  const step = (label, next) => {
    state = next(state);
    frames.push({ label, state: displayState(state) });
  };
  step('1. Synthetic Health Probe against any-like upstream', runSyntheticProbe);
  step('2. Capture a real Codex request template in memory', (current) => (
    captureRepresentativeTemplate(current, realCodexRequestFixture())
  ));
  step('3. Representative Model Probe reuses the template shape', runRepresentativeProbe);
  step('4. Advance past TTL', (current) => advanceTime(current, current.ttlMs + 1));
  step('5. Representative Model Probe after expiry is blocked', runRepresentativeProbe);
  return frames;
}

function printDemo() {
  console.log(`${bold}Representative Model Probe Prototype Demo${reset}`);
  for (const frame of demoFrames()) {
    console.log(`\n${bold}${frame.label}${reset}`);
    console.log(JSON.stringify(frame.state, null, 2));
  }
}

if (process.argv.includes('--demo')) {
  printDemo();
  process.exit(0);
}

let state = createInitialState();
render(state);

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on('keypress', (_str, key) => {
  if (key?.name === 'q' || (key?.ctrl && key?.name === 'c')) {
    clear();
    process.exit(0);
  }
  if (key?.name === 's') state = runSyntheticProbe(state);
  if (key?.name === 'c') state = captureRepresentativeTemplate(state, realCodexRequestFixture());
  if (key?.name === 'r') state = runRepresentativeProbe(state);
  if (key?.name === 't') state = advanceTime(state, 5 * 60 * 1000);
  if (key?.name === 'x') state = advanceTime(state, state.ttlMs + 1);
  if (key?.name === 'd') {
    clear();
    printDemo();
    console.log(`\n${dim}Press any key to return to the interactive prototype.${reset}`);
    process.stdin.once('keypress', () => render(state));
    return;
  }
  render(state);
});

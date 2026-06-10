import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_LABEL = 'com.slizm.codex-api-pool';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config.local.json');
const DEFAULT_PLIST_DIR = path.join(homedir(), 'Library', 'LaunchAgents');

function usage() {
  return [
    'Usage: npm run service -- <command> [options]',
    '',
    'Commands:',
    '  install    Write the LaunchAgent plist, load it, and start the service',
    '  uninstall  Stop the service and remove the LaunchAgent plist',
    '  start      Load the LaunchAgent if needed and start the service',
    '  stop       Stop the loaded LaunchAgent without deleting the plist',
    '  restart    Reload the LaunchAgent command and restart the service',
    '  status     Show launchd state and /health result',
    '  plist      Print the generated plist XML',
    '',
    'Options:',
    '  --label <label>       LaunchAgent label',
    '  --config <path>       Pool configuration path',
    '  --node <path>         Node executable path',
    '  --plist-dir <path>    LaunchAgents directory',
    '  --no-start            With install, only write the plist; do not load or start'
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    command: 'status',
    label: process.env.CODEX_POOL_SERVICE_LABEL || SERVICE_LABEL,
    configPath: process.env.CODEX_POOL_CONFIG || DEFAULT_CONFIG_PATH,
    nodePath: process.env.CODEX_POOL_SERVICE_NODE || process.execPath,
    plistDir: process.env.CODEX_POOL_SERVICE_PLIST_DIR || DEFAULT_PLIST_DIR,
    start: true
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else if (arg === '--label') {
      options.label = requiredValue(argv, ++i, arg);
    } else if (arg === '--config') {
      options.configPath = requiredValue(argv, ++i, arg);
    } else if (arg === '--node') {
      options.nodePath = requiredValue(argv, ++i, arg);
    } else if (arg === '--plist-dir') {
      options.plistDir = requiredValue(argv, ++i, arg);
    } else if (arg === '--no-start') {
      options.start = false;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length) options.command = positional[0];
  options.configPath = path.resolve(options.configPath);
  options.nodePath = path.resolve(options.nodePath);
  options.plistDir = path.resolve(options.plistDir);
  options.plistPath = path.join(options.plistDir, `${options.label}.plist`);
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function serviceCommand(options) {
  const serverPath = path.join(REPO_ROOT, 'src', 'server.mjs');
  const sourceProfile = 'if [ -f "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi';
  return [
    sourceProfile,
    `exec ${shellQuote(options.nodePath)} ${shellQuote(serverPath)} ${shellQuote(options.configPath)}`
  ].join('; ');
}

export function renderPlist(options) {
  const command = serviceCommand(options);
  const outLog = path.join(REPO_ROOT, 'pool.out.log');
  const errLog = path.join(REPO_ROOT, 'pool.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_POOL_CONFIG</key>
    <string>${xmlEscape(options.configPath)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

function ensureInputs(options) {
  const serverPath = path.join(REPO_ROOT, 'src', 'server.mjs');
  if (!existsSync(options.nodePath)) throw new Error(`node executable not found: ${options.nodePath}`);
  if (!existsSync(serverPath)) throw new Error(`server entry not found: ${serverPath}`);
  if (!existsSync(options.configPath)) throw new Error(`config file not found: ${options.configPath}`);
}

function writePlist(options) {
  ensureInputs(options);
  mkdirSync(options.plistDir, { recursive: true });
  writeFileSync(options.plistPath, renderPlist(options));
  console.log(`[service] wrote ${options.plistPath}`);
}

function uid() {
  if (typeof process.getuid !== 'function') throw new Error('launchd user services require process.getuid()');
  return process.getuid();
}

function domainTarget() {
  return `gui/${uid()}`;
}

function serviceTarget(options) {
  return `${domainTarget()}/${options.label}`;
}

function runLaunchctl(args, options = {}) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`launchctl ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

function isLoaded(options) {
  const result = spawnSync('launchctl', ['print', serviceTarget(options)], { encoding: 'utf8' });
  return result.status === 0;
}

function bootstrapIfNeeded(options) {
  if (isLoaded(options)) {
    console.log(`[service] ${options.label} is already loaded`);
    return;
  }
  runLaunchctl(['bootstrap', domainTarget(), options.plistPath]);
}

function reload(options) {
  if (isLoaded(options)) runLaunchctl(['bootout', serviceTarget(options)]);
  runLaunchctl(['bootstrap', domainTarget(), options.plistPath]);
}

function bootoutIfLoaded(options) {
  if (!isLoaded(options)) {
    console.log(`[service] ${options.label} is not loaded`);
    return;
  }
  runLaunchctl(['bootout', serviceTarget(options)]);
}

async function readHealth(options) {
  if (!existsSync(options.configPath)) return null;
  const config = JSON.parse(readFileSync(options.configPath, 'utf8'));
  const host = config.server?.host || '127.0.0.1';
  const port = Number(config.server?.port || 8787);
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 2000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('health check timed out')));
    req.on('error', (error) => resolve({ ok: false, status: 0, text: error.message }));
  });
}

async function status(options) {
  console.log(`[service] label ${options.label}`);
  console.log(`[service] plist ${options.plistPath}`);
  console.log(`[service] config ${options.configPath}`);
  runLaunchctl(['print', serviceTarget(options)], { allowFailure: true });
  const health = await readHealth(options);
  if (health) console.log(`[service] health ${health.status}: ${health.text}`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'help':
      console.log(usage());
      return 0;
    case 'plist':
      ensureInputs(options);
      process.stdout.write(renderPlist(options));
      return 0;
    case 'install':
      writePlist(options);
      if (options.start) {
        reload(options);
        runLaunchctl(['kickstart', '-k', serviceTarget(options)]);
      }
      await status(options);
      return 0;
    case 'uninstall':
      bootoutIfLoaded(options);
      if (existsSync(options.plistPath)) {
        unlinkSync(options.plistPath);
        console.log(`[service] removed ${options.plistPath}`);
      }
      return 0;
    case 'start':
      if (!existsSync(options.plistPath)) writePlist(options);
      bootstrapIfNeeded(options);
      runLaunchctl(['kickstart', '-k', serviceTarget(options)]);
      await status(options);
      return 0;
    case 'stop':
      bootoutIfLoaded(options);
      return 0;
    case 'restart':
      writePlist(options);
      reload(options);
      runLaunchctl(['kickstart', '-k', serviceTarget(options)]);
      await status(options);
      return 0;
    case 'status':
      await status(options);
      return 0;
    default:
      throw new Error(`unknown command: ${options.command}\n\n${usage()}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => {
    process.exit(code);
  }, (error) => {
    console.error(`[service] ${error.message}`);
    process.exit(1);
  });
}

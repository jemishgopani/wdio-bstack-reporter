import { main as sweepMain } from './sweep.js';
import { main as preflightMain } from './preflight.js';
import { loadEnvFile } from './dotenv.js';

const TOP_HELP = `wdio-bstack-reporter — CLI utilities

Usage:
  wdio-bstack-reporter <command> [options]

Commands:
  sweep       Close stuck BrowserStack TM "active" runs
  preflight   Check spec TC IDs against the TM project catalog

Run a command with --help for its options:
  wdio-bstack-reporter sweep --help
  wdio-bstack-reporter preflight --help`;

const argv = process.argv.slice(2);
const sub = argv[0];

async function run(): Promise<number> {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(TOP_HELP);
    return 0;
  }
  // Auto-load `.env` from cwd (same convention as the sample's wdio.conf.ts)
  // so users don't have to `source .env` before every CLI invocation. The
  // shell environment still wins — we never overwrite an already-set var.
  if (loadEnvFile()) console.log('[wdio-bstack-reporter] loaded .env from cwd');
  if (sub === 'sweep') return sweepMain(argv);
  if (sub === 'preflight') return preflightMain(argv.slice(1));
  console.error(`Unknown command: ${sub}\n\n${TOP_HELP}`);
  return 2;
}

void run().then((code) => {
  process.exitCode = code;
});

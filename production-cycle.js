require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  getPostCreateResumeState
} = require('./post-create-resume');

const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, 'integration-state');
const WATCHER_STATE_FILE = path.join(STATE_DIR, 'ops-watcher.json');
const LOCK_FILE = path.join(STATE_DIR, 'production-cycle.lock.json');
const LOG_DIR = path.join(ROOT, 'logs');
let cycleLockHeld = false; // Portfolio hardening: tracks ownership of the lock

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const SKIP_WATCHER = args.includes('--skip-watcher');
const ORDER_ARG_INDEX = args.indexOf('--order');
const EXPLICIT_ORDER =
  ORDER_ARG_INDEX >= 0
    ? String(args[ORDER_ARG_INDEX + 1] || '').trim()
    : '';

const MAX_ORDERS_PER_CYCLE = Math.max(
  1,
  Number(process.env.OPS_MAX_ORDERS_PER_CYCLE || 3) || 3
);

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(
  LOG_DIR,
  `production-cycle-${new Date().toISOString().slice(0, 10)}.log`
);

function log(...values) {
  const line = values.map(value =>
    typeof value === 'string'
      ? value
      : JSON.stringify(value)
  ).join(' ');

  console.log(line);
  fs.appendFileSync(
    logFile,
    `[${new Date().toISOString()}] ${line}\n`,
    'utf8'
  );
}

function loadJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function acquireCycleLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const existing = loadJson(LOCK_FILE, {});
    throw new Error(
      `Another production cycle is already locked. ` +
      `Started=${existing.startedAt || 'unknown'} PID=${existing.pid || 'unknown'}. ` +
      `Inspect ${LOCK_FILE} before removing it.`
    );
  }

  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      live: LIVE
    }, null, 2),
    { flag: 'wx' }
  );
  cycleLockHeld = true;
}

function releaseCycleLock() {
  if (!cycleLockHeld) return;
  if (fs.existsSync(LOCK_FILE)) {
    fs.unlinkSync(LOCK_FILE);
  }
  cycleLockHeld = false;
}

function runNodeScript(script, scriptArgs = []) {
  log(`RUN: node ${script} ${scriptArgs.join(' ')}`.trim());

  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, script), ...scriptArgs.map(String)],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: false,
      env: process.env
    }
  );

  if (result.stdout) {
    const output = result.stdout.trim();
    if (output) {
      console.log(output);
      fs.appendFileSync(logFile, `${output}\n`, 'utf8');
    }
  }

  if (result.stderr) {
    const output = result.stderr.trim();
    if (output) {
      console.error(output);
      fs.appendFileSync(logFile, `${output}\n`, 'utf8');
    }
  }

  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function loadWatcherState() {
  return loadJson(WATCHER_STATE_FILE, {
    version: 1,
    initialized: false,
    knownOrders: {},
    discoveredOrders: {}
  });
}

function updateWatcherRecord(orderNumber, updates) {
  /*
   * An explicit dry-run such as:
   *
   *   node production-cycle.js --order 203 --skip-watcher
   *
   * is diagnostic only. It must not inject an historical/manual order
   * into the persistent watcher queue.
   */
  if (EXPLICIT_ORDER && !LIVE) {
    return;
  }

  const state = loadWatcherState();
  state.discoveredOrders = state.discoveredOrders || {};

  state.discoveredOrders[orderNumber] = {
    ...(state.discoveredOrders[orderNumber] || {}),
    ...updates,
    lastAutomationAt: new Date().toISOString()
  };

  saveJsonAtomic(WATCHER_STATE_FILE, state);
}

function uncertainWriteMessage(text) {
  return /write may have completed|do not rerun automatically|recovery required/i.test(
    String(text || '')
  );
}

function runPreflight(orderNumber) {
  return runNodeScript('production-preflight.js', [orderNumber]);
}

function runIntegration(orderNumber, mode) {
  return runNodeScript('ops-pace-integration.js', [orderNumber, mode]);
}

function processOrder(orderNumber) {
  log('');
  log('========================================');
  log(`PROCESS OPS ORDER ${orderNumber}`);
  log(LIVE ? 'LIVE AUTOMATION' : 'DRY-RUN AUTOMATION');
  log('========================================');

  for (let step = 0; step < 8; step++) {
    const state = getPostCreateResumeState(orderNumber);

    log('Resume state:', {
      nextStep: state.nextStep,
      paceJobNumber: state.paceJobNumber || null,
      blocked: Boolean(state.blocked)
    });

    if (state.blocked || state.nextStep === 'manual_review') {
      updateWatcherRecord(orderNumber, {
        status: 'manual_review',
        automationReason: state.reason || 'Resume state requires manual review.'
      });
      return { status: 'manual_review', state };
    }

    if (state.nextStep === 'complete') {
      updateWatcherRecord(orderNumber, {
        status: 'complete',
        paceJobNumber: state.paceJobNumber || null,
        shipmentNumber: state.shipmentNumber || null,
        completedAt: new Date().toISOString()
      });
      log(`ORDER ${orderNumber}: COMPLETE`);
      return { status: 'complete', state };
    }

    if (state.nextStep === 'reconcile') {
      /*
       * A conversion exists but JobPart state is incomplete. Automatic
       * duplication recovery can be ambiguous after a crash, so this is
       * intentionally a manual-review state rather than a blind retry.
       */
      updateWatcherRecord(orderNumber, {
        status: 'manual_review',
        automationReason:
          'Pace Job exists but JobPart reconciliation is incomplete. Do not rerun conversion automatically.'
      });
      log(`ORDER ${orderNumber}: MANUAL REVIEW - reconciliation incomplete.`);
      return { status: 'manual_review', state };
    }

    if (state.nextStep === 'conversion') {
      const preflight = runPreflight(orderNumber);

      if (preflight.exitCode === 2) {
        updateWatcherRecord(orderNumber, {
          status: 'pending',
          preflightStatus: 'blocked',
          lastPreflightAt: new Date().toISOString()
        });
        return { status: 'pending' };
      }

      if (preflight.exitCode !== 0) {
        updateWatcherRecord(orderNumber, {
          status: 'error',
          automationReason: 'Production preflight errored.'
        });
        return { status: 'error' };
      }

      updateWatcherRecord(orderNumber, {
        status: LIVE ? 'processing' : 'ready',
        preflightStatus: 'ready',
        lastPreflightAt: new Date().toISOString()
      });

      if (!LIVE) {
        log(`ORDER ${orderNumber}: READY FOR CONVERSION (dry-run stopped before write).`);
        return { status: 'ready' };
      }

      const conversion = runIntegration(orderNumber, 'convert-write');
      if (conversion.exitCode !== 0) {
        const output = `${conversion.stdout}\n${conversion.stderr}`;
        updateWatcherRecord(orderNumber, {
          status: uncertainWriteMessage(output) ? 'manual_review' : 'error',
          automationReason: 'Conversion step failed. Inspect the per-order state and log before retrying.'
        });
        return { status: 'error' };
      }

      continue;
    }

    if (state.nextStep === 'artwork') {
      if (!LIVE) {
        updateWatcherRecord(orderNumber, {
          status: 'ready',
          automationReason: 'Artwork write is the next step; dry-run stopped before write.'
        });
        log(`ORDER ${orderNumber}: READY FOR ARTWORK (dry-run stopped before write).`);
        return { status: 'ready' };
      }

      const artwork = runIntegration(orderNumber, 'artwork-write');
      if (artwork.exitCode !== 0) {
        const output = `${artwork.stdout}\n${artwork.stderr}`;
        updateWatcherRecord(orderNumber, {
          status: uncertainWriteMessage(output) ? 'manual_review' : 'error',
          automationReason: 'Artwork step failed. Inspect Pace and local state before retrying.'
        });
        return { status: 'error' };
      }

      continue;
    }

    if (state.nextStep === 'shipment') {
      const prep = runIntegration(orderNumber, 'shipment-prep');
      if (prep.exitCode !== 0) {
        const output = `${prep.stdout}\n${prep.stderr}`;
        updateWatcherRecord(orderNumber, {
          status: uncertainWriteMessage(output) ? 'manual_review' : 'error',
          automationReason: 'Shipment preflight failed.'
        });
        return { status: 'error' };
      }

      if (!LIVE) {
        updateWatcherRecord(orderNumber, {
          status: 'ready',
          automationReason: 'Shipment preflight passed; dry-run stopped before shipment write.'
        });
        log(`ORDER ${orderNumber}: SHIPMENT PREFLIGHT PASSED (dry-run stopped before write).`);
        return { status: 'ready' };
      }

      const shipment = runIntegration(orderNumber, 'shipment-write');
      if (shipment.exitCode !== 0) {
        const output = `${shipment.stdout}\n${shipment.stderr}`;
        updateWatcherRecord(orderNumber, {
          status: uncertainWriteMessage(output) ? 'manual_review' : 'error',
          automationReason: 'Shipment write failed. Inspect Pace and local shipment state before retrying.'
        });
        return { status: 'error' };
      }

      continue;
    }

    updateWatcherRecord(orderNumber, {
      status: 'manual_review',
      automationReason: `Unknown resume nextStep: ${state.nextStep}`
    });
    return { status: 'manual_review', state };
  }

  updateWatcherRecord(orderNumber, {
    status: 'manual_review',
    automationReason: 'Automation exceeded maximum state transitions in one cycle.'
  });
  return { status: 'manual_review' };
}

function candidateOrders() {
  if (EXPLICIT_ORDER) {
    if (!/^\d+$/.test(EXPLICIT_ORDER)) {
      throw new Error(`Invalid --order value: ${EXPLICIT_ORDER}`);
    }
    return [EXPLICIT_ORDER];
  }

  const state = loadWatcherState();
  const discovered = state.discoveredOrders || {};

  return Object.entries(discovered)
    .filter(([, record]) =>
      Boolean(record.discoveredAt) &&
      !['complete', 'ignored', 'manual_review'].includes(record.status)
    )
    .map(([orderNumber]) => orderNumber)
    .sort((a, b) => Number(a) - Number(b))
    .slice(0, MAX_ORDERS_PER_CYCLE);
}

(async () => {
  try {
    acquireCycleLock();

    log('');
    log('========================================');
    log('OPS -> PACE PRODUCTION CYCLE');
    log(LIVE ? 'LIVE MODE' : 'DRY-RUN MODE');
    log('========================================');

    if (!EXPLICIT_ORDER && !SKIP_WATCHER) {
      const watcher = runNodeScript('ops-order-watcher.js');
      if (watcher.exitCode !== 0) {
        throw new Error('OPS watcher failed. Production cycle stopped before processing.');
      }
    }

    const orders = candidateOrders();
    log(`Orders selected: ${orders.length ? orders.join(', ') : '(none)'}`);

    let failedOrders = 0;
    for (const orderNumber of orders) {
      const result = processOrder(orderNumber);
      if (['error', 'manual_review'].includes(result.status)) {
        failedOrders++;
        log(`Order ${orderNumber} requires attention: ${result.status}`);
      }
    }

    if (failedOrders > 0) {
      process.exitCode = 1;
      log(`PRODUCTION CYCLE FINISHED WITH ${failedOrders} ORDER(S) REQUIRING ATTENTION`);
    } else {
      log('PRODUCTION CYCLE COMPLETE');
    }
  } catch (error) {
    console.error(error.stack || error.message);
    try {
      fs.appendFileSync(
        logFile,
        `[${new Date().toISOString()}] ERROR ${error.stack || error.message}\n`,
        'utf8'
      );
    } catch {}
    process.exitCode = 1;
  } finally {
    releaseCycleLock();
  }
})();

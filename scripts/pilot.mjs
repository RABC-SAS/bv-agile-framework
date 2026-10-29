import { parseArgs } from 'node:util';
import { openSync, closeSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GitHub, Ledger } from './api.mjs';
import { loadPilot, repositoryOf, preflight, plan, bootstrap, fixtures, cleanup, recover } from './pilot-kit.mjs';
import { candidate, digest, simulate } from './simulation.mjs';
import { applyControls } from './controls.mjs';

let lock;
let lockPath;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string', default: '.github/planning/pilot.yml' },
    manifest: { type: 'string' }, apply: { type: 'boolean', default: false },
    confirm: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    sha: { type: 'string' }, ticket: { type: 'string' }, artifact: { type: 'string' }, scope: { type: 'string' },
    plan: { type: 'string' }, authorization: { type: 'string' }, 'authorize-controls': { type: 'string' },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !['preflight', 'plan', 'bootstrap', 'fixtures', 'cleanup', 'simulate', 'recover', 'apply-controls'].includes(command)) {
    throw new Error('Commands: preflight, plan, bootstrap, fixtures, cleanup, simulate, recover, apply-controls');
  }
  if (values.apply && values['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive');
  const { pilot, config } = loadPilot(values.config);
  const repository = repositoryOf(pilot);
  const recovery = command === 'recover';
  if (recovery && (values.apply || values['dry-run'] || !values.manifest)) throw new Error('recover requires --manifest and only rechecks recorded membership; no --apply/--dry-run');
  if (command === 'apply-controls' && (!values.apply || !values.plan || !values.authorization || !values['authorize-controls'])) {
    throw new Error('apply-controls requires --apply, --plan, --authorization and --authorize-controls; obtain independent human authorization first');
  }
  const write = ['bootstrap', 'fixtures', 'cleanup', 'apply-controls'].includes(command) && values.apply;
  if (values.apply && !write) throw new Error('--apply is only available for bootstrap, fixtures and cleanup');
  if (write && values.confirm !== repository) throw new Error('--confirm must exactly name the configured organization/repository');
  const api = new GitHub({ dryRun: !write });
  const persist = write || recovery || (command === 'simulate' && values.manifest && !values['dry-run']);
  const ledger = values.manifest ? new Ledger(values.manifest, { repository, dryRun: !persist, allowPending: recovery }) : null;
  if (write && !ledger) throw new Error('Writes require an external --manifest');
  if (persist) {
    mkdirSync(dirname(ledger.path), { recursive: true });
    lockPath = `${ledger.path}.lock`;
    lock = openSync(lockPath, 'wx', 0o600);
    // Reload under the exclusive lock; no concurrent process can use an older manifest.
    ledger.data = new Ledger(values.manifest, { repository, allowPending: recovery }).data;
  }
  let result;
  if (command === 'simulate') {
    const target = candidate({
      repository, ticket: Number(values.ticket ?? 1), scope: values.scope ?? 'SYNTHETIC portable human-agent pilot simulator v1',
      sha: values.sha ?? 'a'.repeat(40), artifact: values.artifact ?? digest('SYNTHETIC artifact, not a build'),
    });
    result = simulate(target, pilot.roles);
    if (ledger && !values['dry-run']) {
      ledger.data.evidence.push({ action: 'SIMULATED', result });
      ledger.save();
    }
  } else if (recovery) {
    result = await recover(api, ledger, pilot, config);
  } else if (command === 'apply-controls') {
    result = await applyControls(api, ledger, pilot, config,
      JSON.parse(readFileSync(values.plan, 'utf8')), JSON.parse(readFileSync(values.authorization, 'utf8')),
      { confirmHash: values['authorize-controls'] });
  } else if (write) {
    result = command === 'bootstrap' ? await bootstrap(api, ledger, pilot, config)
      : command === 'fixtures' ? await fixtures(api, ledger, pilot, config)
        : await cleanup(api, ledger, pilot);
  } else {
    const state = await preflight(api, pilot, config);
    result = command === 'preflight' ? state : { command, dry_run: true, ...plan(pilot, config, state) };
    if (state.access_errors.length || result.blocked) process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock !== undefined) {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, formDocuments } from './policy.mjs';
import { GitHub, Ledger, projectStatuses } from './api.mjs';
import { reconcile } from './validation.mjs';
import { provision } from './setup.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'dry-run': { type: 'boolean', default: false },
  config: { type: 'string', default: '.github/planning/hierarchy.yml' },
  manifest: { type: 'string' },
  numbers: { type: 'string' },
} });

try {
  const config = loadConfig(values.config);
  const repository = `${config.organization}/${config.repository}`;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository) throw new Error('Workflow repository differs from YAML target');
  const api = new GitHub({ dryRun: values['dry-run'] });
  const command = positionals[0];
  const ledger = () => new Ledger(values.manifest, { dryRun: api.dryRun, repository });
  let result;
  if (['generate-forms', 'check-forms'].includes(command)) {
    const documents = formDocuments(config);
    const directory = '.github/ISSUE_TEMPLATE';
    const drift = [];
    if (existsSync(directory)) {
      for (const name of readdirSync(directory)) {
        if (name.endsWith('.yml') && !documents.has(name) && readFileSync(join(directory, name), 'utf8').startsWith('# Generated from .github/planning/hierarchy.yml')) throw new Error(`Stale generated form: ${name}; review and remove explicitly`);
      }
    }
    for (const [name, document] of documents) {
      const path = join(directory, name);
      const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;
      if (current === document) continue;
      drift.push(path);
      if (command === 'generate-forms' && !api.dryRun) {
        if (current !== null && !current.startsWith('# Generated from .github/planning/hierarchy.yml')) throw new Error(`Unmanaged form: ${path}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, document);
        if (readFileSync(path, 'utf8') !== document) throw new Error(`Form read-back failed: ${path}`);
      }
    }
    result = { command, drift, dry_run: api.dryRun };
    if (command === 'check-forms' && drift.length) process.exitCode = 1;
  } else if (command === 'setup') {
    const manifest = ledger();
    result = { types: await provision(api, manifest, config, 'type'), fields: await provision(api, manifest, config, 'field') };
  } else if (command === 'validate') {
    const numbers = values.numbers?.split(',').map(Number);
    if (numbers?.some(number => !Number.isSafeInteger(number) || number <= 0)) throw new Error('Invalid issue numbers');
    const actor = process.env.AGILE_REPORTER_LOGIN || (process.env.GITHUB_ACTIONS === 'true' ? 'github-actions[bot]' : (await api.request('user')).login);
    const validation = await reconcile(api, ledger(), config, { numbers, actor });
    result = { ...validation, results: validation.results.map(({ snapshot, ...row }) => ({ ...row, status: snapshot?.status })) };
    if (validation.violations || validation.access_errors.length) process.exitCode = 1;
  } else if (command === 'inspect') {
    const project = await projectStatuses(api, config);
    const types = await api.list(`orgs/${config.organization}/issue-types`);
    const fields = await api.list(`orgs/${config.organization}/issue-fields`);
    result = { project: project.project, items: [...project.items.values()], types, fields, writes: api.writes };
    if (values.manifest && !api.dryRun) {
      const manifest = ledger();
      manifest.data.evidence.push({ action: 'inspect', result });
      manifest.save();
    }
  } else throw new Error('Commands: setup, inspect, generate-forms, check-forms, validate');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
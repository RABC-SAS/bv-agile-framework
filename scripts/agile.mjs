import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, formDocuments, nativeMode, bodyMode } from './policy.mjs';
import { GitHub, Ledger, projectState } from './api.mjs';
import { reconcile } from './validation.mjs';
import { provision, publishReport, publishDraft } from './operations.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'dry-run': { type: 'boolean', default: false },
  config: { type: 'string', default: '.github/planning/hierarchy.yml' },
  manifest: { type: 'string' },
  numbers: { type: 'string' },
  event: { type: 'string' },
  report: { type: 'string' },
  branch: { type: 'string' },
} });
const command = positionals[0];
const config = loadConfig(values.config);
const api = new GitHub({ dryRun: values['dry-run'] });
const repository = `${config.organization}/${config.repository}`;

try {
  if (command === 'capabilities') {
    const results = [];
    for (const [operation, read] of [
      ['organization_types', () => api.list(`orgs/${config.organization}/issue-types`)],
      ['organization_fields', () => api.list(`orgs/${config.organization}/issue-fields`)],
      ['project_identity_and_fields', () => projectState(api, config)],
    ]) {
      try { results.push({ operation, readable: true, result: await read() }); }
      catch (error) { results.push({ operation, readable: false, http_status: error.status ?? null, error: error.message }); }
    }
    console.log(JSON.stringify({ results, writes: api.writes, dry_run: api.dryRun }, null, 2));
    if (results.some(result => !result.readable)) process.exitCode = 1;
  } else if (['provision-types', 'provision-cost-centre', 'publish-report', 'publish-draft'].includes(command)) {
    const ledger = new Ledger(values.manifest, { dryRun: api.dryRun, repository });
    const result = command === 'publish-report' ? await publishReport(api, ledger, config, values.report)
      : command === 'publish-draft' ? await publishDraft(api, ledger, config, { branch: values.branch, reportPath: values.report })
        : await provision(api, ledger, config, command === 'provision-types' ? 'type' : 'field');
    console.log(JSON.stringify(result, null, 2));
  } else if (['generate-forms', 'check-forms'].includes(command)) {
    if (![nativeMode, bodyMode].includes(config.field_storage.decision)) throw new Error('Resolve storage from a real probe before generating or checking forms');
    const drift = [];
    for (const [name, document] of formDocuments(config)) {
      const path = join('.github', 'ISSUE_TEMPLATE', name);
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (current !== document) {
        drift.push(path);
        if (command === 'generate-forms' && !api.dryRun) {
          if (current !== null && !current.startsWith('# Generated from .github/planning/hierarchy.yml')) throw new Error(`Refuse to overwrite unmanaged form: ${path}`);
          mkdirSync('.github/ISSUE_TEMPLATE', { recursive: true });
          writeFileSync(path, document);
          if (readFileSync(path, 'utf8') !== document) throw new Error(`Form read-back failed: ${path}`);
        }
      }
    }
    console.log(JSON.stringify({ command, dry_run: api.dryRun, drift }, null, 2));
    if (command === 'check-forms' && drift.length) process.exitCode = 1;
  } else if (command === 'validate') {
    const ledger = new Ledger(values.manifest, { dryRun: api.dryRun, repository });
    let numbers;
    if (values.numbers) {
      numbers = values.numbers.split(',').map(Number);
      if (numbers.some(number => !Number.isSafeInteger(number) || number <= 0)) throw new Error('Invalid issue numbers');
    }
    if (values.event) {
      const event = JSON.parse(readFileSync(values.event, 'utf8'));
      const candidate = event.issue?.number;
      if (candidate !== undefined && (!Number.isSafeInteger(candidate) || candidate <= 0)) throw new Error('Invalid issue number in event');
    }
    const actor = process.env.AGILE_REPORTER_LOGIN || (process.env.GITHUB_ACTIONS === 'true' ? 'github-actions[bot]' : (await api.request('user')).login);
    let projectError;
    try { await projectState(api, config); }
    catch (error) { projectError = `Project unreadable or incompatible: ${error.message}; request narrowly scoped App access`; }
    const result = await reconcile(api, ledger, config, { numbers, actor, projectError });
    console.log(JSON.stringify({ ...result, results: result.results.map(({ snapshot, ...result }) => result) }, null, 2));
    if (result.violations || projectError) process.exitCode = 1;
  } else if (command === 'inspect') {
  const repo = await api.request(`repos/${repository}`);
  if (!repo.has_issues) throw new Error('Repository issues unavailable');
  const project = await projectState(api, config);
  const types = await api.list(`orgs/${config.organization}/issue-types`);
  const fields = await api.list(`orgs/${config.organization}/issue-fields`);
  for (const name of config.issue_types) {
    const matches = types.filter(type => type.name === name);
    if (matches.length > 1 || matches.some(type => !type.is_enabled)) throw new Error(`Ambiguous or disabled existing type: ${name}`);
  }
  if (types.some(type => type.name === 'Issue')) throw new Error('Unmanaged Issue type exists; stop rather than delete it');
  for (const field of Object.values(config.fields)) {
    const matches = fields.filter(candidate => candidate.name === field.name);
    if (matches.length > 1 || matches.some(candidate => candidate.data_type !== field.native_type)) throw new Error(`Ambiguous or incompatible organization field: ${field.name}`);
  }
  const missingTypes = config.issue_types.filter(name => !types.some(type => type.name === name));
  const missingFields = Object.values(config.fields).filter(field => !fields.some(candidate => candidate.name === field.name)).map(field => field.name);
  if (types.length + missingTypes.length > 25 || fields.length + missingFields.length > 25) throw new Error('Model exceeds documented organization limits');
  const result = { project, repository: { full_name: repo.full_name, node_id: repo.node_id, permissions: repo.permissions }, types, fields, missingTypes, missingFields, storage: config.field_storage.decision, dry_run: api.dryRun, writes: api.writes };
  if (values.manifest) {
    const ledger = new Ledger(values.manifest, { dryRun: api.dryRun, repository });
    ledger.data.evidence.push({ action: 'inspect', observed_at: new Date().toISOString(), result });
    ledger.save();
  }
  console.log(JSON.stringify(result, null, 2));
  } else throw new Error('Supported commands: inspect, capabilities, validate, generate-forms, check-forms, provision-types, provision-cost-centre, publish-report, publish-draft');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
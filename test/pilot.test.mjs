import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GitHub, Ledger, ApiError } from '../scripts/api.mjs';
import { loadPilot, preflight, plan, bootstrap, fixtures, cleanup, recover } from '../scripts/pilot-kit.mjs';
import { candidate, digest, evaluate, scenario, simulate, consumeSimulation, stages, humanStages } from '../scripts/simulation.mjs';
import { loadConfig, validateIssue, formDocuments, hasContent } from '../scripts/policy.mjs';
import { snapshot } from '../scripts/validation.mjs';
import { parseEntries, timeReport } from '../scripts/timelog.mjs';
import YAML from 'yaml';
import { applyControls, authorizationMessage, rulesetMatches, rulesetBody } from '../scripts/controls.mjs';

const roles = { agent: 'delegated-agent', human: 'simulated-human' };
const target = candidate({ repository: 'example/pilot', ticket: 1, scope: 'Pilot scope', sha: 'a'.repeat(40), artifact: digest('artifact') });
const now = 1800000000000;
const context = { now, expectedRun: 'independent-run' };
const events = () => scenario(target, roles, { now, run: context.expectedRun });

test('complete simulation never authorizes or publishes real work', () => {
  const result = evaluate(events(), target, roles, context);
  assert.equal(result.simulation, 'PASS');
  assert.equal(result.real_authorization, false);
  assert.equal(result.release_published, false);
  assert.throws(() => evaluate(events(), target, roles, { ...context, mode: 'real' }), /cannot satisfy real/);
});

for (const [index, stage] of stages.entries()) {
  test(`gate ${stage}: missing, denied, expired, wrong actor, evidence, scope, order`, () => {
    const mutations = [
      rows => rows.splice(index, 1),
      rows => { rows[index].result = 'deny'; },
      rows => { rows[index].expires = now; },
      rows => { rows[index].actor = 'unknown'; },
      rows => { rows[index].evidence = ''; },
      rows => { rows[index].scope_hash = digest('new scope'); },
      rows => { rows[index].at = now + 1; },
      rows => { rows[index].mode = 'real'; },
    ];
    if (stage !== 'scope') mutations.push(
      rows => { rows[index].sha = 'b'.repeat(40); },
      rows => { rows[index].artifact = digest('other artifact'); },
    );
    if (humanStages.includes(stage)) mutations.push(rows => {
      rows[index].actor = roles.agent;
      rows[index].actor_kind = 'agent';
    });
    for (const mutate of mutations) {
      const rows = events();
      mutate(rows);
      assert.throws(() => evaluate(rows, target, roles, context));
    }
  });
}

test('scope, SHA, artifact changes invalidate decisions; replay and checklists fail closed', () => {
  for (const changed of [{ scope_hash: digest('new') }, { sha: 'b'.repeat(40) }, { artifact: digest('new') }]) {
    assert.throws(() => evaluate(events(), { ...target, ...changed }, roles, context));
  }
  assert.throws(() => evaluate(events(), target, roles, { ...context, expectedRun: 'another-run' }), /Reused/);
  assert.throws(() => evaluate(events(), target, roles), /expected run/);
  const rows = events();
  rows[2].checklist[1].done = false;
  assert.throws(() => evaluate(rows, target, roles, context), /checklist/);
  assert.throws(() => evaluate(events(), target, { human: roles.agent, agent: roles.agent }, context), /Distinct/);
});

test('bundled simulation verifies every positive and negative expectation', () => {
  const result = simulate(target, roles);
  assert.equal(result.results.length, 88);
  assert.ok(result.results.slice(1).every(row => row.rejected));
  assert.equal(result.consumed_ids.length, stages.length);
});

test('simulation receipt store rejects already-consumed decisions, but consumes nothing on invalid input', () => {
  const consumed = new Set();
  const rows = events();
  rows[6].result = 'deny';
  assert.throws(() => consumeSimulation(rows, target, roles, { ...context, consumed }), /denied/);
  assert.equal(consumed.size, 0);
  consumeSimulation(events(), target, roles, { ...context, consumed });
  assert.throws(() => consumeSimulation(events(), target, roles, { ...context, consumed }), /consumed/);
});

const hierarchy = loadConfig();
const nativeFields = config => Object.values(config.fields).filter(field => field.storage === 'organization_field')
  .map((field, index) => ({ id: 7 + index, name: field.name, data_type: field.data_type, ...(field.options ? { options: field.options } : {}) }));
const orgFields = nativeFields(hierarchy);
const native = values => Object.entries(values).map(([name, value]) => {
  const field = orgFields.find(candidate => candidate.name === name);
  return { issue_field_id: field.id, issue_field_name: name, data_type: field.data_type, value };
});
const issue = (body, type = 'Feature', values = {}) => ({
  issue: { id: 1, type: type === null ? null : { name: type }, body },
  orgFields, fieldValues: native(values),
});
const description = '### Description\nA reproducible example.\n';
const criteria = '### Acceptance Criteria\n- [ ] Observable outcome.\n';
const evidence = '### Delivery Evidence\nTests on candidate abc.\n';
const closing = { Replicability: 'Replicable', 'Asset Registration': 'https://example.com/registry/42' };
const boundaries = '### File Boundaries\nsrc/orders/**\n';
const restrictions = '### Restrictions\nDo not change the public API.\n';
const findings = '### Findings Disposition\nNo findings.\n';
const messages = (state, name) => validateIssue(hierarchy, state).filter(error => error.startsWith(`${name}:`));

test('forms and CLI/API body use identical headings, not independent native fields', () => {
  for (const [name, document] of formDocuments(hierarchy)) {
    const form = YAML.parse(document);
    assert.equal(form.body[0].attributes.label, 'Description');
    assert.equal(form.body[0].validations.required, true);
    assert.equal(readFileSync(join('.github', 'ISSUE_TEMPLATE', name), 'utf8').replace(/\r\n/g, '\n'), document);
    const body = form.body.map(field => `### ${field.attributes.label}\n${field.id === 'description' ? 'An example' : '_No response_'}`).join('\n\n');
    assert.deepEqual(validateIssue(hierarchy, { ...issue(body, form.type ?? null), status: 'Backlog' }), []);
  }
});

test('ordered status gates require criteria from Ready and evidence from In review', () => {
  for (const status of hierarchy.project.statuses) {
    const errors = validateIssue(hierarchy, { ...issue(description), status });
    assert.equal(errors.some(error => error.startsWith('Acceptance Criteria')), status !== 'Backlog');
    assert.equal(errors.some(error => error.startsWith('Delivery Evidence')), ['In review', 'Done'].includes(status));
    assert.deepEqual(validateIssue(hierarchy, { ...issue(description + criteria + evidence, 'Feature', closing), status }), []);
  }
});

test('missing/duplicate sections and placeholders are explicit, even optional duplicates', () => {
  assert.ok(validateIssue(hierarchy, { ...issue(''), status: 'Backlog' }).some(error => error.startsWith('Description')));
  for (const value of ['_No response_', 'TBD', '<!-- hidden -->', '   ', '- [ ] TODO', '\u200b']) {
    assert.equal(hasContent(value, hierarchy.validation.placeholders), false);
    assert.ok(validateIssue(hierarchy, { ...issue(description + `### Acceptance Criteria\n${value}`), status: 'Ready' }).length);
  }
  for (const body of [description + description, description + criteria + criteria, description + evidence + evidence]) {
    assert.ok(validateIssue(hierarchy, { ...issue(body), status: 'Backlog' }).some(error => /duplicated/.test(error)));
  }
  assert.deepEqual(validateIssue(hierarchy, { ...issue(description + criteria), status: 'Ready' }), []);
});

test('hierarchy, terminal, cycle, unknown status and unreadable values fail', () => {
  const base = { ...issue(description + criteria + evidence), status: 'Done' };
  assert.ok(validateIssue(hierarchy, { ...base, children: [{ id: 2, type: { name: 'Epic' } }] }).some(error => /Disallowed/.test(error)));
  assert.ok(validateIssue(hierarchy, { ...issue(description, 'Task'), status: 'Backlog', children: [{ id: 2, type: null }] }).some(error => /terminal/.test(error)));
  assert.ok(validateIssue(hierarchy, { ...base, ancestors: [{ id: 1 }] }).some(error => /cycle/.test(error)));
  assert.ok(validateIssue(hierarchy, { ...base, status: 'unknown' }).some(error => /Unknown/.test(error)));
  assert.ok(validateIssue(hierarchy, { ...base, fieldValues: undefined }).some(error => /unreadable/.test(error)));
});

test('agent-executed stories need boundaries and restrictions from Ready; human work does not', () => {
  const body = description + criteria;
  for (const mode of ['Copilot attended', 'Autonomous with checkpoint']) {
    const open = { ...issue(body, 'User Story', { 'Execution Mode': mode }), status: 'Ready' };
    assert.equal(messages(open, 'File Boundaries').length, 1);
    assert.equal(messages(open, 'Restrictions').length, 1);
    assert.deepEqual(validateIssue(hierarchy, { ...open, status: 'Backlog' }), []);
    assert.deepEqual(validateIssue(hierarchy, { ...issue(body + boundaries + restrictions, 'User Story', { 'Execution Mode': mode }), status: 'In progress' }), []);
  }
  assert.deepEqual(validateIssue(hierarchy, { ...issue(body, 'User Story', { 'Execution Mode': 'Human only' }), status: 'Ready' }), []);
  assert.equal(messages({ ...issue(body, 'User Story'), status: 'Ready' }, 'Execution Mode').length, 1);
  assert.equal(messages({ ...issue(description, 'Bug Story', { 'Execution Mode': 'Copilot attended' }), status: 'In progress' }, 'File Boundaries').length, 1);
  const done = { ...issue(body + evidence, 'User Story', { 'Execution Mode': 'Human only', 'Cost Centre': 'CC-1', 'Time Spent': 4 }), status: 'Done' };
  assert.equal(messages(done, 'Findings Disposition').length, 1);
  assert.deepEqual(validateIssue(hierarchy, { ...done, issue: { ...done.issue, body: body + evidence + findings } }), []);
});

test('tasks and meetings only need category, cost centre and time when done', () => {
  for (const type of ['Task', null]) {
    for (const status of ['Backlog', 'Ready', 'In progress', 'In review']) {
      assert.deepEqual(validateIssue(hierarchy, { ...issue(description, type), status }), []);
    }
    const missing = validateIssue(hierarchy, { ...issue(description, type), status: 'Done' });
    assert.deepEqual(missing.map(error => error.split(':')[0]).sort(), ['Cost Centre', 'Time Spent', 'Work Category']);
    for (const hours of [0, 1.5]) {
      assert.deepEqual(validateIssue(hierarchy, { ...issue(description, type, { 'Work Category': 'Meeting', 'Cost Centre': 'CC-100', 'Time Spent': hours }), status: 'Done' }), []);
    }
  }
});

test('cost centre is inherited from any parent; unreadable parents fail', () => {
  const done = { ...issue(description, 'Task', { 'Work Category': 'Delivery', 'Time Spent': 2 }), status: 'Done' };
  const ancestors = [{ id: 2 }, { id: 3 }];
  assert.equal(messages(done, 'Cost Centre').length, 1);
  assert.deepEqual(validateIssue(hierarchy, { ...done, ancestors, ancestorFieldValues: [[], native({ 'Cost Centre': 'CC-200' })] }), []);
  assert.match(messages({ ...done, ancestors }, 'Cost Centre')[0], /unreadable/);
  assert.match(messages({ ...done, ancestors, ancestorFieldValues: [[], native({ 'Cost Centre': 'TBD' })] }, 'Cost Centre')[0], /every parent/);
});

test('estimates are required only for time-and-materials work without sub-issues', () => {
  const billed = model => ({ ancestors: [{ id: 2 }], ancestorFieldValues: [native({ 'Billing Model': model, 'Cost Centre': 'CC-1' })] });
  const task = (status, values = {}) => ({ ...issue(description, 'Task', values), status });
  assert.deepEqual(validateIssue(hierarchy, task('In progress')), []);
  assert.deepEqual(validateIssue(hierarchy, { ...task('In progress'), ...billed('Fixed price') }), []);
  const hourly = billed('Time and materials');
  assert.equal(messages({ ...task('Ready'), ...hourly }, 'Original Estimate').length, 1);
  assert.equal(messages({ ...task('Ready'), ...hourly }, 'Remaining Work').length, 0);
  assert.equal(messages({ ...task('In progress', { 'Original Estimate': 8 }), ...hourly }, 'Remaining Work').length, 1);
  assert.deepEqual(validateIssue(hierarchy, { ...task('In progress', { 'Original Estimate': 8, 'Remaining Work': 3 }), ...hourly }), []);
  const story = { ...issue(description + criteria + evidence + findings, 'User Story', { 'Execution Mode': 'Human only' }), status: 'Done', ...hourly };
  assert.deepEqual(validateIssue(hierarchy, story).map(error => error.split(':')[0]), ['Original Estimate', 'Remaining Work', 'Time Spent']);
  assert.deepEqual(validateIssue(hierarchy, { ...story, children: [{ id: 9, type: { name: 'Task' } }] }), []);
});

test('a feature cannot be done without the replicability answer and the asset record', () => {
  const feature = values => ({ ...issue(description + criteria + evidence, 'Feature', values), status: 'Done' });
  assert.deepEqual(validateIssue(hierarchy, feature()).map(error => error.split(':')[0]), ['Replicability', 'Asset Registration']);
  assert.deepEqual(validateIssue(hierarchy, { ...feature(), status: 'In review' }), []);
  assert.equal(messages(feature({ ...closing, 'Asset Registration': 'TBD' }), 'Asset Registration').length, 1);
  assert.deepEqual(validateIssue(hierarchy, feature(closing)), []);
  const initiative = { ...issue(description + criteria, 'Initiative'), status: 'Ready' };
  assert.deepEqual(validateIssue(hierarchy, initiative).map(error => error.split(':')[0]), ['Engagement', 'Billing Model']);
});

test('negative hours, fields on the wrong type and select option objects are handled', () => {
  assert.match(messages({ ...issue(description, 'Task', { 'Time Spent': -1 }), status: 'Backlog' }, 'Time Spent')[0], /at least 0/);
  assert.match(messages({ ...issue(description, 'Feature', { 'Time Spent': 3 }), status: 'Backlog' }, 'Time Spent')[0], /does not apply/);
  const mode = orgFields.find(field => field.name === 'Execution Mode');
  const selected = { ...issue(description + criteria, 'User Story'), status: 'Ready' };
  selected.fieldValues = [{ issue_field_id: mode.id, data_type: 'single_select', value: null, single_select_option: { id: 1, name: 'Human only', color: 'gray' } }];
  assert.deepEqual(validateIssue(hierarchy, selected), []);
});

test('policy rejects unknown conditions, placeholder options and misplaced keys', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bv-policy-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broken = mutate => () => {
    const config = YAML.parse(readFileSync(join('.github', 'planning', 'hierarchy.yml'), 'utf8'));
    mutate(config);
    writeFileSync(join(directory, 'hierarchy.yml'), YAML.stringify(config));
    return loadConfig(join(directory, 'hierarchy.yml'));
  };
  assert.equal(broken(() => {})().schema_version, 2);
  assert.throws(broken(config => { config.fields.file_boundaries.required_when.in = ['Robot']; }), /unknown option/);
  assert.throws(broken(config => { config.fields.file_boundaries.required_when.field = 'Cost Centre'; }), /single-select/);
  assert.throws(broken(config => { config.fields.replicability.options[1].name = 'N/A'; }), /Invalid option/);
  assert.throws(broken(config => { config.fields.acceptance_criteria.inherit_from_ancestors = true; }), /inherited/);
  assert.throws(broken(config => { config.fields.cost_centre.minimum = 0; }), /minimum/);
  assert.throws(broken(config => { config.time_tracking.total_field = 'Cost Centre'; }), /time_tracking/);
});

test('snapshot reads parent field values only when a field is inherited', async () => {
  const api = new GitHub({ dryRun: true, transport: async (path, { body } = {}) => {
    if (path === 'graphql') return { data: { node: { id: body.variables.id, parent: body.variables.id === 'CHILD' ? { id: 'PARENT', number: 5, repository: { nameWithOwner: 'example/other' } } : null } } };
    if (path === 'repos/example/pilot/issues/9') return { id: 9, number: 9, node_id: 'CHILD', type: { name: 'Task' }, body: description };
    if (path === 'repos/example/other/issues/5') return { id: 5, number: 5, node_id: 'PARENT', type: { name: 'User Story' }, repository_url: 'https://api.github.com/repos/example/other' };
    if (path.startsWith('repos/example/other/issues/5/issue-field-values')) return native({ 'Cost Centre': 'CC-9' });
    if (path.startsWith('repos/example/pilot/issues/9/')) return [];
    throw new Error(`Unexpected mock request ${path}`);
  } });
  const inherited = await snapshot(api, 'example/pilot', 9, orgFields, { inherit: true });
  assert.deepEqual(inherited.ancestorFieldValues, [native({ 'Cost Centre': 'CC-9' })]);
  assert.deepEqual(validateIssue(hierarchy, { ...inherited, issue: { ...inherited.issue, body: description }, status: 'Done' }).map(error => error.split(':')[0]), ['Work Category', 'Time Spent']);
  assert.equal(Object.hasOwn(await snapshot(api, 'example/pilot', 9, orgFields), 'ancestorFieldValues'), false);
  assert.equal(api.writes, 0);
});

const timeComments = [
  { id: 1, user: { login: 'ana', type: 'User' }, created_at: '2026-11-20T15:00:00Z', body: 'Workshop done.\n/spent 1.5h Client workshop\n/spent 30m 2026-11-19' },
  { id: 2, user: { login: 'ana', type: 'User' }, created_at: '2026-11-21T09:00:00Z', body: '/spent -0.5h 2026-11-20 correction' },
  { id: 3, user: { login: 'helper[bot]', type: 'Bot' }, created_at: '2026-11-21T09:00:00Z', body: '/spent 8h' },
  { id: 4, user: { login: 'luis', type: 'User' }, created_at: '2026-11-21T10:00:00Z', body: '/spent two hours\n/spent 1h 2026-02-30\n/spent 0h\n/spentx 3h\nI /spent 2h yesterday' },
];

test('time entries are dated, corrected by negative entries and never taken from bots', () => {
  const { entries, invalid } = parseEntries(timeComments);
  assert.deepEqual(entries.map(({ author, date, hours, note }) => ({ author, date, hours, note })), [
    { author: 'ana', date: '2026-11-20', hours: 1.5, note: 'Client workshop' },
    { author: 'ana', date: '2026-11-19', hours: 0.5, note: '' },
    { author: 'ana', date: '2026-11-20', hours: -0.5, note: 'correction' },
  ]);
  assert.deepEqual(invalid.map(row => row.line), ['/spent two hours', '/spent 1h 2026-02-30', '/spent 0h']);
});

test('time log is read-only and reports a total that differs from the logged entries', async () => {
  const transport = total => async (path, { method = 'GET' } = {}) => {
    assert.equal(method, 'GET');
    if (path.startsWith('orgs/RABC-SAS/issue-fields')) return orgFields;
    if (path.includes('/issues/7/comments')) return timeComments.slice(0, 2);
    if (path.includes('/issues/7/issue-field-values')) return total === null ? [] : native({ 'Time Spent': total });
    throw new Error(`Unexpected mock request ${path}`);
  };
  const differs = await timeReport(new GitHub({ dryRun: true, transport: transport(2) }), hierarchy, { numbers: [7] });
  assert.deepEqual(differs.totals, [{ issue: 7, logged: 1.5, total: 2, differs: true }]);
  assert.equal(differs.entries.length, 3);
  assert.equal(differs.writes, 0);
  const matches = await timeReport(new GitHub({ dryRun: true, transport: transport(1.5) }), hierarchy, { numbers: [7] });
  assert.equal(matches.differences, 0);
  const unset = await timeReport(new GitHub({ dryRun: true, transport: transport(null) }), hierarchy, { numbers: [7] });
  assert.deepEqual(unset.totals, [{ issue: 7, logged: 1.5, total: null, differs: true }]);
});

function fakeGitHub({ autoAdd = false, missingProject = false, missingType = false, missingField = false, denied = false } = {}) {
  const { pilot, config } = loadPilot();
  const project = { id: 'PROJECT_TARGET', number: 2, title: config.project.title, url: 'https://github.com/orgs/RABC-SAS/projects/2', closed: false, viewerCanUpdate: true };
  const types = config.issue_types.filter(name => !missingType || name !== 'Initiative').map((name, id) => ({ id, name, is_enabled: true }));
  const fields = nativeFields(config).filter(field => !missingField || field.name !== 'Cost Centre');
  const statusField = { id: 'STATUS_TARGET', name: 'Status', dataType: 'SINGLE_SELECT', options: config.project.statuses.map((name, i) => ({ id: `OPTION_${i}`, name })) };
  const issues = [];
  const items = [];
  const rulesets = [];
  const branch = { name: 'main', protected: false, commit: { sha: 'c'.repeat(40) } };
  const repo = { full_name: `${pilot.organization}/${pilot.repository}`, visibility: 'public', default_branch: 'main', permissions: { push: true, admin: true }, allow_auto_merge: false };
  const prerequisites = { codeowners: null, checkSuccess: true, reviewerPermission: 'admin', errors: [] };
  let projectExists = !missingProject;
  const mutations = [];
  const api = new GitHub({ transport: async (path, { method, body }) => {
    const clean = path.replace(/[?&]per_page=100&page=\d+/, '');
    if (method !== 'GET' && !(path === 'graphql' && body.query.startsWith('query'))) mutations.push({ path, method, body });
    if (path === 'user') return { login: pilot.expected_actor };
    if (path === `repos/${pilot.organization}/${pilot.repository}`) return repo;
    if (path === 'graphql') {
      const query = body.query;
      if (query.includes('createProjectV2')) { projectExists = true; return { data: { createProjectV2: { projectV2: project } } }; }
      if (query.includes('addProjectV2ItemById')) {
        const item = { id: 'ITEM_OWNED', content: { __typename: 'Issue', id: 'ISSUE_NODE', number: 100, repository: { nameWithOwner: `${pilot.organization}/${pilot.repository}` } }, fieldValueByName: null };
        items.push(item);
        return { data: { addProjectV2ItemById: { item } } };
      }
      if (query.includes('fields(first:100')) return { data: { node: { fields: { nodes: [statusField], pageInfo: { hasNextPage: false } } } } };
      if (query.includes('items(first:100')) return { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false } } } } };
      if (query.includes('projectsV2(first:100')) return { data: { organization: { id: 'ORG_TARGET', projectsV2: { nodes: projectExists ? [project] : [], pageInfo: { hasNextPage: false } } } } };
      if (query.includes('projectV2(number:')) return { data: { organization: { login: pilot.organization, projectV2: projectExists ? project : null } } };
      if (query.includes('organization(login:')) return { data: { organization: { id: 'ORG_TARGET' } } };
    }
    if (clean === `orgs/${pilot.organization}/issue-types`) {
      if (denied) throw new ApiError(403, 'Denied');
      if (method === 'POST') { const row = { ...body, id: 90 }; types.push(row); return row; }
      return types;
    }
    if (clean === `orgs/${pilot.organization}/issue-fields`) {
      if (method === 'POST') { const row = { ...body, id: 80 + fields.length }; fields.push(row); return row; }
      return fields;
    }
    if (clean.endsWith('/issues?state=all')) return issues;
    if (clean.endsWith('/issues') && method === 'POST') {
      const created = { ...body, type: { name: body.type }, id: 100, number: 100, node_id: 'ISSUE_NODE', state: 'open', html_url: 'https://github.com/RABC-SAS/bv-agile-framework/issues/100' };
      issues.push(created);
      if (autoAdd) items.push({ id: 'AUTO_ITEM', content: { __typename: 'Issue', id: created.node_id, number: 100, repository: { nameWithOwner: `${pilot.organization}/${pilot.repository}` } }, fieldValueByName: null });
      return created;
    }
    if (path.endsWith('/issues/100')) {
      if (method === 'PATCH') Object.assign(issues[0], body);
      return issues[0];
    }
    if (path.endsWith('/protection')) throw new ApiError(404, 'Branch not protected');
    if (path.endsWith('/branches/main')) return structuredClone(branch);
    if (clean.split('?')[0].endsWith('/rulesets')) {
      if (method === 'POST') {
        const row = { ...structuredClone(body), id: 700 };
        rulesets.push(row);
        return structuredClone(row);
      }
      return structuredClone(rulesets);
    }
    if (path.endsWith('/rulesets/700')) return structuredClone(rulesets[0]);
    if (path.includes('/contents/.github/CODEOWNERS?ref=')) return {
      type: 'file', encoding: 'base64', content: Buffer.from(prerequisites.codeowners ?? `* ${pilot.controls.human_reviewers.map(login => `@${login}`).join(' ')}`).toString('base64'),
    };
    if (path.includes('/codeowners/errors?ref=')) return { errors: prerequisites.errors };
    if (path.includes('/collaborators/')) return {
      user: { login: path.split('/collaborators/')[1].split('/')[0], type: 'User' }, permission: prerequisites.reviewerPermission,
    };
    if (path.includes('/check-runs?')) return {
      total_count: 1, check_runs: [{ name: pilot.controls.expected_check, app: { id: pilot.controls.expected_app_id }, head_sha: branch.commit.sha, status: 'completed', conclusion: prerequisites.checkSuccess ? 'success' : 'failure' }],
    };
    if (path.endsWith('/actions/permissions')) return { enabled: true, allowed_actions: 'all' };
    if (path.endsWith('/actions/permissions/workflow')) return { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false };
    if (path.includes('/environments')) return { total_count: 0, environments: [] };
    throw new Error(`Unexpected mock request ${method} ${path}`);
  } });
  return { api, pilot, config, mutations, issues, items, branch, repo, rulesets, prerequisites };
}

function temporaryLedger(t, repository = 'RABC-SAS/bv-agile-framework') {
  const directory = mkdtempSync(join(tmpdir(), 'bv-pilot-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new Ledger(join(directory, 'manifest.json'), { repository });
}

test('preflight/plan discover target IDs and propose controls without any writes', async () => {
  const { api, pilot, config, mutations } = fakeGitHub();
  api.dryRun = true;
  const state = await preflight(api, pilot, config);
  assert.deepEqual(state.access_errors, []);
  assert.equal(state.protection.protected, false);
  const planned = plan(pilot, config, state);
  assert.equal(planned.controls.state, 'PROPOSED_NOT_APPLIED');
  assert.match(planned.controls.apply_command, /apply-controls/);
  assert.equal(planned.blocked, false);
  assert.deepEqual(mutations, []);
  assert.equal(planned.plan_hash.length, 64);
});

test('preflight reports missing access and marks plan blocked, never PASS defaults', async () => {
  const { api, pilot, config } = fakeGitHub({ denied: true });
  const state = await preflight(api, pilot, config);
  assert.ok(state.access_errors.some(row => /types/.test(row.capability)));
  assert.equal(plan(pilot, config, state).blocked, true);
});

test('dry-run plan detects native field, disabled type and shared status conflicts', async () => {
  const { api, pilot, config } = fakeGitHub();
  const state = await preflight(api, pilot, config);
  state.types[0].is_enabled = false;
  state.fields[0].data_type = 'number';
  state.project.fields[0].options.pop();
  const result = plan(pilot, config, state);
  assert.equal(result.blocked, true);
  assert.equal(result.conflicts.length, 3);
  assert.equal(api.writes, 0);
});

test('bootstrap adds only missing definitions; reexecution performs zero writes', async t => {
  const { api, pilot, config, mutations } = fakeGitHub({ missingType: true, missingField: true });
  const ledger = temporaryLedger(t);
  await bootstrap(api, ledger, pilot, config);
  assert.equal(mutations.length, 2);
  assert.ok(ledger.data.resources.some(row => row.kind === 'type' && row.name === 'Initiative' && row.owned));
  assert.ok(ledger.data.resources.some(row => row.kind === 'field' && row.name === 'Cost Centre' && row.owned));
  const count = api.writes;
  await bootstrap(api, ledger, pilot, config);
  assert.equal(api.writes, count);
  assert.equal(ledger.data.operations.filter(row => row.state === 'pending').length, 0);
});

test('new project bootstrap discovers organization ID instead of reusing source IDs', async t => {
  const { api, pilot, config, mutations } = fakeGitHub({ missingProject: true });
  config.project.number = null;
  pilot.project.number = null;
  const result = await bootstrap(api, temporaryLedger(t), pilot, config);
  assert.equal(result.number, 2);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.variables.owner, 'ORG_TARGET');
});

test('explicit missing project never creates a substitute', async t => {
  const { api, pilot, config, mutations } = fakeGitHub({ missingProject: true });
  await assert.rejects(bootstrap(api, temporaryLedger(t), pilot, config), /identity mismatch/);
  assert.deepEqual(mutations, []);
});

for (const autoAdd of [false, true]) {
  test(`fixtures ownership, idempotency and close-only cleanup; auto-add=${autoAdd}`, async t => {
    const { api, pilot, config, issues, mutations } = fakeGitHub({ autoAdd });
    const ledger = temporaryLedger(t);
    const created = await fixtures(api, ledger, pilot, config);
    assert.equal(created.mode, 'SIMULATED');
    assert.equal(issues.length, 1);
    const count = mutations.length;
    await fixtures(api, ledger, pilot, config);
    assert.equal(mutations.length, count);
    await assert.rejects(fixtures(api, temporaryLedger(t), pilot, config), /Unowned/);
    await cleanup(api, ledger, pilot);
    assert.equal(issues[0].state, 'closed');
    const closedCount = mutations.length;
    await cleanup(api, ledger, pilot);
    assert.equal(mutations.length, closedCount);
    assert.ok(mutations.every(row => row.method !== 'DELETE'));
    assert.ok(issues[0].body.includes('[ ] [Humano real]'));
  });
}

test('fixture edits prevent cleanup; unrelated resources are never adopted', async t => {
  const { api, pilot, config, issues } = fakeGitHub();
  const ledger = temporaryLedger(t);
  await fixtures(api, ledger, pilot, config);
  issues[0].body += '\nExternal write';
  await assert.rejects(cleanup(api, ledger, pilot), /drift/);
  assert.equal(issues[0].state, 'open');
});

test('recorded pending membership can be recovered read-only, not blindly repeated', async t => {
  const { api, pilot, config, mutations } = fakeGitHub();
  const ledger = temporaryLedger(t);
  await fixtures(api, ledger, pilot, config);
  const operation = ledger.data.operations.at(-1);
  operation.state = 'pending';
  ledger.save();
  const count = mutations.length;
  const recovered = await recover(api, ledger, pilot, config);
  assert.equal(mutations.length, count);
  assert.equal(operation.state, 'verified');
  assert.equal(recovered.journal_updated, true);
  operation.state = 'pending';
  operation.response.id = 'FOREIGN_ITEM';
  await assert.rejects(recover(api, ledger, pilot, config), /not recorded/);
});

test('dry-run blocks REST and GraphQL mutations and pagination has a finite bound', async () => {
  let calls = 0;
  const api = new GitHub({ dryRun: true, transport: async () => { calls += 1; return Array(100).fill({}); } });
  await assert.rejects(api.request('repos/example/pilot/issues', { method: 'POST', body: {} }), /Dry-run/);
  await assert.rejects(api.graphql('mutation {x}', {}, { mutation: true }), /Dry-run/);
  assert.equal(calls, 0);
  await assert.rejects(api.list('orgs/example/issue-types'), /limit/);
  assert.equal(calls, 100);
});

test('manifest rejects local storage, foreign target and interrupted operations', t => {
  assert.throws(() => new Ledger(join(process.cwd(), 'local-manifest.json'), { repository: target.repository }), /outside/);
  const ledger = temporaryLedger(t, target.repository);
  ledger.save();
  assert.throws(() => new Ledger(ledger.path, { repository: 'another/repo' }), /mismatch/);
  ledger.data.operations.push({ state: 'pending' });
  ledger.save();
  assert.throws(() => new Ledger(ledger.path, { repository: target.repository }), /interrupted/);
});

test('CLI simulation is offline, persistent and explicit writes require exact confirmation', t => {
  const ledger = temporaryLedger(t);
  const output = execFileSync(process.execPath, ['scripts/pilot.mjs', 'simulate', '--manifest', ledger.path], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).mode, 'SIMULATED');
  assert.equal(JSON.parse(readFileSync(ledger.path, 'utf8')).evidence.length, 1);
  for (const args of [
    ['bootstrap', '--apply'], ['fixtures', '--apply', '--confirm', 'wrong/repo'], ['cleanup', '--apply', '--dry-run'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/pilot.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /confirm|mutually exclusive/);
  }
});

test('portable config changes all coordinates and rejects real logins as simulated roles', t => {
  const ledger = temporaryLedger(t);
  const original = readFileSync('.github/planning/pilot.yml', 'utf8');
  const path = join(ledger.path, '..', 'portable.yml');
  writeFileSync(path, original.replace('organization: RABC-SAS', 'organization: destination').replace('repository: bv-agile-framework', 'repository: demo').replace('number: 2', 'number: null'));
  const { pilot, config } = loadPilot(path);
  assert.equal(config.organization, 'destination');
  assert.equal(config.repository, 'demo');
  assert.equal(config.project.owner, 'destination');
  assert.equal(config.project.number, null);
  assert.equal(pilot.roles.human, roles.human);
  writeFileSync(path, original.replace('human: simulated-human', 'human: roanboc'));
  assert.throws(() => loadPilot(path), /fictitious/);
  writeFileSync(path, original.replace(/organization: RABC-SAS\r?\n/, ''));
  assert.throws(() => loadPilot(path), /Invalid pilot target/);
});

test('documentation relative links resolve to concrete files', () => {
  for (const file of ['README.md', 'SETUP.md']) {
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (match[1].startsWith('https://')) continue;
      assert.equal(existsSync(match[1].split('#')[0]), true, `${file}: ${match[1]}`);
    }
  }
});

async function signedControlPlan(t, beforePlan = () => {}) {
  const fake = fakeGitHub();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  fake.pilot.controls.expected_app_id = 123456;
  fake.pilot.controls.human_reviewers = ['human-reviewer'];
  fake.pilot.controls.authorization_signer = 'human-reviewer';
  fake.pilot.controls.authorization_public_key = publicKey.export({ type: 'spki', format: 'pem' });
  beforePlan(fake);
  const state = await preflight(fake.api, fake.pilot, fake.config);
  const saved = plan(fake.pilot, fake.config, state);
  const currentTime = Math.max(Date.now(), saved.generated_at + 1);
  const authorization = {
    kind: 'human-signed-control-plan', signer: 'human-reviewer', repository: saved.repository,
    plan_hash: saved.plan_hash, issued_at: saved.generated_at, expires_at: saved.expires_at,
    nonce: 'synthetic-test-authorization-0001',
  };
  authorization.signature = sign(null, Buffer.from(authorizationMessage(authorization)), privateKey).toString('base64');
  return { ...fake, saved, authorization, ledger: temporaryLedger(t), options: { now: currentTime, confirmHash: saved.plan_hash } };
}

test('administrative adapter creates and reads back one owned ruleset only with complete signed prerequisites', async t => {
  const f = await signedControlPlan(t);
  const result = await applyControls(f.api, f.ledger, f.pilot, f.config, f.saved, f.authorization, f.options);
  assert.equal(result.applied, 'new-owned-branch-ruleset-only');
  assert.equal(result.verified_configuration, true);
  assert.equal(result.effective_human_workflow_proven, false);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0].method, 'POST');
  assert.match(f.mutations[0].path, /\/rulesets$/);
  assert.deepEqual(f.mutations[0].body.bypass_actors, []);
  assert.equal(rulesetMatches(f.rulesets[0], rulesetBody(f.saved)), true);
  assert.ok(f.ledger.data.resources.some(resource => resource.kind === 'pilot-ruleset' && resource.id === 700 && resource.owned));
  await assert.rejects(applyControls(f.api, f.ledger, f.pilot, f.config, f.saved, f.authorization, f.options), /already consumed/);
  assert.equal(f.mutations.length, 1);
});

for (const [name, before, after, reason] of [
  ['missing App', f => { f.pilot.controls.expected_app_id = null; }, () => {}, /Select actual/],
  ['missing human key', f => { f.pilot.controls.authorization_public_key = null; }, () => {}, /out-of-band/],
  ['foreign ruleset', f => { f.rulesets.push({ id: 8, name: 'foreign' }); }, () => {}, /Existing branch/],
  ['auto merge enabled', f => { f.repo.allow_auto_merge = true; }, () => {}, /Disable auto-merge/],
  ['invalid codeowners', () => {}, f => { f.prerequisites.codeowners = '* @different-human'; }, /CODEOWNERS/],
  ['codeowners GitHub errors', () => {}, f => { f.prerequisites.errors = [{ message: 'invalid owner' }]; }, /invalid CODEOWNERS/],
  ['reviewer without write access', () => {}, f => { f.prerequisites.reviewerPermission = 'read'; }, /write access/],
  ['human signer without administrative recovery', () => {}, f => { f.prerequisites.reviewerPermission = 'write'; }, /retain repository administration/],
  ['failed check', () => {}, f => { f.prerequisites.checkSuccess = false; }, /not deployed/],
  ['new branch SHA', () => {}, f => { f.branch.commit.sha = 'b'.repeat(40); }, /baseline/],
  ['concurrent foreign ruleset', () => {}, f => { f.rulesets.push({ id: 8, name: 'foreign' }); }, /baseline/],
  ['different target', () => {}, f => { f.pilot.repository = 'other'; }, /target\/configuration/],
  ['tampered plan', () => {}, f => { f.saved.controls.proposed.enforce_admins = false; }, /Plan hash/],
  ['wrong explicit hash', () => {}, f => { f.options.confirmHash = '0'.repeat(64); }, /Plan hash/],
  ['expired plan', () => {}, f => { f.options.now = f.saved.expires_at; }, /expired/],
  ['expired authorization', () => {}, f => { f.authorization.expires_at = f.options.now; }, /expired/],
  ['simulation authorization', () => {}, f => { f.authorization.kind = 'SIMULATED'; }, /Independent human/],
  ['delegated signer', () => {}, f => { f.authorization.signer = f.pilot.expected_actor; }, /Independent human/],
  ['invalid signature', () => {}, f => { f.authorization.signature = Buffer.alloc(64).toString('base64'); }, /signature invalid/],
]) {
  test(`administrative rejection with ZERO writes: ${name}`, async t => {
    const f = await signedControlPlan(t, before);
    after(f);
    await assert.rejects(applyControls(f.api, f.ledger, f.pilot, f.config, f.saved, f.authorization, f.options), reason);
    assert.equal(f.api.writes, 0);
    assert.deepEqual(f.mutations, []);
    assert.equal(f.ledger.data.operations.length, 0);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { loadConfig, validateIssue, formDocuments } from '../scripts/policy.mjs';
import { GitHub, projectStatuses } from '../scripts/api.mjs';
import { reportResult } from '../scripts/validation.mjs';

const config = loadConfig();
const complete = '### Acceptance Criteria\n- [ ] Integration tests pass\n\n### Delivery Evidence\n[Build](https://example.com/build)';
const issue = (type, id = 1, body = '') => ({ id, type: type === null ? null : { name: type }, body });
const state = (status, body = '', type = 'Feature') => ({ issue: issue(type, 1, body), status, orgFields: [{ id: 3, name: 'Cost Centre', data_type: 'text' }], fieldValues: [] });

test('status gates are cumulative and do not prevent Backlog creation', () => {
  assert.deepEqual(validateIssue(config, state('Backlog')), []);
  assert.deepEqual(validateIssue(config, state(null)), []);
  assert.match(validateIssue(config, state('Ready')).join('\n'), /Acceptance Criteria/);
  assert.doesNotMatch(validateIssue(config, state('Ready')).join('\n'), /Delivery Evidence/);
  const criteria = '### Acceptance Criteria\n- [ ] Integration tests pass';
  assert.deepEqual(validateIssue(config, state('Ready', criteria)), []);
  assert.deepEqual(validateIssue(config, state('In progress', criteria)), []);
  for (const status of ['In review', 'Done']) {
    assert.match(validateIssue(config, state(status, criteria)).join('\n'), /Delivery Evidence/);
    assert.deepEqual(validateIssue(config, state(status, complete)), []);
  }
  for (const type of ['Initiative', 'Epic', 'Feature', 'User Story']) assert.match(validateIssue(config, state('Ready', '', type)).join('\n'), /Acceptance Criteria/);
  for (const type of ['Bug Story', 'Task', null]) assert.deepEqual(validateIssue(config, state('Done', '', type)), []);
});

test('required content rejects placeholders, fake headings and duplicates', () => {
  for (const content of ['', ' \t\n', 'TBD', '_No response_', '<!-- evidence -->', '- [ ]', '\u200b']) {
    assert.match(validateIssue(config, state('Ready', `### Acceptance Criteria\n${content}`)).join('\n'), /Acceptance Criteria/);
  }
  for (const body of ['```md\n### Acceptance Criteria\nDone\n```', '> ### Acceptance Criteria\n> Done', `${complete}\n### Acceptance Criteria\nDone`]) assert.match(validateIssue(config, state('Ready', body)).join('\n'), /Acceptance Criteria/);
});

test('hierarchy, terminal leaves, cycles and unreadable status fail explicitly', () => {
  for (const [parent, child] of [['Feature', 'Task'], ['User Story', 'Epic'], [null, 'Task']]) assert.match(validateIssue(config, { ...state('Backlog', '', child), parent: issue(parent, 2) }).join('\n'), /Disallowed hierarchy/);
  assert.match(validateIssue(config, { ...state('Backlog', '', null), children: [issue('Task', 2)] }).join('\n'), /terminal/);
  assert.match(validateIssue(config, { ...state('Backlog'), ancestors: [issue('Epic', 2), issue('Feature', 1)] }).join('\n'), /cycle/);
  assert.match(validateIssue(config, state(undefined)).join('\n'), /unreadable/);
  assert.match(validateIssue(config, state('Unknown')).join('\n'), /Unknown project status/);
});

test('YAML extension adds a new gated body section without validator changes', () => {
  const extended = structuredClone(config);
  extended.fields.security_review = { name: 'Security Review', storage: 'issue_body', heading: 'Security Review', form_id: 'security_review', applies_to: ['Feature'], required_on: ['Feature'], required_from_status: 'In review' };
  assert.deepEqual(validateIssue(extended, state('Ready', complete)), []);
  assert.match(validateIssue(extended, state('In review', complete)).join('\n'), /Security Review/);
  assert.deepEqual(validateIssue(extended, state('In review', `${complete}\n### Security Review\nReviewed by security team`)), []);
  assert.match(formDocuments(extended).get('feature.yml'), /security_review/);
});

test('forms reflect applicability and sections remain optional at creation', () => {
  const documents = formDocuments(config);
  assert.equal(documents.size, 7);
  const feature = YAML.parse(documents.get('feature.yml'));
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.body.find(field => field.id === 'acceptance_criteria').validations.required, false);
  assert.equal(feature.body.find(field => field.id === 'delivery_evidence').validations.required, false);
  assert.doesNotMatch(documents.get('bug_story.yml'), /acceptance_criteria/);
  assert.equal(YAML.parse(documents.get('untyped_issue.yml')).type, undefined);
});

test('dry-run allows GraphQL reads but blocks writes before transport', async () => {
  const api = new GitHub({ dryRun: true, transport: () => ({ data: {} }) });
  await api.graphql('query { viewer { login } }');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(api.request('repos/test/repo/issues', { method }), /Dry-run blocked/);
  await assert.rejects(api.graphql('mutation { example }', {}, { mutation: true }), /Dry-run blocked/);
  assert.equal(api.writes, 0);
});

test('project Status reads paginate, use node/repository identity and fail on redacted items', async () => {
  const transport = (_path, { body }) => {
    if (body.query.includes('organization')) return { data: { organization: { login: config.project.owner, projectV2: { id: 'PVT_test', number: 2, title: config.project.title, closed: false } } } };
    if (body.query.includes('fields(first')) return { data: { node: { fields: { nodes: [{ id: 'STATUS', name: 'Status', dataType: 'SINGLE_SELECT', options: config.project.statuses.map(name => ({ name })) }], pageInfo: { hasNextPage: false } } } } };
    return { data: { node: { items: { nodes: [{ id: 'ITEM', content: { __typename: 'Issue', id: 'ISSUE', number: 1, repository: { nameWithOwner: 'RABC-SAS/bv-agile-framework' } }, fieldValueByName: { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Ready', field: { id: 'STATUS' } } }], pageInfo: { hasNextPage: false } } } } };
  };
  const api = new GitHub({ dryRun: true, transport });
  assert.equal((await projectStatuses(api, config)).items.get('ISSUE').status, 'Ready');
  const redacted = new GitHub({ transport: (path, options) => options.body.query.includes('items(first') ? { data: { node: { items: { nodes: [{ content: null }], pageInfo: { hasNextPage: false } } } } } : transport(path, options) });
  await assert.rejects(projectStatuses(redacted, config), /redacted/);
});

test('unchanged report and dry-run make no comment writes', async () => {
  const body = `${config.validation.marker}\n## Agile Policy: PASS\n\nNo YAML policy violations.`;
  const api = new GitHub({ transport: () => [{ id: 2, body, user: { login: 'reporter' } }] });
  assert.equal((await reportResult(api, null, 'test/repo', 1, [], 'reporter', config.validation.marker)).changed, false);
  assert.equal(api.writes, 0);
});
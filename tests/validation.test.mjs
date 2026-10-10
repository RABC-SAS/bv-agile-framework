import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../scripts/api.mjs';
import { parentOf, reportResult, reconcile } from '../scripts/validation.mjs';
import { loadConfig, marker, bodyMode } from '../scripts/policy.mjs';

const config = loadConfig();
config.field_storage.decision = bodyMode;
const issue = { id: 42, node_id: 'I_42', number: 42, html_url: 'https://github.com/test/repo/issues/42', type: { name: 'Task' }, body: '' };
const orgFields = [{ id: 1, name: 'Cost Centre', data_type: 'text' }];

test('null GraphQL parent node is access failure, not a missing parent', async () => {
  const api = new GitHub({ transport: () => ({ data: { node: null } }) });
  await assert.rejects(parentOf(api, issue), /unreadable or redacted/);
});

test('matching report is a no-op and dry-run never creates or edits comments', async () => {
  const body = `${marker}\n## Agile Policy: PASS\n\nNo YAML policy violations.`;
  const api = new GitHub({ transport: () => [{ id: 2, body, user: { login: 'bot' } }] });
  assert.equal((await reportResult(api, null, 'test/repo', 42, [], 'bot')).changed, false);
  assert.equal(api.writes, 0);
  const dryRun = new GitHub({ dryRun: true, transport: () => [] });
  assert.equal((await reportResult(dryRun, null, 'test/repo', 42, ['Violation'], 'bot')).planned, true);
  assert.equal(dryRun.writes, 0);
});

test('duplicate and foreign markers fail without modifying comments', async () => {
  for (const comments of [[{ body: marker, user: { login: 'other' } }], [{ body: marker, user: { login: 'bot' } }, { body: marker, user: { login: 'bot' } }]]) {
    const api = new GitHub({ transport: () => comments });
    await assert.rejects(reportResult(api, null, 'test/repo', 42, [], 'bot'), /unmanaged result marker/);
    assert.equal(api.writes, 0);
  }
});

test('reconciliation catches API-created blank required issues without any event', async () => {
  const api = new GitHub({ dryRun: true, transport: (path, { body }) => {
    if (path === 'graphql') return { data: { node: { id: 'I_42', parent: null } } };
    if (path.includes('orgs/')) return orgFields;
    if (path.endsWith('/issues/42')) return { ...issue, type: { name: 'Feature' } };
    return [];
  } });
  const result = await reconcile(api, null, config, { numbers: [42], actor: 'bot' });
  assert.equal(result.violations, 1);
  assert.match(result.results[0].errors.join('\n'), /Acceptance Criteria.*required/);
  assert.equal(api.writes, 0);
});
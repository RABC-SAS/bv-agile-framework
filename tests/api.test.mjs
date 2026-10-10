import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHub, Ledger, projectState, ApiError } from '../scripts/api.mjs';
import { provision, publishReport } from '../scripts/operations.mjs';
import { loadConfig } from '../scripts/policy.mjs';

test('dry-run blocks every REST write and GraphQL mutation before transport', async () => {
  let calls = 0;
  const api = new GitHub({ dryRun: true, transport: () => { calls += 1; return {}; } });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(api.request('repos/test/repo/issues', { method }), /Dry-run blocked/);
  await assert.rejects(api.graphql('mutation { test }', {}, { mutation: true }), /Dry-run blocked/);
  assert.equal(calls, 0);
  assert.equal(api.writes, 0);
  await api.graphql('query { viewer { login } }');
  assert.equal(calls, 1);
  assert.equal(api.writes, 0);
});

test('REST inventories paginate completely', async () => {
  const api = new GitHub({ transport: path => new URL(path, 'https://api.github.com/').searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, index) => ({ id: index })) : [{ id: 100 }] });
  assert.equal((await api.list('orgs/test/issue-fields')).length, 101);
});

test('manifest refuses repo-local paths and dry-run cannot create a manifest', () => {
  assert.throws(() => new Ledger('local-manifest.json', { repository: 'test/repo' }), /outside/);
  const root = mkdtempSync(join(tmpdir(), 'bv-agile-ledger-test-'));
  try {
    const path = join(root, 'manifest.json');
    const ledger = new Ledger(path, { dryRun: true, repository: 'test/repo' });
    ledger.record({ kind: 'issue', id: 1, owned: true });
    ledger.save();
    assert.equal(existsSync(path), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('write records owned identity before read-back and rejects silent failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bv-agile-ledger-test-'));
  try {
    const path = join(root, 'manifest.json');
    const ledger = new Ledger(path, { repository: 'test/repo' });
    await assert.rejects(ledger.write('assign type', { type: null }, async () => ({ id: 2 }), async () => {
      assert.equal(JSON.parse(readFileSync(path)).resources[0].id, 2);
      return { type: null };
    }, after => after.type === 'Feature', response => ({ kind: 'issue', id: response.id, owned: true })), /Read-back verification failed/);
    assert.throws(() => new Ledger(path, { repository: 'test/repo' }), /interrupted/);
  } finally { rmSync(root, { recursive: true }); }
});

test('project identity is exact and redacted field nodes fail closed', async () => {
  const config = loadConfig();
  const api = new GitHub({ transport: () => ({ data: { organization: { login: 'RABC-SAS', projectV2: { number: 2, title: 'Wrong', closed: false } } } }) });
  await assert.rejects(projectState(api, config), /identity mismatch/);
  const redacted = new GitHub({ transport: (_path, { body }) => ({ data: body.query.includes('organization') ? { organization: { login: 'RABC-SAS', projectV2: { id: 'PVT_test', number: 2, title: config.smoke_test.project_title, closed: false } } } : { node: { fields: { nodes: [null], pageInfo: { hasNextPage: false } } } } }) });
  await assert.rejects(projectState(redacted, config), /redacted/);
});

test('permission-denied writes remain recorded but do not masquerade as interrupted successes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bv-agile-ledger-test-'));
  try {
    const path = join(root, 'manifest.json');
    const ledger = new Ledger(path, { repository: 'test/repo' });
    await assert.rejects(ledger.write('forbidden create', null, async () => { throw new ApiError(403, 'Forbidden'); }, async () => null, () => false), /403/);
    assert.equal(new Ledger(path, { repository: 'test/repo' }).data.operations[0].state, 'permission_denied');
  } finally { rmSync(root, { recursive: true }); }
});

test('tracking report dry-run reads but never creates resources', async () => {
  const api = new GitHub({ dryRun: true, transport: () => [] });
  const result = await publishReport(api, { data: { resources: [] } }, loadConfig(), 'README.md');
  assert.equal(result.planned, true);
  assert.equal(api.writes, 0);
});

test('second provisioning run preserves owned identity and makes no writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bv-agile-ledger-test-'));
  try {
    const config = { ...loadConfig(), issue_types: ['Task'] };
    const ledger = new Ledger(join(root, 'manifest.json'), { repository: 'RABC-SAS/bv-agile-framework' });
    ledger.record({ kind: 'type', id: 1, name: 'Task', owned: true });
    const api = new GitHub({ transport: (path, { body }) => {
      if (path === 'graphql') return { data: body.query.includes('organization') ? { organization: { login: 'RABC-SAS', projectV2: { id: 'PVT_test', number: 2, title: config.smoke_test.project_title, closed: false } } } : { node: { fields: { nodes: [], pageInfo: { hasNextPage: false } } } } };
      if (path.startsWith('repos/')) return { permissions: { push: true } };
      return [{ id: 1, name: 'Task', is_enabled: true }];
    } });
    const result = await provision(api, ledger, config, 'type');
    assert.equal(result.writes, 0);
    assert.equal(ledger.data.resources[0].owned, true);
    assert.equal(ledger.data.operations.length, 0);
  } finally { rmSync(root, { recursive: true }); }
});
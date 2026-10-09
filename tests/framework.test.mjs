import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GitHub, loadConfig, getParent, root } from '../scripts/github.mjs';
import { hasContent, sections, validate, validateLive, report, marker } from '../scripts/validate-issue.mjs';
import { Setup } from '../scripts/setup-agile.mjs';

const config = loadConfig();
const body = '### Acceptance Criteria\n- [ ] Observable outcome\n\n### Delivery Evidence\nhttps://example.com/evidence';
const issue = (type, number = 1) => ({
  type: type === null ? null : { name: type }, body, number, id: number,
  node_id: `I_${number}`, html_url: `https://github.com/RABC-SAS/bv-agile-framework/issues/${number}`,
  repository_url: 'https://api.github.com/repos/RABC-SAS/bv-agile-framework',
});
const state = () => ({ repository: config.smoke_test.repository, runId: 'test-run', fixtures: {} });

test('all nine fixtures have valid parent-first hierarchy and required content', () => {
  const setup = new Setup({}, config, state(), false);
  const seen = new Map();
  for (const fixture of config.smoke_test.fixtures) {
    if (fixture.parent) assert.ok(seen.has(fixture.parent));
    const value = { ...issue(fixture.type, seen.size + 1), body: setup.fixtureBody(fixture) };
    const children = config.smoke_test.fixtures.filter(child => child.parent === fixture.key)
      .map(child => issue(child.type));
    assert.deepEqual(validate(config, value, seen.get(fixture.parent), children), []);
    seen.set(fixture.key, value);
  }
  assert.equal(seen.size, 9);
});

test('rejects missing, empty and placeholder required content on creation/edit bypasses', () => {
  for (const text of ['', ' \n ', '_No response_', 'N/A', 'none', 'TBD', 'TODO',
    '<!-- hidden -->', '<!-- hidden -->\n_No response_', '- [ ]', '```\n```', 'TBD\nTODO']) {
    assert.equal(hasContent(text), false, text);
    const value = { ...issue('Epic'), body: `### Acceptance Criteria\n${text}\n### Delivery Evidence\n${text}` };
    assert.equal(validate(config, value, issue('Initiative')).length, 2, text);
  }
  assert.equal(hasContent('- [ ] measurable outcome\n[link](https://example.com)'), true);
});

test('optional fields and terminal types do not acquire required fields', () => {
  for (const type of ['Bug Story', 'Task', null]) {
    assert.deepEqual(validate(config, { ...issue(type), body: '' }, null), []);
  }
  assert.deepEqual(validate(config, issue('User Story'), issue('Feature')), []);
  assert.equal(validate(config, { ...issue('Feature'), body: '' }, issue('Epic')).length, 2);
});

test('every disallowed parent-child combination is reported, including untyped parents', () => {
  const types = [...config.issue_types, null];
  for (const parent of types) {
    for (const child of types) {
      const allowed = config.hierarchy.find(rule => rule.parent === parent)?.children.includes(child);
      const violations = validate(config, issue(child), issue(parent));
      assert.equal(violations.length > 0, !allowed, `${parent} → ${child}`);
    }
  }
  for (const terminal of ['Task', null]) {
    assert.match(validate(config, issue(terminal), null, [issue('Task')]).join('\n'), /must be a leaf/);
  }
});

test('section extraction preserves multiline Markdown and ignores headings inside fences', () => {
  const values = sections(`${body}\n### Description\n\`\`\`md\n### Acceptance Criteria\n_No response_\n\`\`\``);
  assert.equal(values.get('Acceptance Criteria').trim(), '- [ ] Observable outcome');
  assert.equal(values.get('Delivery Evidence').trim(), 'https://example.com/evidence');
  assert.equal(sections('### Acceptance Criteria\r\nfirst\r\nsecond').get('Acceptance Criteria'), 'first\nsecond');
});

test('stable bot-owned marker is updated, user spoofed comments are not touched', () => {
  const writes = [];
  let comments = [{ id: 1, user: { login: 'someone', type: 'User' }, body: marker }];
  const api = { list: () => comments, request: (...args) => writes.push(args) };
  report(api, issue('Epic'), ['Missing content.']);
  assert.equal(writes[0][0], 'POST');
  comments.push({ id: 2, user: { login: 'github-actions[bot]', type: 'Bot' }, body: writes[0][2].body });
  report(api, issue('Epic'), ['Missing content.']);
  assert.equal(writes.length, 1);
  report(api, issue('Epic'), []);
  assert.equal(writes[1][0], 'PATCH');
  assert.ok(writes[1][1].endsWith('/issues/comments/2'));
  assert.match(writes[1][2].body, /All framework checks pass/);
});

test('REST pagination includes all pages and API errors fail closed', () => {
  const api = new GitHub();
  const endpoints = [];
  api.request = (method, endpoint, body, paginate) => {
    endpoints.push(endpoint);
    assert.equal(paginate, true);
    return [Array.from({ length: 100 }, (_, id) => ({ id })), [{ id: 100 }]];
  };
  assert.equal(api.list('orgs/RABC-SAS/issue-types').length, 101);
  assert.deepEqual(endpoints, ['orgs/RABC-SAS/issue-types']);
  for (const status of [403, 500]) {
    assert.throws(() => getParent({ request() { throw Object.assign(new Error('API failure'), { status }); } }, issue('Task')));
  }
  assert.equal(getParent({ request() { throw Object.assign(new Error('No parent'), { status: 404 }); } }, issue('Task')), null);
});

test('types and fields reconcile idempotently without altering unmanaged resources', () => {
  const types = config.issue_types.map((name, id) => ({ id, name, is_enabled: true }));
  types.push({ id: 99, name: 'Unmanaged', is_enabled: false });
  const fields = Object.values(config.fields).map((field, id) => ({ id, name: field.name, data_type: 'text' }));
  const writes = [];
  const api = { list: endpoint => endpoint.endsWith('issue-types') ? types : fields,
    request: (...args) => writes.push(args) };
  const setup = new Setup(api, config, state(), true);
  setup.types();
  setup.fields();
  assert.deepEqual(writes, []);
  types[1].is_enabled = false;
  setup.types();
  assert.equal(writes[0][0], 'PUT');
  assert.deepEqual(writes[0][2], { name: types[1].name, is_enabled: true });
  fields[0].data_type = 'number';
  assert.throws(() => setup.fields(), /incompatible/);
});

test('dry-run plans creation but makes no remote writes', () => {
  const api = { list: () => [], request() { assert.fail('Unexpected write'); } };
  const setup = new Setup(api, config, state(), false);
  setup.types();
  setup.fields();
});

test('project identity and state ownership must match before mutation', () => {
  const api = { graphql: () => ({ organization: { id: 'O_1', projectV2: {
    title: 'Unrelated', url: 'https://github.com/orgs/RABC-SAS/projects/2',
  } } }) };
  assert.throws(() => new Setup(api, config, state(), true).project(), /identity mismatch/);
  assert.throws(() => new Setup(api, config, { ...state(), repository: 'other/repo' }, true), /another repository/);
  const setup = new Setup({}, config, state(), true);
  assert.equal(setup.owned({ ...issue('Task'), body: setup.fixtureMarker('story_task') }, 'story_task'), true);
  assert.equal(setup.owned({ ...issue('Task'), body: '<!-- bv-agile-framework-smoke:another-run:story_task -->' }, 'story_task'), false);
});

test('cleanup closes owned fixtures and removes only items created by this run', () => {
  const stored = state();
  stored.fixtures.initiative = { id: 1, number: 1, ownedItemId: 'PVTI_owned' };
  stored.fixtures.epic = { id: 2, number: 2, itemId: 'PVTI_adopted' };
  const writes = [];
  let cleaned = false;
  const setup = new Setup({ request(method, endpoint, payload) {
    if (method === 'GET') {
      const key = endpoint.endsWith('/1') ? 'initiative' : 'epic';
      return { ...issue(key === 'initiative' ? 'Initiative' : 'Epic', key === 'initiative' ? 1 : 2),
        state: cleaned ? 'closed' : 'open', body: setup.fixtureMarker(key) };
    }
    writes.push({ method, endpoint, payload });
  }, graphql(query, variables) {
    writes.push({ query, variables });
    cleaned = true;
  } }, config, stored, true);
  setup.projectInfo = () => ({ project: { id: 'P_2' } });
  setup.projectItems = () => cleaned ? [{ id: 'PVTI_adopted', content: { id: 'I_2' } }] : [
    { id: 'PVTI_owned', content: { id: 'I_1' } },
    { id: 'PVTI_adopted', content: { id: 'I_2' } },
  ];
  setup.cleanup();
  assert.equal(writes.filter(value => value.method === 'PATCH').length, 2);
  assert.equal(writes.filter(value => value.query).length, 1);
  assert.equal(writes.find(value => value.query).variables.item, 'PVTI_owned');
  assert.equal(stored.cleanedUp, true);
});

test('forms enforce exactly configured fields, and workflow has minimal permissions', () => {
  const names = ['initiative', 'epic', 'feature', 'user_story', 'bug_story', 'task', 'issue'];
  const types = [...config.issue_types, null];
  for (const [index, name] of names.entries()) {
    const path = `${root}.github/ISSUE_TEMPLATE/${name}.yml`;
    const form = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
      'puts JSON.generate(YAML.safe_load_file(ARGV[0]))', path], { encoding: 'utf8' }));
    assert.equal(form.type ?? null, types[index]);
    for (const [key, field] of Object.entries(config.fields)) {
      const input = form.body.find(value => value.id === key);
      assert.equal(Boolean(input), (field.required_on ?? field.applies_to).includes(types[index]));
      if (input) assert.equal(input.validations.required, Boolean(field.required_on?.includes(types[index])));
    }
  }
  const workflow = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.safe_load_file(ARGV[0]))', `${root}.github/workflows/validate-issue.yml`],
  { encoding: 'utf8' }));
  assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
  assert.ok(Object.hasOwn(workflow.on, 'issues'));
  assert.ok(!readFileSync(`${root}scripts/validate-issue.mjs`, 'utf8').includes("request('DELETE'"));
});

test('smoke creation, rerun, API verification, live negative reports and cleanup lifecycle', () => {
  const stored = state();
  const issues = [];
  const parents = new Map();
  const items = [];
  const labels = [];
  const comments = new Map();
  let writes = 0;
  const api = {
    list(endpoint) {
      if (endpoint.endsWith('/issue-types')) return config.issue_types.map(name => ({ name, is_enabled: true }));
      if (endpoint.endsWith('/labels')) return labels;
      if (endpoint.includes('issues?state=all')) return issues;
      const number = Number(endpoint.match(/issues\/(\d+)/)?.[1]);
      if (endpoint.endsWith('/sub_issues')) return issues.filter(child => parents.get(child.id) === number);
      if (endpoint.endsWith('/comments')) return comments.get(number) ?? [];
      assert.fail(endpoint);
    },
    request(method, endpoint, payload) {
      const number = Number(endpoint.match(/issues\/(\d+)/)?.[1]);
      if (method === 'GET' && endpoint.endsWith('/parent')) {
        const parent = parents.get(number);
        if (!parent) throw Object.assign(new Error('No parent'), { status: 404 });
        return issues.find(value => value.id === parent);
      }
      if (method === 'GET') return issues.find(value => value.number === number);
      writes++;
      if (endpoint.endsWith('/labels')) {
        labels.push(payload);
        return payload;
      }
      if (method === 'POST' && endpoint.endsWith('/issues')) {
        const created = { ...issue(payload.type ?? null, issues.length + 1), body: payload.body, state: 'open' };
        issues.push(created);
        return created;
      }
      if (endpoint.endsWith('/sub_issues')) {
        assert.equal(payload.replace_parent, false);
        parents.set(payload.sub_issue_id, number);
        return issues.find(value => value.id === payload.sub_issue_id);
      }
      if (endpoint.endsWith('/comments')) {
        comments.set(number, [{ id: number, html_url: `https://example.com/comment/${number}`,
          user: { login: 'github-actions[bot]', type: 'Bot' }, ...payload }]);
        return;
      }
      if (method === 'PATCH') {
        Object.assign(issues.find(value => value.number === number), payload);
        return;
      }
      assert.fail(`${method} ${endpoint}`);
    },
    graphql(query, variables) {
      writes++;
      if (query.includes('addProjectV2ItemById')) {
        const item = { id: `PVTI_${items.length + 1}`, content: { id: variables.content } };
        items.push(item);
        return { addProjectV2ItemById: { item } };
      }
      if (query.includes('deleteProjectV2Item')) {
        items.splice(items.findIndex(item => item.id === variables.item), 1);
        return {};
      }
      assert.fail(query);
    },
  };
  const setup = new Setup(api, config, stored, true);
  setup.projectInfo = () => ({ project: { id: 'P_2', url: setup.projectURL } });
  setup.checkPins = () => {};
  setup.checkProject = () => {};
  setup.projectItems = () => [...items];
  setup.smoke();
  assert.equal(issues.length, 9);
  assert.equal(parents.size, 8);
  assert.equal(items.length, 9);
  const firstWrites = writes;
  setup.smoke();
  assert.equal(writes, firstWrites);
  setup.verify();
  assert.equal(stored.verification.fixtures.length, 9);
  setup.negative();
  assert.equal(issues.length, 12);
  for (const fixture of config.smoke_test.negative_fixtures) {
    const value = setup.getFixture(fixture);
    report(api, value, validateLive(api, config, value).violations);
  }
  setup['verify-negative']();
  assert.equal(stored.negativeVerification.length, 3);
  const beforeNegativeRerun = writes;
  setup.negative();
  assert.equal(writes, beforeNegativeRerun);
  setup.cleanup();
  assert.ok(issues.every(value => value.state === 'closed'));
  assert.equal(items.length, 0);
  const beforeCleanupRerun = writes;
  setup.cleanup();
  assert.equal(writes, beforeCleanupRerun);
});

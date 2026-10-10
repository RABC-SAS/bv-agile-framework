import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, hasContent, sections, validateIssue, formDocuments, bodyMode, nativeMode } from '../scripts/policy.mjs';

const config = loadConfig();
const orgFields = Object.values(config.fields).map((field, index) => ({ id: index + 1, name: field.name, data_type: 'text' }));
const body = '### Acceptance Criteria\n- [ ] Shipping tests pass\n\n### Delivery Evidence\n[Build](https://example.com/build/1)';
const issue = (name, id = 1) => ({ id, number: id, type: name === null ? null : { name }, body });
const snapshot = (name, overrides = {}) => ({ issue: issue(name), orgFields, fieldValues: [], ...overrides });
const mode = decision => ({ ...config, field_storage: { ...config.field_storage, decision } });

test('source of truth targets the confirmed RABC project without changing fixture model', () => {
  assert.equal(config.organization, 'RABC-SAS');
  assert.equal(config.smoke_test.project_title, 'Agile Project Config');
  assert.equal(config.smoke_test.fixtures.length, 9);
});

test('pending storage fails closed', () => {
  assert.match(validateIssue(config, snapshot('Task')).join('\n'), /unresolved/);
});

test('required fallback types reject each missing section, whitespace and placeholders', () => {
  for (const name of ['Initiative', 'Epic', 'Feature', 'User Story']) {
    assert.deepEqual(validateIssue(mode(bodyMode), snapshot(name)), []);
    for (const field of [config.fields.acceptance_criteria, config.fields.delivery_evidence]) {
      for (const value of ['', ' \n\t', 'TBD', '_No response_', '- [ ]', '<!-- evidence -->']) {
        const changed = body.replace(field.fallback_heading === 'Acceptance Criteria' ? '- [ ] Shipping tests pass' : '[Build](https://example.com/build/1)', value);
        assert.match(validateIssue(mode(bodyMode), snapshot(name, { issue: { ...issue(name), body: changed } })).join('\n'), new RegExp(field.name));
      }
      const removed = field.fallback_heading === 'Acceptance Criteria' ? '### Delivery Evidence\nVerified build' : '### Acceptance Criteria\nVerified tests';
      assert.match(validateIssue(mode(bodyMode), snapshot(name, { issue: { ...issue(name), body: removed } })).join('\n'), new RegExp(field.name));
    }
  }
});

test('Markdown fences, quotes and comments cannot supply fake required headings', () => {
  assert.deepEqual(sections('```md\n### Acceptance Criteria\nvalid\n```', 'Acceptance Criteria'), []);
  assert.deepEqual(sections('> ### Acceptance Criteria\n> valid', 'Acceptance Criteria'), []);
  assert.equal(hasContent('<!-- real text -->'), false);
  assert.equal(hasContent('\u200b\u200c'), false);
  assert.equal(hasContent('### Heading only'), false);
  assert.equal(hasContent('- [x] Integration test passed'), true);
});

test('duplicate required headings fail and subheadings stay inside their section', () => {
  assert.equal(sections('### Acceptance Criteria\n#### Details\nDone\n### Delivery Evidence\nBuild', 'Acceptance Criteria').length, 1);
  assert.match(validateIssue(mode(bodyMode), snapshot('Feature', { issue: { ...issue('Feature'), body: `${body}\n### Acceptance Criteria\nExtra` } })).join('\n'), /duplicated/);
});

test('both story branches and their Task/untyped leaves pass; exempt Bug is untouched', () => {
  for (const fixture of config.smoke_test.fixtures) {
    const parent = config.smoke_test.fixtures.find(candidate => candidate.key === fixture.parent);
    assert.deepEqual(validateIssue(mode(bodyMode), snapshot(fixture.type, { parent: parent ? issue(parent.type, 2) : null })), []);
  }
  assert.deepEqual(validateIssue(mode(bodyMode), snapshot('Bug', { issue: { ...issue('Bug'), body: '' } })), []);
});

test('all requested illegal hierarchy cases and terminal leaves fail', () => {
  for (const [parent, child] of [['Feature', 'Task'], ['User Story', 'Epic'], [null, 'Task']]) {
    assert.match(validateIssue(mode(bodyMode), snapshot(child, { parent: issue(parent, 2) })).join('\n'), /Disallowed hierarchy/);
    assert.match(validateIssue(mode(bodyMode), snapshot(parent, { children: [issue(child, 2)] })).join('\n'), /Disallowed hierarchy/);
  }
  for (const terminal of ['Task', null]) assert.match(validateIssue(mode(bodyMode), snapshot(terminal, { children: [issue('Task', 2)] })).join('\n'), /terminal/);
  assert.match(validateIssue(mode(bodyMode), snapshot('Feature', { ancestors: [issue('Epic', 2), issue('Feature', 1)] })).join('\n'), /cycle/);
});

test('native fields require exact definitions, readable values and genuine content', () => {
  const values = orgFields.filter(field => field.name !== 'Cost Centre').map(field => ({ issue_field_id: field.id, data_type: 'text', value: '- [x] Tested\n[Build](https://example.com)' }));
  assert.deepEqual(validateIssue(mode(nativeMode), snapshot('Feature', { fieldValues: values })), []);
  assert.match(validateIssue(mode(nativeMode), snapshot('Feature')).join('\n'), /required/);
  assert.match(validateIssue(mode(nativeMode), snapshot('Feature', { fieldValues: undefined })).join('\n'), /unreadable/);
  assert.match(validateIssue(mode(nativeMode), snapshot('Feature', { orgFields: [...orgFields, orgFields[0]] })).join('\n'), /expected one/);
  assert.match(validateIssue(mode(nativeMode), snapshot('Feature', { orgFields: orgFields.map(field => ({ ...field, data_type: 'single_select' })) })).join('\n'), /expected one/);
});

test('Cost Centre applies only to its YAML types in either mode', () => {
  const costCentre = orgFields.find(field => field.name === 'Cost Centre');
  const values = [{ issue_field_id: costCentre.id, data_type: 'text', value: 'RABC-TEST' }];
  assert.deepEqual(validateIssue(mode(bodyMode), snapshot('Initiative', { fieldValues: values })), []);
  assert.match(validateIssue(mode(bodyMode), snapshot('Task', { fieldValues: values })).join('\n'), /does not apply/);
});

test('API or blank issues and type changes are validated without trusting forms', () => {
  assert.match(validateIssue(mode(bodyMode), snapshot('Feature', { issue: { ...issue('Feature'), body: '' } })).join('\n'), /required/);
  assert.throws(() => validateIssue(mode(bodyMode), snapshot('Task', { issue: { id: 1 } })), /unreadable/);
  const forms = formDocuments(mode(bodyMode));
  assert.equal(forms.size, 7);
  assert.match(forms.get('initiative.yml'), /acceptance_criteria/);
  assert.doesNotMatch(forms.get('bug_story.yml'), /acceptance_criteria/);
  assert.doesNotMatch(forms.get('untyped_issue.yml'), /^type:/m);
  assert.doesNotMatch(formDocuments(mode(nativeMode)).get('initiative.yml'), /acceptance_criteria/);
});
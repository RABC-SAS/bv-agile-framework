import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GitHub, loadConfig, issuePath, getParent } from './github.mjs';
import { validate, validateLive, marker } from './validate-issue.mjs';

const phases = ['probe', 'types', 'fields', 'project', 'smoke', 'verify', 'negative', 'verify-negative', 'cleanup'];
const viewName = 'bv-agile-framework-smoke';
const projectQuery = `query($org:String!, $number:Int!) {
  organization(login:$org) {
    id
    projectV2(number:$number) { id number title url viewerCanUpdate }
  }
}`;

export function uniqueByName(values, name) {
  const matches = values.filter(value => value.name === name);
  if (matches.length > 1) throw new Error(`Ambiguous resource name: ${name}`);
  return matches[0];
}

export class Setup {
  constructor(api, config, state, apply, save = () => {}) {
    Object.assign(this, { api, config, state, apply, save });
    this.repo = config.smoke_test.repository;
    this.org = config.organization;
    this.number = config.smoke_test.project_number_candidate;
    this.projectURL = `https://github.com/orgs/${this.org}/projects/${this.number}`;
    if (this.repo !== `${this.org}/${config.repository}`
        || config.smoke_test.project_owner !== this.org) {
      throw new Error('Configuration organization, repository and project owner must agree.');
    }
    if (state.repository !== this.repo) throw new Error('State belongs to another repository.');
  }

  record(key, value) {
    this.state[key] = value;
    this.save();
  }

  write(method, endpoint, body) {
    console.log(JSON.stringify({ apply: this.apply, method, endpoint, body }));
    return this.apply ? this.api.request(method, endpoint, body) : null;
  }

  mutate(query, variables) {
    console.log(JSON.stringify({ apply: this.apply, query, variables }));
    return this.apply ? this.api.graphql(query, variables) : null;
  }

  types() {
    const types = this.api.list(`orgs/${this.org}/issue-types`);
    for (const name of this.config.issue_types) {
      const existing = uniqueByName(types, name);
      const payload = { name, is_enabled: true };
      if (!existing) {
        const created = this.write('POST', `orgs/${this.org}/issue-types`, payload);
        if (created) types.push(created);
      } else if (!existing.is_enabled) {
        const updated = this.write('PUT', `orgs/${this.org}/issue-types/${existing.id}`, payload);
        if (updated) Object.assign(existing, updated);
      }
      this.record('types', types.filter(type => this.config.issue_types.includes(type.name)));
    }
  }

  fields() {
    const fields = this.api.list(`orgs/${this.org}/issue-fields`);
    for (const field of Object.values(this.config.fields)) {
      const existing = uniqueByName(fields, field.name);
      if (existing && existing.data_type !== field.native_type) {
        throw new Error(`${field.name} exists with incompatible type; it will not be replaced.`);
      }
      if (!existing) {
        const created = this.write('POST', `orgs/${this.org}/issue-fields`, {
          name: field.name, data_type: field.native_type,
        });
        if (created) fields.push(created);
      }
      this.record('fields', fields.filter(value =>
        Object.values(this.config.fields).some(field => field.name === value.name)));
    }
    console.log('Pin fields in organization Settings → Planning → Issue fields → Pin to types:');
    for (const field of Object.values(this.config.fields)) {
      console.log(`${field.name}: ${(field.required_on ?? field.applies_to).join(', ')}`);
    }
    console.log('Pinning writes are not exposed by the public API; verify checks the live pins.');
  }

  checkPins() {
    const data = this.api.graphql(`query($org:String!, $cursor:String) {
      organization(login:$org) {
        issueTypes(first:100, after:$cursor) {
          nodes { name pinnedFields { ... on Node { id } ... on IssueFieldCommon { name } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, { org: this.org, cursor: null });
    const connection = data.organization.issueTypes;
    // Organizations currently support at most 25 types; never silently truncate.
    if (connection.pageInfo.hasNextPage) throw new Error('Issue types pagination exceeds supported limit.');
    const missing = [];
    for (const field of Object.values(this.config.fields)) {
      for (const type of field.required_on ?? field.applies_to) {
        const actual = uniqueByName(connection.nodes, type);
        if (!(actual?.pinnedFields ?? []).some(pin => pin.name === field.name)) {
          missing.push(`${field.name} must be pinned to ${type}`);
        }
      }
    }
    this.record('pinningViolations', missing);
    if (missing.length) throw new Error(`Manual organization pinning required:\n${missing.join('\n')}`);
  }

  projectInfo(required = true) {
    const data = this.api.graphql(projectQuery, { org: this.org, number: this.number });
    if (!data.organization) throw new Error(`Organization not found: ${this.org}`);
    const project = data.organization.projectV2;
    if (!project) {
      if (required) throw new Error(`Project #${this.number} is missing; run project phase.`);
      return { owner: data.organization.id, project: null };
    }
    if (project.title !== this.config.smoke_test.project_title || project.url !== this.projectURL) {
      throw new Error(`Project identity mismatch: ${JSON.stringify(project)}; no changes made.`);
    }
    if (this.apply && !project.viewerCanUpdate) throw new Error('Project write permission is required.');
    this.record('project', project);
    return { owner: data.organization.id, project };
  }

  project() {
    let { owner, project } = this.projectInfo(false);
    if (!project) {
      if (this.state.createdProject) {
        throw new Error(`A prior creation returned a different project number: ${JSON.stringify(this.state.createdProject)}`);
      }
      const result = this.mutate(`mutation($owner:ID!, $title:String!) {
        createProjectV2(input:{ownerId:$owner, title:$title}) {
          projectV2 { id number title url viewerCanUpdate }
        }
      }`, { owner, title: this.config.smoke_test.project_title });
      if (!result) {
        console.log('Project number is allocated by GitHub, not selectable. Apply stops if it is not #2.');
        return;
      }
      project = result.createProjectV2.projectV2;
      this.record('createdProject', project);
      if (project.number !== this.number) {
        throw new Error(`GitHub allocated #${project.number}, not #${this.number}. Preserved ${project.url}; resolve manually.`);
      }
      this.projectInfo();
    }
    const endpoint = `orgs/${this.org}/projectsV2/${this.number}`;
    const orgFields = this.api.list(`orgs/${this.org}/issue-fields`);
    let fields = this.api.list(`${endpoint}/fields`);
    for (const field of Object.values(this.config.fields)) {
      const source = uniqueByName(orgFields, field.name);
      if (!source || source.data_type !== 'text') throw new Error(`Run fields phase first: ${field.name}`);
      if (!fields.some(value => value.issue_field_id === source.id)) {
        if (uniqueByName(fields, field.name)) {
          throw new Error(`Unmanaged project field shadows ${field.name}; no replacement will be made.`);
        }
        this.mutate(`mutation($project:ID!, $field:ID!) {
          createProjectV2IssueField(input:{projectId:$project, issueFieldId:$field}) {
            projectV2Field { ... on ProjectV2FieldCommon { id name } }
          }
        }`, { project: project.id, field: source.node_id });
      }
    }
    if (this.apply) fields = this.api.list(`${endpoint}/fields`);
    this.record('projectFields', fields);
    const system = ['title', 'issue_type', 'parent_issue'].map(type => {
      const field = fields.find(value => value.data_type === type);
      if (!field) throw new Error(`Native ${type} field is unavailable; enable it in the project UI.`);
      return field;
    });
    const visible = [...system, ...fields.filter(value =>
      Object.values(this.config.fields).some(field => field.name === value.name))];
    const filter = `repo:${this.repo} label:${this.config.smoke_test.marker}`;
    const views = this.projectViews(project);
    const existing = uniqueByName(views, viewName);
    if (existing) {
      const sameColumns = visible.every(field => existing.visible_fields?.includes(field.id));
      if (existing.filter !== filter || existing.layout !== 'table' || !sameColumns) {
        throw new Error('Existing smoke view differs. Preserve it and reconcile manually before continuing.');
      }
      this.record('view', existing);
    } else {
      const view = this.write('POST', `${endpoint}/views`, {
        name: viewName, layout: 'table', filter, visible_fields: visible.map(field => field.id),
      });
      if (view) this.record('view', view);
    }
  }

  projectViews(project) {
    const views = [];
    let cursor = null;
    do {
      const data = this.api.graphql(`query($id:ID!, $cursor:String) {
        node(id:$id) { ... on ProjectV2 {
          views(first:100, after:$cursor) {
            nodes { id name number layout filter
              configuration { visibleFields(first:100) {
                nodes { ... on ProjectV2FieldCommon { databaseId } }
                pageInfo { hasNextPage }
              } }
            }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`, { id: project.id, cursor });
      const connection = data.node.views;
      for (const view of connection.nodes) {
        if (view.configuration.visibleFields.pageInfo.hasNextPage) {
          throw new Error('View fields exceeded supported limit; refusing truncated comparison.');
        }
        views.push({ ...view, layout: view.layout === 'TABLE_LAYOUT' ? 'table' : view.layout,
          visible_fields: view.configuration.visibleFields.nodes.map(field => field.databaseId),
          url: `${project.url}/views/${view.number}` });
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return views;
  }

  checkProject(project) {
    const fields = this.api.list(`orgs/${this.org}/projectsV2/${this.number}/fields`);
    const sources = this.api.list(`orgs/${this.org}/issue-fields`);
    const required = ['title', 'issue_type', 'parent_issue'].map(type => {
      const field = fields.find(value => value.data_type === type);
      if (!field) throw new Error(`Missing project system field: ${type}`);
      return field;
    });
    for (const field of Object.values(this.config.fields)) {
      const source = uniqueByName(sources, field.name);
      const binding = source && fields.find(value => value.issue_field_id === source.id);
      if (!binding || source.data_type !== 'text') throw new Error(`Missing native project binding: ${field.name}`);
      required.push(binding);
    }
    const view = uniqueByName(this.projectViews(project), viewName);
    if (!view || view.layout !== 'table'
        || view.filter !== `repo:${this.repo} label:${this.config.smoke_test.marker}`
        || !required.every(field => view.visible_fields.includes(field.id))) {
      throw new Error('Smoke view is missing or has incompatible filter/columns; run project phase.');
    }
    this.record('view', view);
    this.record('projectFields', fields);
  }

  fixtureMarker(key) {
    return `<!-- ${this.config.smoke_test.marker}:${this.state.runId}:${key} -->`;
  }

  owned(issue, key) {
    return issue.body?.includes(this.fixtureMarker(key))
      && issue.repository_url === `https://api.github.com/repos/${this.repo}`;
  }

  fixtureBody(fixture) {
    const sections = ['### Description\nOwned hierarchy smoke fixture.'];
    for (const field of Object.values(this.config.fields)) {
      if (!fixture.omit_required_fields && (field.required_on ?? field.applies_to).includes(fixture.type)) {
        const value = field.name === 'Cost Centre' ? 'SMOKE'
          : field.name === 'Acceptance Criteria' ? '- [ ] Verify the configured hierarchy.'
            : `[Repository](https://github.com/${this.repo})\nCollect API verification results.`;
        sections.push(`### ${field.fallback_heading ?? field.name}\n${value}`);
      }
    }
    return `${this.fixtureMarker(fixture.key)}\n\n${sections.join('\n\n')}`;
  }

  projectItems(project) {
    const items = [];
    let cursor = null;
    do {
      const data = this.api.graphql(`query($id:ID!, $cursor:String) {
        node(id:$id) { ... on ProjectV2 {
          items(first:100, after:$cursor) {
            nodes { id content { ... on Issue { id } } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`, { id: project.id, cursor });
      const connection = data.node.items;
      items.push(...connection.nodes);
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return items;
  }

  smoke(fixtures = this.config.smoke_test.fixtures) {
    const { project } = this.projectInfo();
    this.checkPins();
    this.checkProject(project);
    const types = this.api.list(`orgs/${this.org}/issue-types`);
    for (const name of this.config.issue_types) {
      if (!uniqueByName(types, name)?.is_enabled) throw new Error(`Enable type first: ${name}`);
    }
    const issues = this.api.list(`repos/${this.repo}/issues?state=all`);
    let label = uniqueByName(this.api.list(`repos/${this.repo}/labels`), this.config.smoke_test.marker);
    if (!label) label = this.write('POST', `repos/${this.repo}/labels`, {
      name: this.config.smoke_test.marker, color: '0e8a16', description: 'Agile framework smoke fixtures',
    });
    const items = this.projectItems(project);
    for (const fixture of fixtures) {
      const matches = issues.filter(issue => !issue.pull_request && this.owned(issue, fixture.key));
      if (matches.length > 1) throw new Error(`Duplicate owned fixture: ${fixture.key}`);
      let issue = matches[0];
      if (!issue) {
        const payload = {
          title: `[${this.config.smoke_test.marker}] ${fixture.key}`,
          body: this.fixtureBody(fixture), labels: [this.config.smoke_test.marker],
        };
        if (fixture.type !== null) payload.type = fixture.type;
        issue = this.write('POST', `repos/${this.repo}/issues`, payload);
      }
      if (!issue) {
        console.log(`Would link ${fixture.key} to ${fixture.parent ?? '(root)'} and add to ${project.url}`);
        continue;
      }
      if ((issue.type?.name ?? null) !== fixture.type) {
        throw new Error(`Fixture type drift: ${issue.html_url}; not changed automatically.`);
      }
      const previous = this.state.fixtures[fixture.key] ?? {};
      this.state.fixtures[fixture.key] = { ...previous, number: issue.number, id: issue.id,
        node_id: issue.node_id, url: issue.html_url };
      this.save();
      const parent = getParent(this.api, issue);
      const expectedParent = fixture.parent ? this.state.fixtures[fixture.parent] : null;
      if (fixture.parent && !expectedParent) {
        if (this.apply) throw new Error(`Parent fixture missing: ${fixture.parent}`);
        console.log(`Would link ${fixture.key} after creating ${fixture.parent}`);
      } else if (parent && parent.id !== expectedParent?.id) {
        throw new Error(`Unexpected parent for ${issue.html_url}; will not reparent.`);
      } else if (expectedParent && !parent) {
        this.write('POST', `repos/${this.repo}/issues/${expectedParent.number}/sub_issues`, {
          sub_issue_id: issue.id, replace_parent: false,
        });
      }
      let item = items.find(value => value.content?.id === issue.node_id);
      if (!item) {
        const result = this.mutate(`mutation($project:ID!, $content:ID!) {
          addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } }
        }`, { project: project.id, content: issue.node_id });
        if (result) {
          item = result.addProjectV2ItemById.item;
          this.state.fixtures[fixture.key].ownedItemId = item.id;
          this.save();
        }
      }
      if (item) this.state.fixtures[fixture.key].itemId = item.id;
      this.save();
    }
  }

  negative() {
    if (!this.state.verification) throw new Error('Verify the nine positive fixtures before negative tests.');
    this.smoke(this.config.smoke_test.negative_fixtures);
  }

  ['verify-negative']() {
    const { project } = this.projectInfo();
    const items = this.projectItems(project);
    const results = [];
    for (const fixture of this.config.smoke_test.negative_fixtures) {
      const issue = this.getFixture(fixture);
      const result = validateLive(this.api, this.config, issue);
      const expectedParent = fixture.parent ? this.state.fixtures[fixture.parent]?.id : null;
      if ((issue.type?.name ?? null) !== fixture.type
          || (result.parent?.id ?? null) !== expectedParent
          || !result.violations.length || !items.some(item => item.content?.id === issue.node_id)) {
        throw new Error(`Negative fixture is not in the expected invalid state: ${issue.html_url}`);
      }
      const comments = this.api.list(`${issuePath(issue)}/comments`);
      const reports = comments.filter(comment => comment.user?.login === 'github-actions[bot]'
        && comment.user?.type === 'Bot' && comment.body?.startsWith(marker));
      if (reports.length !== 1
          || !result.violations.every(violation => reports[0].body.includes(`- ${violation}`))) {
        throw new Error(`Await the validation Action then rerun verify-negative: ${issue.html_url}`);
      }
      results.push({ key: fixture.key, url: issue.html_url, id: issue.id, node_id: issue.node_id,
        itemId: items.find(item => item.content?.id === issue.node_id).id,
        parentId: result.parent?.id ?? null, childIds: result.children.map(child => child.id),
        commentId: reports[0].id, commentURL: reports[0].html_url, violations: result.violations });
    }
    this.record('negativeVerification', results);
    console.log(JSON.stringify(results, null, 2));
  }

  getFixture(fixture) {
    const stored = this.state.fixtures[fixture.key];
    if (!stored) throw new Error(`No recorded fixture: ${fixture.key}`);
    const issue = this.api.request('GET', `repos/${this.repo}/issues/${stored.number}`);
    if (!this.owned(issue, fixture.key) || issue.id !== stored.id) {
      throw new Error(`Ownership mismatch: ${fixture.key}; no mutation allowed.`);
    }
    return issue;
  }

  verify() {
    const { project } = this.projectInfo();
    this.checkPins();
    this.checkProject(project);
    const items = this.projectItems(project);
    const results = [];
    for (const fixture of this.config.smoke_test.fixtures) {
      const issue = this.getFixture(fixture);
      const result = validateLive(this.api, this.config, issue);
      const expectedParent = fixture.parent ? this.state.fixtures[fixture.parent].id : null;
      const expectedChildren = this.config.smoke_test.fixtures
        .filter(value => value.parent === fixture.key).map(value => this.state.fixtures[value.key].id);
      if ((issue.type?.name ?? null) !== fixture.type
          || (result.parent?.id ?? null) !== expectedParent
          || result.children.length !== expectedChildren.length
          || !result.children.every(child => expectedChildren.includes(child.id))
          || !items.some(item => item.content?.id === issue.node_id)
          || result.violations.length) {
        throw new Error(`Fixture verification failed: ${issue.html_url}: ${result.violations.join('; ')}`);
      }
      // Negative tests use live API snapshots without corrupting or reparenting fixtures.
      if (fixture.type === 'Initiative'
          && validate(this.config, { ...issue, body: '' }, null).length !== 2) {
        throw new Error('Missing-field negative test failed.');
      }
      if (fixture.type === 'Task'
          && !validate(this.config, issue, { type: { name: 'Initiative' } }).length) {
        throw new Error('Invalid-link negative test failed.');
      }
      if (fixture.type === null
          && !validate(this.config, issue, null, [{ number: 0, type: { name: 'Task' } }]).length) {
        throw new Error('Untyped leaf negative test failed.');
      }
      results.push({ key: fixture.key, url: issue.html_url, id: issue.id,
        node_id: issue.node_id, parentId: result.parent?.id ?? null,
        childIds: result.children.map(child => child.id),
        itemId: items.find(item => item.content?.id === issue.node_id).id });
    }
    this.record('verification', { project, fixtures: results, negativeTests: 'passed (read-only live snapshots)' });
    console.log(JSON.stringify(this.state.verification, null, 2));
  }

  cleanup() {
    const { project } = this.projectInfo();
    const items = this.projectItems(project);
    // Preflight all ownership checks before closing anything.
    const owned = [...this.config.smoke_test.fixtures, ...this.config.smoke_test.negative_fixtures].filter(fixture =>
      this.state.fixtures[fixture.key]).map(fixture => ({ fixture, issue: this.getFixture(fixture) }));
    for (const { fixture, issue } of owned) {
      const item = items.find(value => value.id === this.state.fixtures[fixture.key].ownedItemId);
      if (item && item.content?.id !== issue.node_id) throw new Error('Project item ownership mismatch.');
    }
    for (const { fixture, issue } of owned) {
      if (issue.state !== 'closed') this.write('PATCH', issuePath(issue), {
        state: 'closed', state_reason: 'completed',
      });
      const itemId = this.state.fixtures[fixture.key].ownedItemId;
      const item = items.find(value => value.id === itemId);
      if (item) {
        this.mutate(`mutation($project:ID!, $item:ID!) {
          deleteProjectV2Item(input:{projectId:$project, itemId:$item}) { deletedItemId }
        }`, { project: project.id, item: item.id });
      }
    }
    if (this.apply) {
      for (const { fixture } of owned) {
        if (this.getFixture(fixture).state !== 'closed') throw new Error('Fixture closure verification failed.');
      }
      const remaining = this.projectItems(project);
      if (owned.some(({ fixture }) => remaining.some(item =>
        item.id === this.state.fixtures[fixture.key].ownedItemId))) {
        throw new Error('Owned project item removal verification failed.');
      }
      this.record('cleanedUp', true);
    }
  }

  probe() {
    const repository = this.api.request('GET', `repos/${this.repo}`);
    if (!repository.has_issues) throw new Error('Issues are disabled for this repository.');
    this.record('repositoryURL', repository.html_url);
    this.record('types', this.api.list(`orgs/${this.org}/issue-types`));
    this.record('fields', this.api.list(`orgs/${this.org}/issue-fields`));
    this.projectInfo(false);
    console.log(JSON.stringify(this.state, null, 2));
  }
}

export function main() {
  const { values } = parseArgs({ options: {
    phase: { type: 'string' }, apply: { type: 'boolean', default: false },
    approve: { type: 'string' }, state: { type: 'string', default: '.agile-state.json' },
    'confirm-project': { type: 'string' },
  } });
  if (!phases.includes(values.phase)) throw new Error(`Specify --phase ${phases.join('|')}`);
  const config = loadConfig();
  const state = existsSync(values.state) ? JSON.parse(readFileSync(values.state, 'utf8')) : {
    repository: config.smoke_test.repository, runId: randomUUID(), fixtures: {}, dryRuns: {},
  };
  const digest = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const mutating = !['probe', 'verify', 'verify-negative'].includes(values.phase);
  if (values.apply && !mutating) throw new Error('Read-only phase does not accept --apply.');
  if (values.apply && (values.approve !== values.phase || state.dryRuns[values.phase] !== digest)) {
    throw new Error('Run the same phase dry-run first, then use --apply --approve <phase>.');
  }
  const save = () => {
    writeFileSync(`${values.state}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${values.state}.tmp`, values.state);
  };
  const setup = new Setup(new GitHub(), config, state, values.apply, save);
  if (values.apply && ['project', 'smoke', 'negative', 'cleanup'].includes(values.phase)
      && values['confirm-project'] !== setup.projectURL) {
    throw new Error(`Confirm the live identity with --confirm-project ${setup.projectURL}`);
  }
  if (state.cleanedUp && ['smoke', 'negative'].includes(values.phase)) {
    throw new Error('This run is cleaned up. Use a new state file for a new smoke run.');
  }
  setup[values.phase]();
  if (!values.apply && mutating) {
    state.dryRuns[values.phase] = digest;
    save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

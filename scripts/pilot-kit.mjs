import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import YAML from 'yaml';
import { ApiError, projectState, projectStatuses } from './api.mjs';
import { loadConfig } from './policy.mjs';
import { provision } from './setup.mjs';
import { digest } from './simulation.mjs';

const slug = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const unique = (rows, name) => {
  const found = rows.filter(row => row.name === name);
  assert(found.length <= 1, `Ambiguous resource: ${name}`);
  return found[0];
};
export const repositoryOf = config => `${config.organization}/${config.repository}`;

export function loadPilot(path = '.github/planning/pilot.yml') {
  const pilot = YAML.parse(readFileSync(path, 'utf8'), { uniqueKeys: true });
  assert(pilot?.schema_version === 1 && typeof pilot.organization === 'string' && typeof pilot.repository === 'string' &&
    slug.test(pilot.organization) && slug.test(pilot.repository), 'Invalid pilot target');
  assert(typeof pilot.expected_actor === 'string' && slug.test(pilot.expected_actor), 'Expected delegated actor required');
  assert(typeof pilot.roles?.agent === 'string' && slug.test(pilot.roles.agent) &&
    typeof pilot.roles?.human === 'string' && slug.test(pilot.roles.human) && pilot.roles.agent !== pilot.roles.human &&
    pilot.roles.human !== pilot.expected_actor && pilot.roles.agent !== pilot.expected_actor, 'Use distinct fictitious simulation roles, not delegated login');
  assert(pilot.project && (pilot.project.number === null || (Number.isSafeInteger(pilot.project.number) && pilot.project.number > 0)) &&
    typeof pilot.project.title === 'string' && pilot.project.title.trim() && pilot.project.template === 'manual', 'Invalid project coordinates/template mode');
  assert(pilot.fixture && /^[a-z0-9-]+$/.test(pilot.fixture.key) &&
    pilot.fixture.title?.startsWith('[SIMULADO bv-pilot] ') && pilot.fixture.cleanup === 'close', 'Invalid bounded fixture');
  assert(pilot.controls && typeof pilot.controls.branch === 'string' && slug.test(pilot.controls.branch) && pilot.controls.required_approvals === 1 &&
    typeof pilot.controls.expected_check === 'string' && pilot.controls.expected_check.length > 0 &&
    (pilot.controls.expected_app_id === null || (Number.isSafeInteger(pilot.controls.expected_app_id) && pilot.controls.expected_app_id > 0)) &&
    Array.isArray(pilot.controls.human_reviewers) && pilot.controls.human_reviewers.every(login => typeof login === 'string' && slug.test(login)), 'Invalid proposed controls');
  assert((pilot.controls.authorization_public_key === null || typeof pilot.controls.authorization_public_key === 'string') &&
    (pilot.controls.authorization_signer === null || pilot.controls.human_reviewers.includes(pilot.controls.authorization_signer)), 'Human signing key must be pinned to a configured reviewer');
  const config = loadConfig(pilot.hierarchy);
  config.organization = pilot.organization;
  config.repository = pilot.repository;
  config.project = { ...config.project, owner: pilot.organization, number: pilot.project.number, title: pilot.project.title };
  assert(config.issue_types.includes(pilot.fixture.type), 'Fixture must use a configured issue type');
  if (process.env.GITHUB_REPOSITORY) assert(process.env.GITHUB_REPOSITORY === repositoryOf(pilot), 'Workflow target differs from pilot target');
  return { pilot, config };
}

export async function identity(api, pilot) {
  const actor = await api.request('user');
  assert(actor.login === pilot.expected_actor, `Delegated actor mismatch; expected ${pilot.expected_actor}`);
  const repo = await api.request(`repos/${repositoryOf(pilot)}`);
  assert(repo.full_name?.toLowerCase() === repositoryOf(pilot).toLowerCase(), 'Repository identity mismatch');
  return { actor: actor.login, repo };
}

export async function discoverProject(api, config) {
  if (config.project.number !== null) return projectState(api, config);
  const projects = [];
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    const data = await api.graphql('query($owner:String!,$cursor:String){organization(login:$owner){id projectsV2(first:100,after:$cursor){nodes{id number title url closed viewerCanUpdate} pageInfo{hasNextPage endCursor}}}}', { owner: config.organization, cursor });
    const connection = data.organization?.projectsV2;
    assert(connection?.nodes && connection.nodes.every(Boolean), 'Organization projects unreadable');
    projects.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      const matches = projects.filter(project => project.title === config.project.title);
      assert(matches.length <= 1 && !matches[0]?.closed, 'Ambiguous or closed project title; select explicit coordinates');
      return matches[0] ? projectState(api, { ...config, project: { ...config.project, number: matches[0].number } }) : null;
    }
    cursor = connection.pageInfo.endCursor;
    assert(cursor && !seen.has(cursor), 'Project pagination did not advance');
    seen.add(cursor);
  }
  throw new Error('Project discovery page limit exceeded');
}

export async function preflight(api, pilot, config) {
  const { actor, repo } = await identity(api, pilot);
  const access_errors = [];
  const read = async (name, action) => {
    try { return await action(); }
    catch (error) {
      access_errors.push({ capability: name, error: error.message });
      return { unavailable: true };
    }
  };
  const types = await read('organization issue types', () => api.list(`orgs/${pilot.organization}/issue-types`));
  const fields = await read('organization issue fields', () => api.list(`orgs/${pilot.organization}/issue-fields`));
  const project = await read('project', () => discoverProject(api, config));
  const base = `repos/${repositoryOf(pilot)}`;
  const branch = await read('branch', () => api.request(`${base}/branches/${pilot.controls.branch}`));
  const protection = await read('branch protection', async () => {
    try { return await api.request(`${base}/branches/${pilot.controls.branch}/protection`); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404 && repo.permissions?.admin && branch.name === pilot.controls.branch) {
        return { protected: false, note: 'Admin read: branch exists, protection endpoint returned 404' };
      }
      throw error;
    }
  });
  const rulesets = await read('rulesets', () => api.list(`${base}/rulesets?includes_parents=true`));
  const actions = await read('actions permissions', () => api.request(`${base}/actions/permissions`));
  const workflow = await read('workflow permissions', () => api.request(`${base}/actions/permissions/workflow`));
  const environments = await read('environments', () => api.request(`${base}/environments?per_page=100`));
  if (environments.total_count > 100) access_errors.push({ capability: 'environments', error: 'More than 100 environments; explicit manual inspection required' });
  return {
    repository: repositoryOf(pilot), actor, identity_kind: 'agent-with-delegated-credentials',
    visibility: repo.visibility, default_branch: repo.default_branch,
    permissions: repo.permissions, allow_auto_merge: repo.allow_auto_merge,
    security_and_analysis: repo.security_and_analysis ?? { unavailable: true },
    types, fields, project, branch, protection, rulesets, actions, workflow, environments,
    access_errors, writes: api.writes, continuous_enforcement_installed: false,
  };
}

export function plan(pilot, config, state) {
  const generated = Date.now();
  const missing = (definitions, existing) => Array.isArray(existing) ? definitions.filter(name => !unique(existing, name)) : null;
  const conflicts = [];
  if (Array.isArray(state.types)) {
    for (const name of config.issue_types) {
      const found = unique(state.types, name);
      if (found && !found.is_enabled) conflicts.push(`Disabled issue type: ${name}`);
    }
    if (state.types.some(type => type.name === 'Issue')) conflicts.push('Unmanaged Issue type conflicts with untyped leaf policy');
  }
  if (Array.isArray(state.fields)) {
    for (const field of Object.values(config.fields).filter(field => field.storage === 'organization_field')) {
      const found = unique(state.fields, field.name);
      if (found && found.data_type !== field.data_type) conflicts.push(`Incompatible native field: ${field.name}`);
      if (found && field.options && JSON.stringify(found.options?.map(({ name, color, priority }) => ({ name, color, priority }))) !== JSON.stringify(field.options)) {
        conflicts.push(`Existing field options differ: ${field.name}`);
      }
    }
  }
  if (state.project?.fields) {
    const status = unique(state.project.fields, config.project.status_field);
    if (status?.dataType !== 'SINGLE_SELECT' || config.project.statuses.some(name => status.options?.filter(option => option.name === name).length !== 1)) {
      conflicts.push('Project statuses require manual alignment before fixtures; no shared options will be changed');
    }
  }
  const result = {
    repository: repositoryOf(pilot), config_hash: digest({ pilot, config }),
    generated_at: generated, expires_at: generated + 1800000,
    blocked: state.access_errors.length > 0 || conflicts.length > 0, conflicts,
    bootstrap: {
      project: state.project === null ? { create: config.project.title } : { reuse_without_edit: state.project?.url },
      missing_types: missing(config.issue_types, state.types),
      missing_fields: missing(Object.values(config.fields).filter(field => field.storage === 'organization_field').map(field => field.name), state.fields),
      fixture: { key: pilot.fixture.key, title: pilot.fixture.title, mode: 'SIMULATED', max_issues: 1 },
    },
    controls: {
      state: 'PROPOSED_NOT_APPLIED', requires_separate_human_authorization: true,
      branch: pilot.controls.branch,
      proposed: {
        required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true, require_code_owner_reviews: true },
        required_status_checks: { strict: true, checks: [{ context: pilot.controls.expected_check, app_id: pilot.controls.expected_app_id }] },
        required_conversation_resolution: true,
        enforce_admins: true, allow_force_pushes: false, allow_deletions: false,
        agent_bypass: false, automatic_merge: false,
      },
      blockers: [
        'Human must approve the exact target, reviewer availability and admin treatment before administrative writes.',
        'Provision a least-privilege App separately; delegated OAuth identity is not proof of a human.',
        ...(pilot.controls.expected_app_id === null ? ['Expected check App ID has not been selected and verified.'] : []),
        ...(!pilot.controls.human_reviewers.length ? ['Real authorized reviewers and effective CODEOWNERS have not been selected.'] : []),
        ...(!pilot.controls.authorization_public_key ? ['An out-of-band human Ed25519 authorization key has not been pinned.'] : []),
        'No check producer is installed by this kit; verify a trusted producer before requiring its check.',
        'No real scope/PR/UAT/release approval adapter, security scanner or release workflow is installed.',
      ],
      release: { environment: 'release', reviewers: pilot.controls.human_reviewers, prevent_self_review: true, admin_bypass: false, state: 'manual-capability-check-required' },
      apply_command: 'npm run pilot -- apply-controls --apply --confirm OWNER/REPO --plan PLAN.json --authorize-controls PLAN_HASH --authorization HUMAN_SIGNATURE.json --manifest EXTERNAL_MANIFEST.json',
    },
    manual: [
      'Enable native Type via Project table + > Hidden fields > Type; never create a custom Type.',
      'Verify organization-field applicability/pinning and link existing organization fields to the project.',
      'Mark the intended project as an organization template in project settings, if supported and authorized.',
      'Preserve shared Status options/views/workflows; configure missing statuses manually before fixtures.',
      'Publish issue forms on the default branch only through a human merge.',
      'Recheck environment reviewer availability for the destination visibility and GitHub plan; public support does not imply private support.',
    ],
    report_only: ['Project status/content/hierarchy validator; does not prevent transitions'],
    simulated: ['Scope, acceptance, PR review, security decision, UAT, release'],
    baseline: state,
  };
  return { ...result, plan_hash: digest(result) };
}

export async function bootstrap(api, ledger, pilot, config) {
  const { repo } = await identity(api, pilot);
  assert(repo.permissions?.push, 'Repository push permission required');
  let project = await discoverProject(api, config);
  if (!project) {
    assert(config.project.number === null, 'Never substitute a missing configured project');
    const data = await api.graphql('query($owner:String!){organization(login:$owner){id}}', { owner: pilot.organization });
    assert(data.organization?.id, 'Organization owner ID unreadable');
    project = await ledger.write(`create pilot project ${config.project.title}`, null,
      async () => {
        const result = await api.graphql('mutation($owner:ID!,$title:String!){createProjectV2(input:{ownerId:$owner,title:$title}){projectV2{id number title url}}}', { owner: data.organization.id, title: config.project.title }, { mutation: true });
        assert(result.createProjectV2?.projectV2?.id, 'Project creation result unreadable');
        return result.createProjectV2.projectV2;
      },
      () => discoverProject(api, config),
      (after, response) => after?.id === response.id && after.title === config.project.title,
      response => ({ kind: 'pilot-project', id: response.id, number: response.number, title: response.title, owned: true, url: response.url }));
  }
  assert(project.viewerCanUpdate, 'Project update capability required');
  const configured = { ...config, project: { ...config.project, number: project.number } };
  const types = await provision(api, ledger, configured, 'type');
  const fields = await provision(api, ledger, configured, 'field');
  return { project: project.url, number: project.number, types, fields, writes: api.writes, controls_applied: false, template: 'manual' };
}

const fixtureMarker = pilot => `<!-- bv-portable-pilot:v1:${pilot.fixture.key} -->`;
function fixtureBody(pilot) {
  return `${fixtureMarker(pilot)}\n### Description\nSIMULADO: propuesta sintetica creada por un agente con credenciales delegadas. No representa aprobacion humana.\n\n### Acceptance Criteria\n- [ ] [Agente] Implementar y verificar el candidato sintetico.\n- [ ] [Humano real] Aprobar alcance operativo; NO concedido por esta simulacion.\n\n### Delivery Evidence\nSimulacion local reproducible: npm run pilot -- simulate. No hay reviews, UAT ni release reales.\n`;
}

async function settledMembership(api, config, issueNode, expectedId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await projectStatuses(api, config);
    if (state.items.get(issueNode)?.id === expectedId) return state;
    if (attempt < 3) await setTimeout(250 * 2 ** attempt);
  }
  throw new Error('Project membership read-back did not settle after four reads; use recover, never retry mutation blindly');
}

export async function fixtures(api, ledger, pilot, config) {
  await identity(api, pilot);
  const project = await discoverProject(api, config);
  assert(project?.viewerCanUpdate, 'Existing writable project required; bootstrap first');
  const target = { ...config, project: { ...config.project, number: project.number } };
  const state = await projectStatuses(api, target);
  const repository = repositoryOf(pilot);
  const path = `repos/${repository}/issues`;
  const matches = (await api.list(`${path}?state=all`)).filter(issue => !issue.pull_request &&
    (issue.body?.includes(fixtureMarker(pilot)) || issue.title === pilot.fixture.title));
  assert(matches.length <= 1, 'Duplicate fixture markers/titles; stop');
  let issue = matches[0];
  if (issue) {
    assert(ledger.data.resources.some(resource => resource.kind === 'pilot-issue' && resource.id === issue.id &&
      resource.owned && resource.key === pilot.fixture.key), 'Unowned fixture; never adopt from marker alone');
    assert(issue.state === 'open' && issue.body === fixtureBody(pilot) && issue.title === pilot.fixture.title &&
      issue.type?.name === pilot.fixture.type, 'Fixture drift or closed fixture; inspect manually');
  } else {
    assert(!ledger.data.resources.some(resource => resource.kind === 'pilot-issue' && resource.key === pilot.fixture.key), 'Owned fixture disappeared; no replacement');
    issue = await ledger.write(`create SIMULATED fixture ${pilot.fixture.key}`, null,
      () => api.request(path, { method: 'POST', body: { title: pilot.fixture.title, body: fixtureBody(pilot), type: pilot.fixture.type } }),
      response => api.request(`${path}/${response.number}`),
      (after, response) => after.id === response.id && after.type?.name === pilot.fixture.type && after.body === fixtureBody(pilot),
      response => ({ kind: 'pilot-issue', id: response.id, node_id: response.node_id, number: response.number, key: pilot.fixture.key, owned: true, url: response.html_url }));
  }
  let item = state.items.get(issue.node_id);
  if (!item) {
    item = await ledger.write(`add fixture #${issue.number} to project`, null,
      async () => {
        const current = (await projectStatuses(api, target)).items.get(issue.node_id);
        if (current) return { id: current.id, recovered_auto_add: true };
        try {
          const data = await api.graphql('mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}', { project: project.id, content: issue.node_id }, { mutation: true });
          assert(data.addProjectV2ItemById?.item?.id, 'Project add result unreadable');
          return data.addProjectV2ItemById.item;
        } catch (error) {
          const raced = (await projectStatuses(api, target)).items.get(issue.node_id);
          if (!raced) throw error;
          return { id: raced.id, recovered_auto_add: true, original_error: error.message };
        }
      },
      response => settledMembership(api, target, issue.node_id, response.id),
      (after, response) => after.items.get(issue.node_id)?.id === response.id,
      response => ({ kind: 'pilot-item', id: response.id, project_id: project.id, issue_id: issue.id, owned: !response.recovered_auto_add }));
    item = item.items.get(issue.node_id);
  }
  assert(item.status === config.project.empty_status, 'Fixture is not in Backlog; shared automation may have moved it; no status overwritten');
  return { mode: 'SIMULATED', issue: issue.html_url, number: issue.number, project: project.url, status: item.status, writes: api.writes };
}

export async function recover(api, ledger, pilot, config) {
  await identity(api, pilot);
  const pending = ledger.data.operations.filter(operation => operation.state === 'pending');
  assert(pending.length === 1, 'Recovery requires exactly one pending operation');
  const operation = pending[0];
  const owned = ledger.data.resources.filter(resource => resource.kind === 'pilot-issue' && resource.key === pilot.fixture.key && resource.owned);
  assert(owned.length === 1, 'Recovery requires one recorded owned fixture');
  const resource = owned[0];
  const issue = await api.request(`repos/${repositoryOf(pilot)}/issues/${resource.number}`);
  assert(issue.id === resource.id && issue.node_id === resource.node_id && issue.body === fixtureBody(pilot) &&
    issue.title === pilot.fixture.title && issue.type?.name === pilot.fixture.type, 'Recovery fixture identity/content mismatch');
  assert(operation.action === `add fixture #${resource.number} to project` && operation.response?.id, 'Only recorded project-membership read-back recovery is supported; inspect other pending writes manually');
  const project = await discoverProject(api, config);
  assert(project?.id, 'Recovery project inaccessible');
  assert(ledger.data.resources.some(row => row.kind === 'pilot-item' && row.id === operation.response.id &&
    row.project_id === project.id && row.issue_id === resource.id), 'Recovery membership is not recorded for this fixture/project');
  const state = await settledMembership(api, { ...config, project: { ...config.project, number: project.number } }, issue.node_id, operation.response.id);
  operation.state = 'verified';
  operation.recovery = { verified_at: new Date().toISOString(), item: state.items.get(issue.node_id), github_writes: api.writes };
  ledger.save();
  return { recovered: operation.action, github_writes: api.writes, journal_updated: true };
}

export async function cleanup(api, ledger, pilot) {
  await identity(api, pilot);
  const owned = ledger.data.resources.filter(resource => resource.kind === 'pilot-issue' && resource.owned && resource.key === pilot.fixture.key);
  assert(owned.length <= 1, 'Cleanup limited to one owned fixture');
  for (const resource of owned) {
    const path = `repos/${repositoryOf(pilot)}/issues/${resource.number}`;
    const issue = await api.request(path);
    assert(issue.id === resource.id && issue.node_id === resource.node_id && issue.body === fixtureBody(pilot) &&
      issue.title === pilot.fixture.title && issue.type?.name === pilot.fixture.type, 'Cleanup identity/content drift; no resources changed');
    if (issue.state !== 'closed') await ledger.write(`close owned fixture #${resource.number}`, issue,
      () => api.request(path, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } }),
      () => api.request(path),
      after => after.id === resource.id && after.state === 'closed');
  }
  return { closed_owned_fixtures: owned.map(resource => resource.number), writes: api.writes,
    preserved: 'Project items, projects, shared types/fields, views, workflows and all unowned resources. No deletion.' };
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ApiError, projectState } from './api.mjs';

export async function provision(api, ledger, config, kind) {
  await projectState(api, config);
  const repository = `${config.organization}/${config.repository}`;
  const repo = await api.request(`repos/${repository}`);
  if (!repo.permissions?.push) throw new Error('Push permission required before setup writes');
  const path = `orgs/${config.organization}/${kind === 'type' ? 'issue-types' : 'issue-fields'}`;
  const before = await api.list(path);
  if (kind === 'type' && before.some(resource => resource.name === 'Issue')) throw new Error('Unmanaged Issue type exists; stop');
  const definitions = kind === 'type' ? config.issue_types.map(name => ({ name, is_enabled: true })) : [{ name: config.fields.cost_centre.name, data_type: config.fields.cost_centre.native_type }];
  const planned = [];
  for (const definition of definitions) {
    const matches = before.filter(resource => resource.name === definition.name);
    if (matches.length > 1 || matches.some(resource => kind === 'type' ? !resource.is_enabled : resource.data_type !== definition.data_type)) throw new Error(`Ambiguous or incompatible ${kind}: ${definition.name}`);
    if (matches.length) {
      const recorded = ledger?.data.resources.find(resource => resource.kind === kind && resource.id === matches[0].id);
      ledger?.record({ kind, id: matches[0].id, name: definition.name, owned: recorded?.owned ?? false, before: matches[0] });
    } else planned.push(definition);
  }
  if (before.length + planned.length > 25) throw new Error('Organization limit would be exceeded');
  if (api.dryRun) return { planned, writes: 0 };
  for (const definition of planned) {
    await ledger.write(`create ${kind}: ${definition.name}`, before,
      () => api.request(path, { method: 'POST', body: definition }),
      () => api.list(path),
      after => {
        const matches = after.filter(resource => resource.name === definition.name);
        return matches.length === 1 && (kind === 'type' ? matches[0].is_enabled : matches[0].data_type === definition.data_type) && before.every(resource => JSON.stringify(after.find(candidate => candidate.id === resource.id)) === JSON.stringify(resource));
      },
      response => ({ kind, id: response.id, name: response.name, owned: true }));
  }
  return { planned, writes: api.writes };
}

export async function publishReport(api, ledger, config, path) {
  const repository = `${config.organization}/${config.repository}`;
  const title = '[bv-agile-framework-setup] RABC-SAS setup and validation evidence';
  const body = readFileSync(path, 'utf8');
  const issues = (await api.list(`repos/${repository}/issues?state=all`)).filter(issue => !issue.pull_request && issue.title === title);
  if (issues.length > 1) throw new Error('Duplicate tracking issues; stop');
  const existing = issues[0];
  if (existing && !ledger.data.resources.some(resource => resource.kind === 'tracking_issue' && resource.id === existing.id && resource.owned)) throw new Error('Existing tracking issue is unmanaged');
  if (api.dryRun || existing?.body === body) return { changed: false, planned: !existing || existing.body !== body, url: existing?.html_url };
  return ledger.write('publish tracking report', existing ?? null,
    () => api.request(`repos/${repository}/issues${existing ? `/${existing.number}` : ''}`, { method: existing ? 'PATCH' : 'POST', body: { title, body } }),
    response => api.request(`repos/${repository}/issues/${response.number}`),
    after => after.title === title && after.body === body,
    response => ({ kind: 'tracking_issue', id: response.id, number: response.number, owned: true, url: response.html_url }));
}

export async function publishDraft(api, ledger, config, { branch, reportPath }) {
  if (!/^validation\/rabc-agile-[\w-]+$/.test(branch ?? '')) throw new Error('Use a new validation/rabc-agile-* branch');
  const repository = `${config.organization}/${config.repository}`;
  const base = await api.request(`repos/${repository}/branches/main`);
  const localBase = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (localBase !== base.commit.sha) throw new Error('Local HEAD differs from remote main; stop before publishing');
  const baseCommit = await api.request(`repos/${repository}/git/commits/${base.commit.sha}`);
  const paths = [
    '.github/planning/hierarchy.yml', '.github/workflows/agile-policy.yml', '.github/workflows/agile-tests.yml',
    '.gitignore', 'package.json', 'package-lock.json', 'scripts/policy.mjs', 'scripts/api.mjs', 'scripts/agile.mjs',
    'scripts/validation.mjs', 'scripts/operations.mjs', 'tests/policy.test.mjs', 'tests/api.test.mjs', 'tests/validation.test.mjs',
    'RABC_SETUP.md',
  ];
  const files = paths.filter(path => existsSync(path)).map(path => ({ path, mode: '100644', type: 'blob', content: readFileSync(path, 'utf8') }));
  try {
    await api.request(`repos/${repository}/git/ref/heads/${branch}`);
    throw new Error('Publication branch already exists; no branch overwritten');
  } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  const body = readFileSync(reportPath, 'utf8');
  if (api.dryRun) return { planned_branch: branch, planned_files: files.map(file => file.path), writes: 0 };
  const tree = await ledger.write('publish owned source tree', { base_tree: baseCommit.tree.sha },
    () => api.request(`repos/${repository}/git/trees`, { method: 'POST', body: { base_tree: baseCommit.tree.sha, tree: files } }),
    response => api.request(`repos/${repository}/git/trees/${response.sha}?recursive=1`),
    after => !after.truncated && files.every(file => {
      const bytes = Buffer.from(file.content);
      const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      return after.tree.some(entry => entry.path === file.path && entry.sha === hash);
    }),
    response => ({ kind: 'git_tree', id: response.sha, owned: true }));
  const commit = await ledger.write('publish draft commit', { base_commit: base.commit.sha },
    () => api.request(`repos/${repository}/git/commits`, { method: 'POST', body: { message: 'Propose independent RABC agile policy validation', tree: tree.sha, parents: [base.commit.sha] } }),
    response => api.request(`repos/${repository}/git/commits/${response.sha}`),
    after => after.tree.sha === tree.sha && after.parents.length === 1 && after.parents[0].sha === base.commit.sha,
    response => ({ kind: 'git_commit', id: response.sha, owned: true }));
  await ledger.write('publish new draft branch', null,
    () => api.request(`repos/${repository}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } }),
    () => api.request(`repos/${repository}/git/ref/heads/${branch}`),
    after => after.object.sha === commit.sha,
    response => ({ kind: 'git_branch', id: response.ref, owned: true, commit: commit.sha }));
  return ledger.write('open independent draft PR', null,
    () => api.request(`repos/${repository}/pulls`, { method: 'POST', body: { title: 'Independent RABC-SAS agile setup and validation', head: branch, base: 'main', draft: true, body } }),
    response => api.request(`repos/${repository}/pulls/${response.number}`),
    after => after.head.sha === commit.sha && after.head.ref === branch && after.base.ref === 'main' && after.draft,
    response => ({ kind: 'pull_request', id: response.id, number: response.number, owned: true, url: response.html_url }));
}
import { validateIssue } from './policy.mjs';
import { projectStatuses } from './api.mjs';

export async function parentOf(api, issue) {
  const data = await api.graphql('query($id:ID!){node(id:$id){... on Issue{id parent{id number repository{nameWithOwner}}}}}', { id: issue.node_id });
  if (!data.node || !Object.hasOwn(data.node, 'parent')) throw new Error('Parent relationship is unreadable or redacted');
  if (data.node.parent === null) return null;
  const reference = data.node.parent;
  if (!reference.repository?.nameWithOwner) throw new Error('Parent repository is unreadable');
  const parent = await api.request(`repos/${reference.repository.nameWithOwner}/issues/${reference.number}`);
  if (parent.node_id !== reference.id) throw new Error('Parent read-back identity mismatch');
  return parent;
}

export async function snapshot(api, repository, number, orgFields, { inherit = false } = {}) {
  const issue = await api.request(`repos/${repository}/issues/${number}`);
  if (issue.pull_request) throw new Error('Pull requests are not issues to validate');
  const parent = await parentOf(api, issue);
  const ancestors = [];
  let ancestor = parent;
  const visited = new Set([issue.node_id]);
  while (ancestor) {
    ancestors.push(ancestor);
    if (visited.has(ancestor.node_id)) break;
    visited.add(ancestor.node_id);
    if (ancestors.length > 100) throw new Error('Hierarchy traversal limit exceeded');
    ancestor = await parentOf(api, ancestor);
  }
  const children = await api.list(`repos/${repository}/issues/${number}/sub_issues`);
  const fieldValues = await api.list(`repos/${repository}/issues/${number}/issue-field-values`);
  // Parent values are read only when the policy lets a field be inherited.
  const ancestorFieldValues = [];
  for (const row of inherit ? ancestors : []) {
    const base = row.repository_url?.replace('https://api.github.com/', '');
    if (!/^repos\/[^/]+\/[^/]+$/.test(base ?? '')) throw new Error('Parent repository is unreadable');
    ancestorFieldValues.push(await api.list(`${base}/issues/${row.number}/issue-field-values`));
  }
  return { issue, parent, ancestors, children, fieldValues, orgFields, ...(inherit ? { ancestorFieldValues } : {}) };
}

// Keeps one note per issue: created when something is missing, updated in place afterwards.
// An issue with nothing missing and no earlier note gets no comment at all.
export async function reportResult(api, ledger, repository, number, errors, actor, marker) {
  const comments = await api.list(`repos/${repository}/issues/${number}/comments`);
  const matches = comments.filter(comment => comment.body?.includes(marker));
  if (matches.length > 1 || matches.some(comment => comment.user?.login !== actor || !comment.body.startsWith(marker))) {
    throw new Error(`Issue #${number}: duplicate or unmanaged result marker; no comments altered`);
  }
  const body = errors.length
    ? `${marker}\n## Faltan datos en este issue\n\n${errors.map(error => `- ${error}`).join('\n')}\n\nEsta nota se actualiza sola en la próxima revisión.`
    : `${marker}\n## Datos completos\n\nYa no falta nada en este issue.`;
  const existing = matches[0];
  if (!existing && !errors.length) return { changed: false, planned: false, id: null, url: null };
  if (existing?.body === body || api.dryRun) return { changed: false, planned: !existing || existing.body !== body, id: existing?.id ?? null, url: existing?.html_url ?? null };
  const path = existing ? `repos/${repository}/issues/comments/${existing.id}` : `repos/${repository}/issues/${number}/comments`;
  const comment = await ledger.write(`report ${repository}#${number}`, existing ?? null,
    () => api.request(path, { method: existing ? 'PATCH' : 'POST', body: { body } }),
    response => api.request(`repos/${repository}/issues/comments/${response.id}`),
    after => after.body === body && after.user?.login === actor,
    response => ({ kind: 'comment', id: response.id, owned: !existing || ledger.data.resources.some(resource => resource.kind === 'comment' && resource.id === response.id && resource.owned), repository, number, url: response.html_url }));
  const readBack = (await api.list(`repos/${repository}/issues/${number}/comments`)).filter(candidate => candidate.body?.includes(marker));
  if (readBack.length !== 1 || readBack[0].id !== comment.id) throw new Error('Result marker uniqueness read-back failed');
  return { changed: true, planned: false, id: comment.id, url: comment.html_url };
}

// Without numbers, checks every issue in the shared project, whatever its repository.
// With numbers, checks those issues of the home repository, in the project or not.
export async function reconcile(api, ledger, config, { numbers, actor } = {}) {
  const home = `${config.organization}/${config.repository}`;
  let orgFields;
  let fieldError;
  try { orgFields = Object.values(config.fields).some(field => field.storage === 'organization_field') ? await api.list(`orgs/${config.organization}/issue-fields`) : []; }
  catch (error) { fieldError = `Organization fields unreadable: ${error.message}; request a narrowly scoped GitHub App, not an admin PAT`; }
  let statuses;
  let projectError;
  try { statuses = await projectStatuses(api, config); }
  catch (error) { projectError = `Project status unreadable: ${error.message}; request narrowly scoped App project-read access`; }
  const issues = numbers ? numbers.map(number => ({ repository: home, number }))
    : [...(statuses?.items.values() ?? [])].map(item => ({ repository: item.repository, number: item.number }));
  const inherit = Object.values(config.fields).some(field => field.inherit_from_ancestors);
  const results = [];
  for (const reference of issues) {
    let errors = [];
    let failed = false;
    let state;
    try {
      state = await snapshot(api, reference.repository, reference.number, orgFields, { inherit });
      state.status = statuses ? statuses.items.get(state.issue.node_id)?.status ?? null : undefined;
      errors = validateIssue(config, state);
    } catch (error) {
      failed = true;
      errors.push(`No se pudo revisar este issue: ${error.message}`);
    }
    // Access problems are for the maintainer; they are reported once, not on every issue.
    let report;
    if (!failed && !fieldError && !projectError) {
      try { report = await reportResult(api, ledger, reference.repository, reference.number, errors, actor, config.validation.marker); }
      catch (error) {
        failed = true;
        errors.push(`No se pudo dejar la nota: ${error.message}`);
      }
    }
    results.push({ repository: reference.repository, number: reference.number, url: state?.issue.html_url, errors, failed, report, snapshot: state });
  }
  if (ledger && !api.dryRun) {
    ledger.data.evidence.push({ action: 'reconciliation', run_url: process.env.GITHUB_RUN_ID ? `https://github.com/${home}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, results });
    ledger.save();
  }
  return {
    results, violations: results.filter(result => result.errors.length).length, failures: results.filter(result => result.failed).length,
    access_errors: [fieldError, projectError].filter(Boolean), writes: api.writes,
  };
}

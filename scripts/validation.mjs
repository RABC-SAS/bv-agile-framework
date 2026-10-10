import { marker, validateIssue } from './policy.mjs';

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

export async function snapshot(api, repository, number, orgFields) {
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
  return { issue, parent, ancestors, children, fieldValues, orgFields };
}

export async function reportResult(api, ledger, repository, number, errors, actor) {
  const comments = await api.list(`repos/${repository}/issues/${number}/comments`);
  const matches = comments.filter(comment => comment.body?.includes(marker));
  if (matches.length > 1 || matches.some(comment => comment.user?.login !== actor || !comment.body.startsWith(marker))) {
    throw new Error(`Issue #${number}: duplicate or unmanaged result marker; no comments altered`);
  }
  const body = `${marker}\n## Agile Policy: ${errors.length ? 'FAIL' : 'PASS'}\n\n${errors.length ? errors.map(error => `- ${error}`).join('\n') : 'No YAML policy violations.'}`;
  const existing = matches[0];
  if (existing?.body === body || api.dryRun) return { changed: false, planned: !existing || existing.body !== body, id: existing?.id ?? null, url: existing?.html_url ?? null };
  const path = existing ? `repos/${repository}/issues/comments/${existing.id}` : `repos/${repository}/issues/${number}/comments`;
  const comment = await ledger.write(`report issue #${number}`, existing ?? null,
    () => api.request(path, { method: existing ? 'PATCH' : 'POST', body: { body } }),
    response => api.request(`repos/${repository}/issues/comments/${response.id}`),
    after => after.body === body && after.user?.login === actor,
    response => ({ kind: 'comment', id: response.id, owned: !existing || ledger.data.resources.some(resource => resource.kind === 'comment' && resource.id === response.id && resource.owned), number, url: response.html_url }));
  const readBack = (await api.list(`repos/${repository}/issues/${number}/comments`)).filter(candidate => candidate.body?.includes(marker));
  if (readBack.length !== 1 || readBack[0].id !== comment.id) throw new Error('Result marker uniqueness read-back failed');
  return { changed: true, planned: false, id: comment.id, url: comment.html_url };
}

export async function reconcile(api, ledger, config, { numbers, actor, projectError } = {}) {
  const repository = `${config.organization}/${config.repository}`;
  let orgFields;
  let fieldError;
  try { orgFields = await api.list(`orgs/${config.organization}/issue-fields`); }
  catch (error) { fieldError = `Organization fields unreadable: ${error.message}; request a narrowly scoped GitHub App, not an admin PAT`; }
  const issues = numbers ? numbers.map(number => ({ number })) : (await api.list(`repos/${repository}/issues?state=all`)).filter(issue => !issue.pull_request);
  const results = [];
  for (const reference of issues) {
    let errors = [];
    let state;
    try {
      state = await snapshot(api, repository, reference.number, orgFields);
      errors = validateIssue(config, state);
    } catch (error) { errors.push(`Unable to validate: ${error.message}`); }
    if (fieldError) errors.push(fieldError);
    if (projectError) errors.push(projectError);
    let report;
    try { report = await reportResult(api, ledger, repository, reference.number, errors, actor); }
    catch (error) { errors.push(`Unable to report: ${error.message}`); }
    results.push({ number: reference.number, url: state?.issue.html_url, errors, report, snapshot: state });
  }
  if (ledger && !api.dryRun) {
    ledger.data.evidence.push({ action: 'reconciliation', run_url: process.env.GITHUB_RUN_ID ? `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, results });
    ledger.save();
  }
  return { results, violations: results.filter(result => result.errors.length).length, writes: api.writes };
}
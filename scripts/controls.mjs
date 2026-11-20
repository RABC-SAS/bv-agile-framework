import { createPublicKey, verify } from 'node:crypto';
import { digest } from './simulation.mjs';
import { preflight, repositoryOf, plan } from './pilot-kit.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (left, right) => left === undefined || right === undefined ? left === right : digest(left) === digest(right);

export function authorizationMessage(authorization) {
  return JSON.stringify({
    kind: authorization.kind, signer: authorization.signer, repository: authorization.repository,
    plan_hash: authorization.plan_hash, issued_at: authorization.issued_at,
    expires_at: authorization.expires_at, nonce: authorization.nonce,
  });
}

export function controlBaseline(state) {
  return {
    repository: state.repository, actor: state.actor, visibility: state.visibility, default_branch: state.default_branch,
    head: state.branch?.commit?.sha, protected: state.branch?.protected,
    protection: state.protection, rulesets: state.rulesets, allow_auto_merge: state.allow_auto_merge,
    workflow: state.workflow, actions: state.actions, security_and_analysis: state.security_and_analysis,
    environments: state.environments,
  };
}

export function rulesetBody(savedPlan) {
  const proposed = savedPlan.controls.proposed;
  assert(proposed.agent_bypass === false && proposed.automatic_merge === false && proposed.enforce_admins === true, 'Bypass and auto-merge must remain disabled; admins must be subject to rules');
  return {
    name: `bv-pilot-${savedPlan.plan_hash.slice(0, 16)}`, target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${savedPlan.controls.branch}`], exclude: [] } },
    rules: [
      { type: 'deletion' }, { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {
        required_approving_review_count: proposed.required_pull_request_reviews.required_approving_review_count,
        dismiss_stale_reviews_on_push: proposed.required_pull_request_reviews.dismiss_stale_reviews,
        require_code_owner_review: proposed.required_pull_request_reviews.require_code_owner_reviews,
        require_last_push_approval: proposed.required_pull_request_reviews.require_last_push_approval,
        required_review_thread_resolution: proposed.required_conversation_resolution,
      } },
      { type: 'required_status_checks', parameters: {
        required_status_checks: proposed.required_status_checks.checks.map(check => ({ context: check.context, integration_id: check.app_id })),
        strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
      } },
    ],
  };
}

export function rulesetMatches(live, expected) {
  return live?.name === expected.name && live.target === 'branch' && live.enforcement === 'active' &&
    Array.isArray(live.bypass_actors) && live.bypass_actors.length === 0 &&
    same(live.conditions, expected.conditions) && live.rules?.length === expected.rules.length &&
    expected.rules.every(rule => {
      const actual = live.rules.filter(candidate => candidate.type === rule.type);
      return actual.length === 1 && (!rule.parameters ||
        Object.entries(rule.parameters).every(([key, value]) => same(actual[0].parameters?.[key], value)));
    });
}

export async function applyControls(api, ledger, pilot, config, savedPlan, authorization, { now = Date.now(), confirmHash } = {}) {
  assert(ledger && !api.dryRun, 'Administrative apply needs explicit write mode and an external manifest');
  const { command, dry_run, plan_hash, ...unsigned } = savedPlan;
  assert(plan_hash === digest(unsigned) && plan_hash === confirmHash, 'Plan hash/explicit authorization mismatch');
  assert(unsigned.repository === repositoryOf(pilot) && unsigned.config_hash === digest({ pilot, config }), 'Plan target/configuration mismatch');
  assert(unsigned.blocked === false && Number.isSafeInteger(unsigned.generated_at) && Number.isSafeInteger(unsigned.expires_at) &&
    unsigned.generated_at <= now && unsigned.expires_at > now && unsigned.expires_at - unsigned.generated_at <= 1800000, 'Plan blocked, expired or invalid');
  assert(unsigned.controls?.branch === pilot.controls.branch &&
    same(unsigned.controls.proposed, plan(pilot, config, unsigned.baseline).controls.proposed), 'Plan control specification is not the supported conservative configuration');
  assert(authorization?.kind === 'human-signed-control-plan' && authorization.repository === unsigned.repository &&
    authorization.plan_hash === plan_hash && authorization.signer === pilot.controls.authorization_signer &&
    pilot.controls.human_reviewers.includes(authorization.signer) &&
    authorization.signer !== pilot.expected_actor, 'Independent human-signed authorization required; simulation/delegated identity is insufficient');
  assert(Number.isSafeInteger(authorization.issued_at) && Number.isSafeInteger(authorization.expires_at) &&
    authorization.issued_at <= now && authorization.issued_at >= unsigned.generated_at &&
    authorization.expires_at > now && authorization.expires_at <= unsigned.expires_at &&
    /^[a-zA-Z0-9-]{16,128}$/.test(authorization.nonce ?? ''), 'Authorization expired, invalid or not bound to this plan lifetime');
  assert(typeof pilot.controls.authorization_public_key === 'string', 'Configure an out-of-band human Ed25519 public key, never a key held by the agent');
  const publicKey = createPublicKey(pilot.controls.authorization_public_key);
  assert(publicKey.asymmetricKeyType === 'ed25519', 'Only pinned Ed25519 human authorization keys are supported');
  assert(typeof authorization.signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(authorization.signature) &&
    verify(null, Buffer.from(authorizationMessage(authorization)), publicKey, Buffer.from(authorization.signature, 'base64')), 'Human authorization signature invalid');
  const receipt = digest(authorizationMessage(authorization));
  assert(!ledger.data.resources.some(resource => resource.kind === 'control-authorization' && resource.id === receipt), 'Control authorization already consumed');
  assert(pilot.controls.expected_app_id && pilot.controls.human_reviewers.length > 0, 'Select actual check App and independent human reviewers');
  const state = await preflight(api, pilot, config);
  assert(state.access_errors.length === 0 && state.permissions?.admin === true, 'Admin capability/read-back prerequisites are not available');
  assert(same(controlBaseline(state), controlBaseline(unsigned.baseline)), 'Live control baseline or branch SHA changed; regenerate and reauthorize the plan');
  assert(state.allow_auto_merge === false && state.workflow.default_workflow_permissions === 'read' &&
    state.workflow.can_approve_pull_request_reviews === false, 'Disable auto-merge and privileged workflow defaults through a separate approved operation first');
  assert(state.protection?.protected === false && state.branch?.protected === false && Array.isArray(state.rulesets) && state.rulesets.length === 0,
    'Existing branch protection/rulesets require manual reconciliation; this adapter only creates a new owned ruleset');
  const base = `repos/${repositoryOf(pilot)}`;
  if (state.visibility !== 'public') {
    const organization = await api.request(`orgs/${pilot.organization}`);
    assert(['team', 'enterprise'].includes(organization.plan?.name?.toLowerCase()), 'Private repository ruleset capability is not verified for the organization plan; inspect product support manually');
  }
  const sha = state.branch.commit?.sha;
  assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Branch SHA unreadable');
  const codeowners = await api.request(`${base}/contents/.github/CODEOWNERS?ref=${sha}`);
  assert(codeowners.type === 'file' && codeowners.encoding === 'base64' && typeof codeowners.content === 'string', 'Effective .github/CODEOWNERS is required on the exact branch SHA');
  const lines = Buffer.from(codeowners.content, 'base64').toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const expectedOwners = pilot.controls.human_reviewers.map(login => `@${login}`).sort();
  assert(lines.length === 1 && lines[0].startsWith('* ') && same(lines[0].split(/\s+/).slice(1).sort(), expectedOwners),
    'Only one global CODEOWNERS rule naming exactly the configured independent humans is supported; resolve more complex ownership manually');
  const errors = await api.request(`${base}/codeowners/errors?ref=${sha}`);
  assert(Array.isArray(errors.errors) && errors.errors.length === 0, 'GitHub reports invalid CODEOWNERS');
  for (const login of pilot.controls.human_reviewers) {
    assert(login !== pilot.expected_actor && !login.endsWith('[bot]'), 'Reviewer must be independent of the delegated agent account');
    const collaborator = await api.request(`${base}/collaborators/${login}/permission`);
    assert(collaborator.user?.login === login && collaborator.user?.type === 'User' &&
      ['write', 'maintain', 'admin'].includes(collaborator.permission), `Reviewer lacks verified code-owner write access: ${login}`);
    if (login === authorization.signer) assert(collaborator.permission === 'admin', 'The independent human signer must retain repository administration to recover from lockout');
  }
  const runs = await api.request(`${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(pilot.controls.expected_check)}&filter=latest&per_page=100`);
  assert(Number.isSafeInteger(runs.total_count) && runs.total_count <= 100 && Array.isArray(runs.check_runs), 'Check run discovery is incomplete');
  const expectedRuns = runs.check_runs.filter(run => run.name === pilot.controls.expected_check && run.app?.id === pilot.controls.expected_app_id);
  assert(expectedRuns.length === 1 && expectedRuns[0].head_sha === sha && expectedRuns[0].status === 'completed' &&
    expectedRuns[0].conclusion === 'success', 'Required check is not deployed/successful for this exact SHA and expected App');
  // Re-read after prerequisite discovery; no protection is written against a stale head.
  const latest = await preflight(api, pilot, config);
  assert(latest.access_errors.length === 0 && same(controlBaseline(latest), controlBaseline(state)), 'Baseline changed during prerequisite discovery');
  assert(unsigned.expires_at > Date.now() && authorization.expires_at > Date.now(), 'Plan/authorization expired during prerequisite discovery');
  const expected = rulesetBody(savedPlan);
  ledger.record({ kind: 'control-authorization', id: receipt, owned: true, signer: authorization.signer, plan_hash, consumed_at: now });
  const path = `${base}/rulesets`;
  // POST creates an owned resource; PUT branch protection could overwrite a concurrent foreign edit.
  await ledger.write(`create approved ruleset ${pilot.controls.branch}`, state.rulesets,
    () => api.request(path, { method: 'POST', body: expected }),
    async response => ({
      ruleset: await api.request(`${path}/${response.id}`),
      all: await api.list(`${path}?includes_parents=true`),
    }),
    (after, response) => after.ruleset.id === response.id && rulesetMatches(after.ruleset, expected) &&
      after.all.length === 1 && after.all[0].id === response.id,
    response => ({ kind: 'pilot-ruleset', id: response.id, owned: true, plan_hash, name: expected.name }));
  return {
    repository: repositoryOf(pilot), branch: pilot.controls.branch, plan_hash,
    applied: 'new-owned-branch-ruleset-only', verified_configuration: true, effective_human_workflow_proven: false,
    writes: api.writes, manual: 'Humans must still test independent reviews, checks and merge restrictions on a real PR. No release/security/environment control was applied.',
  };
}

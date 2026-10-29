import { createHash, randomUUID } from 'node:crypto';

export const stages = ['proposal', 'scope', 'implementation', 'verification', 'acceptance', 'review', 'security', 'uat', 'release'];
export const humanStages = ['scope', 'acceptance', 'review', 'security', 'uat', 'release'];
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };

export function candidate({ repository, ticket, scope, sha, artifact }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(ticket) || ticket < 1 ||
      typeof scope !== 'string' || !scope.trim() || !/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{64}$/.test(artifact)) fail('Invalid candidate');
  return { repository, ticket, scope_hash: digest(scope), sha, artifact };
}

// This evaluator has no trusted-human adapter. Local events never authorize real work.
export function evaluate(events, target, roles, { mode = 'simulation', now = Date.now(), expectedRun } = {}) {
  if (mode !== 'simulation') fail('SIMULATED events cannot satisfy real gates; trusted human integration is not implemented');
  if (!roles?.agent || !roles.human || roles.agent === roles.human) fail('Distinct simulation roles required');
  if (typeof expectedRun !== 'string' || !expectedRun) fail('Independent expected run context is required');
  candidate({ ...target, scope: 'shape validation' });
  if (!/^[a-f0-9]{64}$/.test(target.scope_hash)) fail('Invalid scope hash');
  if (!Array.isArray(events) || events.length !== stages.length) fail('Every gate is required exactly once');
  const seen = new Set();
  let run;
  for (const [index, stage] of stages.entries()) {
    const event = events[index];
    if (!event || event.stage !== stage || event.mode !== 'SIMULATED' || event.result !== 'pass') fail(`Missing or denied gate: ${stage}`);
    if (typeof event.id !== 'string' || event.id !== `${expectedRun}:${stage}` || seen.has(event.id)) fail(`Reused decision: ${stage}`);
    seen.add(event.id);
    if (event.run !== expectedRun || (run && event.run !== run)) fail('Cross-run decision reuse');
    run = event.run;
    const human = humanStages.includes(stage);
    if (event.actor !== roles[human ? 'human' : 'agent'] || event.actor_kind !== (human ? 'human-simulated' : 'agent')) fail(`Unauthorized actor: ${stage}`);
    if (event.repository !== target.repository || event.ticket !== target.ticket || event.scope_hash !== target.scope_hash) fail(`Stale scope: ${stage}`);
    if (stage !== 'scope' && (event.sha !== target.sha || event.artifact !== target.artifact)) fail(`Stale candidate: ${stage}`);
    if (stage === 'scope' && (event.sha !== null || event.artifact !== null)) fail('Scope decision must not authorize a future candidate');
    if (!Number.isSafeInteger(event.at) || !Number.isSafeInteger(event.expires) ||
        event.at > now || event.expires <= now || event.expires <= event.at ||
        (index && event.at <= events[index - 1].at)) fail(`Expired or unordered decision: ${stage}`);
    if (typeof event.evidence !== 'string' || !event.evidence.startsWith('simulation:') || event.evidence.length < 20) fail(`Missing simulation evidence: ${stage}`);
    if (stage === 'implementation' && (!Array.isArray(event.checklist) || event.checklist.length !== 3 ||
        event.checklist.some((item, i) => item.key !== ['scope', 'implementation', 'tests'][i] || item.done !== true))) fail('Incomplete agent checklist');
  }
  return { simulation: 'PASS', real_authorization: false, release_published: false, candidate: target, run };
}

export function scenario(target, roles, { now = Date.now(), run = randomUUID() } = {}) {
  return stages.map((stage, index) => {
    const human = humanStages.includes(stage);
    return {
      id: `${run}:${stage}`, run, mode: 'SIMULATED', stage, result: 'pass',
      actor: roles[human ? 'human' : 'agent'], actor_kind: human ? 'human-simulated' : 'agent',
      ...target, ...(stage === 'scope' ? { sha: null, artifact: null } : {}),
      at: now - 10000 + index, expires: now + 60000,
      evidence: `simulation:${stage}:synthetic-evidence-not-a-real-approval`,
      ...(stage === 'implementation' ? { checklist: ['scope', 'implementation', 'tests'].map(key => ({ key, done: true })) } : {}),
    };
  });
}

export function consumeSimulation(events, target, roles, { consumed, ...context }) {
  if (!(consumed instanceof Set)) fail('Independent consumed-decision store required');
  if (events.some(event => consumed.has(event.id))) fail('Previously consumed decision cannot be reused');
  const result = evaluate(events, target, roles, context);
  events.forEach(event => consumed.add(event.id));
  return result;
}

export function simulate(target, roles) {
  const now = Date.now();
  const expectedRun = randomUUID();
  const events = scenario(target, roles, { now, run: expectedRun });
  const consumed = new Set();
  const results = [{ name: 'positive-complete', expected: 'allow-simulation', result: consumeSimulation(events, target, roles, { now, expectedRun, consumed }) }];
  let reuseRejected = false;
  try { consumeSimulation(events, target, roles, { now, expectedRun, consumed }); }
  catch (error) {
    reuseRejected = true;
    results.push({ name: 'previously-consumed-approval', expected: 'reject', rejected: true, reason: error.message });
  }
  if (!reuseRejected) fail('Consumed approval was accepted twice');
  const reject = (name, mutate, mode = 'simulation', replacement = target) => {
    const altered = structuredClone(events);
    mutate(altered);
    try { evaluate(altered, replacement, roles, { now, mode, expectedRun }); }
    catch (error) { results.push({ name, expected: 'reject', rejected: true, reason: error.message }); return; }
    fail(`Negative scenario unexpectedly authorized: ${name}`);
  };
  for (const [index, stage] of stages.entries()) {
    reject(`${stage}:missing`, rows => rows.splice(index, 1));
    reject(`${stage}:denied`, rows => { rows[index].result = 'deny'; });
    reject(`${stage}:expired`, rows => { rows[index].expires = now; });
    reject(`${stage}:wrong-actor`, rows => { rows[index].actor = 'untrusted'; });
    reject(`${stage}:stale-scope`, rows => { rows[index].scope_hash = '0'.repeat(64); });
    reject(`${stage}:unmarked`, rows => { rows[index].mode = 'real'; });
    if (stage !== 'scope') {
      reject(`${stage}:wrong-sha`, rows => { rows[index].sha = '0'.repeat(40); });
      reject(`${stage}:wrong-artifact`, rows => { rows[index].artifact = '0'.repeat(64); });
    }
    if (humanStages.includes(stage)) reject(`${stage}:agent-approval`, rows => {
      rows[index].actor = roles.agent; rows[index].actor_kind = 'agent';
    });
  }
  reject('reused-id', rows => { rows[2].id = rows[1].id; });
  reject('reused-run', rows => { rows[4].run = 'another-run'; });
  reject('scope-change', () => {}, 'simulation', { ...target, scope_hash: digest('changed scope') });
  reject('new-commit', () => {}, 'simulation', { ...target, sha: '1'.repeat(40) });
  reject('new-artifact', () => {}, 'simulation', { ...target, artifact: '1'.repeat(64) });
  reject('real-gates-reject-simulation', () => {}, 'real');
  reject('unchecked-checklist', rows => { rows[2].checklist[2].done = false; });
  reject('wrong-order', rows => { [rows[4], rows[5]] = [rows[5], rows[4]]; });
  reject('missing-evidence', rows => { rows[6].evidence = ''; });
  reject('future-decision', rows => { rows[6].at = now + 100; });
  return {
    mode: 'SIMULATED', real_authorization: false, release_published: false,
    warning: 'Synthetic role-play by an agent, not human approvals, GitHub reviews, UAT or a real release.',
    results, events, consumed_ids: [...consumed],
  };
}

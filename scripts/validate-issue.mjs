import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHub, loadConfig, issuePath, getParent } from './github.mjs';

export const marker = '<!-- bv-agile-framework-validation:v1 -->';

export function hasContent(value) {
  const lines = String(value ?? '').replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/).map(line => line.trim().replace(/^[-*]\s*\[[ xX]\]\s*/, '')
      .replace(/[`*_]/g, '').trim()).filter(Boolean);
  return lines.some(line => !/^(?:no response|n\/a|none|tbd|todo|[-–—~]+)[\s.!]*$/i.test(line));
}

export function sections(body) {
  const result = new Map();
  let heading;
  let fenced = false;
  let fence;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const matchFence = line.match(/^\s*(`{3,}|~{3,})/);
    if (matchFence && (!fenced || matchFence[1][0] === fence)) {
      fenced = !fenced;
      fence = matchFence[1][0];
    }
    const match = !fenced && line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (match) {
      heading = match[1];
      if (!result.has(heading)) result.set(heading, []);
    } else if (heading) {
      result.get(heading).push(line);
    }
  }
  return new Map([...result].map(([key, lines]) => [key, lines.join('\n')]));
}

export function validate(config, issue, parent, children = []) {
  const violations = [];
  const type = issue.type?.name ?? null;
  const label = type ?? 'Untyped Issue';
  if (type !== null && !config.issue_types.includes(type)) {
    // Unmanaged types are preserved; edges involving them still cannot match the hierarchy.
    if (!parent && children.length === 0) return violations;
  }
  const body = sections(issue.body);
  for (const field of Object.values(config.fields)) {
    if (field.required_on?.includes(type) && !hasContent(body.get(field.fallback_heading))) {
      violations.push(`${field.name} requires non-placeholder content.`);
    }
  }
  if (parent) {
    const parentType = parent.type?.name ?? null;
    const rule = config.hierarchy.find(entry => entry.parent === parentType);
    if (!rule?.children.includes(type)) {
      violations.push(`Invalid parent/child types: ${parentType ?? 'Untyped Issue'} → ${label}.`);
    }
  }
  if (config.validation.terminal_types.includes(type) && children.length) {
    violations.push(`${label} must be a leaf (has ${children.length} sub-issues).`);
  }
  const rule = config.hierarchy.find(entry => entry.parent === type);
  for (const child of children) {
    const childType = child.type?.name ?? null;
    if (!rule?.children.includes(childType)) {
      violations.push(`Invalid child #${child.number}: ${label} → ${childType ?? 'Untyped Issue'}.`);
    }
  }
  return violations;
}

export function report(api, issue, violations) {
  const endpoint = issuePath(issue);
  const existing = api.list(`${endpoint}/comments`).filter(comment =>
    comment.user?.type === 'Bot' && comment.user?.login === 'github-actions[bot]'
    && comment.body?.startsWith(marker));
  if (!violations.length && !existing.length) return;
  const body = `${marker}\n### Agile framework validation\n\n${violations.length
    ? violations.map(value => `- ${value}`).join('\n')
    : 'All framework checks pass.'}\n\nReport only: no fields, types, or parent links were changed.`;
  if (existing.length) {
    if (existing[0].body !== body) {
      api.request('PATCH', `${endpoint.replace(/\/issues\/\d+$/, '')}/issues/comments/${existing[0].id}`, { body });
    }
  } else {
    api.request('POST', `${endpoint}/comments`, { body });
  }
}

export function validateLive(api, config, issue) {
  const parent = getParent(api, issue);
  const children = api.list(`${issuePath(issue)}/sub_issues`);
  return { parent, children, violations: validate(config, issue, parent, children) };
}

export function main() {
  const config = loadConfig();
  if (config.field_storage.decision !== config.field_storage.fallback) {
    throw new Error('This validator requires the configured issue-form fallback storage.');
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!event.issue || event.issue.pull_request) return;
  const api = new GitHub();
  const issue = api.request('GET', `repos/${process.env.GITHUB_REPOSITORY}/issues/${event.issue.number}`);
  const result = validateLive(api, config, issue);
  report(api, issue, result.violations);
  console.log(`#${issue.number}: ${result.violations.length} violation(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

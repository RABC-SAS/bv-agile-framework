import { nativeValue } from './policy.mjs';

const round = hours => Math.round(hours * 100) / 100;

// Reads dated time entries from issue comments: "/spent 1.5h 2026-11-20 Client workshop".
// The date defaults to the comment date; a negative entry corrects an earlier one.
export function parseEntries(comments, command = '/spent') {
  const entries = [];
  const invalid = [];
  for (const comment of comments) {
    if (comment.user?.type === 'Bot') continue;
    for (const line of (comment.body ?? '').split(/\r?\n/)) {
      const text = line.trim();
      if (text !== command && !text.startsWith(`${command} `)) continue;
      const match = text.slice(command.length).match(/^\s+(-?\d+(?:\.\d+)?)(h|m)(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(.*))?$/);
      const date = match?.[3] ?? comment.created_at?.slice(0, 10);
      const real = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
      if (!match || !real || Number(match[1]) === 0) {
        invalid.push({ comment_id: comment.id, url: comment.html_url ?? null, line: text });
        continue;
      }
      entries.push({
        comment_id: comment.id, url: comment.html_url ?? null, author: comment.user?.login ?? null, date,
        hours: round(Number(match[1]) / (match[2] === 'm' ? 60 : 1)), note: match[4]?.trim() ?? '',
      });
    }
  }
  return { entries, invalid };
}

// Read-only: lists entries per issue and compares their sum with the total field.
export async function timeReport(api, config, { numbers } = {}) {
  if (!config.time_tracking) throw new Error('time_tracking is not configured');
  const repository = `${config.organization}/${config.repository}`;
  const definitions = (await api.list(`orgs/${config.organization}/issue-fields`)).filter(field => field.name === config.time_tracking.total_field);
  if (definitions.length !== 1 || definitions[0].data_type !== 'number') throw new Error(`Expected one organization number field: ${config.time_tracking.total_field}`);
  const issues = numbers ? numbers.map(number => ({ number })) : (await api.list(`repos/${repository}/issues?state=all`)).filter(issue => !issue.pull_request);
  const entries = [];
  const totals = [];
  const invalid = [];
  for (const { number } of issues) {
    const parsed = parseEntries(await api.list(`repos/${repository}/issues/${number}/comments`), config.time_tracking.command);
    const value = nativeValue((await api.list(`repos/${repository}/issues/${number}/issue-field-values`)).find(row => row.issue_field_id === definitions[0].id));
    const logged = round(parsed.entries.reduce((sum, entry) => sum + entry.hours, 0));
    const total = typeof value === 'number' ? value : null;
    entries.push(...parsed.entries.map(entry => ({ issue: number, ...entry })));
    invalid.push(...parsed.invalid.map(entry => ({ issue: number, ...entry })));
    if (parsed.entries.length || total !== null) totals.push({ issue: number, logged, total, differs: parsed.entries.length > 0 && logged !== total });
  }
  return { field: config.time_tracking.total_field, entries, totals, invalid, differences: totals.filter(row => row.differs).length, writes: api.writes };
}

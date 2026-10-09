import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function loadConfig() {
  return JSON.parse(execFileSync('ruby', [
    '-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.safe_load_file(ARGV.fetch(0)))',
    `${root}.github/planning/hierarchy.yml`,
  ], { encoding: 'utf8' }));
}

export class GitHub {
  request(method, endpoint, body, paginate = false) {
    const args = ['api', endpoint, '--method', method,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10'];
    if (body !== undefined) args.push('--input', '-');
    if (paginate) args.push('--paginate', '--slurp');
    try {
      const output = execFileSync('gh', args, {
        input: body === undefined ? undefined : JSON.stringify(body),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() ? JSON.parse(output) : null;
    } catch (error) {
      const message = String(error.stderr || error.message);
      const failure = new Error(`${method} ${endpoint}: ${message.trim()}`);
      failure.status = Number(message.match(/HTTP (\d+)/)?.[1]);
      throw failure;
    }
  }

  list(endpoint) {
    const pages = this.request('GET', endpoint, undefined, true);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new Error(`Expected list pages from ${endpoint}`);
    }
    return pages.flat();
  }

  graphql(query, variables = {}) {
    const response = this.request('POST', 'graphql', { query, variables });
    if (response.errors?.length) throw new Error(JSON.stringify(response.errors));
    return response.data;
  }
}

export function issuePath(issue) {
  const repository = new URL(issue.repository_url).pathname.replace(/^\/repos\//, '');
  return `repos/${repository}/issues/${issue.number}`;
}

export function getParent(api, issue) {
  try {
    return api.request('GET', `${issuePath(issue)}/parent`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

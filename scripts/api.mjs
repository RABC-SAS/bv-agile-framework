import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export class ApiError extends Error {
  constructor(status, message) {
    super(`GitHub HTTP ${status}: ${message}`);
    this.status = status;
  }
}

export class GitHub {
  constructor({ dryRun = false, transport } = {}) {
    this.dryRun = dryRun;
    this.transport = transport;
    this.writes = 0;
  }

  async request(path, { method = 'GET', body } = {}) {
    const graphRead = path === 'graphql' && method === 'POST' && /^query(?:\s|[({])/.test(body?.query ?? '') && !/\bmutation\b/.test(body.query);
    const write = method !== 'GET' && !graphRead;
    if (this.dryRun && write) throw new Error(`Dry-run blocked ${method} ${path}`);
    if (write) this.writes += 1;
    if (this.transport) return this.transport(path, { method, body });
    if (path.startsWith('https://api.github.com/')) path = path.slice('https://api.github.com/'.length);
    if (!/^[a-zA-Z_][\w/?=&%.:-]*$/.test(path)) throw new Error('Unsafe GitHub API path');
    const token = write ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN : process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      const response = await fetch(`https://api.github.com/${path}`, {
        method,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const result = text ? JSON.parse(text) : null;
      if (!response.ok) throw new ApiError(response.status, result?.message ?? 'Request failed');
      return result;
    }
    const executable = process.env.GH_BIN || (process.platform === 'win32' ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh');
    try {
      const args = ['api', path, '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
      if (body !== undefined) args.push('--input', '-');
      const output = execFileSync(executable, args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      return output.trim() ? JSON.parse(output) : null;
    } catch (error) {
      const status = Number(String(error.stderr ?? '').match(/HTTP (\d{3})/)?.[1] ?? 0);
      throw new ApiError(status, `CLI request failed for ${method} ${path}`);
    }
  }

  async graphql(query, variables = {}, { mutation = false } = {}) {
    if (this.dryRun && mutation) throw new Error('Dry-run blocked GraphQL mutation');
    const result = await this.request('graphql', { method: 'POST', body: { query, variables } });
    if (result.errors?.length) throw new Error(`GraphQL: ${result.errors.map(error => error.message).join('; ')}`);
    return result.data;
  }

  async list(path) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const rows = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error(`Expected paginated array: ${path}`);
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }
}

export class Ledger {
  constructor(path, { dryRun = false, repository } = {}) {
    if (!path) throw new Error('--manifest outside the repository is required');
    this.path = resolve(path);
    this.dryRun = dryRun;
    let ancestor = dirname(this.path);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const resolvedParent = resolve(realpathSync(ancestor), relative(ancestor, dirname(this.path)));
    const local = relative(realpathSync(process.cwd()), resolvedParent);
    if (local === '' || (!local.startsWith('..') && !isAbsolute(local))) throw new Error('Manifest must be outside the repository');
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { schema: 1, repository, resources: [], operations: [], evidence: [] };
    if (this.data.schema !== 1 || this.data.repository !== repository) throw new Error('Manifest repository or schema mismatch');
    if (this.data.operations.some(operation => operation.state === 'pending')) throw new Error('Manifest has an interrupted write; inspect before resuming');
  }

  save() {
    if (this.dryRun) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }

  record(resource) {
    const existing = this.data.resources.find(candidate => candidate.kind === resource.kind && candidate.id === resource.id);
    if (existing) {
      if (existing.owned !== resource.owned) throw new Error('Resource ownership cannot be changed');
      return;
    }
    this.data.resources.push(resource);
    this.save();
  }

  async write(action, before, mutate, readBack, verify, identify) {
    if (this.dryRun) throw new Error(`Dry-run blocked manifest write: ${action}`);
    const operation = { action, before, state: 'pending', started_at: new Date().toISOString() };
    this.data.operations.push(operation);
    this.save();
    let response;
    try { response = await mutate(); }
    catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        operation.state = 'permission_denied';
        operation.error = error.message;
        this.save();
      }
      throw error;
    }
    operation.response = response;
    if (identify) this.record(identify(response));
    this.save();
    const after = await readBack(response);
    operation.after = after;
    if (!verify(after, response)) throw new Error(`Read-back verification failed: ${action}`);
    operation.state = 'verified';
    this.save();
    return after;
  }
}

export async function projectState(api, config) {
  const identity = await api.graphql('query($owner:String!,$number:Int!){organization(login:$owner){login projectV2(number:$number){id number title url closed viewerCanUpdate}}}', { owner: config.project.owner, number: config.project.number });
  const project = identity.organization?.projectV2;
  if (!project || project.closed || identity.organization.login !== config.project.owner || project.title !== config.project.title || project.number !== config.project.number) {
    throw new Error('Existing project identity mismatch or inaccessible; never create a substitute');
  }
  const fields = [];
  let cursor = null;
  do {
    const data = await api.graphql('query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{fields(first:100,after:$cursor){nodes{__typename ... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}} ... on ProjectV2IterationField{id name dataType}} pageInfo{hasNextPage endCursor}}}}}', { id: project.id, cursor });
    const connection = data.node?.fields;
    if (!connection || connection.nodes.some(field => !field)) throw new Error('Project fields are unreadable or redacted');
    fields.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return { ...project, owner: identity.organization.login, fields };
}

export async function projectStatuses(api, config) {
  const project = await projectState(api, config);
  const fields = project.fields.filter(field => field.name === config.project.status_field);
  if (fields.length !== 1 || fields[0].dataType !== 'SINGLE_SELECT') throw new Error('Expected one single-select project Status field');
  for (const name of config.project.statuses) {
    if (fields[0].options.filter(option => option.name === name).length !== 1) throw new Error(`Project Status option missing or ambiguous: ${name}`);
  }
  const items = new Map();
  let cursor = null;
  do {
    const data = await api.graphql('query($id:ID!,$cursor:String,$field:String!){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){nodes{id content{__typename ... on Issue{id number repository{nameWithOwner}} ... on PullRequest{id} ... on DraftIssue{id}} fieldValueByName(name:$field){__typename ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id}}}}} pageInfo{hasNextPage endCursor}}}}}', { id: project.id, cursor, field: config.project.status_field });
    const connection = data.node?.items;
    if (!connection) throw new Error('Project items are unreadable');
    for (const item of connection.nodes) {
      if (!item?.content) throw new Error('Project item content is redacted; access failure');
      if (item.content.__typename !== 'Issue' || item.content.repository.nameWithOwner !== `${config.organization}/${config.repository}`) continue;
      if (items.has(item.content.id)) throw new Error('Duplicate project items for the same issue');
      const value = item.fieldValueByName;
      if (value && (value.__typename !== 'ProjectV2ItemFieldSingleSelectValue' || value.field.id !== fields[0].id)) throw new Error('Project status value is unreadable or incompatible');
      items.set(item.content.id, { id: item.id, number: item.content.number, status: value?.name ?? config.project.empty_status });
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return { project, field: fields[0], items };
}
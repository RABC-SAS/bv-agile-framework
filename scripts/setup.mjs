import { projectState } from './api.mjs';

export async function provision(api, ledger, config, kind) {
  await projectState(api, config);
  const repository = `${config.organization}/${config.repository}`;
  const repo = await api.request(`repos/${repository}`);
  if (!repo.permissions?.push) throw new Error('Push permission required before setup writes');
  const path = `orgs/${config.organization}/${kind === 'type' ? 'issue-types' : 'issue-fields'}`;
  const before = await api.list(path);
  if (kind === 'type' && before.some(resource => resource.name === 'Issue')) throw new Error('Unmanaged Issue type exists; stop');
  const definitions = kind === 'type' ? config.issue_types.map(name => ({ name, is_enabled: true }))
    : Object.values(config.fields).filter(field => field.storage === 'organization_field').map(field => ({ name: field.name, data_type: field.data_type, ...(field.options ? { options: field.options } : {}) }));
  const planned = [];
  for (const definition of definitions) {
    const matches = before.filter(resource => resource.name === definition.name);
    if (matches.length > 1 || matches.some(resource => kind === 'type' ? !resource.is_enabled : resource.data_type !== definition.data_type)) throw new Error(`Ambiguous or incompatible ${kind}: ${definition.name}`);
    if (matches.length && definition.options && JSON.stringify(matches[0].options.map(({ name, color, priority }) => ({ name, color, priority }))) !== JSON.stringify(definition.options)) throw new Error(`Existing options differ: ${definition.name}; no existing field updated`);
    if (matches.length) {
      const recorded = ledger.data.resources.find(resource => resource.kind === kind && resource.id === matches[0].id);
      ledger.record({ kind, id: matches[0].id, name: definition.name, owned: recorded?.owned ?? false, before: matches[0] });
    } else planned.push(definition);
  }
  if (before.length + planned.length > 25) throw new Error('Organization limit would be exceeded');
  if (api.dryRun) return { planned, writes: 0 };
  for (const definition of planned) {
    await ledger.write(`create ${kind}: ${definition.name}`, before,
      () => api.request(path, { method: 'POST', body: definition }),
      () => api.list(path),
      (after, response) => {
        const matches = after.filter(resource => resource.name === definition.name);
        return matches.length === 1 && matches[0].id === response.id && (kind === 'type' ? matches[0].is_enabled : matches[0].data_type === definition.data_type) && before.every(resource => JSON.stringify(after.find(candidate => candidate.id === resource.id)) === JSON.stringify(resource));
      },
      response => ({ kind, id: response.id, name: response.name, owned: true }));
  }
  return { planned, writes: api.writes };
}
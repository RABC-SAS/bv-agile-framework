import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: true });

export function loadConfig(path = '.github/planning/hierarchy.yml') {
  const config = YAML.parse(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (config.schema_version !== 2) throw new Error('Unsupported hierarchy schema');
  if (config.validation.mode !== 'report_only') throw new Error('Only report-only validation is supported');
  if (config.project.owner !== config.organization || !Number.isSafeInteger(config.project.number) || config.project.number <= 0) throw new Error('Invalid project identity');
  const statuses = config.project.statuses;
  if (!Array.isArray(statuses) || !statuses.length || new Set(statuses).size !== statuses.length || !statuses.includes(config.project.empty_status)) throw new Error('Invalid ordered project statuses');
  if (!Array.isArray(config.validation.placeholders) || config.validation.placeholders.some(value => typeof value !== 'string') || !config.validation.marker?.startsWith('<!--')) throw new Error('Invalid validation reporting/content settings');
  if (new Set(config.issue_types).size !== config.issue_types.length || config.issue_types.includes('Issue')) {
    throw new Error('Types must be unique; Issue must remain untyped');
  }
  if (config.leaf_issue_type !== null) throw new Error('The leaf issue type must be null');
  const known = new Set([...config.issue_types, null]);
  const parents = new Set();
  for (const rule of config.hierarchy) {
    if (!known.has(rule.parent) || parents.has(rule.parent) || config.validation.terminal_types.includes(rule.parent)) {
      throw new Error('Invalid or duplicate hierarchy parent');
    }
    parents.add(rule.parent);
    if (rule.children.some(child => !known.has(child))) throw new Error('Unknown child type');
  }
  for (const type of known) {
    const visit = (current, trail = []) => {
      if (trail.includes(current)) throw new Error('Hierarchy configuration contains a cycle');
      for (const child of config.hierarchy.find(rule => rule.parent === current)?.children ?? []) {
        visit(child, [...trail, current]);
      }
    };
    visit(type);
  }
  const fieldNames = new Set();
  const headings = new Set();
  const formIds = new Set([config.forms.description_form_id]);
  for (const field of Object.values(config.fields)) {
    if (!field.name || fieldNames.has(field.name)) throw new Error('Field names must be unique');
    fieldNames.add(field.name);
    if ([...(field.required_on ?? []), ...(field.applies_to ?? [])].some(type => !known.has(type))) {
      throw new Error(`Unknown type in field ${field.name}`);
    }
    if (!Array.isArray(field.applies_to) || (field.required_on ?? []).some(type => !field.applies_to.includes(type))) throw new Error(`Invalid applicability: ${field.name}`);
    if (field.required_on?.length && !statuses.includes(field.required_from_status)) throw new Error(`Invalid required_from_status: ${field.name}`);
    if (field.storage === 'issue_body') {
      if (!field.heading || headings.has(field.heading) || field.heading === config.forms.description_heading || !/^[a-z][a-z0-9_]*$/.test(field.form_id ?? '') || formIds.has(field.form_id)) throw new Error(`Invalid or duplicate body section: ${field.name}`);
      headings.add(field.heading);
      formIds.add(field.form_id);
    } else if (field.storage === 'organization_field') {
      if (!['text', 'number', 'date', 'single_select', 'multi_select'].includes(field.data_type)) throw new Error(`Unsupported native data type: ${field.name}`);
      if (field.data_type.endsWith('select') && !field.options?.length) throw new Error(`Select field options required: ${field.name}`);
      checkOptions(field, config.validation.placeholders);
    } else throw new Error(`Unsupported storage: ${field.name}`);
    if (field.description !== undefined && typeof field.description !== 'string') throw new Error(`Invalid description: ${field.name}`);
    for (const key of ['inherit_from_ancestors', 'required_without_children']) {
      if (field[key] !== undefined && typeof field[key] !== 'boolean') throw new Error(`${key} must be true or false: ${field.name}`);
    }
    if (field.inherit_from_ancestors && field.storage !== 'organization_field') throw new Error(`Only organization fields can be inherited: ${field.name}`);
    if (field.minimum !== undefined && (field.data_type !== 'number' || !Number.isFinite(field.minimum))) throw new Error(`minimum requires a number field: ${field.name}`);
  }
  for (const field of Object.values(config.fields)) {
    if (field.required_when === undefined) continue;
    const source = Object.values(config.fields).find(candidate => candidate.name === field.required_when?.field);
    const values = field.required_when?.in;
    if (!source || source === field || source.storage !== 'organization_field' || source.data_type !== 'single_select' || source.required_when) throw new Error(`required_when must name another unconditional single-select organization field: ${field.name}`);
    if (!Array.isArray(values) || !values.length || values.some(value => !source.options.some(option => option.name === value))) throw new Error(`required_when lists an unknown option: ${field.name}`);
  }
  if (config.time_tracking !== undefined) {
    const total = Object.values(config.fields).find(field => field.name === config.time_tracking.total_field);
    if (!/^\/[a-z]+$/.test(config.time_tracking.command ?? '') || total?.storage !== 'organization_field' || total.data_type !== 'number') throw new Error('time_tracking needs a /command and a number organization field');
  }
  return config;
}

const optionColors = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'];

function checkOptions(field, placeholders) {
  if (field.options === undefined) return;
  if (!field.data_type.endsWith('select') || !Array.isArray(field.options)) throw new Error(`Options require a select field: ${field.name}`);
  const names = field.options.map(option => option?.name);
  const priorities = field.options.map(option => option?.priority);
  if (new Set(names).size !== names.length || new Set(priorities).size !== priorities.length) throw new Error(`Option names and priorities must be unique: ${field.name}`);
  for (const option of field.options) {
    // A placeholder such as "N/A" as an option would always read as an empty value.
    if (!hasContent(option.name, placeholders) || !optionColors.includes(option.color) || !Number.isSafeInteger(option.priority) || option.priority <= 0 || Object.keys(option).length !== 3) {
      throw new Error(`Invalid option in ${field.name}: each needs only a real name, a supported color and a positive priority`);
    }
  }
}

export function hasContent(value, placeholders = []) {
  if (typeof value !== 'string') return false;
  const tokens = markdown.parse(value.replace(/[\p{Cf}\u00a0]/gu, ' '), {});
  const visible = [];
  const collect = token => {
    if (['text', 'code_inline', 'fence', 'code_block'].includes(token.type)) visible.push(token.content);
    for (const child of token.children ?? []) collect(child);
  };
  tokens.forEach((token, index) => {
    if (token.type === 'inline' && tokens[index - 1]?.type === 'heading_open') return;
    collect(token);
  });
  const lines = visible.join('\n').split('\n').map(line => line.replace(/^[\s\[\]xX-]+/, '').trim()).filter(Boolean);
  const normalize = text => text.replace(/[.!]+$/, '').trim().toLowerCase();
  const rejected = new Set(placeholders.map(normalize));
  return lines.some(line => /[\p{L}\p{N}]/u.test(line) && !rejected.has(normalize(line)));
}

export function sections(body, heading) {
  const tokens = markdown.parse(body ?? '', {});
  const found = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || token.level !== 0 || token.tag !== 'h3' || tokens[index + 1]?.content !== heading) continue;
    const start = tokens[index + 1].map?.[1] ?? token.map[1];
    let end = (body ?? '').split('\n').length;
    for (let next = index + 3; next < tokens.length; next += 1) {
      if (tokens[next].type === 'heading_open' && tokens[next].level === 0 && Number(tokens[next].tag.slice(1)) <= 3) {
        end = tokens[next].map[0];
        break;
      }
    }
    found.push((body ?? '').split('\n').slice(start, end).join('\n'));
  }
  return found;
}

export function issueType(issue) {
  if (!Object.hasOwn(issue, 'type')) throw new Error('Issue type is unreadable');
  if (issue.type === null) return null;
  if (typeof issue.type?.name !== 'string') throw new Error('Issue type is unreadable');
  return issue.type.name;
}

// A select value may arrive as the option name or as the option object.
export function nativeValue(row) {
  if (!row) return undefined;
  if (row.value !== undefined && row.value !== null) return row.value;
  if (row.single_select_option?.name) return row.single_select_option.name;
  if (Array.isArray(row.multi_select_options)) return row.multi_select_options.map(option => option.name);
  return undefined;
}

export function validateIssue(config, { issue, status, parent = null, children = [], ancestors = [], fieldValues, orgFields, ancestorFieldValues }) {
  const errors = [];
  const type = issueType(issue);
  const label = type ?? 'untyped issue';
  const descriptions = sections(issue.body, config.forms.description_heading);
  if (descriptions.length > 1 || (config.forms.description_required &&
      (descriptions.length !== 1 || !hasContent(descriptions[0], config.validation.placeholders)))) {
    errors.push(`${config.forms.description_heading}: section is missing, duplicated, empty or placeholder`);
  }
  if (status === undefined) errors.push('Project status is unreadable');
  else if (status !== null && !config.project.statuses.includes(status)) errors.push(`Unknown project status: ${status}`);
  const present = value => typeof value === 'string' ? hasContent(value, config.validation.placeholders) : typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) && value.length > 0;
  const states = new Map();
  // Reads one organization field: its own value and, when allowed, the nearest parent value.
  const native = field => {
    if (states.has(field.name)) return states.get(field.name);
    const state = { values: [] };
    states.set(field.name, state);
    if (!Array.isArray(orgFields) || !Array.isArray(fieldValues)) return Object.assign(state, { error: `${field.name}: native field values or definitions are unreadable` });
    const definitions = orgFields.filter(candidate => candidate.name === field.name);
    if (definitions.length !== 1 || definitions[0].data_type !== field.data_type) return Object.assign(state, { error: `${field.name}: expected one organization ${field.data_type} field` });
    const pick = rows => rows.filter(candidate => candidate.issue_field_id === definitions[0].id);
    state.values = pick(fieldValues).map(row => ({ ...row, value: nativeValue(row) }));
    state.ambiguous = state.values.length > 1 || state.values.some(candidate => candidate.data_type !== field.data_type);
    if (!state.ambiguous && present(state.values[0]?.value)) state.effective = state.values[0].value;
    else if (!state.ambiguous && field.inherit_from_ancestors && ancestors.length) {
      if (!Array.isArray(ancestorFieldValues) || ancestorFieldValues.length !== ancestors.length || ancestorFieldValues.some(rows => !Array.isArray(rows))) state.inheritedUnreadable = true;
      else state.effective = ancestorFieldValues.map(rows => nativeValue(pick(rows)[0])).find(present);
    }
    return state;
  };
  for (const field of Object.values(config.fields)) {
    const source = field.required_when && Object.values(config.fields).find(candidate => candidate.name === field.required_when.field);
    const required = (field.required_on?.includes(type) ?? false) && status !== null && config.project.statuses.indexOf(status) >= config.project.statuses.indexOf(field.required_from_status)
      && !(field.required_without_children && children.length > 0)
      && (!source || field.required_when.in.includes(native(source).effective));
    if (field.storage === 'organization_field') {
      const state = native(field);
      if (state.error) {
        errors.push(state.error);
        continue;
      }
      if (state.ambiguous) {
        errors.push(`${field.name}: ambiguous or incompatible field values`);
      } else if (required && state.effective === undefined) {
        errors.push(state.inheritedUnreadable ? `${field.name}: required for ${label} at ${status}; parent values are unreadable`
          : `${field.name}: required for ${label} at ${status}; value is missing or placeholder${field.inherit_from_ancestors ? ' here and on every parent' : ''}`);
      }
      if (field.minimum !== undefined && state.values.some(candidate => typeof candidate.value === 'number' && candidate.value < field.minimum)) {
        errors.push(`${field.name}: must be at least ${field.minimum}`);
      }
      if (config.validation.check_field_applicability && !field.applies_to.includes(type) && state.values.some(candidate => present(candidate.value))) {
        errors.push(`${field.name}: does not apply to ${label}`);
      }
    } else {
      const values = sections(issue.body, field.heading);
      if (values.length > 1 || (required && (values.length !== 1 || !hasContent(values[0], config.validation.placeholders)))) {
        errors.push(`${field.name}: required for ${label} at ${status}; section is missing, duplicated, empty or placeholder`);
      }
    }
  }
  const allowed = parentType => config.hierarchy.find(rule => rule.parent === parentType)?.children ?? [];
  if (config.validation.enforce_allowed_parent_child_types && parent && !allowed(issueType(parent)).includes(type)) {
    errors.push(`Disallowed hierarchy: ${issueType(parent) ?? 'untyped issue'} -> ${label}`);
  }
  for (const child of children) {
    if (config.validation.enforce_allowed_parent_child_types && !allowed(type).includes(issueType(child))) {
      errors.push(`Disallowed hierarchy: ${label} -> ${issueType(child) ?? 'untyped issue'}`);
    }
  }
  if (config.validation.terminal_types.includes(type) && children.length) errors.push(`${label} must be terminal with no sub-issues`);
  const ids = [issue.id, ...ancestors.map(ancestor => ancestor.id)];
  if (new Set(ids).size !== ids.length) errors.push('Hierarchy cycle detected');
  return [...new Set(errors)];
}

export function formDocuments(config) {
  return new Map([...config.issue_types, null].map(type => {
    const name = type ?? 'Untyped Issue';
    const body = [{ type: 'textarea', id: config.forms.description_form_id, attributes: { label: config.forms.description_heading }, validations: { required: config.forms.description_required } }];
    for (const field of Object.values(config.fields)) {
      if (field.storage === 'issue_body' && field.applies_to.includes(type)) body.push({ type: 'textarea', id: field.form_id, attributes: { label: field.heading }, validations: { required: false } });
    }
    return [`${(type ?? 'untyped_issue').toLowerCase().replaceAll(' ', '_')}.yml`, `# Generated from .github/planning/hierarchy.yml\n${YAML.stringify({ name, description: `Create ${name}`, ...(type === null ? {} : { type }), body })}`];
  }));
}
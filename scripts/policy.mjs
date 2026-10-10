import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: true });
export const marker = '<!-- bv-agile-framework-validation:v1 -->';
export const nativeMode = 'native_issue_fields';
export const bodyMode = 'issue_form_sections_and_validation_action';

export function loadConfig(path = '.github/planning/hierarchy.yml') {
  const config = YAML.parse(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (config.schema_version !== 1) throw new Error('Unsupported hierarchy schema');
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
  for (const field of Object.values(config.fields)) {
    if ([...(field.required_on ?? []), ...(field.applies_to ?? [])].some(type => !known.has(type))) {
      throw new Error(`Unknown type in field ${field.name}`);
    }
    if (field.native_type !== 'text') throw new Error(`Expected native text field: ${field.name}`);
  }
  return config;
}

export function hasContent(value) {
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
  const placeholder = /^(?:tbd|todo|n\/?a|none|null|placeholder|no response|not provided|not applicable|to be (?:defined|determined|added)|(?:enter|add|insert|your) (?:text|criteria|evidence|description)(?: here)?)[.!]*$/i;
  return lines.some(line => /[\p{L}\p{N}]/u.test(line) && !placeholder.test(line));
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

export function validateIssue(config, { issue, parent = null, children = [], ancestors = [], fieldValues, orgFields }) {
  const errors = [];
  const type = issueType(issue);
  const label = type ?? 'untyped issue';
  const decision = config.field_storage.decision;
  if (![nativeMode, bodyMode].includes(decision)) errors.push('Field storage decision is unresolved');
  for (const field of Object.values(config.fields)) {
    const required = field.required_on?.includes(type) ?? false;
    const native = !field.fallback_heading || decision === nativeMode;
    if (native) {
      if (!Array.isArray(orgFields) || !Array.isArray(fieldValues)) {
        errors.push(`${field.name}: native field values or definitions are unreadable`);
        continue;
      }
      const definitions = orgFields.filter(candidate => candidate.name === field.name);
      if (definitions.length !== 1 || definitions[0].data_type !== field.native_type) {
        errors.push(`${field.name}: expected one organization ${field.native_type} field`);
        continue;
      }
      const values = fieldValues.filter(candidate => candidate.issue_field_id === definitions[0].id);
      if (values.length > 1 || values.some(candidate => candidate.data_type !== field.native_type)) {
        errors.push(`${field.name}: ambiguous or incompatible field values`);
      } else if (required && !hasContent(values[0]?.value)) {
        errors.push(`${field.name}: required for ${label}; content is empty, whitespace or placeholder`);
      }
      if (field.applies_to && !field.applies_to.includes(type) && values.some(candidate => hasContent(candidate.value))) {
        errors.push(`${field.name}: does not apply to ${label}`);
      }
    } else if (required && decision === bodyMode) {
      const values = sections(issue.body, field.fallback_heading);
      if (values.length !== 1 || !hasContent(values[0])) {
        errors.push(`${field.name}: required for ${label}; section is missing, duplicated, empty, whitespace or placeholder`);
      }
    }
  }
  const allowed = parentType => config.hierarchy.find(rule => rule.parent === parentType)?.children ?? [];
  if (parent && !allowed(issueType(parent)).includes(type)) {
    errors.push(`Disallowed hierarchy: ${issueType(parent) ?? 'untyped issue'} -> ${label}`);
  }
  for (const child of children) {
    if (!allowed(type).includes(issueType(child))) {
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
    const body = [{ type: 'textarea', id: config.field_storage.description_form_id, attributes: { label: config.field_storage.description_heading }, validations: { required: true } }];
    if (config.field_storage.decision !== nativeMode) {
      for (const field of Object.values(config.fields)) {
        if (field.required_on?.includes(type)) body.push({ type: 'textarea', id: field.fallback_form_id, attributes: { label: field.fallback_heading }, validations: { required: true } });
      }
    }
    return [`${(type ?? 'untyped_issue').toLowerCase().replaceAll(' ', '_')}.yml`, `# Generated from .github/planning/hierarchy.yml\n${YAML.stringify({ name, description: `Create ${name}`, ...(type === null ? {} : { type }), body })}`];
  }));
}
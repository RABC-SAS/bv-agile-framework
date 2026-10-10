# Setup and Extension

## Configure

Install Node.js 22+ and GitHub CLI; authenticate directly with `gh auth login --web`.
Run `npm ci --ignore-scripts`. All operational commands support `--dry-run`.

```powershell
node scripts/planning.mjs inspect --dry-run
node scripts/planning.mjs setup --dry-run --manifest "$env:TEMP/bv-agile-framework/setup.json"
node scripts/planning.mjs setup --manifest "$env:TEMP/bv-agile-framework/setup.json"
node scripts/planning.mjs generate-forms
node scripts/planning.mjs check-forms --dry-run
```

Setup creates only missing YAML types and organization fields. Existing Task, Bug, Feature, Priority, Start date,
Target date and Effort are preserved. It never creates a replacement project or project-only field copies.
Exact-name/type conflicts stop setup. Each write is recorded outside the repo and read back before proceeding.
Organization writes require an organization owner with setup-only authority (OAuth `admin:org` or a suitable App).
Project access requires `project` for sample item writes; read-only validation does not require project-write access.
Do not put an organization-admin PAT in Actions secrets.

In organization Settings > Planning > Issue fields, open Cost Centre and configure its pinned types as
Initiative, Epic and Feature using the field's type applicability controls. Verify those controls in the live UI;
API setup does not claim to set pinning. In project #2's field menu, select the organization Cost Centre field,
not a new custom project field. Leave existing views, workflows and auto-add rules unchanged.

## Validate Status Gates

The issue forms deliberately do not require criteria or evidence when an issue is created in Backlog.
The YAML's ordered `project.statuses` makes `required_from_status` cumulative through later statuses.
An unchecked acceptance checklist is valid; placeholders, whitespace and missing/duplicate sections are not.
Status spellings must exactly match GitHub's options, including `In review`.
An empty project status is treated as the configured `empty_status` (Backlog).
Issues outside the configured project have no stage gate; their hierarchy and native-field applicability are still checked.
Unreadable/redacted project items or field values fail validation rather than being treated as empty or absent.

```powershell
node scripts/planning.mjs validate --dry-run --manifest "$env:TEMP/bv-agile-framework/validation.json"
node scripts/planning.mjs validate --numbers 12,13 --manifest "$env:TEMP/bv-agile-framework/validation.json"
```

Validation updates one stable reporter-owned marker comment, exits nonzero on violations and does not change status.
Use the same reporter account consistently; foreign or duplicate marker comments stop reporting rather than being overwritten.
The small test suite is `npm test`; CI also checks that generated forms match the YAML.

## Activate the Action

Review and merge the setup PR. Issue creation, edits, type/field changes, hourly reconciliation and manual runs
validate every repository issue. Project-status and hierarchy changes do not natively trigger this Action;
the hourly reconciliation detects them, or run the workflow manually for an immediate check.
For immediate automatic feedback, install an external GitHub App/webhook bridge subscribed to `projects_v2_item`
and `sub_issues`; it dispatches `bv-agile-hierarchy-changed`. This bridge is not included or deployed here.

CI has already shown that the repository `GITHUB_TOKEN` cannot read organization fields or the private project.
Provide `AGILE_READ_TOKEN` as a narrowly scoped read credential with tested project, issue/hierarchy and
organization-field access, preferably an App installation token refreshed by the App integration. Installation
tokens expire; a one-off token pasted into a secret is not a durable solution. Never use admin credentials here.
The read credential handles reads; `GITHUB_TOKEN` with `issues: write` handles comments.
If the App token endpoints cannot read organization fields, resolve supported permissions before enabling validation.
Use repository/organization Secrets settings directly; do not send tokens through chat or commit them.

This is report-only control, not a GitHub UI transition lock. Rolling back statuses is deliberately not implemented.

## Verify With Samples

Use only titles `[bv-agile-framework-smoke] <key>` from `smoke_test.fixtures`; search both open and closed issues,
stop on duplicates and record created IDs outside the repo before any later mutation. Do not adopt production issues.

1. Create the YAML's Initiative > Epic > Feature > User Story / Bug Story > Task / untyped issue hierarchy.
2. Assign types explicitly, read each back, and link children with their numeric issue IDs without replacing parents.
3. Add fixtures to existing project #2 and record project item IDs. Assign Cost Centre only to its configured types.
4. Confirm Backlog passes with empty sections; Ready fails without Acceptance Criteria and passes after adding it.
5. Confirm In review fails without Delivery Evidence and passes after adding a real link or delivery detail.
6. Test whitespace, TBD, type changes and illegal hierarchy links; restore each owned fixture and rerun validation.
7. Rerun setup and validation to check no duplicate resources/comments; dry-run must make no writes.
8. Remove only recorded owned project items and close only recorded owned fixtures. Preserve shared resources.

Live sample testing requires the missing organization types and Cost Centre to exist. Local tests alone are not live evidence.

## Extend the YAML

Add a body section using the same pattern as existing fields:

```yaml
security_review:
  name: Security Review
  storage: issue_body
  heading: Security Review
  form_id: security_review
  applies_to: [Feature]
  required_on: [Feature]
  required_from_status: In review
```

For native fields use `storage: organization_field` plus `data_type` (`text`, `number`, `date`, `single_select`,
or `multi_select`). Select fields need `options` objects with name, color and priority. Setup stops rather than
changing incompatible existing options. Use `required_on: []` for optional fields.
Edit `hierarchy` to change allowed children; edit `validation.placeholders` to extend rejected content.
Regenerate forms, run `npm test` and `check-forms`, then review the YAML change in a PR.
For a removed/renamed type, explicitly review deletion of its generated form; unmanaged forms/resources are never removed automatically.
New rule kinds beyond status gates, hierarchy and field applicability require validator code, not just a new YAML key.
# Independent RABC-SAS Setup

This implementation follows the hierarchy YAML and does not use or modify PR #1.
Project #2 was confirmed live as **Agile Project Config**, node ID `PVT_kwDOFEjvg84Bma0l`.
The YAML target edit is proposed for review; no hierarchy or required-type model was changed.

## Current Status

Storage remains pending until a disposable native text field passes the API and UI criteria in the YAML.
Do not generate forms or declare setup complete before resolving that decision from evidence.
No types, organization fields or smoke fixtures have been created yet.
The independent policy, API safety and reconciliation tests run with `npm test`.

## Commands

Use Node 22 or newer and `npm ci --ignore-scripts`.
Every operational command accepts `--dry-run`; it cannot write remotely or create a local manifest.
Mutating remote commands require `--manifest` pointing outside this checkout.

```text
node scripts/agile.mjs inspect --dry-run
node scripts/agile.mjs capabilities --dry-run
node scripts/agile.mjs inspect --manifest <external-manifest.json>
node scripts/agile.mjs provision-types --dry-run --manifest <external-manifest.json>
node scripts/agile.mjs provision-cost-centre --dry-run --manifest <external-manifest.json>
node scripts/agile.mjs validate --dry-run --manifest <external-manifest.json>
node scripts/agile.mjs validate --numbers 1,2 --manifest <external-manifest.json>
node scripts/agile.mjs generate-forms --dry-run
node scripts/agile.mjs check-forms --dry-run
```

Read-back checks protect exact resource identity, preserved preexisting resources and comment uniqueness.
An ambiguous type, field, form, tracking issue or result comment stops the operation.
An interrupted successful write leaves a pending ledger operation that must be inspected before resuming.
No command reparents or closes issues or deletes shared resources.
Fixture simulation and fixture cleanup commands are not implemented yet and must not be claimed as tested.

## Validation Deployment

The new Agile Policy workflow reports through one stable actor-owned marker comment per issue.
It runs full reconciliation for issue creation, edit, type and field-value events, manual runs and hourly schedules.
Full reconciliation handles changed parents and children, including changes where no issue event fired.
Current GitHub Actions docs do not list `sub_issues` as a workflow trigger; a GitHub App webhook bridge may dispatch
`bv-agile-hierarchy-changed` for prompt hierarchy-event coverage. The schedule remains the independent safety net.

The workflow uses only `contents: read` and `issues: write`. It fails if organization fields or project data cannot be read.
If the workflow token cannot read them, test a narrowly scoped GitHub App's organization-read and project-read permissions;
do not add an organization-admin PAT to repository secrets. No App access is presumed until its endpoints are tested.
The draft is not deployed until a maintainer reviews and merges it into the default branch.
The form-drift CI gate intentionally fails while storage is unresolved or generated forms are missing.

## Outstanding Setup Access

The authenticated account is an active organization admin, but its current OAuth scopes do not authorize organization creation.
For setup-only API operations, the owner can authorize `admin:org` directly using GitHub CLI's browser flow.
This is not a request for a broad admin PAT or permission to use admin credentials in routine validation.
Alternatively, sign in to the shared browser and use the organization settings UI without expanding CLI permissions.
Signed-in UI access is also required to test multiline editing and Markdown rendering and to verify field pinning.
Keep all existing project views, workflows and auto-add rules unchanged.
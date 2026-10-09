# Bigview agile framework implementation

The executable configuration targets **RABC-SAS**, not the original placeholder
organization Bigview-SAS. It is defined in `.github/planning/hierarchy.yml`.
The seven forms and `.github/workflows/validate-issue.yml` activate after merging.

## Run the implementation

Requirements: Node.js 22+, Ruby with its standard YAML library, and a recent `gh`
CLI supporting `api --paginate --slurp`. No npm packages are needed.
Authenticate `gh` as an RABC-SAS administrator with organization issue type/field,
repository issue, and organization Projects write access. An organization's admin
access does not automatically grant those permissions to an integration.
Do not put tokens in configuration or commit the state file.

```bash
cd /home/runner/work/bv-agile-framework/bv-agile-framework
gh auth login
node --test tests/framework.test.mjs
node scripts/setup-agile.mjs --phase probe

# Each pair is a separate approval gate. Inspect dry-run output before applying.
node scripts/setup-agile.mjs --phase types
node scripts/setup-agile.mjs --phase types --apply --approve types
node scripts/setup-agile.mjs --phase fields
node scripts/setup-agile.mjs --phase fields --apply --approve fields
```

**One UI-only step:** Organization Settings → Planning → Issue fields → Pin to
types. Pin Acceptance Criteria and Delivery Evidence to Initiative, Epic, Feature
and User Story; pin Cost Centre to Initiative, Epic and Feature. Pinning controls
visibility, not requiredness or exclusive applicability. Do not remove unrelated
pins. The CLI checks required pinning through GraphQL before smoke creation.
There is no documented public API mutation for pinning.

Open <https://github.com/orgs/RABC-SAS/projects/2> and confirm its identity.
The CLI refuses a mismatched title rather than renaming another project.
If #2 is absent, GitHub allocates the next project number; the API cannot select
it. A creation returning a number other than 2 is recorded and preserved, and
execution stops for manual resolution rather than creating duplicates.

```bash
PROJECT=https://github.com/orgs/RABC-SAS/projects/2
node scripts/setup-agile.mjs --phase project
node scripts/setup-agile.mjs --phase project --apply --approve project --confirm-project "$PROJECT"

# Run only after merging the forms and validation Action.
node scripts/setup-agile.mjs --phase smoke
node scripts/setup-agile.mjs --phase smoke --apply --approve smoke --confirm-project "$PROJECT"
node scripts/setup-agile.mjs --phase verify

# Three additional, isolated fixtures deliberately violate required fields/links.
node scripts/setup-agile.mjs --phase negative
node scripts/setup-agile.mjs --phase negative --apply --approve negative --confirm-project "$PROJECT"
# Wait for the issue-triggered Actions to finish; rerun if comments are pending.
node scripts/setup-agile.mjs --phase verify-negative

node scripts/setup-agile.mjs --phase cleanup
node scripts/setup-agile.mjs --phase cleanup --apply --approve cleanup --confirm-project "$PROJECT"
```

Dry-run is the default and never mutates GitHub. Apply requires a successful
dry-run of that phase against the same configuration and an explicit approval.
Read-only `probe`, `verify`, and `verify-negative` reject `--apply`.
Plans contain proposed payloads; later phases require earlier resources to exist.
Review each phase separately, not a blind loop.

## Behavior and safety

- Types and fields are matched by name; duplicates and incompatible field types
  stop execution. Unmanaged resources are preserved.
- Project columns reuse **organization issue-field identities**, not project-only
  fields with matching names. The smoke table exposes native Type and Parent issue
  columns plus the three organization fields. Its filter is
  `repo:RABC-SAS/bv-agile-framework label:bv-agile-framework-smoke`.
  A conflicting existing view is preserved and flagged for manual reconciliation.
- The positive fixtures are created in this order: Initiative, Epic, Feature,
  User Story, Task, Untyped Issue, Bug Story, Bug Task, Bug Untyped Issue.
  Links use the parent's `/sub_issues` endpoint with the child's numeric issue ID
  and `replace_parent: false`. Type/parent drift stops execution, never reparents.
- Negative fixtures are a missing-field Initiative, an invalid Task child of that
  Initiative, and an invalid untyped child of the Task. They are separate from the
  nine valid fixtures. `verify-negative` checks live links, project membership,
  violations, and the single bot-owned marker comment for each negative issue.
- `.agile-state.json` records the run UUID, resource URLs, numeric IDs, node IDs,
  project item IDs, view identity, and verification results. It is ignored by Git.
  Back it up and keep using the same file to resume safely. Losing the state file
  starts a new run; it does not adopt another run's fixtures. For an alternate
  location, pass the same `--state /absolute/path/state.json` on every invocation.
  Run only one CLI process per state file at a time.
- Cleanup closes, never deletes, owned positive and negative issues. It removes
  only project items recorded as created by this run, preserving adopted items,
  links, the project, fields, view and label. It checks closure/item removal via
  API. Export verification before cleanup; positive membership verification is
  intentionally expected to fail after owned project items are removed.
  Use a new state file for a new run after cleanup.
- The Action has only `contents: read` and `issues: write`. It reads fresh issue,
  parent and sub-issue data on all issue events, including creation/edit and
  hierarchy/type changes. It reports but never edits issue bodies, fields, types,
  or links. API failures fail the job rather than silently declaring success.
  Comments use `<!-- bv-agile-framework-validation:v1 -->` and are updated only
  when authored by `github-actions[bot]`; user marker spoofing is ignored.
  Concurrent runs are serialized per issue so unrelated events are not dropped
  and marker creation cannot race. Each run reports only on its triggering issue,
  checking both its parent edge and all child edges. Existing neighbor comments
  are refreshed on that neighbor's next issue event, not rewritten across jobs.

## Field storage decision

Acceptance Criteria and Delivery Evidence use required Markdown form sections.
The Action also detects bypasses, whitespace, `_No response_`, and common
placeholders. Bug Story, Task and untyped issues do not require these fields.
Cost Centre is optional.

Organization text fields are still created and bound to the project. Their values
are **not automatically synchronized** with form sections; native metadata can be
entered separately. Markdown/checklist rendering and multiline UI editing have
not been verified, so native fields are not the authoritative validation store.
Changing the storage decision requires the three capability tests in the YAML
and a corresponding validator implementation; this validator fails closed if
configured for another storage mode.

## Live status and resource inventory

During implementation, the integration received `403 Resource not accessible by
integration` from the organization issue-types and issue-fields APIs; local `gh`
was unauthenticated. **No live types, fields, project, or fixtures were created
or verified.** Full organization admin access does not remove this token boundary.
This is a runnable implementation, not a claim of completed live provisioning.

| Resource | URL / recorded identifier |
| --- | --- |
| Repository | https://github.com/RABC-SAS/bv-agile-framework |
| Implementation PR | https://github.com/RABC-SAS/bv-agile-framework/pull/1 |
| Candidate project | https://github.com/orgs/RABC-SAS/projects/2 — identity not yet verified |
| Organization types / fields | IDs recorded in state by `types` / `fields`; currently unprovisioned by this session |
| Smoke view | URL, ID and number recorded in state by `project` |
| Positive fixtures | Each URL, issue ID, node ID and item ID recorded by `smoke` / `verify` |
| Negative fixtures / comments | IDs and URLs recorded by `negative` / `verify-negative` |

Keep the generated state/verification JSON as the live execution evidence.
The local test suite exercises the full lifecycle against an in-memory API,
including rerun idempotency, negative cases, ownership checks and cleanup.
It does not substitute for live UI capability checks or authenticated execution.

API references: [organization types](https://docs.github.com/en/rest/orgs/issue-types),
[organization fields](https://docs.github.com/en/rest/orgs/issue-fields),
[sub-issues](https://docs.github.com/en/rest/issues/sub-issues),
[project fields](https://docs.github.com/en/rest/projects/fields),
[project views](https://docs.github.com/en/rest/projects/views),
[GraphQL Projects](https://docs.github.com/en/graphql/reference/projects).

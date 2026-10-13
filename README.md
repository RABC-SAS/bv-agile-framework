# Agile Planning Configuration

The source of truth is [.github/planning/hierarchy.yml](.github/planning/hierarchy.yml).
It configures RABC-SAS first; change the organization, repository and project identity for a later Bigview-SAS rollout.

- Reuse Task, Bug and Feature; add Initiative, Epic, User Story and Bug Story.
- Add Cost Centre as an organization text field, applicable to Initiative, Epic and Feature.
- Keep Acceptance Criteria and Delivery Evidence in the issue body, using generated forms.
- Require Acceptance Criteria from Ready onward, and Delivery Evidence from In review onward.
- Apply those gates to Initiative, Epic, Feature and User Story. Bug Story, Task and untyped issues are exempt.
- Report hierarchy and content violations; never revert status, edit issue bodies or reparent automatically.

| Status | Required Sections |
| --- | --- |
| Backlog | None |
| Ready / In progress | Acceptance Criteria |
| In review / Done | Acceptance Criteria and Delivery Evidence |

See [SETUP.md](SETUP.md) for setup, credentials, live sample verification and extending the YAML.

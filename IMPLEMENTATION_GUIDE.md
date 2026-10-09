# Bigview-SAS Admin Setup — Implementation Guide

**Complete setup playbook for Bigview-SAS issue type hierarchy and project validation.**

---

## Quick Navigation

1. **[Phase 0: Verify APIs and Capabilities](PHASE_0_ADMIN_INSTRUCTIONS.md)** — Read-only probes, permission matrix, decide native vs. fallback storage
2. **[Phase 1: Create Issue Types](PHASE_1_ADMIN_INSTRUCTIONS.md)** — Organization-level: Initiative, Epic, Feature, User Story, Bug Story, Task
3. **[Phase 2: Configure Fields and Project](PHASE_2_ADMIN_INSTRUCTIONS.md)** — Organization fields (Acceptance Criteria, Delivery Evidence, Cost Centre) and project setup
4. **[Phase 3: Forms and Validation](PHASE_3_IMPLEMENTATION_GUIDE.md)** — Issue templates and GitHub Action for policy enforcement
5. **[Phase 4: Smoke Tests](PHASE_4_SMOKE_TESTS.md)** — Build fixtures, verify hierarchy, test edge cases

---

## Configuration Reference

**File:** `.github/planning/hierarchy.yml`

Defines:
- Organization: `Bigview-SAS`
- Repository: `bv-agile-framework`
- Issue types: 6 managed types + 1 untyped leaf
- Fields: Acceptance Criteria, Delivery Evidence, Cost Centre
- Hierarchy: 5-level tree with two branches (User Story and Bug Story)
- Smoke test fixtures and project location

---

## Execution Model

### Admin Role
- **Phase 0:** Run read-only shell probes; complete capability matrix
- **Phase 1:** Create/enable issue types (UI or API)
- **Phase 2:** Create organization fields and project columns
- **Approval:** Record findings and approve decision (native vs. fallback)

### Agent Role
- **Phase 0:** Parse YAML, run shell commands, summarize results
- **Phase 3:** Implement forms and Action (reviewed PR)
- **Phase 4:** Build fixtures, run tests, clean up

### Repository Maintainer Role
- **Phase 3:** Review and merge forms + Action PR
- **Phase 4:** Approve test fixture creation

---

## Key Principles

✅ **Idempotent:** Every phase can re-run without duplicates  
✅ **Dry-run first:** All changes are visible before commit  
✅ **No auto-mutations:** Action reports violations; does not auto-fix or delete  
✅ **Permission-minimal:** Use only required scopes; no broad admin tokens in config  
✅ **Stop-gate-approve:** Each phase ends; approval required to proceed  
✅ **Read-before-write:** Verify current state before making changes  

---

## Start Here

**Run Phase 0** (read-only):
```bash
cd /path/to/bv-agile-framework
source <(ruby -ryaml -e '
  config = YAML.safe_load_file(".github/planning/hierarchy.yml")
  puts "export ORG=\"#{config[\"organization\"]}\""
  puts "export REPO=\"#{config[\"repository\"]}\""
  puts "export PROJECT_NUMBER=#{config[\"smoke_test\"][\"project_number_candidate\"]}"
')

echo "Organization: $ORG"
echo "Repository: $REPO"
echo "Project: $PROJECT_NUMBER"

# Follow PHASE_0_ADMIN_INSTRUCTIONS.md
```

---

## References

- [GitHub Organizations API](https://docs.github.com/en/rest/organizations)
- [GitHub Issues API](https://docs.github.com/en/rest/issues)
- [GitHub Projects API (GraphQL)](https://docs.github.com/en/graphql/reference)
- [GitHub Issue Forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)

---

**Next:** Open [Phase 0](PHASE_0_ADMIN_INSTRUCTIONS.md)

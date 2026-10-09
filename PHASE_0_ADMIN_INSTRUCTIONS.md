# Phase 0 — Verify APIs, Permissions, Project, and Text Capabilities

**Admin participation required.** This phase confirms that GitHub APIs, permissions, and capabilities support the planned Bigview-SAS configuration before bulk setup begins.

---

## Part A: Read-Only Probes (Agent/Local Shell)

Execute these read-only commands in a shell with `gh` authenticated. They verify API availability and current state without making changes.

```bash
cd /home/runner/work/bv-agile-framework/bv-agile-framework
CONFIG=.github/planning/hierarchy.yml

# Parse YAML using Ruby standard library
ORG=$(ruby -ryaml -e 'puts YAML.safe_load_file(ARGV[0]).fetch("organization")' "$CONFIG")
REPO=$(ruby -ryaml -e 'puts YAML.safe_load_file(ARGV[0]).fetch("repository")' "$CONFIG")
PROJECT_NUMBER=$(ruby -ryaml -e 'puts YAML.safe_load_file(ARGV[0]).fetch("smoke_test").fetch("project_number_candidate")' "$CONFIG")

echo "Organization: $ORG"
echo "Repository: $REPO"
echo "Project Number: $PROJECT_NUMBER"

# List organization issue types
echo ""
echo "=== Organization Issue Types ==="
gh api --paginate "orgs/$ORG/issue-types"

# List organization issue fields
echo ""
echo "=== Organization Issue Fields ==="
gh api --paginate "orgs/$ORG/issue-fields"

# Verify repository exists and inspect permissions
echo ""
echo "=== Repository Details ==="
gh api "repos/$ORG/$REPO" --jq '{full_name,permissions,has_issues}'

# Query the candidate project (number 2)
echo ""
echo "=== Project Details and Fields ==="
gh api graphql -f query='
  query($org:String!, $number:Int!) {
    organization(login:$org) {
      projectV2(number:$number) {
        id
        number
        title
        url
        viewerCanUpdate
        fields(first:100) {
          nodes {
            __typename
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
            }
            ... on ProjectV2IterationField {
              id
              name
              dataType
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }' -f org="$ORG" -F number="$PROJECT_NUMBER"
```

**Expected outcomes:**
- Issue types are currently empty or contain unrelated types (Task, Bug, Feature, Priority, Start date, Target date, Effort from prior setup)
- Project #2 exists with title "Bigview Project Template Test"
- Repository has `has_issues: true` and appropriate permissions
- Project fields may include Task, Bug, Feature but no Acceptance Criteria or Delivery Evidence yet

**Record:**
- Project `id`, `number`, `title`, `url`, `viewerCanUpdate` status
- All field names, IDs, and data types
- Any pagination cursors needed for follow-up queries

---

## Part B: Capability Matrix — Admin Verification

For each operation below, the **Admin** records:
- Current official GitHub documentation URL
- API version / headers required
- Live result / HTTP status
- Authorized actor
- Any product/preview restrictions

Use the documented REST/GraphQL API where available. Test on a disposable issue rather than changing production issues.

### B1: Organization Issue Types

**Operation:** List, create, and update organization issue types  
**API:** REST `/orgs/{org}/issue-types`  
**Documentation:** Check [GitHub Issue Types API](https://docs.github.com/en/rest/issues/types)

**Admin task:**
```bash
ORG="Bigview-SAS"

# List current types
gh api --paginate "orgs/$ORG/issue-types"

# Test write permission by creating a test type
# (This will fail if your account lacks permission; record the error)
gh api -X POST "orgs/$ORG/issue-types" \
  -f name="TestType" \
  -f description="Temporary test type for Phase 0 verification"
```

**Record:**
- HTTP status code (200 for list, 201 for create, 403 for permission denied, 404 for org not found)
- Whether a test type was created (if yes, note its ID for cleanup)
- If the POST fails, confirm the error is a permission issue, not an unsupported endpoint

---

### B2: Organization Issue Fields

**Operation:** List, create, and update organization issue fields  
**API:** REST `/orgs/{org}/issue-fields`  
**Documentation:** Check [GitHub Issue Fields API](https://docs.github.com/en/rest/issues/fields)

**Admin task:**
```bash
ORG="Bigview-SAS"

# List current fields
gh api --paginate "orgs/$ORG/issue-fields"

# Inspect a field's detail and visibility endpoints
# (Use an existing field ID if available; otherwise this step may return empty)
FIELD_ID="<existing_field_id>"  # Replace with actual ID from list above
gh api "orgs/$ORG/issue-fields/$FIELD_ID"
gh api "orgs/$ORG/issue-fields/$FIELD_ID/visibility"
```

**Record:**
- HTTP status codes (200 for list, 403 for permission denied, 404 if endpoint unavailable)
- All existing field names, IDs, data types, and visibility
- Whether the `/visibility` endpoint is supported

---

### B3: Issue Field Values (Native Storage)

**Operation:** Read and write issue field values via the REST API  
**API:** REST `/repos/{owner}/{repo}/issues/{issue_number}/issue-field-values`  
**Documentation:** Check [GitHub Issue Field Values API](https://docs.github.com/en/rest/issues/field-values)

**Admin task:**
Create a temporary disposable issue to test field writes:

```bash
ORG="Bigview-SAS"
REPO="bv-agile-framework"

# Create a test issue (will be deleted in cleanup)
TEST_ISSUE=$(gh api -X POST "repos/$ORG/$REPO/issues" \
  -f title="[Phase0-Test] Issue Field Values API" \
  -f body="Temporary test issue for field value writes." \
  --jq '.number')

echo "Test issue number: $TEST_ISSUE"

# Try to read current field values
gh api --paginate "repos/$ORG/$REPO/issues/$TEST_ISSUE/issue-field-values"

# If an organization text field exists, attempt to write a value
# (Update FIELD_ID and ISSUE_ID_NODE as needed)
FIELD_ID="<org_field_id>"
ISSUE_NODE_ID="<issue_node_id>"

gh api -X POST "repos/$ORG/$REPO/issues/$TEST_ISSUE/issue-field-values" \
  -f issue_field_values='[{"field_id":"'"$FIELD_ID"'","value":"Test value"}]'
```

**Record:**
- HTTP status codes for read (200 ok, 404 endpoint not available, 403 permission denied)
- HTTP status codes for write (200/201 success, 422 validation error, 403/404 as above)
- Whether field values can be read and written independently

---

### B4: Issue Type Assignment

**Operation:** Assign and clear issue types via the issue API  
**API:** REST `/repos/{owner}/{repo}/issues/{issue_number}`  
**Documentation:** Check [GitHub Issues API](https://docs.github.com/en/rest/issues)

**Admin task:**
```bash
ORG="Bigview-SAS"
REPO="bv-agile-framework"
ISSUE_NUMBER="<test_issue_number>"

# Read current type (should be null if no type is assigned)
gh api "repos/$ORG/$REPO/issues/$ISSUE_NUMBER" --jq '.type'

# Attempt to set a type (if TestType from B1 exists)
gh api -X PATCH "repos/$ORG/$REPO/issues/$ISSUE_NUMBER" \
  -f type="TestType"

# Verify the type was set
gh api "repos/$ORG/$REPO/issues/$ISSUE_NUMBER" --jq '.type'

# Attempt to clear the type
gh api -X PATCH "repos/$ORG/$REPO/issues/$ISSUE_NUMBER" \
  -f type=null

# Verify the type is null
gh api "repos/$ORG/$REPO/issues/$ISSUE_NUMBER" --jq '.type'
```

**Record:**
- HTTP status codes for PATCH operations (200 success, 422 validation error, 403 permission denied)
- Whether type assignment works
- Whether type can be cleared to `null`

---

### B5: Parent and Sub-Issues (Hierarchy)

**Operation:** Read and link parent/child issues  
**API:** REST `/repos/{owner}/{repo}/issues/{issue_number}/parent` and `/sub_issues`  
**Documentation:** Check [GitHub Sub-Issues API](https://docs.github.com/en/rest/issues/relationships)

**Admin task:**
```bash
ORG="Bigview-SAS"
REPO="bv-agile-framework"
PARENT_NUMBER="<parent_issue_number>"
CHILD_NUMBER="<child_issue_number>"

# Create two test issues (parent and child)
PARENT=$(gh api -X POST "repos/$ORG/$REPO/issues" \
  -f title="[Phase0-Test] Parent Issue" \
  -f body="Test parent." \
  --jq '.number')

CHILD=$(gh api -X POST "repos/$ORG/$REPO/issues" \
  -f title="[Phase0-Test] Child Issue" \
  -f body="Test child." \
  --jq '.number')

# Read parent's sub-issues (should be empty)
gh api --paginate "repos/$ORG/$REPO/issues/$PARENT/sub_issues"

# Link child to parent (use child's numeric issue ID, not node ID)
gh api -X POST "repos/$ORG/$REPO/issues/$CHILD/parent" \
  -f parent_issue_number="$PARENT"

# Verify the link was created
gh api "repos/$ORG/$REPO/issues/$CHILD/parent"
gh api --paginate "repos/$ORG/$REPO/issues/$PARENT/sub_issues"
```

**Record:**
- HTTP status codes for read and link operations
- Whether parent/child linking works
- Maximum sub-issues limit and nesting depth (documented limit: 100 sub-issues, 8 levels)

---

### B6: Project Items and Field Values

**Operation:** Add issues to projects and update field values via GraphQL  
**API:** GraphQL `addProjectV2ItemById`, `updateProjectV2ItemFieldValue`  
**Documentation:** Check [GitHub Projects API](https://docs.github.com/en/graphql/reference/mutations#addprojectv2itembyid)

**Admin task:**
```bash
ORG="Bigview-SAS"
REPO="bv-agile-framework"
PROJECT_NUMBER=2
ISSUE_NUMBER="<test_issue_number>"
ISSUE_NODE_ID="<issue_node_id>"  # From GraphQL query in Part A

# Add issue to project
gh api graphql -f query='
  mutation($project:ID!, $issue:ID!) {
    addProjectV2ItemById(input:{projectId:$project, contentId:$issue}) {
      item {
        id
      }
    }
  }' \
  -f project="<project_node_id>" \
  -f issue="$ISSUE_NODE_ID"

# Query project items to verify membership
gh api graphql -f query='
  query($org:String!, $number:Int!) {
    organization(login:$org) {
      projectV2(number:$number) {
        items(first:10) {
          nodes {
            id
            content {
              ... on Issue {
                number
                title
              }
            }
          }
        }
      }
    }
  }' -f org="$ORG" -F number="$PROJECT_NUMBER"
```

**Record:**
- HTTP status codes and GraphQL errors for mutation operations
- Whether items can be added to the project
- Whether the item appears in the project's item list

---

### B7: Multiline Text Field Storage (Native Pass Criteria)

**Operation:** Write, read, and edit multiline text with Markdown/checklist preservation  
**API:** REST `/orgs/{org}/issue-fields` (create), `/repos/{owner}/{repo}/issues/{issue_number}/issue-field-values` (write/read)  
**UI:** Organization Settings → Planning → Issue fields → Create field; GitHub issue edit/view

**Admin prerequisites:**
1. An organization text issue field must exist (created in Phase 1 or for this test)
2. A disposable test issue in the repository
3. Access to GitHub's web UI and issue editing

**Admin task — API test:**
```bash
ORG="Bigview-SAS"
REPO="bv-agile-framework"
FIELD_ID="<text_field_id>"

# Create or reuse a test field named "Multiline Test"
# (If it doesn't exist, create via Organization Settings UI)

# Write the multiline test value to an issue
TEST_VALUE="First paragraph.

- [ ] Multiline checklist
- [x] Completed item

[Repository](https://github.com/Bigview-SAS/bv-agile-framework)"

gh api -X POST "repos/$ORG/$REPO/issues/TEST_ISSUE/issue-field-values" \
  -f issue_field_values='[{"field_id":"'"$FIELD_ID"'","value":"'"$(echo "$TEST_VALUE" | jq -Rs .)"'"}]'

# Read it back
gh api "repos/$ORG/$REPO/issues/TEST_ISSUE/issue-field-values" \
  --jq '.[] | select(.field_id == "'"$FIELD_ID"'") | .value'
```

**Admin task — UI test:**
1. Go to the test issue in GitHub
2. Click **Edit** on the issue (if the field is pinned, it appears in the form)
3. Locate the "Multiline Test" field
4. Edit multiple lines, save, and reopen
5. **Verify:**
   - The value is preserved exactly (including newlines)
   - Checkboxes render as `- [ ]` and `- [x]` (clickable), not literal syntax
   - The link `[Repository](...)` renders as a clickable link, not literal Markdown

**Record:**
- API write response (HTTP 200/201)
- API read response: does the value match exactly, including newlines?
- UI evidence: screenshot or note of preserved checkboxes and clickable link
- Any escaping or truncation observed

---

## Part C: Project Identity Confirmation

**Admin task:**

Navigate to the **Bigview-SAS** organization in GitHub web UI:
1. Click **Projects** (top menu)
2. Locate project number **2**
3. **Record:**
   - Project title (must be "Bigview Project Template Test" or similar; if different, stop and clarify)
   - Project URL
   - Project node ID (view page source or use GraphQL from Part A)
   - Current project owner
   - Existing views, columns, and automation workflows

**If project #2 does not exist:**
- Stop; do not create a new project yet
- Confirm the intended project number and title with the team
- Update the YAML and re-run this phase

---

## Part D: Capability Summary and Decision Gate

**Admin:** Complete this checklist based on Part A–C findings:

### Permission & API Availability
- [ ] Organization has issue-types API available (HTTP 200 for GET)
- [ ] Current user has write permission to organization issue types (HTTP 201 for POST, or 403 confirmed as permission error)
- [ ] Organization has issue-fields API available (HTTP 200 for GET)
- [ ] Current user has write permission to organization issue fields
- [ ] Repository issue API allows type assignment (PATCH with `type` field works)
- [ ] Repository has parent/sub-issue API available (GET/POST on `/issues/{number}/parent` and `/sub_issues`)
- [ ] Project #2 exists, title matches, and node ID is known
- [ ] Project GraphQL mutations (`addProjectV2ItemById`) are available

### Native Text Field Storage
**Choose one:**

**NATIVE PASS** — If ALL of the following are true:
- [ ] Issue field values API supports read/write (HTTP 200/201)
- [ ] Multiline text with newlines is preserved (API read-back matches write exactly)
- [ ] Markdown checkboxes render as clickable, not literal (UI evidence)
- [ ] Links render as clickable, not literal syntax (UI evidence)
- [ ] No truncation or escaping observed

**If NATIVE PASS:** Set `field_storage.decision: native_issue_fields` in YAML before Phase 1

**NATIVE FAIL or BLOCKED** — If any of the following occur:
- [ ] Issue field values API returns 404 / endpoint unavailable
- [ ] Multiline text is truncated, newlines lost, or escaped in read-back
- [ ] Checkboxes or links do not render as Markdown in the UI
- [ ] Permission error (403) on write despite admin token

**If NATIVE FAIL:** Set `field_storage.decision: issue_form_sections_and_validation_action` in YAML before Phase 1

---

## Part E: Cleanup (Admin)

1. Delete any test types created in B1 (if created and ID was recorded)
2. Delete any test fields created in B7 (if created and ID was recorded)
3. Close (do not delete) any test issues created in B3–B6 (keep URLs for reference)

---

## Phase 0 Gate Approval

**Stop here.** Do not proceed to Phase 1 until:

1. ✅ All probes in Part A completed and results recorded
2. ✅ Capability matrix in Part B completed for all seven operations
3. ✅ Project #2 identity confirmed in Part C
4. ✅ Native/fallback decision made and recorded in YAML (Part D)
5. ✅ All admin-only approvals obtained
6. ✅ Phase 0 findings posted on setup PR with test URLs and any permission blockers

**Next:** Once approved, proceed to [Phase 1 — Reconcile Organization Issue Types](PHASE_1_ADMIN_INSTRUCTIONS.md)

---

## References

- [GitHub Issue Types API](https://docs.github.com/en/rest/issues/types)
- [GitHub Issue Fields API](https://docs.github.com/en/rest/issues/fields)
- [GitHub Issue Field Values API](https://docs.github.com/en/rest/issues/field-values)
- [GitHub Issues API](https://docs.github.com/en/rest/issues)
- [GitHub Sub-Issues API](https://docs.github.com/en/rest/issues/relationships)
- [GitHub Projects GraphQL API](https://docs.github.com/en/graphql/reference/mutations#addprojectv2itembyid)
- [GitHub Organization Settings — Planning](https://docs.github.com/en/organizations/managing-organization-settings/managing-organization-project-settings)

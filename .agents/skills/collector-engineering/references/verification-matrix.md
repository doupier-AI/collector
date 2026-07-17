# Verification Matrix

| Change area | Required verification |
| --- | --- |
| Contracts | Valid, invalid and compatible payload tests |
| SQLite/schema | Empty initialization, migration, rollback and idempotent restart |
| Research sessions | Input persistence, task recovery, refresh and source relationships |
| Parser | Stable content snapshots and anchors for text, Markdown, DOCX and PDF |
| URL fetch and search | Public success; private target, redirect, timeout and size rejection |
| Model gateway | Fake success, streaming, invalid output, retry, usage and redaction |
| HTTP security | Local session, Host/Origin validation, anonymous allowlist and restricted CORS |
| WebUI | Real browser input, loading, streaming, selection, routing, keyboard and responsive states |
| Browser extension | Authenticated submission, offline replay identity and source snapshot |
| Observation | Correlation IDs, model/search trace completeness, credential redaction and export |
| Documentation | Product, architecture, commands and recovery match verified behavior |

## Release Gate

1. Run a clean build and all automated tests.
2. Run static project checks.
3. Run isolated real-browser tests for WebUI changes.
4. Inspect the diff for secrets, generated files and unrelated changes.
5. Verify persisted/API-visible state after the user-visible path.
6. Use fake providers for automated regression. Run a real cloud call only with explicit consent and an isolated runtime credential.

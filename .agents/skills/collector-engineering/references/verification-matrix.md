# Verification Matrix

| Change area | Required verification |
| --- | --- |
| Contracts | Validation tests for valid, invalid, and backward-compatible payloads |
| SQLite/schema | Empty initialization, JSON migration, rollback on failure, idempotent restart |
| Capture service | Idempotency, checksum duplicate behavior, immutable source records |
| Parser | Stable fragments and locators for text, Markdown, PDF pages, and browser snapshots |
| URL fetch | Public URL success; private IP, redirect-to-private, timeout, and size rejection |
| Model gateway | Fake success, empty response, invalid JSON, invalid fragment IDs, one retry, redaction |
| Review workflow | Accept creates relation and audit decision; reject does not; revoke retains history |
| Topic workspace | Only accepted, non-revoked relations appear as formal knowledge |
| HTTP security | Anonymous allowlist, missing/invalid token rejection, pairing expiry and one-time use, restricted CORS |
| Browser extension | Paired submission, offline queue replay with same client ID, page snapshot capture |
| Electron preload/IPC | Bridge availability, no renderer Node access, safe file-path handoff |
| Desktop capture | Paste, URL, file upload, draft recovery, failure retention, successful clear/hide |
| Shortcut/lifecycle | Registration failure message, tray fallback, isolated single-instance smoke |
| Documentation | Commands, architecture, security boundary, migration and recovery reflect actual code |

## Release Gate

1. Run clean build and all tests.
2. Run static project checks.
3. Run isolated GUI smoke after terminating or isolating unrelated Collector instances.
4. Inspect `git diff` for secrets, generated files, and unrelated changes.
5. Verify one complete capture-to-inbox path against the real persistence layer.
6. For AI releases, run offline fake-provider regression first. Run a real call only with explicit consent and a rotated runtime credential.

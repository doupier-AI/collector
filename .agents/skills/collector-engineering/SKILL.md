---
name: collector-engineering
description: Implement, debug, review, or release the Collector local-first TypeScript, Electron, Chromium extension, and Node API project. Use for changes involving desktop lifecycle, global shortcuts, preload/IPC, browser capture, embedded API, persistence or migrations, parsers, model gateways, authentication, GUI smoke tests, or knowledge-review workflows.
---

# Collector Engineering

Apply this workflow to every Collector change. Preserve the local-first trust boundary and verify user-visible data flow, not only compilation.

## Start With Reality

1. Read the relevant source, tests, package scripts, and current `git status`.
2. Run `scripts/check-project.ps1` from this skill before designing substantial changes.
3. Separate confirmed behavior from planned behavior. Do not describe compiled code as a working GUI feature.
4. Keep user changes. Never repair an unrelated dirty file by reverting it.
5. Define the acceptance path before editing: input, persistence, processing, API, UI, and recovery.

## Preserve Boundaries

- Keep browser extension and Electron renderer as capture adapters. Put parsing, deduplication, AI orchestration, and knowledge mutation behind the API/service layer.
- Treat `Artifact` and source snapshots as immutable. Add derived `Fragment`, `KnowledgeItem`, proposal, decision, and relation records without overwriting evidence.
- Require user review before creating formal knowledge relations. Revoke records instead of deleting audit history.
- Keep model credentials out of renderer state, SQLite, logs, exports, source, and `.env` files. Use Electron `safeStorage` or a runtime environment variable.
- Never use a credential pasted into chat or committed history. Require rotation.
- Make AI failure non-destructive. Invalid, empty, uncited, or schema-invalid output may create a failed run, but must not update the knowledge layer.

## Implement In Vertical Slices

For each feature, complete the smallest real path:

1. Extend shared contracts and validation.
2. Add storage schema and migration with rollback behavior.
3. Implement domain/service behavior independently of HTTP and Electron.
4. Expose the API with authorization and bounded inputs.
5. Connect one client adapter.
6. Add unit, API, and user-path verification proportional to risk.
7. Update architecture and operations documentation in the same change.

Do not build UI controls over placeholder persistence or simulated service results unless the UI explicitly labels them as unavailable.

## Electron Rules

- Keep the renderer sandboxed with `contextIsolation: true` and `nodeIntegration: false`.
- Compile preload as CommonJS (`.cts` to `.cjs`) when the package is ESM. Verify the exact built preload path before GUI testing.
- Access local file paths through `webUtils.getPathForFile` in preload; do not depend on removed renderer `File.path` behavior.
- Register IPC channels once in the main process and expose the smallest typed bridge.
- Handle global shortcut registration failure explicitly and keep a tray/menu fallback.
- Preserve drafts on hide or submission failure. Clear them only after the API confirms persistence.
- Treat `requestSingleInstanceLock` as a test boundary. GUI tests need isolated user data, instance identity, ports, and database paths.
- Confirm that the embedded API belongs to the current app instance. A generic `/health` response is insufficient when another Collector process may own the port.

Read [failure-modes.md](references/failure-modes.md) before changing Electron startup, IPC, file upload, shortcuts, embedded API startup, or GUI tests.

## Local API And Data Rules

- Bind to loopback, but do not treat loopback as authentication.
- Leave only health and one-time pairing exchange anonymous. Require a bearer token or HttpOnly local session elsewhere.
- Never send `Access-Control-Allow-Origin: *`. Validate explicit origins and still require authentication.
- Hash stored tokens, expire pairing codes, and consume each code once.
- Bound body size, redirect count, response size, parser work, and network timeout.
- Block loopback, link-local, private, multicast, and other non-public destinations before and after URL redirects.
- Run migrations transactionally. Keep the old JSON data until SQLite commit succeeds, then create a backup.
- Make client request IDs unique and idempotent. A retry must return the original resource.

## Evidence And Model Rules

- Parse locally before calling a model. Do not call a deep model when extraction failed or the capture disabled AI.
- Preserve stable fragment locators: URL and DOM offsets, file checksum and page, or explicit `user_supplied` provenance.
- Require every generated claim and relation suggestion to reference existing fragment IDs.
- Validate structured model output locally and retry malformed output at most once.
- Persist provider, model, prompt version, processing level, token usage, latency, status, and redacted error details in `AgentRun`.
- Use a deterministic fake provider for tests. Real-provider acceptance is a separate, explicit test with a rotated key and cloud-data consent.

## Verification Gate

Run the checks in [verification-matrix.md](references/verification-matrix.md). At minimum:

```powershell
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
```

For Electron behavior, also run `npm.cmd run test:gui` in an isolated profile. Validate persisted/API-visible records after UI actions; a success toast alone is not proof.

Before reporting completion, state exactly which checks ran, which did not, and whether a real cloud-model call was performed.

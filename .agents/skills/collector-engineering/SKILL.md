---
name: collector-engineering
description: Implement, debug, review, or release the Collector single-user local WebUI, Node API, SQLite persistence, document readers, model gateway, research sessions, selection popovers, later learning, and source return. Existing Electron and browser-extension code is handled as a migration or maintenance scope.
---

# Collector Engineering

Apply this workflow to every Collector change. Verify the user-visible WebUI flow and the persisted local-service result.

## Start With Reality

1. Read `AGENTS.md`, the relevant current product documents, source, tests, `package.json`, and `git status`.
2. Run `scripts/check-project.ps1` from this skill before substantial changes.
3. Separate product consensus, current code behavior, prototype behavior, and verified WebUI behavior.
4. Preserve user changes and keep unrelated files untouched.
5. Define the acceptance path: browser input → HTTP/SSE → persistence → processing → WebUI result → refresh/restart recovery.

## Current Runtime Shape

Collector MVP is a single-user local Web application:

```text
Double-click Collector launcher
        ↓
Start or reuse loopback local service
        ↓
Open default browser at 127.0.0.1:<dynamic-port>
        ↓
WebUI ↔ HTTP/SSE ↔ Node service ↔ SQLite/files/model providers
```

Prefer serving WebUI and API from the same origin. The local service owns data, imported files, content snapshots, parsing, model calls, background tasks, search, credentials, and recovery.

## Preserve Boundaries

- Keep WebUI as a browser adapter. Put domain behavior, parsing, AI orchestration, and persistence behind the API/service layer.
- Preserve imported files, stable content snapshots, selected text, and source anchors for research branches, later learning, citations, and source return.
- Send provider credentials directly to the backend credential boundary. WebUI stores and displays configured state only.
- Bind to loopback, validate request origin, use a local session token, and avoid wildcard CORS.
- Persist submitted inputs and task state before model work so page refresh and browser close remain recoverable.
- Validate model output and citations locally before publishing formal results.
- Make AI recovery explicit while manual selection, saved sources, later learning, and navigation remain available.

## Implement Vertical Slices

For each feature, complete the smallest real path:

1. Extend shared contracts and validation.
2. Add transactional storage and migration behavior.
3. Implement service behavior independently of the frontend.
4. Expose bounded, authenticated HTTP and streaming endpoints.
5. Connect one WebUI user path.
6. Verify loading, success, empty, recovery, refresh, and restart states.
7. Update current product, architecture, and human-acceptance documents.

Every visible control connects to real persistence and service state. Disposable prototypes use isolated files and state their data limitations.

## WebUI Rules

- Use semantic HTML, visible keyboard focus, accessible names, and predictable focus movement for popovers and drawers.
- Keep current content readable while the selection window opens near the selected range; use a bottom drawer when space is limited.
- Render fixed selection fields and stable loading placeholders immediately. Stream or progressively reveal AI fields without layout instability.
- Preserve drafts and submitted task identity across route changes and refreshes.
- Upload files through bounded browser file selection or drag-and-drop endpoints; show progress, cancellation, parsing state, and recovery actions.
- Render imported and generated content through safe sanitization. Treat source text and AI content as untrusted input.
- Use explicit empty, error, offline, expired-session, and task-recovery states.
- Test real browser selection, range positioning, routing, streaming, refresh recovery, keyboard access, and responsive layouts.

## Local API And Data Rules

- Bind only to loopback and select or announce the active dynamic port safely.
- Reuse the active service on repeated launch and expose a user-visible shutdown flow.
- Use same-origin delivery where possible. Otherwise validate exact origins and keep authentication mandatory.
- Bound request bodies, uploads, responses, redirects, parser work, model work, and network timeouts.
- Validate public network targets before requests and after redirects.
- Hash tokens, expire one-time values, and keep request IDs unique and idempotent.
- Run migrations transactionally and retain recoverable backups.
- Keep provider secrets outside ordinary business tables, logs, exports, browser storage, and source.
- Persist provider, model, prompt version, usage, latency, status, and redacted errors for model runs.
- Use deterministic fake providers in automated tests. Real-provider acceptance requires explicit cloud-data consent and isolated credentials.

## Existing Electron And Extension Code

`apps/desktop-capture` and `apps/browser-extension` are current repository code, not the target product frontend.

When a task explicitly maintains or removes these areas:

- Keep Electron renderer isolation and preload/IPC type synchronization intact during the migration step.
- Handle `safeStorage` availability and existing encrypted/plaintext compatibility.
- Use isolated ports, profiles, instance IDs, and data directories for Electron tests.
- Read `references/failure-modes.md` before Electron startup, IPC, shortcuts, embedded API, or GUI-test work.

Place new product UI behavior in the WebUI path and communicate with the local service through HTTP/SSE.

## Verification Gate

At minimum run:

```powershell
npm.cmd run build
npm.cmd test
powershell -ExecutionPolicy Bypass -File .agents\skills\collector-engineering\scripts\check-project.ps1
```

For WebUI behavior, run the project browser test command and verify persisted/API-visible state after real browser actions. For existing Electron maintenance, run its isolated GUI check.

Before reporting completion, state exactly which checks ran, which checks were skipped, and whether a real cloud-model call occurred.

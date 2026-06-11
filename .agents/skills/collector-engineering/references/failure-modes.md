# Collector Failure Modes

## Electron Binary And Startup

**Symptom:** TypeScript builds, but Electron cannot open a window.

**Cause:** `ELECTRON_SKIP_BINARY_DOWNLOAD=1` installs package metadata without the runtime binary, or GitHub download is unavailable.

**Prevention:** Distinguish compile verification from runtime verification. Check `node_modules/electron/dist/electron.exe`. Use an approved mirror only for dependency installation; never claim GUI completion until the executable starts.

## Preload Bridge Missing

**Symptom:** Paste may render, but submit, file selection, drag/drop, or shortcut settings do nothing; `window.collector` is undefined.

**Cause:** An ESM build emitted preload in an incompatible format or `BrowserWindow` points at the wrong artifact.

**Prevention:** Keep preload in `.cts`, emit `.cjs`, verify the output exists, log `preload-error`, and make renderer readiness observable for smoke tests.

## Renderer Initialized Too Early Or Partially

**Symptom:** Controls appear enabled but listeners are absent, or a top-level exception disables all later behavior.

**Cause:** Missing bridge/DOM nodes or an exception during module initialization.

**Prevention:** Fail visibly, set a renderer-ready marker only after listeners are installed, and assert that marker in GUI smoke tests.

## Global Shortcut Stops Working

**Symptom:** `Ctrl+Shift+Space` no longer opens the window.

**Cause:** Another process owns the shortcut, registration failed, an older Collector instance owns the single-instance lock, or the process exited.

**Prevention:** Check `globalShortcut.register` result, expose a configurable fallback, retain tray activation, unregister on quit, and verify the exact running binary/profile.

## GUI Test Talks To The Wrong Instance

**Symptom:** Test sees a healthy API or an existing window but new data is absent from the test database.

**Cause:** Fixed ports, shared user data, single-instance lock, or an already-running embedded API.

**Prevention:** Isolate API port, debug port, Electron user-data directory, database directory, and app instance ID. Add an instance identifier to health responses and assert it.

## File Drop Or Selection Does Nothing

**Symptom:** Files appear in the UI but are not uploaded, or file selection never reaches main.

**Cause:** Renderer attempted filesystem access, relied on deprecated `File.path`, preload bridge failed, unsupported MIME inference, or form submission skipped queued files.

**Prevention:** Convert `File` to a path only in preload via `webUtils`, validate size/type both client and server side, upload artifacts before capture creation, and verify both artifact and capture records.

## Success UI But Inbox Is Empty

**Symptom:** Capture window reports success; the inbox shows no content.

**Cause:** UI accepted an unresolved request, submitted to another API instance, failed to persist, or inbox rendering omitted the record.

**Prevention:** Await the API response, keep the draft on error, verify by capture ID through `GET /v1/captures/{id}`, and make smoke tests assert persisted/API-visible state.

## Retry Creates Duplicate Captures

**Symptom:** Network recovery or extension retry creates multiple records.

**Cause:** A new client ID was generated per retry or idempotency was enforced only in memory.

**Prevention:** Generate `clientCaptureId` once, persist it with queued work, enforce a unique database constraint, and return the existing record on replay.

## Encoding Corruption

**Symptom:** Chinese labels display as mojibake in source inspection, tray menus, or UI.

**Cause:** PowerShell/default code page decoded UTF-8 as a legacy encoding or a script rewrote files without explicit UTF-8.

**Prevention:** Keep source UTF-8, avoid shell-based file rewrites, use patch-based edits, and set explicit UTF-8 when inspection tools require it. Verify rendered text, not terminal output alone.

## Localhost Data Exposure

**Symptom:** Any local web page or extension can read/write Collector data.

**Cause:** Loopback binding was treated as sufficient security and wildcard CORS was enabled.

**Prevention:** Pair clients, require tokens/sessions, restrict origins, hash tokens, and make anonymous routes an explicit allowlist.

## Model Output Pollutes Knowledge

**Symptom:** Unsupported claims or malformed model output becomes formal knowledge.

**Cause:** Output was trusted before schema/evidence validation or proposals bypassed review.

**Prevention:** Require JSON schema validation and valid fragment references, persist only proposals, and create formal revocable relations solely from recorded user decisions.

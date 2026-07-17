# Collector Failure Modes

## WebUI Connects To The Wrong Service

**Symptom:** The page opens, but saved data appears in another instance or disappears after refresh.

**Prevention:** Isolate ports, database directories, session state and instance IDs in tests. Include the instance ID in health responses and verify it before submitting data.

## Stream Ends Before The Task

**Symptom:** Generated text stops when the page refreshes or the network connection closes.

**Prevention:** Persist input and task identity before model work. Treat the stream as delivery, query durable task state after reconnect, and render already saved output.

## File Drop Or Selection Does Nothing

**Symptom:** A document appears selected but no import result is created.

**Prevention:** Validate size and type in the browser and service, upload through bounded HTTP endpoints, expose progress and cancellation, and verify both the stored file and content snapshot.

## Retry Creates Duplicate Content

**Symptom:** Network recovery or extension replay creates multiple records.

**Prevention:** Generate the client request ID once, persist it with queued work, enforce a unique database constraint, and return the existing result on replay.

## Encoding Corruption

**Symptom:** Chinese text becomes unreadable in source or the rendered WebUI.

**Prevention:** Keep source UTF-8, use patch-based edits, set explicit UTF-8 for inspection commands, and verify rendered text.

## Localhost Data Exposure

**Symptom:** Another local web page can read or change Collector data.

**Prevention:** Bind to loopback, require local sessions, validate Host and Origin, restrict CORS, hash tokens, and keep anonymous routes in an explicit allowlist.

## Model Or Search Output Pollutes Research

**Symptom:** Unsupported claims, malformed model output or unverifiable search results become formal content.

**Prevention:** Validate schemas and source references locally, preserve provenance, keep intermediate results reviewable, and publish formal results only after validation.

## Credentials Enter Browser State Or Logs

**Symptom:** Provider credentials appear in browser storage, API responses, logs or exports.

**Prevention:** Send credentials directly to the local service credential boundary, expose configured state only, and redact authentication fields before observation and export.

# Collector-Specific Patterns

These are concrete examples. Names and IDs are project-specific.

## Route registration chain

Each tab's data fetch needs three layers:
1. Service method (service.ts)
2. HTTP route (http.ts)
3. IPC handler (main.ts) + preload bridge (preload.cts)

Check with: grep -n "pathname ===" apps/api/src/http.ts

## Workspace tab HTML IDs

Each tab section: section-{capture,recent,topics,materials,settings}

initWorkspace expects inside each section root:
- #{prefix}-list, #{prefix}-detail, #{prefix}-search, #{prefix}-title, #{prefix}-refresh

Recent tab additionally needs:
- #recent-status-badge, #recent-organize, #recent-summary
- #recent-error, #recent-result, #recent-cluster-count
- #recent-view-unclustered, #recent-retry

## Idempotency key

recent:organize requires idempotencyKey. Generate before calling:
  "recent-ui-" + crypto.randomUUID()

## Build after HTML change

Run npm run build to copy shell.html to dist/.
The app loads from dist, not src.

---
name: frontend-debug
description: >
  Debug frontend UI issues in Electron and TypeScript monorepo apps.
  Use when tabs are blank, layout is broken, duplicate HTML IDs cause
  rendering bugs, or error text pushes buttons out of shape. Covers
  Windows PowerShell encoding pitfalls (GBK vs UTF-8) that silently
  corrupt source files. Also covers verifying tag balance, route
  registration, and IPC chain integrity.
---

# Frontend Debug Skill

## Before touching any file

- Read the current file with proper encoding first.
- On Windows: verify the file is readable as UTF-8 before editing.
- Prefer `apply_patch` for targeted edits. For bulk changes, use Python
  scripts saved to temp files with explicit UTF-8 encoding.

## Encoding: the silent killer

On Chinese Windows, PowerShell defaults to GBK (CP936). Project files are UTF-8.
Every write without explicit encoding is a corruption.

**Safe:**

```
Set-Content path -Value content -Encoding utf8 -NoNewline

$script = '@'...Python code...'@'
Set-Content "$env:TEMP/work.py" -Value $script -Encoding utf8
python "$env:TEMP/work.py"
```

**Unsafe (will corrupt Chinese text):**

- `Set-Content path -Value content` (no `-Encoding`)
- `git show OLD:path | Set-Content path` (pipe destroys encoding)
- `python -c "..."` with regex containing `\w` or `\d` (PowerShell intercepts)

**Recovery:** re-read with GBK, write back as UTF-8 via Python.

## HTML structure after edits

After modifying any HTML file, verify tag balance:

```python
import re
html = open("file.html", "r", encoding="utf-8").read()
tags = re.findall(r"<(\w+)(?:\s[^>]*)?>", html)
closes = re.findall(r"</(\w+)>", html)
for t in set(tags):
    if tags.count(t) != closes.count(t):
        print(f"UNBALANCED: {t}")
```

## Common UI failures

For each symptom, check causes in this order. Project-specific
examples use a Collector-like app but the diagnosis pattern is general.

### Tabs look identical or are all blank

1. **Missing API routes** -- Check the network layer. Each tab
   requires its data-fetch endpoint registered.
2. **Duplicate HTML IDs** -- JS `querySelector` finds the first match.
   A duplicate ID in another section causes it to pick the wrong element.
3. **Unbalanced tags** -- An unclosed tag leaks content or causes the
   browser to restructure the DOM incorrectly.

### One page shows text from another page

Unclosed `<section>` or `<div>` leaking content. Run tag balance check.

### Button shape changes on error

Error element is in normal flow. Fix: parent to `position: relative`
with `min-height`, error to `position: absolute`.

### Button shows "Route not found" or "Key required"

Trace the IPC chain: renderer -> preload -> main -> client -> API.
Missing links: route not registered, parameter not passed through.

## Git discipline

- **Never** `git add -A` (picks up untracked files)
- Stage specific files: `git add path/to/file.ts`
- `git status --short` before every commit

# Collector Frontend Debug Skill

## Windows Encoding Pitfalls

PowerShell on Chinese Windows defaults to GBK (CP936). All project files are UTF-8.

### Never do this

```
Set-Content "file.html" -Value $content              // writes GBK, not UTF-8
Set-Content "file.html" -Value $content -NoNewline   // still GBK
git show OLD:file.html | Set-Content file.html       // encoding destroyed by pipe
python -c "import re; re.findall(r'\w+', c)"         // \w interpreted by PowerShell
```

### Always do this

```
Set-Content "file.html" -Value $content -Encoding utf8 -NoNewline

$script = @'...Python code...'@
Set-Content "$env:TEMP/work.py" -Value $script -Encoding utf8
python "$env:TEMP/work.py"
```

## HTML Editing Rules

Never regex-patch minified HTML. The tag structure is too fragile.

When the structure is deeply corrupted, rebuild the file from scratch using Python string generation. Verify with:

```python
opens = len(re.findall(r'<section\b', html))
closes = len(re.findall(r'</section>', html))
assert opens == closes, f"Unbalanced: {opens} vs {closes}"
```

## Common Issues

### All tabs are empty
- Check that /v1/inbox and /v1/relations routes exist in http.ts
- Check section IDs match shell-renderer.ts tab names
- Check for duplicate HTML IDs (root.querySelector returns first match only)
- Check section tag balance

### Settings page shows text from other tabs
- Unclosed section tag leaking content

### Button shape changes on error
- Set parent to position:relative with min-height
- Set error text to position:absolute so it does not push the button

### Idempotency-Key missing
- Trace the IPC chain: renderer -> preload -> main -> client -> API
- main.ts recent:organize handler requires idempotencyKey parameter

## Git Rules

Never use git add -A (picks up untracked files like .codex/, .scratch/, temp files).

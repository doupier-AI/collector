# Collector Ralph

Collector Ralph runs one local Markdown Issue per fresh Codex context. It exists to keep implementation work inside a small, relevant context rather than extending one conversation until attention degrades.

## Safety model

- Select only `ready-for-agent`, `AFK`, `open` Issues whose dependencies are complete.
- Start implementation and validation with separate `codex exec --ephemeral` sessions.
- Ignore user-level Codex configuration and disable plugins and multi-Agent fan-out so unrelated tooling does not consume the working context.
- Scope the implementation session to one Issue and require the repository TDD Skill.
- Reject a dirty worktree before execution.
- Never push and never call a real cloud model from Collector tests.
- Run `npm test`, the Collector project check, and GUI smoke outside the implementation agent.
- Use a fresh read-only Codex session for validation; `pass` is valid only with zero findings.
- Record `HEAD` before implementation. If the implementation Agent creates a commit, move back with `git reset --soft` so the commit is removed but all code changes remain staged for inspection, then stop.
- Protect the local tracker, Ralph runner, repository Agent guide, and TDD Skill from implementation-session edits.
- Mark the Issue complete and commit only after verification and validation pass.
- Stop on ambiguity, timeout, failed checks, or failed validation. Changes remain available for human inspection.

## Commands

Preview the next eligible Issue without invoking Codex:

```powershell
npm run ralph:dry
```

Run one Issue:

```powershell
npm run ralph:once
```

Run at most three Issues, with a fresh implementation and validation context for each:

```powershell
npm run ralph:afk
```

Direct parameters are available through the PowerShell scripts:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ralph\once.ps1 `
  -Issue 01-recoverable-local-workflow.md `
  -Model <codex-model> `
  -TimeoutMinutes 45
```

`COLLECTOR_RALPH_MODEL` and `COLLECTOR_RALPH_TIMEOUT_MINUTES` provide optional defaults. Omitting the model uses the authenticated Codex default.

Ralph commits locally but does not push. Review the commit before publishing it.

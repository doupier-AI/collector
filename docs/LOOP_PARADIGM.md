# Loop Paradigm

The five-step loop paradigm lives as a standalone package at `C:\Users\Administrator\.codex\skills\loop-paradigm\`.

## Quick reference

| File | Purpose |
|---|---|
| `LOOP_PARADIGM.md` | Full paradigm reference: five steps, project requirements, quick start, token budget |
| `config.template.toml` | Clean config template with `{PLACEHOLDER}` values |
| `skills/*-loop.template.md` | Generic skill templates for all four steps |
| `agents/*.template.toml` | Implementer and reviewer sub-agent templates |

## Using the paradigm

1. Copy `config.template.toml` → `.loop/config.toml` and fill in your project values.
2. Copy the four skill templates from `skills/` → `.agents/skills/` in your project.
3. Copy the two agent templates from `agents/` → `.codex/agents/` in your project.
4. Add `.worktrees/` to `.gitignore`.
5. Create a cron automation that invokes the four skills in sequence.
6. Start PAUSED, verify config, then activate.

## Collector implementation

This project is the first complete implementation. See:

- `.loop/config.toml` — filled-in Collector configuration
- `.agents/skills/triage-loop/SKILL.md` — discovery with Collector's signal sources
- `.agents/skills/handoff-loop/SKILL.md` — handoff with worktree dispatch
- `.agents/skills/verify-loop/SKILL.md` — three-layer verification (mechanical + review + Playwright QA)
- `.agents/skills/persist-loop/SKILL.md` — merge, issue update, budget enforcement
- `.codex/agents/loop-implementer.toml` — implementer sub-agent
- `.codex/agents/loop-reviewer.toml` — reviewer sub-agent

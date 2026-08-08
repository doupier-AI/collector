# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Closing issues on completion

- A task whose implementation commit completes a full issue (not just a slice) closes that issue in the same task, immediately after the commit lands — do not defer it to a later task. Mandated by AGENTS.md (代码提交).
- Closing comment format (follows #44/#31/#32/#34 precedent):
  - 用户可见结果（what the user can now do）;
  - 验收对照（acceptance criteria 逐条 ✅，或对无验收清单的 parent 规格用"实施章节 → 子票据 → 提交"映射表）;
  - 证据（commits、ADR、PROJECT.md 能力表状态、e2e/browser 测试）。
- Cross-commit issues close once the dependency chain / child tickets are all complete and evidenced; parent spec issues close only after all child tickets are complete; DEFERRED issues stay open until their stated re-trigger condition (e.g. merge to master); SUPERSEDED issues close as archival when superseding scope is delivered.
- Never close with evidence that contradicts `docs/PROJECT.md` 四态能力表; sync the table in the same task first if the capability status changed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

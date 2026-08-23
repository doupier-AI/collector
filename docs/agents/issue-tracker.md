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

## Branch plans and linked branches

Every new issue, and every existing open issue before it is claimed, must expose a **branch plan**. This lets the next agent discover the work location from the issue instead of relying on chat history.

Append this idempotent block after the issue number exists:

```markdown
## 分支计划

<!-- collector-branch-plan -->
- **基线**：`master`
- **计划分支**：`codex/<purpose>/<english-slug>-<issue-number>`
- **处置方式**：`合并候选` / `一次性研究或原型资产，不合入基线` / `仅 Issue 决策，不写仓库`
- **实际状态**：以 GitHub Development 中的原生关联分支为准；没有关联分支表示尚未创建或本票无需分支。
```

- The plan records stable intent: base, deterministic name, and disposition. The GitHub Development linked branch records live state; do not duplicate a mutable current branch in comments or body text.
- Use an explicit `无独立分支` plan for tracker-only work. If repository writes later become necessary, update the plan and create a linked branch before the first write.
- Default names are `codex/research/<slug>-<number>`, `codex/prototype/<slug>-<number>`, `codex/decision/<slug>-<number>`, `codex/task/<slug>-<number>`, `codex/feature/<slug>-<number>`, or `codex/fix/<slug>-<number>`. Use a short lower-kebab English slug. The issue's recorded plan, not label inference, is authoritative.
- Do not create branches for blocked or unclaimed issues. After claiming a branch-backed issue, run `gh issue develop --list <number>` first. Reuse the linked branch if one exists; otherwise create and link the planned branch with `gh issue develop <number> --base <base> --name <planned-branch>` before repository writes.
- If the plan and a native link disagree, treat the native link as the actual branch, stop before creating another branch, and reconcile the issue plan.
- At resolution, name the actual branch and its disposition in the closing comment. Keep throwaway research/prototype branches as linked primary-source context; merge-capable issues follow the repository's commit and close rules.

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

---
description: Hand a task, investigation or fix to Google Antigravity (agy) through the agy-rescue subagent
argument-hint: "[--background|--wait] [--gemini-api|--agy] [--read-only] [--allow-shell] [--resume|--fresh] [--model <auto|opus|sonnet|gemini-pro|gemini-flash|slug>] [--effort <low|medium|high|xhigh|max>] [what agy should do]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill. Do not call `Skill(agy:rescue)`: that re-enters this command.
The final user-visible response must be agy's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- `--background`: run the subagent in the background. `--wait`: run it in the foreground. Neither: foreground.
- `--background` and `--wait` are for Claude Code only. Do not forward them.
- `--gemini-api`, `--agy`, `--read-only`, `--allow-shell`, `--model` and `--effort` are forwarded as flags, not as task text. `--gemini-api` runs the task on the user's own Gemini API key (Gemini CLI) instead of their Google AI plan sign-in; with it, Claude models are not available, so leave `--model` out unless the user named a Gemini model.
- If the request has no `--model`, choose one only if the rules below call for a specific model (otherwise leave it out). If the request has no `--effort`, choose one (rules below) and add it to the forwarded request, so the level reflects what the user asked in this conversation.

Choosing `--model` (if the user named a model, use exactly that):

- Leave it out for ordinary work: it then runs Claude Sonnet, or Opus when the effort is `high`.
- `opus` for work where getting it right matters more than speed, even at medium effort: hard or long-running bugs, design and architecture, security, concurrency, data migrations, a careful review of risky changes.
- `sonnet` to force Sonnet on high-effort work that is long but not subtle (big mechanical refactors, lots of boilerplate).
- `gemini-pro` when the input is very large (huge logs, many files read at once, a very long document) and long context matters more than Claude's judgment, or when Claude models fail with a quota or rate-limit error.
- `gemini-flash` for bulk trivial work (simple renames or formatting across many files, quick summaries) to spare the Claude quota.

Choosing `--effort` (the user can always override it):

- If the user named a level or model tier ("--effort high", "use opus high"), use exactly that.
- Otherwise read it from how they asked: "quick", "briefly", "just check", "rough" -> `low`; "think hard", "carefully", "deep dive", "thoroughly", "ultrathink", "get this right" -> `high`.
- Otherwise judge the task: a lookup, a small mechanical edit or a simple question -> `low`; an ordinary fix, feature or explanation -> `medium`; hard debugging, a subtle or cross-file bug, design or architecture, security, concurrency, or a large review -> `high`.
- `xhigh` and `max` are accepted and run at agy's highest tier (`high`).

- If the request has `--resume` or `--fresh`, do not ask: the user already chose.
- Otherwise check for an earlier agy conversation in this repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" resume-candidate --json
```

- If it reports `available: true`, use `AskUserQuestion` once with the options `Continue the last agy conversation` and `Start a new agy conversation`. Put the continue option first with `(Recommended)` if the request is a follow-up ("continue", "keep going", "apply the fix", "dig deeper"); otherwise put the new option first with `(Recommended)`. Add `--resume` or `--fresh` to the request accordingly.
- If it reports `available: false`, do not ask.

Rules:

- The subagent only forwards. It does not read files, poll status or summarize.
- Return agy's output verbatim, with no commentary before or after it.
- If the output says agy is missing or not signed in, tell the user to run `/agy:setup`.
- If the user gave no task, ask what agy should do.

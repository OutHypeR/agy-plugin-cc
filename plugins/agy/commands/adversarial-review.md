---
description: Ask Google Antigravity (agy) to challenge your changes - design, assumptions and failure modes
argument-hint: "[--base <ref>] [--background] [--gemini-api|--agy] [--model <auto|opus|sonnet|gemini-pro|gemini-flash|slug>] [--effort <level>] [what to focus on]"
allowed-tools: Bash(node:*)
---

Run, passing the user's arguments through unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --adversarial $ARGUMENTS
```

If the arguments have no `--effort`, add one, chosen as below (a review of a few lines -> `low`; a normal change -> `medium`; a big, risky or security-related change, or the user asked for a careful review -> `high`). Pass the other arguments through unchanged.

Choosing `--effort` (the user can always override it):

- If the user named a level or model tier ("--effort high", "use opus high"), use exactly that.
- Otherwise read it from how they asked: "quick", "briefly", "just check", "rough" -> `low`; "think hard", "carefully", "deep dive", "thoroughly", "ultrathink", "get this right" -> `high`.
- Otherwise judge the task: a lookup, a small mechanical edit or a simple question -> `low`; an ordinary fix, feature or explanation -> `medium`; hard debugging, a subtle or cross-file bug, design or architecture, security, concurrency, or a large review -> `high`.
- `xhigh` and `max` are accepted and run at agy's highest tier (`high`).

If the arguments have no `--model`: add `--model opus` for risky or security-related changes, `--model gemini-pro` for a very large diff (thousands of lines); otherwise leave it out.

Use a Bash timeout of 600000 ms. agy gets the diff in its prompt and runs in an empty temporary folder, so it cannot read or change the repository.

Return the command's output verbatim. Do not act on it unless the user asks.

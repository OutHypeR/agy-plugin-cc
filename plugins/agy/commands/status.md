---
description: Show agy jobs started from Claude Code, or one job's progress
argument-hint: "[job id]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status $ARGUMENTS
```

Return the output verbatim.

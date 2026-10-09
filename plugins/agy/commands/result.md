---
description: Show the answer of a finished agy job (the latest one if no id is given)
argument-hint: "[job id]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result $ARGUMENTS
```

Return the output verbatim.

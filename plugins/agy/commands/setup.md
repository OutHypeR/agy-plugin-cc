---
description: Check agy and the Gemini API key option, choose the default backend, or change the default model
argument-hint: "[--backend agy|gemini-api] [--gemini-api-model <name>|default] [--default-model <auto|opus|sonnet|slug|agy-default>] [--default-effort <low|medium|high>]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup $ARGUMENTS
```

Present the output to the user as-is.

- If agy is not installed, show the install command from the output and tell the user to run it in a terminal, then open a new terminal so `agy` is on PATH. Do not run the installer yourself unless the user asks.
- If agy is installed but not signed in, tell the user to run `agy` once in a terminal and sign in with their Google account. The plugin never handles their sign-in.

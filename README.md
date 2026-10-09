# agy-plugin-cc

**Unofficial.** A Claude Code plugin that hands tasks and code reviews to Google's models, so the work doesn't use your Claude plan. Each run uses one of two backends:

- **`--gemini-api`: your own Gemini API key** (from Google AI Studio), run through Google's open-source Gemini CLI. This is the route Google recommends for third-party coding agents. It is billed per use to your key, under the Gemini API terms.
- **`--agy`: your Google AI plan sign-in**, through the Antigravity CLI (`agy`). This also gives you the Claude Sonnet and Opus models that Antigravity offers. **Read the warning below before using it.**

Not affiliated with, endorsed by or supported by Google, Anthropic or OpenAI. It is modelled on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (see NOTICE).

## Warning: the agy backend and Google's terms

Google's [Antigravity FAQ](https://antigravity.google/docs/faq/) says:

- Using third-party software (it names Claude Code, OpenClaw and OpenCode) with your Antigravity login "is a violation of our Terms of Service". It can lead to the suspension of your Antigravity and Gemini CLI access.
- Headless mode (`agy -p`) "is intended for direct scripting and CI workflows". Wrapping `agy` inside third-party coding agents or applications is not supported on consumer plans.
- For third-party coding agents, Google recommends a Google AI Studio or Gemini Enterprise API key.

The `--agy` backend runs `agy -p` from Claude Code, which is exactly what that FAQ describes. It never reads or reuses agy's credentials, and it only starts the official, unmodified `agy` program. But that does not make it allowed: **on a consumer plan, using `--agy` may breach Google's terms and get your access suspended.** Users have reported suspensions with no warning. The `--gemini-api` backend avoids this.

The plugin never routes work automatically; every run is one you start. The `--agy` backend stays in for people on plans where this is allowed, and for those who choose to accept the risk.

## Requirements

- Claude Code, Node 18+ and git.
- For `--gemini-api`:
  - Gemini CLI (`npm install -g @google/gemini-cli`), set to API-key auth: `"security": {"auth": {"selectedType": "gemini-api-key"}}` in `~/.gemini/settings.json`.
  - A key from [Google AI Studio](https://aistudio.google.com/apikey) in the `GEMINI_API_KEY` environment variable, or in `~/.gemini/.env`. The plugin never reads, prints or stores the key; Gemini CLI reads it itself.
- For `--agy`: `agy` installed and signed in once.
  - Windows: `irm https://antigravity.google/cli/install.ps1 | iex`
  - macOS / Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  - Then run `agy` once and sign in.

Tested on Windows 11 with agy 1.3.2 and Gemini CLI 0.62. The `--gemini-api` backend was tested up to the API call (missing key, wrong model, an invalid key), but not yet with a working key. macOS and Linux are untested.

## Install

```
claude plugin marketplace add OutHypeR/agy-plugin-cc
claude plugin install agy@agy-plugin-cc
```

Start a new session and run `/agy:setup`. It shows both backends. Pick the default with `/agy:setup --backend gemini-api` (or `agy`); the default is `agy`.

## Commands

| Command | What it does |
|---|---|
| `/agy:setup` | Shows both backends, your default backend and models, and agy usage left. Options: `--backend agy\|gemini-api`, `--gemini-api-model <name>\|default`, `--default-model`, `--default-effort`. |
| `/agy:rescue <task>` | Hands a task over through the `agy-rescue` subagent. The model may read and edit files in the current folder. |
| `/agy:review [--base <ref>] [focus]` | Read-only review of uncommitted changes, or of a branch since `<ref>`. |
| `/agy:adversarial-review [...]` | Same, but the model challenges the design, assumptions and failure modes. |
| `/agy:status [id]`, `/agy:result [id]`, `/agy:cancel [id]` | Follow, read and stop jobs. |

Options for `rescue`:

- `--gemini-api` / `--agy`: the backend for this run.
- `--read-only`: works in a throwaway git worktree copy (including your uncommitted and untracked files), deleted afterwards.
- `--allow-shell`: lets the model run shell commands. Without it, it can only read and edit files.
- `--background`, `--resume` / `--fresh` (agy only), `--model`, `--effort`.

## Models and effort

**`--agy`:**
- The default `auto` runs Claude Sonnet, or Claude Opus at high effort.
- Shortcuts: `opus`, `sonnet`, `gemini-pro` and `gemini-flash` resolve to the newest matching model in `agy models`. A full slug works too.
- Effort maps onto agy's tiers: low, medium, high (`xhigh` and `max` become high). The calling Claude picks it from how you asked.

**`--gemini-api`:** Gemini CLI's default model, unless you name an exact Gemini model with `--model`, or set one with `/agy:setup --gemini-api-model <name>`. Claude models are not available on a Gemini API key.

Every answer ends with a footer naming the backend and the model.

## How it works

- **`--agy`:** runs `agy --input-format stream-json --output-format stream-json` with the task on stdin.
  - Reviews send the diff in the prompt and run in an empty temporary folder, so they cannot touch your repository.
  - agy's documented [status line](https://antigravity.google/docs/cli/statusline) reports its quota. `/agy:setup` adds a `statusLine` entry to `~/.gemini/antigravity-cli/settings.json`, so the plugin can show what is left and refuse runs on a used-up model group.
  - It never replaces a statusLine you set yourself; delete the entry to undo it.
- **`--gemini-api`:** runs `gemini -p -o json --skip-trust` with the task on stdin.
  - Read-only work and reviews use Gemini CLI's own `plan` (read-only) mode.
  - Edits use `auto_edit`; `--allow-shell` uses `yolo`.
- **Storage:** jobs and settings live in `~/.claude/agy-companion`; override with `AGY_COMPANION_HOME`.

## agy quirks found while building this (agy 1.3.2)

- `--mode plan` does **not** stop file writes in headless mode, so read-only uses a throwaway copy.
- A refused shell command **ends the turn with no reply**, so the plugin tells agy up front that it has no shell.
- agy passes quotes in a statusLine command to the program literally. If your home folder path contains a space, usage tracking will not work on Windows.
- `--effort` conflicts with a model slug that already names a tier.

## Credits

Written by OutHypeR together with Claude (Anthropic's Claude Opus 5.5, in Claude Code). The plugin layout follows [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see NOTICE.

## License

Apache-2.0. See LICENSE and NOTICE.

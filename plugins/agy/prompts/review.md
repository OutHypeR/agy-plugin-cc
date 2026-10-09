You are reviewing a code change in the repository "{{REPO}}" ({{SCOPE}}).
The full diff is below. You cannot open other files in the repository, so judge from the diff alone and say when a finding depends on code you cannot see.
Do not create or edit any files and do not run any tools or shell commands (they are refused and end your turn). Answer in text only.

{{FOCUS}}
{{TRUNCATED}}

Look for real problems: bugs, wrong logic, crashes, data loss, security holes, race conditions, broken edge cases, and changes that do not do what they appear to intend. Skip style nits and personal preferences.

Reply in this shape:

## Verdict
One line: "Looks good", "Minor issues" or "Needs changes", plus one sentence why.

## Findings
A numbered list, most serious first. For each:
- **[high|medium|low] file:line** - what is wrong
- Why it matters: the concrete input or situation that breaks
- Fix: the smallest change that fixes it

If there are no real findings, write "None." Do not invent problems to fill the list.

## Not checked
Anything you could not judge from the diff.

---

{{DIFF}}

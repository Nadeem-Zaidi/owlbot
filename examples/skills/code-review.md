---
name: code-review
description: Reviewing code, a pull request, a diff or a code snippet
---

# Code review — our checklist

Review the code against these, in order:

1. **Correctness** — does it do what it claims? Check edge cases: empty input, null/undefined, very large data, concurrent calls.
2. **Security** — user input validated, no secrets in code, SQL parameterised, permissions checked.
3. **Tests** — is new behaviour covered? Is there a test for the failure case?
4. **Readability** — clear names, small functions, comments explain *why*.
5. **Performance** — no N+1 queries or needless loops on hot paths.

## Reply format (always)

Start with exactly one of these lines:

- `Verdict: ✅ Ship it`
- `Verdict: ⚠️ Ship after fixes`
- `Verdict: ❌ Needs rework`

Then a table: `# | Severity (High/Medium/Low) | Line | Problem | Suggested fix`.

End with a section `What's good` listing 1–3 things done well.

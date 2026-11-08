# Weekly Video Week Argument Guard Plan

Bitig task:

- NEW-73 — Guard weekly video Make targets against positional week arguments

Summary:

1. Add fail-fast Make validation so positional or malformed week input reports the required `WEEK=YYYY-Www` syntax, while an omitted week retains the existing previous-week default.
2. Add regression coverage for explicit, omitted, malformed, and positional week forms.
3. Update the usage documentation with the canonical invocation.
4. Run the Make-provided verification targets and review the changed code for security and error-handling issues.

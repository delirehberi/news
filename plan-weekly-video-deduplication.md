# Weekly Video Cross-Week Deduplication Plan

- `[NEW-74] Prevent repeated stories across approved and published weekly videos`
  1. Add historical story-identity lookup across approved and published editions, matching normalized URLs and stable cluster IDs.
  2. Exclude historical matches during selection, backfill from the remaining candidates, and report each exclusion with its prior edition. Fail clearly when too few unique candidates remain.
  3. Enforce the same validation when an edition transitions to approved or published so manual edits cannot bypass the selection check.
  4. Add coverage for repeated URLs, matching clusters with different URLs, distinct follow-up stories, ignored drafts, insufficient unique candidates, and API bypass attempts. Run the Makefile test and type-check targets and perform a focused security review.

Matching intentionally avoids fuzzy title comparison because similar wording can describe a legitimate follow-up story.

The separate pending task `[NEW-73] Guard weekly video Make targets against positional week arguments` remains outside this implementation.

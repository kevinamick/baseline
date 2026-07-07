# Instances: 10 prompt-optimization jobs

Each instance is one Eval Run Row / frozen Instance. **Input** is the packaged job P
receives (all three of P's required inputs, so its "help me build them" branch never
triggers). **Expected** is the row's expected-output note — what a good P transcript
looks like for this job — for the judge's benefit.

Every "current prompt" below is deliberately flawed in a way its test cases expose.
The flaw is noted for our benefit in *(seeded flaw)* lines; those lines are NOT part
of the row input.

---

## 1. Changelog summarizer

*(seeded flaw: no length bound, no audience, invites marketing fluff)*

**Input:**

```
CURRENT PROMPT:
Summarize these git commit messages into a changelog entry for our release notes.
Make it engaging for readers.

TEST CASES:
1. Input: "fix: null deref in export | feat: CSV export | chore: bump deps" — Good: 2 user-facing bullets (CSV export added, export crash fixed); dep bump omitted or one quiet line.
2. Input: 14 commits, 11 of them "wip" or merge commits, 3 real fixes — Good: only the 3 real fixes appear.
3. Input: "feat!: remove legacy API v1 (BREAKING)" — Good: breaking change flagged first, migration note suggested.
4. Input: single commit "perf: 40% faster search indexing" — Good: one bullet, keeps the concrete number.
5. Input: commits in mixed languages (two in Spanish) — Good: uniform English output, nothing dropped.

SCORING CRITERIA:
- Only user-visible changes appear; internal chores are omitted or minimized.
- Breaking changes are flagged prominently.
- Tone is factual; no hype words (amazing, supercharged, revolutionary).
```

**Expected:** Diagnosis should converge on the unbounded "engaging" instruction
producing hype and chore-noise; revisions should add audience/length/tone constraints
and a breaking-change rule. Table shows hype and chore-leak cases improving without
regressing the single-commit case.

---

## 2. Email subject line generator

*(seeded flaw: no length cap, no spam-word rule, always exclaims)*

**Input:**

```
CURRENT PROMPT:
Write a great subject line for this email. Make it exciting so people open it!

TEST CASES:
1. Input: outage postmortem email to customers — Good: sober, factual subject; no exclamation.
2. Input: monthly newsletter with 3 feature updates — Good: under 60 chars, mentions the lead feature.
3. Input: invoice reminder, second notice — Good: clear, polite, includes invoice number if given.
4. Input: webinar invite, date included — Good: date present, under 60 chars.
5. Input: security disclosure requiring action — Good: urgency without spam-trigger words (FREE, ACT NOW).

SCORING CRITERIA:
- Under 60 characters.
- Tone matches the email's content (sober content gets a sober subject).
- No spam-trigger vocabulary or unnecessary exclamation marks.
```

**Expected:** Diagnosis: one-size-fits-all excitement. Revisions should add the length
cap and a tone-matching rule. Postmortem and security cases must improve; newsletter
case must not regress.

---

## 3. Support-email field extractor

*(seeded flaw: no schema, no null policy — invents fields and values)*

**Input:**

```
CURRENT PROMPT:
Extract the customer details from this support email as JSON.

TEST CASES:
1. Input: email with name, account id, and clear bug report — Good: {"name","account_id","issue"} exactly; valid JSON.
2. Input: angry email, no account id anywhere — Good: account_id is null, never guessed.
3. Input: email mentioning two different order numbers — Good: both captured in a list, not silently one.
4. Input: empty body, subject only — Good: nulls, no invented issue text.
5. Input: email in French — Good: same schema, values extracted, not translated away.

SCORING CRITERIA:
- Output is valid JSON with a consistent key set across all cases.
- Missing information becomes null; nothing is ever invented.
- All values present in the email are captured (no silent drops).
```

**Expected:** Diagnosis: no declared schema/null policy. Revision adds an explicit key
set and "null when absent" rule. Cases 2 and 4 improve most; case 1 stays perfect.

---

## 4. SQL query writer

*(seeded flaw: no dialect, no schema discipline, SELECT * habits)*

**Input:**

```
CURRENT PROMPT:
You are a SQL expert. Write a query for whatever the user asks.

TEST CASES:
1. Input: "monthly signups this year" + schema: users(id, created_at) — Good: Postgres date_trunc, GROUP BY, no SELECT *.
2. Input: "top 5 customers by revenue" + schema given — Good: correct join, LIMIT 5, explicit columns.
3. Input: request referencing a column not in the schema — Good: says the column does not exist; no guessing.
4. Input: "delete inactive users" — Good: includes a WHERE clause and suggests running SELECT first; never a bare DELETE.
5. Input: ambiguous "sales by region" with two region-ish columns — Good: asks which column, or states its assumption explicitly.

SCORING CRITERIA:
- Queries are valid PostgreSQL and use only columns from the provided schema.
- Explicit column lists; no SELECT *.
- Destructive requests are guarded; ambiguity is surfaced, not silently resolved.
```

**Expected:** Diagnosis: no dialect/schema/safety contract. One revision per round:
pin dialect + schema adherence, then guard destructive ops. Case 3 and 4 improve;
cases 1-2 hold.

---

## 5. Review sentiment classifier

*(seeded flaw: forces binary positive/negative)*

**Input:**

```
CURRENT PROMPT:
Classify this product review as positive or negative.

TEST CASES:
1. Input: "Great hardware, terrible app. Returning it." — Good: negative overall, mixed acknowledged.
2. Input: "It's fine I guess." — Good: neutral, not forced positive.
3. Input: "Oh WONDERFUL, it died in a week. Just perfect." — Good: negative (sarcasm caught).
4. Input: "Five stars just for the delivery speed, product untested." — Good: neutral or explicitly scoped to delivery.
5. Input: straightforward "Love it, works exactly as described." — Good: positive.

SCORING CRITERIA:
- Label set handles neutral and mixed, not just binary.
- Sarcasm classified by meaning, not surface words.
- One label per review plus a one-line justification.
```

**Expected:** Diagnosis: the binary label set is the recurring cost. Revision widens
labels + requires justification. Cases 2-4 improve; case 5 must not wobble.

---

## 6. Meeting-notes action-item extractor

*(seeded flaw: no owner/date rules, paraphrases into hallucination)*

**Input:**

```
CURRENT PROMPT:
Pull out the action items from these meeting notes.

TEST CASES:
1. Input: notes with "Dana to send deck by Fri" — Good: item with owner=Dana, due=Friday.
2. Input: notes with a decision ("we chose vendor B") but no tasks — Good: zero items; decisions are not tasks.
3. Input: "someone should look at churn" — Good: item captured with owner=unassigned, not a guessed name.
4. Input: notes where the same task is mentioned twice — Good: one deduplicated item.
5. Input: 2-line standup with nothing actionable — Good: explicitly "no action items."

SCORING CRITERIA:
- Every item has owner and due date fields, using "unassigned"/"none" when absent.
- Only genuine commitments become items; decisions and status remarks do not.
- Verbatim-faithful: no invented owners, dates, or tasks.
```

**Expected:** Diagnosis: missing field contract lets it guess owners and inflate
items. Revision adds the field schema + "commitments only" rule. Cases 2, 3, 5 improve.

---

## 7. Plain-language rewriter for docs

*(seeded flaw: "simplify" with no preservation rule — drops caveats)*

**Input:**

```
CURRENT PROMPT:
Rewrite this technical documentation paragraph in simple language anyone can understand.

TEST CASES:
1. Input: paragraph with a data-loss warning mid-text — Good: warning survives, prominent.
2. Input: paragraph defining a term then using it — Good: definition kept or inlined; term not orphaned.
3. Input: steps with a strict order dependency ("before enabling X, do Y") — Good: order preserved unambiguously.
4. Input: already-simple paragraph — Good: light touch, no dumbing down of exact values.
5. Input: paragraph with a version-specific caveat ("only on v2 or later") — Good: caveat retained.

SCORING CRITERIA:
- All warnings, caveats, and version constraints survive the rewrite.
- Reading level drops (shorter sentences, common words) without losing precision.
- Numbers, versions, and command names stay verbatim.
```

**Expected:** Diagnosis: simplification with no preservation contract. Revision adds a
"never drop warnings/caveats/exact values" rule. Cases 1, 3, 5 improve; case 4 stays
light-touch.

---

## 8. Support reply drafter

*(seeded flaw: no policy grounding — over-promises)*

**Input:**

```
CURRENT PROMPT:
Draft a friendly reply to this customer. Make them happy.
Context you may use: refunds allowed within 30 days; no refunds on used consumables;
escalation to a human is always available on request.

TEST CASES:
1. Input: refund request, day 12, unopened item — Good: approves per policy, states the step.
2. Input: refund request, day 45 — Good: declines kindly, offers alternatives; does not bend the 30-day rule.
3. Input: refund request for used consumable + legal threat — Good: policy held, escalation offered, no legal improvisation.
4. Input: furious ALL-CAPS message, valid complaint — Good: de-escalates, no groveling discount promises.
5. Input: question fully answered by the context — Good: answers directly, no invented policy details.

SCORING CRITERIA:
- Never promises anything the stated policy does not allow.
- Empathetic, concise tone without over-apologizing or unauthorized compensation.
- Offers escalation when the customer is hostile or threatens legal action.
```

**Expected:** Diagnosis: "make them happy" outranks policy. Revision reorders the
contract: policy first, warmth second. Cases 2-4 improve; case 1 stays approved.

---

## 9. Regex writer

*(seeded flaw: no anchoring/engine/testing discipline)*

**Input:**

```
CURRENT PROMPT:
Write a regex for what the user describes.

TEST CASES:
1. Input: "match a US ZIP code" — Good: anchored, handles 5 and 5+4, notes it validates format only.
2. Input: "extract the domain from an email" — Good: capture group, no catastrophic backtracking pattern.
3. Input: "match dates like 2026-07-06" — Good: anchored YYYY-MM-DD; states it does not validate real calendar dates.
4. Input: "match anything between quotes" — Good: non-greedy, escaped-quote caveat mentioned.
5. Input: request that regex handles poorly ("match balanced parentheses") — Good: says regex is the wrong tool.

SCORING CRITERIA:
- Patterns are anchored where matching (vs extracting) and state the target engine or its assumptions.
- Each answer includes 2-3 example matches and one non-match.
- Known regex limitations are stated instead of papered over.
```

**Expected:** Diagnosis: bare patterns with no anchors/examples/limits. Revision adds
the answer format (pattern + examples + caveat). Case 5 flips from a wrong pattern to
an honest refusal.

---

## 10. Blog title generator

*(seeded flaw: SEO keyword-stuffing instruction fights honesty)*

**Input:**

```
CURRENT PROMPT:
Generate 5 SEO-optimized titles for this blog post. Include as many keywords as
possible so it ranks well.

TEST CASES:
1. Input: post announcing a small bugfix release — Good: honest scale ("patch", "fix"), no "major update" inflation.
2. Input: technical deep-dive, keyword list of 8 terms provided — Good: 1-2 keywords per title, all under 65 chars.
3. Input: opinion piece with a clear thesis — Good: thesis visible in at least 3 of 5 titles.
4. Input: tutorial post — Good: at least one "How to" form; promise matches the post's actual content.
5. Input: post with no keywords supplied — Good: derives natural terms; no invented buzzwords.

SCORING CRITERIA:
- Titles under 65 characters, each distinct in structure (not five rephrasings).
- At most 2 keywords per title; reads naturally to a human.
- Title promises match the post content; no clickbait inflation.
```

**Expected:** Diagnosis: "as many keywords as possible" collides with every naturalness
criterion. Revision replaces stuffing with a per-title keyword budget. Cases 1, 2, 5
improve; case 3's thesis coverage holds.

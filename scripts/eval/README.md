# Accuracy eval harness

The keystone that makes the **accuracy-first mandate** ("no wrong lender, ever")
measurable instead of assumed. The bar: a staff member who produced a wrong funder
shortlist, or a wrong funding-source record, would be held accountable. This
harness holds the software to the same standard.

## What it checks

**1. Retrieval** (`golden/retrieval/*.json`): drives the live search pipeline via
the bearer-gated `POST /api/search/debug` and asserts the firing-level guarantee:
a returned shortlist **never contains a lender that contradicts a stated deal
constraint** (geo / asset / size). This is rule-based (zero `contradict` verdicts
in the result set) and needs **no ground truth**. It enforces "no wrong lender,
ever" by construction. Optional fields add stronger checks once an operator supplies them:

- `must_not_include_ids`: lenders that must NEVER appear (a hard FAIL if they do).
- `expected_lender_ids`: lenders that should appear (recall; a WARN if missing).
- `expect_extraction`: what the query must be **understood** to mean (hard FAIL).
- `min_results` / `max_results`: shortlist size. `min_results` is a **hard FAIL**;
  `max_results` is a WARN.

Every case also prints a `parse[...]` line showing the criteria the search actually
ran on, so a human reading the output can see the understanding and not just the
verdict.

### `expect_extraction`: why a green case is not automatically a real case

The zero-contradiction guarantee is **vacuously satisfiable**. Every dimension in
`src/lib/search/structured-filter.ts` returns `unknown` when the corresponding deal
criterion is empty (blank is never guessed; that is the accuracy mandate working
as designed). So a query that parses to **nothing** produces zero `contradict`
verdicts and passes. Two multilingual cases once did exactly that:
empty `must_not_include_ids` + empty `expected_lender_ids` gated their blocks off
entirely, `min_results` only warned, and their notes claimed guarantees the harness
never checked.

`expect_extraction` asserts the parse itself, against `effective` from
`/api/search/debug` (the parse plus operator chip edits; falls back to `extraction`
on a deployment that predates `effective`). Every key is optional; **every key
present is a hard FAIL when unmet**, including the case where the endpoint returns
no parse at all: "could not check" must never read as "passed".

| Key | Type | Assertion |
|-----|------|-----------|
| `asset_classes` | `string[]` | every listed value is present (subset, not equality) |
| `geographic_scope` | `string[]` | every listed value is present |
| `not_geographic_scope` | `string[]` | none of these are present |
| `intl_required` | `boolean` | equals |
| `deal_size_min_usd` | `number \| null` | equals exactly (`null` = unstated) |
| `deal_size_max_usd` | `number \| null` | equals exactly |
| `asset_year` | `number \| null` | equals exactly |

Numbers are compared exactly. The extractor is deterministic (`extract-deal.ts`,
no LLM), so a tolerance would only hide a regression.

`not_geographic_scope` exists because a mis-parsed geography is not a missing
filter, it is the **wrong** filter: `US 3 milhoes no Brasil` reading as United
States made a Brazil deal look domestic and put US-only lenders on the shortlist.

**`min_results` is a hard failure**, not a warn. An empty shortlist is a wrong
shortlist, and a case that returns nothing has proved nothing. A warn here is what
let a query that parsed to nothing report green.

**Rule for new cases:** if a case is meant to prove the pipeline understood a
sentence, it must assert `expect_extraction`. Empty id lists are fine (operator ground
truth may still be outstanding); asserting nothing at all is not.

**2. Parse** (`golden/parse/*.json`): runs the doc→field extractor on golden docs
and checks field-level accuracy. `critical_fields` mismatches are hard FAILs (a
wrong asset class or geography is firing-level); other field misses are WARNs.

A hard FAIL exits non-zero (wire into CI later). WARNs never fail the run.

## Run it

```bash
# from repo root, with env loaded
set -a && source .env.local && set +a

# both evals, against the live deployment
EVAL_BASE_URL=https://your-app.vercel.app pnpm eval

# against local dev
pnpm dev   # in another shell
pnpm eval

# one at a time
pnpm eval -- --retrieval-only
pnpm eval -- --parse-only
```

### Env

| Var | Needed for | Notes |
|-----|-----------|-------|
| `EVAL_BASE_URL` | retrieval | default `http://localhost:3000` |
| `SEARCH_DEBUG_TOKEN` | retrieval | the bearer for `/api/search/debug` (same value as the deployment's env) |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | parse | extractor logging |
| `LLM_BACKEND`, `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `EMBED_MODEL`, `LLM_MODEL` | parse | AI backend (local Ollama or an OpenAI-compatible endpoint) |

Missing env → that eval is **skipped with a WARN**, never a false FAIL.

## Ground truth to collect from your own team

The rule-based guarantee runs today. To lock in recall + real negative cases,
collect:

1. **5–10 real deals** → the funder shortlist an experienced operator would produce
   (fills `expected_lender_ids`).
2. **Known negatives**: "for THIS deal, lender X must NEVER appear" (fills
   `must_not_include_ids`).
3. **3–5 lender docs** incl. a Portuguese-language tear sheet → exact correct field
   values (new `golden/parse/*.json` files; flip `pending:false` once `doc_text` is in).

> Privacy: run parse-eval ground-truth ingestion against a local or self-hosted AI
> backend so real lender doc text never leaves your network.

## Add a case

Drop a JSON file in `golden/retrieval/` or `golden/parse/`. Shapes are documented
inline in `scripts/eval/run.ts` (`RetrievalCase`, `ParseCase`).

# QA golden set qa.v1.1

Same 112 questions as qa.v1 (see `../qa-v1/README.md`), with two corrections: evidence extended across chunk boundaries for 10 questions, and the 3 questions flagged ambiguous in golden v1 excluded. `review.json` records every label override.

## Error categories (`error-categories.json`)
- Each of the 53 real RAG mistakes gets one category with a note, read against the source text by Claude (claude-opus-5-5) and pending human review. Constructed mistakes are categorised by construction (`lib/eval/error-categories.ts`).
- No category is derived from Jev or judge output.

## Errata
- **q3-017 (hybrid RAG answer, "$5.0 billion"): disputed truth label.** The 10-Q states both a $5.0 billion (pre-tax) impairment loss and $3,760M after tax; the reference used the after-tax figure, so the answer may be correct. Because published reports are immutable, the qa.v1.1 report keeps the original label. The item is marked `disputed` and excluded from the Evaluator Intelligence analysis. Fix it in the next dataset version.

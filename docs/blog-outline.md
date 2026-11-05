# Blog post outline: "Jev vs. an LLM judge: evaluating evidence-grounded financial claims"

> Rule for this post: only numbers from committed reports in `reports/` may appear. Sections marked **[PENDING]** have no measurement yet and must not be filled from intuition.

## 1. Why evaluate decision models as a system
- The task: deciding whether a financial claim is supported, contradicted, or unknown, given a report.
- Airbnb's eval-driven development lessons applied here: separate layers, failure taxonomies, a judge that is itself under evaluation.
- Agreement is not correctness. A mock run in this project showed two constant "insufficient" predictors agreeing 100% while scoring 0% accuracy.

## 2. Setup
- Jev (TypeSafe System One, `jev-1.14.0`): one request containing a verdict Choice plus per-passage relation Choices. Structured probabilities, no generated text.
- The judge (`google/gemma-4-31b-it:free` via OpenRouter): JSON verdict, rationale and verbatim quotes.
- Both see identical evidence. Decision schema `decision.v1`.
- Golden v1: 112 claims over a 10-Q and a shareholder letter. Labels are machine-verified for quotes and arithmetic, pending human review (say so prominently).

## 3. Finding 1: Lexical retrieval misses a quarter of the evidence at k=8 (measured)
- Postgres FTS (`ts_rank_cd`) on 108 claims with labelled evidence: Recall@1 53.7%, @5 71.8%, @8 75.5%, @10 81.0%; MRR 0.628 (report `2026-10-29-be7f92c5`).
- Implication: in end-to-end runs at k=8, roughly one in four claims cannot be decided correctly because of retrieval alone. Errors on those claims must not be blamed on the decision model.
- **[PENDING]** Vector (bge-m3) and hybrid (RRF) recall, and whether either closes the gap on numeric table rows and multi-page claims.

## 4. Finding 2: Decision quality on oracle evidence **[PENDING]**
- Jev vs. judge accuracy with Wilson CIs, macro-F1 and an exact McNemar test.
- False-positive rate on *supported* (the costly error).
- Category slices: `calculation_required`, `period_confusion`, `outside_knowledge_trap`, `prompt_injection`.

## 5. Finding 3: Abstention behavior **[PENDING]**
- Correct-abstention precision and recall on the 18 insufficient-evidence claims; incorrect abstentions on answerable ones.

## 6. Finding 4: How retrieval failures propagate end to end **[PENDING]**
- Failures attributed by the taxonomy to `retrieval_miss` vs. reasoning codes, per strategy.

## 7. Reliability, latency and cost **[PENDING]**
- Jev native-confidence reliability table and ECE; judge malformed-output rate.
- Latency p50/p95 per provider; cost per evaluation (Jev ~$0.042/Mtok input; judge $0 on the free tier).

## 8. Failure gallery **[PENDING]**
- Three to five traces with passages, both outputs and the gold rationale.

## 9. Limitations and next steps
- One issuer, LLM-drafted labels pending human review, class imbalance, no OCR.
- Next: human review pass, then golden v2 with reviewed failures (v1 results stay frozen), a second issuer, and a reranker only if measurements justify it.

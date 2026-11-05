# QA golden set qa.v1: datasheet

This dataset measures **which evaluator grades RAG answers more reliably**: Jev or the LLM judge. Every candidate answer has a known truth (correct or wrong), established without using either evaluator.

| | |
|---|---|
| Questions | 112 (`questions.jsonl`): 95 answerable, 17 not answerable from the document. Ids match golden v1, so evidence anchors (`../v1/resolved.json`) carry over unchanged |
| Documents | Berkshire Hathaway Q3 2025 10-Q and 2025 shareholder letter (pinned in `../v1/documents.json`) |
| Candidate answers | 526 (`items.jsonl`, frozen). **516 are scored**: 270 correct, 246 wrong. 10 are excluded as ambiguous |
| Answer model | `openai/gpt-4.1-nano` (RAG answers only). It is a different model family from the judge (Gemma) and the label drafter (Claude) |

## Candidate answers

| Source | Count | Truth from |
|---|---|---|
| `reference`: the reference answer | 112 | Correct by construction |
| `rag_oracle`: RAG answer on labelled evidence (gold passages + fixed distractors) | 112 | Answer checker, plus review |
| `rag_hybrid`: RAG answer on hybrid search, top 8 | 112 | Answer checker, plus review |
| `perturbation`: controlled mistakes, at most 2 per question | 190 | Wrong by construction |

**Mistake types**

| Type | Count | What it does |
|---|---|---|
| `number_shift` | 69 | Every copy of the key figure moved 15–35% |
| `false_abstention` | 49 | "The document does not say" for an answerable question |
| `unit_swap` | 38 | Every million ↔ billion swapped |
| `direction_flip` | 17 | Rose ↔ fell, above ↔ below |
| `fabricated_answer` | 17 | A confident answer to an unanswerable question |

Period and entity swaps are **not** generated, because they can't be guaranteed wrong.

## How truth is established
1. **References** were drafted by Claude (claude-opus-5-5) from the source PDFs. Their figures and anchors come from golden v1, where every quote and calculation is machine-verified.
2. **Answer checker** (`lib/eval/answer-check.ts`):
   - it extracts numbers, percentages and scaled $ amounts and compares them with each question's key facts within tolerance;
   - it requires the expected wording and rejects forbidden wording;
   - it detects declined answers;
   - when unsure, it returns `needs_review`; it never guesses.
3. **Consistency checks** (`scripts/check-qa-golden.ts`): every reference answer must grade correct, and no constructed mistake may grade correct.
4. **Review** (`review.json`): an annotator audit, done by Claude, read every RAG answer the checker labelled correct and every one it labelled wrong.
   - **23 overrides**, each with a note: 4 false "correct", 3 false "wrong", 6 review items resolved, 10 excluded.
   - **Rounding policy:** percentages within 0.3 points of the exact value but mis-rounded are excluded as ambiguous; beyond that they are wrong.
5. **No Jev or judge output is ever used for truth.**

**Truth sources:** construction 302 · reference checker 201 · review 23.

## Known limitations
- One issuer and two documents.
- The constructed mistakes are easier to catch than natural RAG errors. Results are therefore reported separately by source and by mistake type.
- References and the review were done by an LLM (Claude). Human review is pending.
- Truth means "correct according to the **document**". A RAG answer that says "not stated" because search missed the evidence counts as wrong, even if the passages the evaluators saw don't contain the answer. Evaluators only see the passages, so some of their "errors" on `rag_hybrid` items are caused by retrieval. Compare the `rag_oracle` and `rag_hybrid` rows to see this.

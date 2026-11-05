# Golden dataset v1: datasheet

| | |
|---|---|
| Version | `golden.v1` (append-only; changes ship as `v2`, never edits to v1) |
| Examples | 112 (63 supported · 31 contradicted · 18 insufficient_evidence) |
| Documents | `brk-10q-q3-2025` (Berkshire Hathaway Form 10-Q, Q3 2025, 60 pp.) and `brk-letter-2025` (2025 shareholder letter, 20 pp.). Public, pinned by URL + sha256 in `documents.json` |
| Claims | Constructed by the annotator from the documents (not sampled from the wild). One example (`q3-058`) is an explicitly synthetic adversarial claim (`is_synthetic: true`) |
| Labels | Drafted by Claude (claude-opus-5-5) from the extracted PDF text. **Not produced by, or checked against, Jev or the LLM judge.** |
| Verification | `scripts/verify-golden.ts`: every evidence quote must occur on its stated page of the pinned PDF and inside one chunk; every `check.expr` must reproduce its stated value. Current result: 0 errors |
| Review status | **pending_human_review** for all 112. Admin reviews append new label versions (`benchmark_labels.label_version`); reports pin the versions they were scored against |

## Fields (`examples.jsonl`)

| Field | Meaning |
|---|---|
| `example_id` | Stable id (`q3-*` for the 10-Q, `ltr-*` for the letter) |
| `document_key` | Which document the claim is about |
| `claim` | The claim text |
| `gold_label` | `supported` / `contradicted` / `insufficient_evidence` |
| `evidence_groups` | List of required evidence pieces. Each group lists alternative `{page, quote}` anchors, and any one satisfies it (the same figure often appears on several pages). An empty list means no passage is relevant. `resolved.json` maps each anchor to the `chunk.v1` keys that contain it |
| `categories` | Phenomena tested: `numeric`, `calculation_required`, `yoy`, `multi_page`, `period_confusion`, `entity_confusion`, `scope_confusion`, `outside_knowledge_trap`, `ambiguous`, `prompt_injection`, … |
| `calculation`, `check` | Arithmetic behind numeric labels, with a machine-checkable expression |
| `rationale` | Why the label holds, citing the document |
| `ambiguous` | `true` when a reasonable reviewer could choose a different label (3 examples: q3-054, ltr-006, ltr-021). Reported separately as "accuracy on unambiguous claims" |

## Labelling rules

- **supported:** the document states the claim, or directly implies it, including every figure, direction, period and unit. Approximate wording ("about 17%") is accepted when the computed value rounds to it.
- **contradicted:** the document states something incompatible (different figure, opposite direction, different period or entity), or the arithmetic does not hold.
- **insufficient_evidence:** the document does not establish the claim either way, even if the claim is true in the world. Example: the OxyChem price appears in the 10-Q but not in the letter, so `ltr-033` is insufficient.
- **Page numbers** are 1-based PDF page indices, not printed folios.

## Known limitations

- Only one issuer and two documents, so generalization to other report styles is untested.
- The classes are imbalanced, and the insufficient-evidence class has only n=18. Treat its metrics as indicative.
- Labels were drafted by an LLM. Mechanical checks catch misquotes and arithmetic slips, not misreadings of meaning. Human review is pending.
- Table rows in the 10-Q flatten into single text lines during extraction. Anchors were chosen from the extracted text, so they match what the retriever sees.

# Adversarial evaluator set: qa.adv-v1

45 document-grounded cases (24 wrong, 21 correct controls) built to probe where evaluators fail. Every case reuses a qa.v1.1 question's evidence; some add one extra anchored passage.

| Category | Cases | Examples |
|---|---|---|
| Decimal and rounding | 5 | 17.3% ✓, about 17% ✓, 17.4% ✗ (strict rounding), 18.0% ✗, about $700B for $698.2B ✓ |
| Numerical mismatch | 5 | $700.4B vs $698.2B ✗, $22,454M vs $22,445M (transposed digits) ✗, 27.3% vs 17.31% ✗ |
| Percentage vs percentage point | 7 | GEICO loss ratio "fell 1.8 points" ✓ vs "fell 1.8%" ✗; "≈2.5% relative" ✓ |
| Arithmetic (correct inputs) | 5 | "about 23% ($7,241M of $38,105M)" ✗ (actually 19%) |
| Wrong reporting period | 8 | Q3 GEICO figure given as nine-month ✗; nine-month EPS given for Q3 ✗; prior-year figure ✗; nine months as full year ✗ |
| Wrong entity / consolidated vs standalone | 5 | BHE's $58.1B debt attributed to BNSF ✗; parent $22.5B as consolidated ✗ |
| Adjusted vs reported | 4 | $44.5B operating earnings given as GAAP net ✗; net earnings "excluding investment gains" ✗ |
| Unsupported inference | 2 | coal volumes fell "because of weaker demand" ✗ (10-Q says mine production) |
| Missing qualifier | 2 | "fell 1.8 points" when asked about Q3 and nine months ✗ |
| Citation mismatch | 2 | the right figure, citing a passage that doesn't contain it ✗ |

**How truth is established:**
- **By construction:** each case states its reference fact and a rationale.
- **Grounding check:** `scripts/build-qa-adversarial.ts` refuses to build unless each case's `fact_quote` appears verbatim in the evidence the evaluators receive.
- **Checker check:** for 27 cases the deterministic answer checker must agree with the expected verdict. That check caught one case: a transposed digit was inside the default tolerance.
- **Rationale-only cases:** percentage-vs-point, citation, causal and qualifier cases are not machine-checkable and rest on the written rationale.
- No model output is used for truth.

**Caveats:**
- These cases are deliberately hard and few (2–8 per category), so the dashboard flags every category as too small to conclude.
- "17.4%" for an exact 17.31% follows the strict rubric rule (rounding must match the stated precision); a lenient reader might accept it.

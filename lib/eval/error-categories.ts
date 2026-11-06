// Error taxonomy for evaluator capability analysis.
//
// Wrong answers carry exactly ONE error category:
//   - constructed mistakes: mapped deterministically from their mistake type
//   - real RAG mistakes: from an annotation file (note + annotator), else `unclassified`
// Correct answers carry *probe* categories: what their question could trip an
// evaluator on, mapped from golden v1 question tags. Correct answers give each
// category a false-positive rate. Nothing here is derived from Jev or judge output.

export const ERROR_CATEGORIES = {
  numerical_mismatch: "Numerical mismatch",
  decimal_rounding: "Decimal and rounding errors",
  unit_scale: "Unit and scale mismatch",
  pct_vs_pp: "Percentage vs percentage-point",
  arithmetic: "Arithmetic and calculation errors",
  wrong_period: "Wrong reporting period",
  wrong_entity: "Wrong entity, subsidiary or line item",
  wrong_baseline: "Wrong comparison baseline",
  adjusted_vs_reported: "Adjusted vs reported figures",
  directional: "Directional errors",
  semantic_distortion: "Correct figures, wrong conclusion",
  missing_qualifier: "Missing qualifier or context",
  unsupported_inference: "Unsupported inference",
  fabricated: "Fabricated information",
  insufficient_evidence: "Answered without evidence",
  false_not_stated: "Says 'not stated' when it is",
  citation_mismatch: "Citation or evidence mismatch",
  unclassified: "Unclassified",
} as const;
export type ErrorCategory = keyof typeof ERROR_CATEGORIES;
export const isErrorCategory = (c: string): c is ErrorCategory => c in ERROR_CATEGORIES;

/** Constructed mistake type → category (deterministic, by construction). */
export const PERTURBATION_CATEGORY: Record<string, ErrorCategory> = {
  number_shift: "numerical_mismatch",
  unit_swap: "unit_scale",
  direction_flip: "directional",
  fabricated_answer: "insufficient_evidence",
  false_abstention: "false_not_stated",
};

/** Golden v1 question tag → the category a correct answer to it probes. */
export const TAG_PROBES: Record<string, ErrorCategory> = {
  period_confusion: "wrong_period",
  temporal: "wrong_period",
  out_of_period: "wrong_period",
  entity_confusion: "wrong_entity",
  scope_confusion: "wrong_entity",
  metric_confusion: "wrong_entity",
  cross_document_confusion: "wrong_entity",
  calculation_required: "arithmetic",
  direction: "directional",
  sign: "directional",
  units: "unit_scale",
  rounding: "decimal_rounding",
  approximate: "decimal_rounding",
  incorrect_number: "numerical_mismatch",
  digit_transposition: "numerical_mismatch",
  insufficient: "insufficient_evidence",
  unsupported_inference: "unsupported_inference",
  causal: "unsupported_inference",
  misleading: "semantic_distortion",
  partial_truth: "semantic_distortion",
  fabricated_detail: "fabricated",
};

export type Annotation = { category: string; note: string; annotator: string; disputed?: boolean };

export type CategorizedItem = {
  item_id: string;
  truth: "correct" | "incorrect";
  /** Wrong answers: exactly one. Correct answers: zero or more probes. */
  categories: ErrorCategory[];
  provenance: "construction" | "annotation" | "probe" | "none";
  disputed: boolean;
};

export function categorize(
  item: { item_id: string; truth: "correct" | "incorrect"; perturbation: string | null; question_tags: string[]; explicit_category?: string | null },
  annotations: Record<string, Annotation>,
): CategorizedItem {
  const ann = annotations[item.item_id];
  const disputed = !!ann?.disputed;
  if (item.explicit_category && isErrorCategory(item.explicit_category)) {
    // Adversarial cases state their category directly (wrong cases and their correct controls).
    return { item_id: item.item_id, truth: item.truth, categories: [item.explicit_category], provenance: "construction", disputed };
  }
  if (item.truth === "incorrect") {
    if (item.perturbation && PERTURBATION_CATEGORY[item.perturbation]) {
      return { item_id: item.item_id, truth: "incorrect", categories: [PERTURBATION_CATEGORY[item.perturbation]], provenance: "construction", disputed };
    }
    if (ann && isErrorCategory(ann.category)) {
      return { item_id: item.item_id, truth: "incorrect", categories: [ann.category], provenance: "annotation", disputed };
    }
    return { item_id: item.item_id, truth: "incorrect", categories: ["unclassified"], provenance: "none", disputed };
  }
  const probes = [...new Set(item.question_tags.map((t) => TAG_PROBES[t]).filter(Boolean))] as ErrorCategory[];
  return { item_id: item.item_id, truth: "correct", categories: probes, provenance: probes.length ? "probe" : "none", disputed };
}

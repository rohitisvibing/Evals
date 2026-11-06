import { describe, expect, it } from "vitest";
import { categorize, PERTURBATION_CATEGORY, TAG_PROBES, ERROR_CATEGORIES } from "@/lib/eval/error-categories";

describe("error categories", () => {
  it("maps constructed mistakes deterministically", () => {
    expect(categorize({ item_id: "a", truth: "incorrect", perturbation: "number_shift", question_tags: [] }, {}).categories).toEqual(["numerical_mismatch"]);
    expect(categorize({ item_id: "a", truth: "incorrect", perturbation: "unit_swap", question_tags: [] }, {}).categories).toEqual(["unit_scale"]);
    expect(categorize({ item_id: "a", truth: "incorrect", perturbation: "false_abstention", question_tags: [] }, {}).provenance).toBe("construction");
    for (const c of Object.values(PERTURBATION_CATEGORY)) expect(c in ERROR_CATEGORIES).toBe(true);
    for (const c of Object.values(TAG_PROBES)) expect(c in ERROR_CATEGORIES).toBe(true);
  });

  it("uses annotations for real RAG mistakes and falls back to unclassified", () => {
    const ann = { x: { category: "wrong_period", note: "Q3 figure for nine months", annotator: "t" } };
    expect(categorize({ item_id: "x", truth: "incorrect", perturbation: null, question_tags: [] }, ann)).toMatchObject({ categories: ["wrong_period"], provenance: "annotation" });
    expect(categorize({ item_id: "y", truth: "incorrect", perturbation: null, question_tags: [] }, ann)).toMatchObject({ categories: ["unclassified"], provenance: "none" });
    expect(categorize({ item_id: "z", truth: "incorrect", perturbation: null, question_tags: [] }, { z: { category: "not-a-category", note: "", annotator: "t" } }).categories).toEqual(["unclassified"]);
  });

  it("gives exactly one category to wrong answers and probe categories to correct ones", () => {
    const c = categorize({ item_id: "c", truth: "correct", perturbation: null, question_tags: ["period_confusion", "temporal", "calculation_required", "supported"] }, {});
    expect(c.categories).toEqual(["wrong_period", "arithmetic"]);
    expect(c.provenance).toBe("probe");
    expect(categorize({ item_id: "c", truth: "correct", perturbation: null, question_tags: ["supported"] }, {}).categories).toEqual([]);
  });

  it("explicit adversarial categories win and disputed items are flagged", () => {
    expect(categorize({ item_id: "adv", truth: "correct", perturbation: null, question_tags: ["direction"], explicit_category: "pct_vs_pp" }, {}).categories).toEqual(["pct_vs_pp"]);
    expect(categorize({ item_id: "d", truth: "incorrect", perturbation: null, question_tags: [] }, { d: { category: "unclassified", note: "", annotator: "t", disputed: true } }).disputed).toBe(true);
  });
});

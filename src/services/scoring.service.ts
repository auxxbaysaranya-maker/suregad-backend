export interface ChecklistItem {
  key: string;
  label: string;
  group?: string;
  critical?: boolean;
  weight: number;
}

export interface CheckInput {
  key: string;
  result: "passed" | "failed" | "not_tested" | "not_applicable" | "unable_to_verify";
  comment?: string;
  evidenceIds?: string[];
}

export interface ScoreReport {
  score: number | null;
  componentScores: Record<string, number | null>;
  criticalFailures: string[];
  verdict: "incomplete" | "critical_failure" | "passed_with_notes" | "passed";
  results: Array<CheckInput & { label: string; critical: boolean; weight: number }>;
}

export function scoreInspection(checklist: ChecklistItem[], submitted: CheckInput[]): ScoreReport {
  const byKey = new Map(submitted.map((item) => [item.key, item]));
  const results = checklist.map((item) => {
    const found = byKey.get(item.key);
    return {
      key: item.key,
      label: item.label,
      result: found?.result || "not_tested",
      comment: found?.comment,
      evidenceIds: found?.evidenceIds || [],
      critical: Boolean(item.critical),
      weight: item.weight,
    };
  });
  const missing = results.filter((item) => item.result === "not_tested");
  const criticalFailures = results
    .filter((item) => item.critical && item.result === "failed")
    .map((item) => item.label);
  const groups = new Map<string, { weight: number; earned: number; scored: boolean }>();
  let weight = 0;
  let earned = 0;
  for (const item of results) {
    if (item.result === "not_applicable") continue;
    if (item.result !== "passed" && item.result !== "failed") continue;
    const group = checklist.find((entry) => entry.key === item.key)?.group || "general";
    const bucket = groups.get(group) || { weight: 0, earned: 0, scored: true };
    bucket.weight += item.weight;
    if (item.result === "passed") bucket.earned += item.weight;
    groups.set(group, bucket);
    weight += item.weight;
    if (item.result === "passed") earned += item.weight;
  }
  const score = weight === 0 ? null : Math.round((earned / weight) * 100);
  const componentScores: Record<string, number | null> = {};
  for (const [group, bucket] of groups) {
    componentScores[group] = bucket.weight ? Math.round((bucket.earned / bucket.weight) * 100) : null;
  }
  let verdict: ScoreReport["verdict"] = "passed";
  if (missing.length) verdict = "incomplete";
  else if (criticalFailures.length) verdict = "critical_failure";
  else if (results.some((item) => item.result === "failed" || item.result === "unable_to_verify")) {
    verdict = "passed_with_notes";
  }
  return { score, componentScores, criticalFailures, verdict, results };
}

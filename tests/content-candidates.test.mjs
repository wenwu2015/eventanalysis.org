import test from "node:test";
import assert from "node:assert/strict";
import { createCandidate, partitionCandidates } from "../pipeline/lib/content-candidates.mjs";

test("candidate identity routes the same event, type and angle to update", () => {
  const first = createCandidate({ type: "match_analysis", angle: "width", eventRefs: ["event_1"], entityRefs: ["team_b", "team_a"] });
  const repeated = createCandidate({ type: "match_analysis", angle: "width", eventRefs: ["event_1"], entityRefs: ["team_a", "team_b"] });
  const different = createCandidate({ type: "match_analysis", angle: "substitutions", eventRefs: ["event_1"], entityRefs: ["team_a", "team_b"] });
  const result = partitionCandidates([repeated, different], [{ primaryIntentKey: first.primaryIntentKey, angleKey: first.angleKey }]);
  assert.deepEqual(result.update.map(({ angleKey }) => angleKey), ["width"]);
  assert.deepEqual(result.create.map(({ angleKey }) => angleKey), ["substitutions"]);
});

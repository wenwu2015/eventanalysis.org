import test from "node:test";
import assert from "node:assert/strict";
import { lexicalSimilarity, longestConsecutiveTokenOverlap, languageLooksValid } from "../pipeline/lib/quality.mjs";

test("exact and copied passages are measurable without treating names as full duplicates", () => {
  const body = "Spain kept the pitch wide and created the winning goal through a late run between the centre backs";
  assert.equal(lexicalSimilarity(body, body), 1);
  assert.ok(longestConsecutiveTokenOverlap(body, `Report: ${body}. End.`) >= 12);
  assert.ok(lexicalSimilarity("Spain 2 England 1", "Spain and England met in Berlin") < 0.72);
});

test("script checks catch obvious cross-language placeholders", () => {
  assert.equal(languageLooksValid("zh", "西班牙在下半场保持了场地宽度。"), true);
  assert.equal(languageLooksValid("zh", "This is an English placeholder with no translation."), false);
  assert.equal(languageLooksValid("ar", "حافظت إسبانيا على عرض الملعب في الشوط الثاني"), true);
});

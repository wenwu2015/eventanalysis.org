import test from "node:test";
import assert from "node:assert/strict";
import { chooseLocale } from "../site/static-worker.js";

test("browser language selection respects quality and regional variants", () => {
  assert.equal(chooseLocale("zh-TW,zh;q=0.8,en;q=0.5"), "zh-hant");
  assert.equal(chooseLocale("zh-Hans-CN"), "zh");
  assert.equal(chooseLocale("ja-JP,ja;q=0.9,en;q=0.7"), "ja");
  assert.equal(chooseLocale("pt-BR,es;q=0.8"), "pt");
  assert.equal(chooseLocale("xx-YY,ja;q=0.4,en;q=0.8"), "en");
});

test("unsupported, empty and excluded languages fall back to English", () => {
  assert.equal(chooseLocale("xx-YY"), "en");
  assert.equal(chooseLocale(""), "en");
  assert.equal(chooseLocale("ja;q=0,*;q=1"), "en");
});

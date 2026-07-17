import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  defaultLegalFocus,
  fetchOfficialSources,
  manualLegalTaskKey,
  manualLegalTaskNextLabel,
  manualLegalTaskNextStatus,
  manualLegalTaskStatusLabel,
  refreshPackOfficialSourcesIfNeeded,
  updateManualLegalTaskRegistry,
} from "../pipeline/review-admin.mjs";

test("refresh pack official sources fills missing checkedAt and contentHash from https urls", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://example.gov/doc");
    return new Response("official-source-body", { status: 200 });
  };
  const registry = {
    packs: [{
      jurisdiction: "AR",
      status: "draft",
      reviewedAt: "",
      expiresAt: "",
      counsel: { name: "", barJurisdiction: "", signatureHash: "" },
      officialSources: [{ url: "https://example.gov/doc", checkedAt: "", contentHash: "" }],
      notes: [],
    }],
  };
  const result = await refreshPackOfficialSourcesIfNeeded(registry, "AR");
  assert.equal(result.refreshed, true);
  const pack = result.registry.packs.find((entry) => entry.jurisdiction === "AR");
  assert.equal(pack.officialSources.length, 1);
  assert.ok(pack.officialSources[0].checkedAt);
  assert.equal(
    pack.officialSources[0].contentHash,
    createHash("sha256").update("official-source-body").digest("hex"),
  );
});

test("refresh pack official sources skips fetch when hashes already exist", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("unused", { status: 200 });
  };
  const registry = {
    packs: [{
      jurisdiction: "AR",
      status: "active",
      reviewedAt: "2026-07-16T00:00:00Z",
      expiresAt: "2026-08-16T00:00:00Z",
      counsel: { name: "Counsel", barJurisdiction: "AR", signatureHash: "a".repeat(64) },
      officialSources: [{
        url: "https://example.gov/doc",
        checkedAt: "2026-07-16T00:00:00Z",
        contentHash: "b".repeat(64),
      }],
      notes: [],
    }],
  };
  const result = await refreshPackOfficialSourcesIfNeeded(registry, "AR");
  assert.equal(result.refreshed, false);
  assert.equal(fetchCalls, 0);
});

test("fetch official sources rejects non-https urls", async () => {
  await assert.rejects(
    fetchOfficialSources(["http://example.com/doc"]),
    /官方来源必须使用 https/,
  );
});

test("manual legal task registry keeps the same task path while advancing status", () => {
  const now = new Date("2026-07-17T00:40:54Z");
  const contentId = "match_analysis_event_1fa9a50fd27ce823bb3f_zh";
  const jurisdiction = "FR";
  const path = "/tmp/2026-07-17-match_analysis_event_1fa9a50fd27ce823bb3f_zh-FR.md";
  const generated = updateManualLegalTaskRegistry({}, {
    contentId,
    jurisdiction,
    status: "generated",
    path,
  }, now);
  const sent = updateManualLegalTaskRegistry(generated, {
    contentId,
    jurisdiction,
    status: "sent",
  }, new Date("2026-07-17T00:56:54Z"));
  const key = manualLegalTaskKey(contentId, jurisdiction);
  assert.equal(sent.tasks[key].path, path);
  assert.equal(sent.tasks[key].status, "sent");
});

test("manual legal task status labels and next actions follow the intended sequence", () => {
  assert.equal(manualLegalTaskStatusLabel("generated"), "已生成");
  assert.equal(manualLegalTaskStatusLabel("sent"), "已发出");
  assert.equal(manualLegalTaskStatusLabel("received"), "已回传");
  assert.equal(manualLegalTaskStatusLabel("applied"), "已应用到 legal pack");
  assert.equal(manualLegalTaskNextStatus("generated"), "sent");
  assert.equal(manualLegalTaskNextStatus("sent"), "received");
  assert.equal(manualLegalTaskNextStatus("received"), "");
  assert.equal(manualLegalTaskNextLabel("generated"), "标记已发出");
  assert.equal(manualLegalTaskNextLabel("sent"), "标记已回传");
  assert.equal(manualLegalTaskNextLabel("received"), "");
});

test("default legal focus prefers the current blocked item and first blocked jurisdiction", () => {
  const state = {
    registry: {
      operatorJurisdictions: ["AR"],
    },
    items: [
      {
        id: "match-ready",
        workflow: { status: "editorial_approved" },
        legal: { blockedJurisdictions: ["FR"] },
      },
      {
        id: "match-blocked",
        workflow: { status: "release_blocked" },
        legal: { blockedJurisdictions: ["ES", "AR"] },
      },
    ],
  };
  assert.deepEqual(defaultLegalFocus(state), {
    currentId: "match-blocked",
    packCode: "AR",
  });
});

test("default legal focus falls back to operator jurisdiction when the focused item has no blocked code", () => {
  const state = {
    registry: {
      operatorJurisdictions: ["AR"],
    },
    items: [
      {
        id: "match-approved",
        workflow: { status: "editorial_approved" },
        legal: { blockedJurisdictions: [] },
      },
    ],
  };
  assert.deepEqual(defaultLegalFocus(state), {
    currentId: "match-approved",
    packCode: "AR",
  });
});

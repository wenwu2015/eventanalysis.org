#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const manifestPath = resolve(root, "pipeline/runtime/compliance/edge-manifest.json");
const runtimePath = resolve(root, "pipeline/runtime/compliance/edge-store.json");
const name = process.env.EVENTANALYSIS_CLOUDFRONT_KVS_NAME || "eventanalysis-publication-policy";
const region = "us-east-1";

function aws(service, command, args = []) {
  const output = execFileSync("aws", [service, command, ...args, "--region", region, "--output", "json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return output.trim() ? JSON.parse(output) : {};
}

async function waitForReady(kvsName) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = aws("cloudfront", "describe-key-value-store", ["--name", kvsName]);
    if (result.KeyValueStore?.Status === "READY") return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`CloudFront KeyValueStore ${kvsName} did not become READY`);
}

async function ensureStore() {
  const stores = aws("cloudfront", "list-key-value-stores").KeyValueStoreList?.Items || [];
  let store = stores.find((candidate) => candidate.Name === name);
  if (!store) {
    const created = aws("cloudfront", "create-key-value-store", ["--name", name, "--comment", "EventAnalysis publication policy and route leases"]);
    store = created.KeyValueStore;
  }
  const described = store.Status === "READY" ? aws("cloudfront", "describe-key-value-store", ["--name", name]) : await waitForReady(name);
  const arn = described.KeyValueStore.ARN;
  const dataPlane = aws("cloudfront-keyvaluestore", "describe-key-value-store", ["--kvs-arn", arn]);
  return { arn, etag: dataPlane.ETag };
}

function updateKeys(arn, etag, { puts = [], deletes = [] }) {
  if (!puts.length && !deletes.length) return etag;
  const args = ["--kvs-arn", arn, "--if-match", etag];
  if (puts.length) args.push("--puts", JSON.stringify(puts));
  if (deletes.length) args.push("--deletes", JSON.stringify(deletes.map((Key) => ({ Key }))));
  return aws("cloudfront-keyvaluestore", "update-keys", args).ETag;
}

function batches(values, size = 50) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const store = await ensureStore();
let etag = store.etag;

// Freeze before any multi-request mutation. If the process stops midway, the
// edge remains closed rather than serving a partially updated route table.
etag = updateKeys(store.arn, etag, { puts: [{ Key: "publication_mode", Value: "frozen" }] });
const current = aws("cloudfront-keyvaluestore", "list-keys", ["--kvs-arn", store.arn]).Items || [];
const desiredRoutes = new Map((manifest.routes || []).map((route) => [
  `route:${route.path}`,
  `live|${route.countryMask}|${Math.floor(Date.parse(route.expiresAt) / 1000)}|`,
]));
const staleRouteKeys = current.filter(({ Key, Value }) => Key.startsWith("route:") && String(Value).startsWith("live|") && !desiredRoutes.has(Key)).map(({ Key }) => Key);

for (const batch of batches([...desiredRoutes].map(([Key, Value]) => ({ Key, Value })))) etag = updateKeys(store.arn, etag, { puts: batch });
for (const batch of batches(staleRouteKeys)) etag = updateKeys(store.arn, etag, { deletes: batch });

const globals = [
  { Key: "content_valid_until", Value: String(Math.floor(Date.parse(manifest.contentValidUntil) / 1000)) },
  { Key: "country_index", Value: JSON.stringify(manifest.countryIndex) },
  { Key: "policy_hash", Value: manifest.policyHash },
  { Key: "generated_at", Value: manifest.generatedAt },
];
etag = updateKeys(store.arn, etag, { puts: globals });
if (manifest.publicationMode === "normal") etag = updateKeys(store.arn, etag, { puts: [{ Key: "publication_mode", Value: "normal" }] });

await mkdir(resolve(runtimePath, ".."), { recursive: true });
await writeFile(runtimePath, `${JSON.stringify({ name, arn: store.arn, etag, publicationMode: manifest.publicationMode, routeCount: desiredRoutes.size }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: "edge_policy_synced", name, arn: store.arn, publicationMode: manifest.publicationMode, routes: desiredRoutes.size }, null, 2));

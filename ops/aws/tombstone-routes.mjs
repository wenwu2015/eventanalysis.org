#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const manifestFlag = process.argv.find((value) => value.startsWith("--manifest="));
if (!manifestFlag) throw new Error("Usage: node ops/aws/tombstone-routes.mjs --manifest=<runtime-json>");
const manifest = JSON.parse(await readFile(resolve(root, manifestFlag.slice(11)), "utf8"));
const name = process.env.EVENTANALYSIS_CLOUDFRONT_KVS_NAME || "eventanalysis-publication-policy";
const bucket = "eventanalysis.org";

function aws(service, command, args = []) {
  const value = execFileSync("aws", [service, command, ...args, "--region", "us-east-1", "--output", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return value.trim() ? JSON.parse(value) : {};
}

const stores = aws("cloudfront", "list-key-value-stores").KeyValueStoreList?.Items || [];
const store = stores.find((candidate) => candidate.Name === name && candidate.Status === "READY");
if (!store) throw new Error(`CloudFront KeyValueStore ${name} is missing or not READY`);
let etag = aws("cloudfront-keyvaluestore", "describe-key-value-store", ["--kvs-arn", store.ARN]).ETag;
const puts = manifest.routes.map((path) => ({ Key: `route:${path}`, Value: `gone|0|4102444800|${manifest.incidentId}` }));
for (let index = 0; index < puts.length; index += 50) {
  const result = aws("cloudfront-keyvaluestore", "update-keys", ["--kvs-arn", store.ARN, "--if-match", etag, "--puts", JSON.stringify(puts.slice(index, index + 50))]);
  etag = result.ETag;
}
for (const path of manifest.routes) {
  const key = `${decodeURIComponent(path).replace(/^\//, "")}index.html`;
  execFileSync("aws", ["s3api", "delete-object", "--bucket", bucket, "--key", key], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}
console.log(JSON.stringify({ status: "edge_tombstones_written", incidentId: manifest.incidentId, routes: manifest.routes.length }, null, 2));

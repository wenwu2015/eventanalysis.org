#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const functionName = process.env.EVENTANALYSIS_CLOUDFRONT_FUNCTION_NAME || "eventanalysis-request-router";
const etag = process.argv.find((value) => value.startsWith("--etag="))?.slice(7);
if (!etag) throw new Error("Usage: node ops/aws/test-edge-function.mjs --etag=<development-etag>");
const directory = resolve(root, "pipeline/runtime/cloudfront-test");
await mkdir(directory, { recursive: true });

function event(uri, host = "www.eventanalysis.org", querystring = {}) {
  return {
    version: "1.0",
    context: { eventType: "viewer-request" },
    viewer: { ip: "198.51.100.10" },
    request: { method: "GET", uri, querystring, headers: { host: { value: host } }, cookies: {} },
  };
}

const manifest = JSON.parse(await readFile(resolve(root, "pipeline/runtime/compliance/edge-manifest.json"), "utf8"));
const articleRoute = manifest.routes?.[0]?.path;
if (!articleRoute) throw new Error("Edge manifest has no article route to test");
const checks = [
  {
    name: "canonical-host",
    uri: "/en/football/",
    host: "eventanalysis.org",
    querystring: { ref: { value: "homepage" }, tag: { value: "one", multiValue: [{ value: "one" }, { value: "two" }] } },
    expected: { statusCode: 301, location: "https://www.eventanalysis.org/en/football/?ref=homepage&tag=one&tag=two" },
  },
  { name: "home", uri: "/en/football/", expected: "request" },
  { name: "zh-all-content", uri: "/zh/football/%E5%85%A8%E9%83%A8%E5%86%85%E5%AE%B9/", expected: "request" },
  { name: "zh-search", uri: "/zh/football/%E6%90%9C%E7%B4%A2/", expected: "request" },
  { name: "article", uri: articleRoute, expected: "request" },
  { name: "retired-route", uri: "/en/articles/spain-england-euro-2024-final/", expected: [410, 451] },
];
for (const check of checks) {
  const path = resolve(directory, `${check.name}.json`);
  await writeFile(path, JSON.stringify(event(check.uri, check.host, check.querystring)));
  const result = JSON.parse(execFileSync("aws", ["cloudfront", "test-function", "--name", functionName, "--if-match", etag, "--stage", "DEVELOPMENT", "--event-object", `fileb://${path}`, "--output", "json"], { cwd: root, encoding: "utf8" }));
  if (result.TestResult.FunctionErrorMessage) throw new Error(`${check.name} edge test failed: ${result.TestResult.FunctionErrorMessage}`);
  const output = JSON.parse(result.TestResult.FunctionOutput);
  if (check.expected === "request" && output.request?.uri !== check.uri) throw new Error(`${check.name} edge test did not return the request`);
  if (typeof check.expected === "number" && output.response?.statusCode !== check.expected) throw new Error(`${check.name} edge test expected ${check.expected}, received ${output.response?.statusCode}`);
  if (Array.isArray(check.expected) && !check.expected.includes(output.response?.statusCode)) throw new Error(`${check.name} edge test expected one of ${check.expected.join(", ")}, received ${output.response?.statusCode}`);
  if (check.expected && !Array.isArray(check.expected) && typeof check.expected === "object") {
    if (output.response?.statusCode !== check.expected.statusCode) throw new Error(`${check.name} edge test expected ${check.expected.statusCode}, received ${output.response?.statusCode}`);
    if (output.response?.headers?.location?.value !== check.expected.location) throw new Error(`${check.name} edge test expected ${check.expected.location}, received ${output.response?.headers?.location?.value}`);
  }
}
console.log(JSON.stringify({ status: "edge_function_tests_passed", checks: checks.length }, null, 2));

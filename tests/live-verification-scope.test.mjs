import test from "node:test";
import assert from "node:assert/strict";
import { isDiscoveredPathInScope, releaseScopePrefixes } from "../ops/aws/live-verification-scope.mjs";

test("live verification follows only the currently released locale scope", () => {
  const manifest = {
    publicRoutes: [
      "/zh/football/",
      "/zh/football/%E5%85%A8%E9%83%A8%E5%86%85%E5%AE%B9/",
    ],
    routes: [
      { path: "/zh/football/%E7%B2%BE%E5%BD%A9%E8%A7%A3%E8%AF%BB/sk-brann-kvinner-paok-3-2-moment-analysis/" },
    ],
  };
  const expectedPaths = new Set([
    "/",
    "/404.html",
    "/assets/site.css",
    ...manifest.publicRoutes,
    ...manifest.routes.map(({ path }) => path),
  ]);

  assert.deepEqual(releaseScopePrefixes(manifest), ["/zh/football/"]);
  assert.equal(isDiscoveredPathInScope("/zh/football/%E6%90%9C%E7%B4%A2/", expectedPaths, manifest), true);
  assert.equal(isDiscoveredPathInScope("/en/football/search/", expectedPaths, manifest), false);
  assert.equal(isDiscoveredPathInScope("/ja/football/%E6%A4%9C%E7%B4%A2/", expectedPaths, manifest), false);
  assert.equal(isDiscoveredPathInScope("/assets/site.css", expectedPaths, manifest), true);
});

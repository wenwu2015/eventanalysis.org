export function releaseScopePrefixes(manifest) {
  const paths = [
    ...(manifest?.publicRoutes || []),
    ...((manifest?.routes || []).map(({ path }) => path)),
  ].filter(Boolean);
  return [...new Set(paths
    .map((path) => String(path).match(/^\/[^/]+\/[^/]+\//)?.[0] || null)
    .filter(Boolean))]
    .sort();
}

export function isDiscoveredPathInScope(pathname, expectedPaths, manifest) {
  if (!pathname) return false;
  if (expectedPaths?.has(pathname)) return true;
  return releaseScopePrefixes(manifest).some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

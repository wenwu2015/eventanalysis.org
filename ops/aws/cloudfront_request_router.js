import cf from "cloudfront";

// Viewer-request guard. Published article routes are globally readable while
// missing, frozen and withdrawn routes remain fail-closed.
const kvs = cf.kvs();

var SUPPORTED = {
  zh: true, "zh-hant": true, en: true, ja: true, ko: true, ru: true, es: true, pt: true, fr: true,
  de: true, it: true, ar: true, sv: true, nl: true, tr: true, pl: true,
  hr: true, sr: true, uk: true, fa: true, id: true
};

function redirect(location, permanent) {
  return {
    statusCode: permanent ? 301 : 302,
    statusDescription: permanent ? "Moved Permanently" : "Found",
    headers: {
      location: { value: location },
      "cache-control": { value: permanent ? "public, max-age=3600" : "private, no-store" },
      vary: { value: "Accept-Language" }
    }
  };
}

function querySuffix(querystring) {
  if (!querystring) return "";
  if (typeof querystring === "string") return querystring ? "?" + querystring : "";
  var parts = [];
  for (var key in querystring) {
    var entry = querystring[key] || {};
    var values = entry.multiValue && entry.multiValue.length ? entry.multiValue : [entry];
    for (var index = 0; index < values.length; index += 1) {
      parts.push(key + "=" + (values[index].value || ""));
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function blocked(statusCode, incidentId) {
  var gone = statusCode === 410;
  var body = gone ? "This publication has been withdrawn." : "This publication is unavailable.";
  return {
    statusCode: statusCode,
    statusDescription: gone ? "Gone" : "Unavailable For Legal Reasons",
    headers: {
      "cache-control": { value: "private, no-store, max-age=0" },
      "content-type": { value: "text/plain; charset=utf-8" },
      "x-robots-tag": { value: "noindex, nofollow, noarchive" },
      "x-eventanalysis-incident": { value: incidentId || "policy" }
    },
    body: body
  };
}

function chooseLocale(headerValue) {
  var entries = (headerValue || "").toLowerCase().replace(/_/g, "-").split(",");
  var preferences = [];
  for (var index = 0; index < entries.length; index += 1) {
    var parts = entries[index].trim().split(";");
    var quality = 1;
    for (var parameterIndex = 1; parameterIndex < parts.length; parameterIndex += 1) {
      var parameter = parts[parameterIndex].trim();
      if (parameter.slice(0, 2) === "q=") quality = Number(parameter.slice(2));
    }
    if (parts[0] && parts[0] !== "*" && quality > 0) preferences.push({ tag: parts[0], quality: quality, index: index });
  }
  preferences.sort(function (left, right) { return right.quality - left.quality || left.index - right.index; });
  for (var preferenceIndex = 0; preferenceIndex < preferences.length; preferenceIndex += 1) {
    var tag = preferences[preferenceIndex].tag;
    if (tag === "zh-hant" || /^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return "zh-hant";
    if (tag === "zh" || tag.slice(0, 3) === "zh-") return "zh";
    if (SUPPORTED[tag]) return tag;
    var base = tag.split("-")[0];
    if (SUPPORTED[base]) return base;
  }
  return "en";
}

function isAlwaysAvailable(uri) {
  if (uri === "/" || uri === "/404.html" || uri === "/favicon.svg" || uri === "/robots.txt" || uri === "/sitemap.xml") return true;
  if (uri.slice(0, 8) === "/assets/" || uri.slice(0, 10) === "/sitemaps/") return true;
  if (/^\/[a-z-]+\/football\/$/.test(uri)) return true;
  return /^\/[a-z-]+\/football\/(?:legal|privacy|corrections)\/$/.test(uri);
}

async function getValue(key) {
  try { return await kvs.get(key); } catch (error) { return null; }
}

async function handler(event) {
  var request = event.request;
  var host = (request.headers.host || { value: "" }).value.toLowerCase();
  var uri = request.uri || "/";
  var suffix = querySuffix(request.querystring);

  if (host === "eventanalysis.org") return redirect("https://www.eventanalysis.org" + uri + suffix, true);
  if (uri === "/index.html" || uri.slice(-11) === "/index.html") return redirect(uri.replace(/index\.html$/, "") + suffix, true);
  if (uri === "/") {
    var acceptLanguage = (request.headers["accept-language"] || { value: "" }).value;
    return redirect("/" + chooseLocale(acceptLanguage) + "/football/" + suffix, false);
  }
  if (isAlwaysAvailable(uri)) return request;

  var routeValue = await getValue("route:" + uri);
  if (routeValue && routeValue.split("|")[0] === "public") return request;

  var mode = await getValue("publication_mode");
  if (mode !== "normal") return blocked(410, "publication-frozen");

  if (!routeValue) return blocked(451, "route-unregistered");
  var parts = routeValue.split("|");
  if (parts[0] === "gone") return blocked(410, parts[3] || "withdrawn");
  if (parts[0] !== "live") return blocked(451, "route-invalid");

  return request;
}

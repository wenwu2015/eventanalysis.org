// CloudFront Function (viewer-request): canonical host/path handling plus the
// one-time browser-language redirect at the site root. Localized URLs remain
// immutable static files and are never redirected by language.

var SUPPORTED = {
  zh: true, 'zh-hant': true, en: true, ja: true, ko: true, ru: true, es: true, pt: true, fr: true,
  de: true, it: true, ar: true, sv: true, nl: true, tr: true, pl: true,
  hr: true, sr: true, uk: true, fa: true, id: true
};

function redirect(location, permanent) {
  return {
    statusCode: permanent ? 301 : 302,
    statusDescription: permanent ? 'Moved Permanently' : 'Found',
    headers: {
      location: { value: location },
      'cache-control': { value: permanent ? 'public, max-age=3600' : 'private, no-store' },
      vary: { value: 'Accept-Language' }
    }
  };
}

function chooseLocale(headerValue) {
  var entries = (headerValue || '').toLowerCase().replace(/_/g, '-').split(',');
  var preferences = [];

  for (var index = 0; index < entries.length; index += 1) {
    var parts = entries[index].trim().split(';');
    var quality = 1;
    for (var parameterIndex = 1; parameterIndex < parts.length; parameterIndex += 1) {
      var parameter = parts[parameterIndex].trim();
      if (parameter.slice(0, 2) === 'q=') quality = Number(parameter.slice(2));
    }
    if (parts[0] && parts[0] !== '*' && quality > 0) {
      preferences.push({ tag: parts[0], quality: quality, index: index });
    }
  }

  preferences.sort(function (left, right) {
    return right.quality - left.quality || left.index - right.index;
  });

  for (var preferenceIndex = 0; preferenceIndex < preferences.length; preferenceIndex += 1) {
    var tag = preferences[preferenceIndex].tag;
    if (tag === 'zh-hant' || /^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return 'zh-hant';
    if (tag === 'zh' || tag.slice(0, 3) === 'zh-') return 'zh';
    if (SUPPORTED[tag]) return tag;
    var base = tag.split('-')[0];
    if (SUPPORTED[base]) return base;
  }

  return 'en';
}

function handler(event) {
  var request = event.request;
  var host = (request.headers.host || { value: '' }).value.toLowerCase();
  var uri = request.uri || '/';

  if (host === 'www.eventanalysis.org') {
    return redirect('https://eventanalysis.org' + uri, true);
  }

  if (uri === '/index.html' || uri.slice(-11) === '/index.html') {
    return redirect(uri.replace(/index\.html$/, ''), true);
  }

  var retiredMethodPage = uri.match(/^\/([a-z-]+)\/methodology\/?$/);
  if (retiredMethodPage && SUPPORTED[retiredMethodPage[1]]) {
    return redirect('/' + retiredMethodPage[1] + '/', true);
  }

  if (uri === '/') {
    var acceptLanguage = (request.headers['accept-language'] || { value: '' }).value;
    return redirect('/' + chooseLocale(acceptLanguage) + '/', false);
  }

  return request;
}

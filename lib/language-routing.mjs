export const supportedLocales = [
  "zh", "zh-hant", "en", "ja", "ko", "ru", "es", "pt", "fr", "de", "it",
  "ar", "sv", "nl", "tr", "pl", "hr", "sr", "uk", "fa", "id",
];
const supportedLocaleSet = new Set(supportedLocales);

export function chooseLocale(acceptLanguage = "") {
  const preferences = String(acceptLanguage)
    .split(",")
    .map((entry, index) => {
      const [rawTag, ...parameters] = entry.trim().split(";");
      const qualityParameter = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
      const parsedQuality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
      return {
        tag: rawTag.trim().toLowerCase().replaceAll("_", "-"),
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
        index,
      };
    })
    .filter(({ tag, quality }) => tag && tag !== "*" && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { tag } of preferences) {
    if (tag === "zh-hant" || /^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(tag)) return "zh-hant";
    if (tag === "zh" || tag.startsWith("zh-")) return "zh";
    if (supportedLocaleSet.has(tag)) return tag;
    const baseLanguage = tag.split("-")[0];
    if (supportedLocaleSet.has(baseLanguage)) return baseLanguage;
  }

  return "en";
}

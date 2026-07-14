import localeData from "../content/locales.json" with { type: "json" };

export type Locale =
  | "zh"
  | "zh-hant"
  | "en"
  | "ja"
  | "ko"
  | "ru"
  | "es"
  | "pt"
  | "fr"
  | "de"
  | "it"
  | "ar"
  | "sv"
  | "nl"
  | "tr"
  | "pl"
  | "hr"
  | "sr"
  | "uk"
  | "fa"
  | "id";

export type LocaleDefinition = {
  code: Locale;
  htmlLang: string;
  nativeName: string;
  englishName: string;
  dir: "ltr" | "rtl";
};

export const localeDefinitions = localeData as LocaleDefinition[];
export const supportedLocales = localeDefinitions.map((locale) => locale.code);
export const localeByCode = Object.fromEntries(
  localeDefinitions.map((locale) => [locale.code, locale]),
) as Record<Locale, LocaleDefinition>;

export function isLocale(value: string): value is Locale {
  return value in localeByCode;
}

export function localeAlternates(path = "") {
  return Object.fromEntries(
    localeDefinitions.map(({ code, htmlLang }) => [htmlLang, `/${code}${path}`]),
  );
}

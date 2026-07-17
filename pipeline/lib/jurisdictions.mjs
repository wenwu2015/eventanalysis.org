export const TEAM_COUNTRY_CODES = new Map(Object.entries({
  Mexico: "MX", "South Africa": "ZA", "South Korea": "KR", Czechia: "CZ", Canada: "CA",
  "Bosnia & Herzegovina": "BA", USA: "US", "United States": "US", Paraguay: "PY", Qatar: "QA", Switzerland: "CH",
  Brazil: "BR", Morocco: "MA", Haiti: "HT", Scotland: "GB", Australia: "AU", "Türkiye": "TR",
  Germany: "DE", "Curaçao": "CW", Netherlands: "NL", Japan: "JP", "Côte d'Ivoire": "CI", "Ivory Coast": "CI",
  Ecuador: "EC", Sweden: "SE", Tunisia: "TN", Spain: "ES", "Cabo Verde": "CV", "Cape Verde": "CV", Belgium: "BE",
  Egypt: "EG", "Saudi Arabia": "SA", Uruguay: "UY", Iran: "IR", "New Zealand": "NZ", France: "FR",
  Senegal: "SN", Iraq: "IQ", Norway: "NO", Argentina: "AR", Algeria: "DZ", Austria: "AT", Jordan: "JO",
  Portugal: "PT", "DR Congo": "CD", England: "GB", Croatia: "HR", Ghana: "GH", Panama: "PA",
  Uzbekistan: "UZ", Colombia: "CO", Cameroon: "CM", "Costa Rica": "CR", Denmark: "DK", Italy: "IT",
  Nigeria: "NG", Poland: "PL", Ukraine: "UA", Wales: "GB",
}));

export const VENUE_COUNTRY_CODES = new Map(Object.entries({
  "Estadio Azteca": "MX", "Estadio Akron": "MX", "Estadio BBVA": "MX", "BMO Field": "CA", "BC Place": "CA",
  "SoFi Stadium": "US", "Levi's Stadium": "US", "MetLife Stadium": "US", "Gillette Stadium": "US",
  "NRG Stadium": "US", "AT&T Stadium": "US", "Lincoln Financial Field": "US", "Mercedes-Benz Stadium": "US",
  "Lumen Field": "US", "Hard Rock Stadium": "US", "Arrowhead Stadium": "US", "Olympiastadion Berlin": "DE",
}));

export function teamCountryCode(name) {
  return TEAM_COUNTRY_CODES.get(name) || null;
}

export function venueCountryCode(name) {
  return VENUE_COUNTRY_CODES.get(name) || null;
}

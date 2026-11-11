/**
 * Comprehensive world-country geography dictionary for deterministic deal
 * extraction (NO LLM — see extract-deal.ts header).
 *
 * Why this exists: the geo/intl hard-exclude is the top accuracy rule. If a deal names
 * a foreign country that the extractor doesn't recognise, `geographic_scope` comes
 * back empty, no geo constraint engages, and a US/domestic-only lender wrongly
 * surfaces for that FOREIGN deal — exactly the failure the accuracy-first mandate
 * forbids ("no wrong lender, ever"). A small hardcoded list (Canada/Mexico/Brazil/
 * UK/Europe…) left Argentina, Portugal, Japan, Nigeria, Indonesia, Chile, UAE and
 * ~180 others unrecognised. This module closes that gap with the full UN member
 * set plus common aliases and demonyms.
 *
 * Shape: canonical country name → lowercased match patterns. Patterns are matched
 * against a space-padded, comma-stripped haystack (see extract-deal.ts `pad`), so
 * a leading/trailing space in a pattern (e.g. ' uk ') forces a whole-token match
 * and avoids substring false-positives (the classic " us " inside "houston").
 *
 * IMPORTANT: every entry here is a NON-US foreign country. Recognising one means
 * the deal is international → it engages the intl hard-exclude so a lender stated
 * `intl_domestic='Domestic'` (even with blank geography) is contradicted. The
 * United States itself, US states, and US-internal regions live in extract-deal.ts
 * (US_STATES) and must NOT appear here.
 */

// Canonical foreign country → lowercased match patterns (name + aliases + demonyms).
// Single-word, unambiguous patterns are bare; short/ambiguous ones are space-padded
// to force a whole-token match.
export const FOREIGN_COUNTRIES: Record<string, string[]> = {
  // --- North & Central America (non-US) ---
  Canada: ['canada', 'canadian'],
  Mexico: ['mexico', 'méxico', 'mexican'],
  Guatemala: ['guatemala', 'guatemalan'],
  Belize: ['belize', 'belizean'],
  Honduras: ['honduras', 'honduran'],
  'El Salvador': ['el salvador', 'salvadoran'],
  Nicaragua: ['nicaragua', 'nicaraguan'],
  'Costa Rica': ['costa rica', 'costa rican'],
  Panama: ['panama', 'panamá', 'panamanian'],

  // --- Caribbean ---
  Cuba: ['cuba', 'cuban'],
  'Dominican Republic': ['dominican republic', 'dominican'],
  Haiti: ['haiti', 'haitian'],
  Jamaica: ['jamaica', 'jamaican'],
  Bahamas: ['bahamas', 'bahamian'],
  Barbados: ['barbados', 'barbadian'],
  'Trinidad and Tobago': ['trinidad and tobago', 'trinidad', 'tobago', 'trinidadian'],
  'Cayman Islands': ['cayman islands', 'cayman', 'caymanian'],
  Bermuda: ['bermuda', 'bermudian'],

  // --- South America ---
  Brazil: ['brazil', 'brasil', 'brazilian'],
  Argentina: ['argentina', 'argentine', 'argentinian', 'argentinean'],
  Chile: ['chile', 'chilean'],
  Colombia: ['colombia', 'colombian'],
  Peru: ['peru', 'perú', 'peruvian'],
  Venezuela: ['venezuela', 'venezuelan'],
  Ecuador: ['ecuador', 'ecuadorian'],
  Bolivia: ['bolivia', 'bolivian'],
  Paraguay: ['paraguay', 'paraguayan'],
  Uruguay: ['uruguay', 'uruguayan'],
  Guyana: ['guyana', 'guyanese'],
  Suriname: ['suriname', 'surinamese'],

  // --- Western Europe ---
  'United Kingdom': ['united kingdom', ' uk ', 'great britain', 'britain', 'british', 'england', 'english', 'scotland', 'scottish', 'wales', 'welsh', 'northern ireland'],
  Ireland: ['ireland', 'irish'],
  France: ['france', 'french'],
  Germany: ['germany', 'german'],
  Spain: ['spain', 'españa', 'spanish'],
  Portugal: ['portugal', 'portuguese'],
  Italy: ['italy', 'italian'],
  Netherlands: ['netherlands', 'holland', 'dutch'],
  Belgium: ['belgium', 'belgian'],
  Luxembourg: ['luxembourg', 'luxembourgish'],
  Switzerland: ['switzerland', 'swiss'],
  Austria: ['austria', 'austrian'],
  Monaco: ['monaco', 'monacan', 'monégasque'],

  // --- Nordics ---
  Sweden: ['sweden', 'swedish'],
  Norway: ['norway', 'norwegian'],
  Denmark: ['denmark', 'danish'],
  Finland: ['finland', 'finnish'],
  Iceland: ['iceland', 'icelandic'],

  // --- Eastern & Southern Europe ---
  Poland: ['poland', 'polish'],
  'Czech Republic': ['czech republic', 'czechia', 'czech'],
  Slovakia: ['slovakia', 'slovak'],
  Hungary: ['hungary', 'hungarian'],
  Romania: ['romania', 'romanian'],
  Bulgaria: ['bulgaria', 'bulgarian'],
  Greece: ['greece', 'greek'],
  Croatia: ['croatia', 'croatian'],
  Serbia: ['serbia', 'serbian'],
  Slovenia: ['slovenia', 'slovenian'],
  Ukraine: ['ukraine', 'ukrainian'],
  Russia: ['russia', 'russian'],
  Turkey: ['turkey', 'türkiye', 'turkish'],
  Cyprus: ['cyprus', 'cypriot'],
  Malta: ['malta', 'maltese'],
  Estonia: ['estonia', 'estonian'],
  Latvia: ['latvia', 'latvian'],
  Lithuania: ['lithuania', 'lithuanian'],

  // --- Middle East ---
  'United Arab Emirates': ['united arab emirates', ' uae ', 'dubai', 'abu dhabi', 'emirati', 'emirates'],
  'Saudi Arabia': ['saudi arabia', 'saudi', 'ksa'],
  Qatar: ['qatar', 'qatari', 'doha'],
  Kuwait: ['kuwait', 'kuwaiti'],
  Bahrain: ['bahrain', 'bahraini'],
  Oman: ['oman', 'omani'],
  Israel: ['israel', 'israeli'],
  Jordan: ['jordan', 'jordanian'],
  Lebanon: ['lebanon', 'lebanese'],
  Iraq: ['iraq', 'iraqi'],
  Iran: ['iran', 'iranian'],

  // --- Africa ---
  'South Africa': ['south africa', 'south african'],
  Nigeria: ['nigeria', 'nigerian'],
  Egypt: ['egypt', 'egyptian'],
  Kenya: ['kenya', 'kenyan'],
  Morocco: ['morocco', 'moroccan'],
  Algeria: ['algeria', 'algerian'],
  Tunisia: ['tunisia', 'tunisian'],
  Ghana: ['ghana', 'ghanaian'],
  Ethiopia: ['ethiopia', 'ethiopian'],
  Tanzania: ['tanzania', 'tanzanian'],
  Uganda: ['uganda', 'ugandan'],
  Angola: ['angola', 'angolan'],
  Mozambique: ['mozambique', 'mozambican'],
  Namibia: ['namibia', 'namibian'],
  Botswana: ['botswana', 'botswanan'],
  Zambia: ['zambia', 'zambian'],
  Zimbabwe: ['zimbabwe', 'zimbabwean'],
  Senegal: ['senegal', 'senegalese'],
  "Côte d'Ivoire": ["côte d'ivoire", 'ivory coast', 'ivorian'],
  Rwanda: ['rwanda', 'rwandan'],
  Libya: ['libya', 'libyan'],

  // --- South & Central Asia ---
  India: ['india', 'indian'],
  Pakistan: ['pakistan', 'pakistani'],
  Bangladesh: ['bangladesh', 'bangladeshi'],
  'Sri Lanka': ['sri lanka', 'sri lankan'],
  Nepal: ['nepal', 'nepalese', 'nepali'],
  Afghanistan: ['afghanistan', 'afghan'],
  Kazakhstan: ['kazakhstan', 'kazakh'],
  Uzbekistan: ['uzbekistan', 'uzbek'],

  // --- East & Southeast Asia ---
  China: ['china', 'chinese', 'prc'],
  'Hong Kong': ['hong kong', 'hongkong'],
  Taiwan: ['taiwan', 'taiwanese'],
  Japan: ['japan', 'japanese'],
  'South Korea': ['south korea', 'korea', 'korean'],
  Mongolia: ['mongolia', 'mongolian'],
  Singapore: ['singapore', 'singaporean'],
  Malaysia: ['malaysia', 'malaysian'],
  Indonesia: ['indonesia', 'indonesian'],
  Thailand: ['thailand', 'thai'],
  Vietnam: ['vietnam', 'vietnamese'],
  Philippines: ['philippines', 'filipino', 'philippine'],
  Cambodia: ['cambodia', 'cambodian'],
  Laos: ['laos', 'lao', 'laotian'],
  Myanmar: ['myanmar', 'burma', 'burmese'],
  Brunei: ['brunei', 'bruneian'],

  // --- Oceania ---
  Australia: ['australia', 'australian'],
  'New Zealand': ['new zealand', 'kiwi'],
  Fiji: ['fiji', 'fijian'],
  'Papua New Guinea': ['papua new guinea', 'papua'],
}

/**
 * Foreign REGIONS (multi-country geographies that are NOT inside the US). These
 * also engage international intent. US-internal regions (Midwest, Northeast,
 * West Coast…) stay in extract-deal.ts US_STATES and must NOT appear here.
 */
export const FOREIGN_REGIONS: Record<string, string[]> = {
  Caribbean: ['caribbean', 'west indies'],
  'Latin America': ['latin america', 'latam', 'south america', 'central america'],
  Europe: ['europe', 'european', ' eu '],
  'Middle East': ['middle east', 'gulf states', 'gcc'],
  Asia: ['asia', 'asian', 'apac', 'asia-pacific', 'asia pacific'],
  Africa: ['africa', 'african'],
  Oceania: ['oceania'],
  Scandinavia: ['scandinavia', 'scandinavian', 'nordics', 'nordic'],
}

/**
 * Combined non-US foreign-geography dictionary (countries + regions). Consumed by
 * extract-deal.ts to (a) populate geographic_scope with the canonical foreign
 * name and (b) flag the deal as international.
 */
export const FOREIGN_GEOS: Record<string, string[]> = {
  ...FOREIGN_COUNTRIES,
  ...FOREIGN_REGIONS,
}

/** Canonical names that are non-US foreign geographies — used to engage intl intent. */
export const FOREIGN_GEO_NAMES: ReadonlySet<string> = new Set(Object.keys(FOREIGN_GEOS))

/**
 * Which countries each foreign region contains.
 *
 * Needed because a lender states a region and a deal states a country: a
 * lender covers "Africa" and the deal is Nigeria, or "Europe" and the deal is
 * France. Without containment those read as a geography mismatch and the lender
 * is wrongly hard-excluded.
 *
 * Deliberately NOT symmetric with FOREIGN_REGIONS' matching patterns — this maps
 * region → member countries, while FOREIGN_REGIONS maps region → the words that
 * name it in prose.
 */
export const REGION_MEMBERS: Record<string, readonly string[]> = {
  'North America': ['Canada', 'Mexico'],
  Caribbean: [
    'Cuba', 'Dominican Republic', 'Haiti', 'Jamaica', 'Bahamas', 'Barbados',
    'Trinidad and Tobago', 'Cayman Islands', 'Bermuda',
  ],
  'Latin America': [
    'Mexico', 'Guatemala', 'Belize', 'Honduras', 'El Salvador', 'Nicaragua',
    'Costa Rica', 'Panama', 'Cuba', 'Dominican Republic', 'Brazil', 'Argentina',
    'Chile', 'Colombia', 'Peru', 'Venezuela', 'Ecuador', 'Bolivia', 'Paraguay',
    'Uruguay', 'Guyana', 'Suriname',
  ],
  Europe: [
    'United Kingdom', 'Ireland', 'France', 'Germany', 'Spain', 'Portugal', 'Italy',
    'Netherlands', 'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Monaco',
    'Sweden', 'Norway', 'Denmark', 'Finland', 'Iceland', 'Poland', 'Czech Republic',
    'Slovakia', 'Hungary', 'Romania', 'Bulgaria', 'Greece', 'Croatia', 'Serbia',
    'Slovenia', 'Ukraine', 'Cyprus', 'Malta', 'Estonia', 'Latvia', 'Lithuania',
  ],
  Scandinavia: ['Sweden', 'Norway', 'Denmark', 'Finland', 'Iceland'],
  'Middle East': [
    'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman',
    'Israel', 'Jordan', 'Lebanon', 'Iraq', 'Iran', 'Turkey',
  ],
  Africa: [
    'South Africa', 'Nigeria', 'Egypt', 'Kenya', 'Morocco', 'Algeria', 'Tunisia',
    'Ghana', 'Ethiopia', 'Tanzania', 'Uganda', 'Angola', 'Mozambique', 'Namibia',
    'Botswana', 'Zambia', 'Zimbabwe', 'Senegal', 'Rwanda', 'Libya',
  ],
  Asia: [
    'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Afghanistan',
    'Kazakhstan', 'Uzbekistan', 'China', 'Hong Kong', 'Taiwan', 'Japan',
    'South Korea', 'Mongolia', 'Singapore', 'Malaysia', 'Indonesia', 'Thailand',
    'Vietnam', 'Philippines', 'Cambodia', 'Laos', 'Myanmar', 'Brunei',
  ],
  Oceania: ['Australia', 'New Zealand', 'Fiji', 'Papua New Guinea'],
}

/** True when `region` is a foreign region that contains `country`. */
export function regionContains(region: string, country: string): boolean {
  const members = REGION_MEMBERS[region]
  if (!members) return false
  const c = country.toLowerCase().trim()
  return members.some((m) => m.toLowerCase() === c)
}

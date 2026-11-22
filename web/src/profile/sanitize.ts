// Stamp sanitiser: place names on cards and in crate lore name a district or
// a city, never a street, a house number or a postcode (GAMEPLAY.md,
// "Collection" and "Social"). The input is a geocoder field (suburb, city)
// that should already be a district or city, but geocoders sometimes hand
// back "12 Rue de Rivoli, 75004 Paris": this is the defensive filter.
//
// Rules (strict on purpose: privacy beats a pretty name):
// 1. Split into segments on , ; / | newline, " - " and parentheses.
// 2. Remove postcode patterns (UK, Canada, Netherlands, Poland, Portugal,
//    Sweden/Czechia, US ZIP+4, any run of 3+ digits).
// 3. Drop a whole segment when it looks like a street: a street word with
//    a name next to it ("Rue de Rivoli", "Via Roma"; alone, "Rue" and
//    "Largo" are towns), a street
//    suffix glued to a word ("Hauptstraße", "Kalverstraat", "Drottninggatan"),
//    or a street abbreviation ("Main St", "Bd Haussmann", "ul. Nowy Świat").
// 4. Drop a whole segment holding a house number ("77", "12b", "221B").
//    In the segments kept, drop every token with a digit, house-number
//    markers ("No.", "n°", "bis", "ter"), and leftover punctuation.
// 5. Keep the first segment left (the most specific), trimmed to 60 chars.
//    Nothing left => "" (callers fall back to the city, then to a generic name).
//
// False positives are accepted: "Earls Court" or "Leicester Square" (areas
// named after a street) are dropped and the stamp falls back to the city.
// Limit: a bare street name with no street word and no number ("Strøget",
// "Unter den Linden") can't be told from a district name. Geocoder
// district/city fields don't carry those; a full address line with a house
// number is dropped by rule 4 (a segment with a house number goes whole).

/// Street words, matched as whole words anywhere in a segment (after
/// lower-casing and removing accents). Several languages.
const STREET_WORDS = new Set([
  // English
  "street", "road", "avenue", "boulevard", "lane", "drive", "way", "court", "terrace", "crescent",
  "highway", "alley", "parkway", "square", "place", "close", "row", "mews", "embankment",
  // French
  "rue", "allee", "impasse", "chemin", "quai", "route", "passage", "cours", "ruelle", "voie",
  "sentier", "chaussee", "rond-point", "montee", "parvis", "esplanade",
  // German / Dutch
  "strasse", "gasse", "weg", "platz", "damm", "ufer", "steig", "pfad", "straat", "laan", "gracht",
  "plein", "kade", "steeg", "dreef",
  // Spanish / Italian / Portuguese
  "calle", "avenida", "paseo", "plaza", "camino", "carrera", "carretera", "ronda", "travesia", "pasaje",
  "via", "viale", "piazza", "corso", "vicolo", "largo", "strada", "piazzale", "lungomare", "lungotevere",
  "rua", "travessa", "praca", "estrada", "alameda", "beco",
  // Polish / Czech / Scandinavian / Turkish / Russian
  "ulica", "aleja", "plac", "ulice", "namesti", "trida", "gata", "gatan", "gade", "vej", "vagen", "veien",
  "cadde", "caddesi", "sokak", "sokagi", "bulvar", "bulvari", "mahallesi",
  "улица", "проспект", "переулок", "шоссе", "площадь", "бульвар", "набережная",
]);

/// Street suffixes glued to a name ("Hauptstraße", "Kalverstraat", "Drottninggatan").
const STREET_SUFFIXES = [
  "strasse", "str", "gasse", "straat", "gracht", "laan", "steeg", "gatan", "vagen", "gade", "vej", "veien",
  "katu", "tie", "utca", "allee", "platz",
];

/// Abbreviations that mark a street when they end a segment ("Main St").
const STREET_ABBREV_LAST = new Set(["st", "rd", "ave", "av", "blvd", "ln", "dr", "ct", "pl", "sq", "hwy", "pkwy", "ter", "cres"]);
/// Abbreviations that mark a street when they start a segment ("Bd Haussmann", "C/ Mayor").
const STREET_ABBREV_FIRST = new Set(["av", "ave", "avda", "bd", "bld", "bvd", "blvd", "c/", "c/.", "cl", "pza", "pca"]);
/// The same, only with a dot ("al. Jerozolimskie", "R. Augusta"): without one
/// they are ordinary words ("Al Ain").
const STREET_ABBREV_FIRST_DOT = new Set(["al", "ul", "pl", "r", "str", "trav", "av", "c", "pr", "sh"]);

/// House-number markers dropped as tokens.
const NUMBER_MARKERS = new Set(["no", "nº", "n°", "nr", "num", "numero", "number", "bis", "ter", "quater", "#"]);

/// Postcode and number patterns removed before tokenising.
const POSTCODES: RegExp[] = [
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, // UK: SW1A 1AA, M1 1AE
  /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/gi, // Canada: K1A 0B1
  /\b\d{4}\s?[A-Z]{2}\b/g, // Netherlands: 1012 AB
  /\b\d{2}-\d{3}\b/g, // Poland: 00-950
  /\b\d{4}-\d{3}\b/g, // Portugal: 1100-148
  /\b\d{3}\s\d{2}\b/g, // Sweden / Czechia: 111 52
  /\b\d{5}-\d{4}\b/g, // US ZIP+4
  /\d{3,}/g, // any long number
];

const MAX_LEN = 60;

/// Lower-case, accents removed, ß -> ss (for matching only).
function fold(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function isStreetSegment(seg: string): boolean {
  const raw = fold(seg).split(/\s+/).filter((w) => w.length > 0);
  const words = raw
    .flatMap((w) => w.split(/[.]+/))
    .map((w) => w.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}/]+$/gu, ""))
    .filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const parts = words.flatMap((w) => w.split("-")).filter((p) => p.length > 0);
  // A street word needs a name next to it: "Rue de Rivoli", "Via Roma",
  // "Rue-de-la-Paix". Alone it is a place name ("Rue", "Largo").
  if (parts.length > 1) {
    for (const w of words) if (STREET_WORDS.has(w)) return true;
    for (const p of parts) if (STREET_WORDS.has(p)) return true;
  }
  for (const w of parts) {
    for (const suf of STREET_SUFFIXES) if (w.length > suf.length + 2 && w.endsWith(suf)) return true;
  }
  if (words.length > 1) {
    if (STREET_ABBREV_LAST.has(words[words.length - 1])) return true;
    if (STREET_ABBREV_FIRST.has(words[0])) return true;
    const first = raw[0];
    if (first.endsWith(".") && STREET_ABBREV_FIRST_DOT.has(first.slice(0, -1))) return true;
    if (first.includes(".") && STREET_ABBREV_FIRST_DOT.has(first.split(".")[0])) return true;
  }
  return false;
}

function cleanSegment(seg: string): string {
  let s = seg;
  for (const re of POSTCODES) s = s.replace(re, " ");
  // A house number ("77", "12b", "221B", "5-7") means the segment is an
  // address line even without a street word ("Unter den Linden 77"): drop it.
  // Ordinals ("4e", "17th") are not house numbers; their token is dropped below.
  if (s.split(/\s+/).some((t) => /^\d{1,4}([a-d]|-\d{1,4})?[.,]?$/i.test(t))) return "";
  const tokens = s
    .split(/\s+/)
    .filter((t) => !/\d/.test(t)) // before trimming: "4e" must go, not become "e"
    .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")) // edge punctuation (keeps inner hyphens and apostrophes)
    .filter((t) => t.length > 0 && !NUMBER_MARKERS.has(fold(t).replace(/\.$/, "")));
  return tokens.join(" ");
}

/// A district or city name safe for a stamp or a lore line ("" when nothing is left).
export function sanitizePlace(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .normalize("NFC")
    // Spanish "C/ Mayor" (calle) before "/" splits bilingual names ("Bruxelles/Brussel").
    .replace(/(^|[\s,;])c\/\s*/gi, "$1Calle ");
  const segments = text.split(/[,;/|\n()[\]]|\s[-–—]\s/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed || isStreetSegment(trimmed)) continue;
    const clean = cleanSegment(trimmed);
    if (clean.length === 0) continue;
    // The cleaned segment may now read like a street ("12 Main St" -> "Main St").
    if (isStreetSegment(clean)) continue;
    return clean.length > MAX_LEN ? clean.slice(0, MAX_LEN).replace(/\s+\S*$/, "").trim() || clean.slice(0, MAX_LEN) : clean;
  }
  return "";
}

/// The place shown on a stamp or in lore: "District, City", or the city
/// alone, or a generic name when both sanitise to nothing.
export function placeLabel(district: string, city: string): string {
  const d = sanitizePlace(district);
  const c = sanitizePlace(city);
  if (d && c && fold(d) !== fold(c)) return `${d}, ${c}`;
  return d || c || "an unnamed district";
}

/// Whether a text looks like it contains a street, a number or a postcode
/// (the property the tests check on every stamp and lore line).
export function looksLikeAddress(text: string): boolean {
  if (/\d/.test(text)) return true;
  return text.split(/[,;()]/).some((seg) => seg.trim() && isStreetSegment(seg.trim()));
}

// Stamp sanitiser: place names on cards and in crate lore name a district or
// a city, never a street, a house number or a postcode (GAMEPLAY.md,
// "Collection" and "Social").
//
// THE PRIVACY GUARANTEE IS THE INPUT CONTRACT, NOT THIS FILE. `city` and
// `district` (MatchSummary, DailyEvent) come only from the place search's
// administrative fields (`placeFromGeocoder` in place.ts): never from
// `road`, `house_number`, `postcode`, `display_name` or free text. A
// blacklist can't know every street form in the world, and every word it
// adds risks a real town ("Piazza Armerina", "Road Town"). This filter is
// defence in depth: it catches the common address shapes (a house number,
// a postcode, a street word or abbreviation in a few dozen languages) in
// case a geocoder field carries one, and it doesn't try to be complete.
//
// Two modes, because the two fields don't carry the same risk:
// - "district" (default, strict): a segment that looks like a street is
//   dropped. Accepted false positives: areas named after a street ("Earls
//   Court", "Jalan Besar") fall back to the city.
// - "city" (lenient): the city field is an admin name, and many real towns
//   start with a street word ("Strada in Chianti", "Plaza Huincul",
//   "Crescent City", "Neustadt an der Weinstraße"). Numbers and postcodes
//   are still removed, a segment with a street abbreviation ("Main St",
//   "ul. Długa") is still dropped, and a street-looking segment is skipped
//   only when another segment is left ("Rue de Rivoli, Paris" -> "Paris").
//   A parenthesised qualifier is kept ("Halle (Saale)" and "Halle (Westf.)"
//   are two cities, and the city key is built from this name).
//
// Rules:
// 1. Split into segments on , ; / | newline, " - " (and parentheses in
//    district mode).
// 2. Remove postcode patterns (UK, Canada, Netherlands, Poland, Portugal,
//    Sweden/Czechia, US ZIP+4, any run of 3+ digits).
// 3. Street segments (see `isStreetSegment`): a street word with a name next
//    to it ("Rue de Rivoli", "Via Roma"; alone, "Rue" and "Largo" are
//    towns), some words only first ("Jalan Thamrin", "Soi Nana") or only
//    last ("Nanjing Lu", "Andrássy út"), a glued suffix ("Hauptstraße",
//    "Kalverstraat", "Mannerheimintie"), a hyphenated one ("Teheran-ro",
//    "Mido-suji"), or an abbreviation ("Main St", "Bd Haussmann", "ul.
//    Nowy Świat", "V.le Monza", "İstiklal Cd.", "Váci u.", "ул. Тверская").
//    A segment with an admin word ("Kreis Bergstraße", "Lu County",
//    "Caferağa Mahallesi") or a known admin name ("Landstraße", Vienna's
//    3rd district) is never a street.
// 4. A segment holding a house number ("77", "12b", "221B") is dropped,
//    except when it is the whole input and reads "<one word> <1-2 digits>":
//    that is a numbered district ("Praha 1" -> "Praha", "Wien 3" -> "Wien").
//    In the segments kept, every token with a digit goes, as do house-number
//    markers ("No.", "n°", "bis") and leftover punctuation. When a token
//    with a digit went, a division word goes too ("Paris 4e Arrondissement"
//    -> "Paris", "1st Arrondissement" -> ""): a stamp never shows a digit.
// 5. Keep the first segment left (the most specific), trimmed to 60 chars.
//    Nothing left => "" (callers fall back to the city, then to a generic name).
//
// Limit: a bare street name with no marker and no number ("Strøget",
// "Unter den Linden") can't be told from a district name. The input
// contract is what keeps those out.

export type PlaceField = "district" | "city";

/// Street words, matched as whole words (or hyphen parts) anywhere in a
/// segment with another word next to it (after `fold`).
const STREET_WORDS = new Set([
  // English
  "street", "road", "avenue", "boulevard", "lane", "drive", "way", "court", "terrace", "crescent",
  "highway", "alley", "parkway", "square", "place", "close", "row", "mews", "embankment",
  // French ("Faubourg" is not here: "Faubourg-Montmartre" is an official Paris quartier)
  "rue", "allee", "impasse", "chemin", "quai", "route", "passage", "cours", "ruelle", "voie",
  "sentier", "chaussee", "rond-point", "montee", "parvis", "esplanade",
  // German / Dutch
  "strasse", "gasse", "weg", "platz", "damm", "ufer", "steig", "pfad", "straat", "laan", "gracht",
  "plein", "kade", "steeg", "dreef",
  // Spanish / Italian / Portuguese / Venetian
  "calle", "avenida", "paseo", "plaza", "camino", "carrera", "carretera", "ronda", "travesia", "pasaje", "jiron",
  "via", "viale", "piazza", "corso", "vicolo", "largo", "strada", "piazzale", "lungomare", "lungotevere",
  "fondamenta", "salizada",
  "rua", "travessa", "praca", "estrada", "alameda", "beco", "ladeira",
  // Catalan ("placa" is "plaça" folded)
  "carrer", "passeig", "avinguda", "placa", "rambla", "travessera",
  // Japanese (romanised; Korean "-ro"/"-gil" are in HYPHEN_SUFFIXES)
  "dori", "kaido",
  // Polish / Czech / Hungarian / Scandinavian / Turkish
  "ulica", "aleja", "plac", "ulice", "namesti", "trida", "utca", "korut", "gata", "gatan", "gade", "vej", "vagen", "veien",
  "cadde", "caddesi", "sokak", "sokagi", "bulvar", "bulvari",
  // Russian (Cyrillic and transliterated)
  "улица", "проспект", "переулок", "шоссе", "площадь", "бульвар", "набережная",
  "ulitsa", "prospekt", "pereulok", "shosse", "naberezhnaya",
  // Hebrew (transliterated)
  "rehov",
]);

/// Street words that count only as the first word, before a name: alone or
/// later in a name they are ordinary words ("Sderot" is a city).
const STREET_WORDS_FIRST = new Set([
  "jalan", "thanon", "soi", "duong", "pho", // Malay / Indonesian, Thai, Vietnamese
  "sderot", "derech", // Hebrew
  "calzada", "calcada", // Spanish, Portuguese ("La Calzada" is a district of Gijón)
]);

/// Street words that count only as the last word, after a name: first they
/// start ordinary names ("Lu County", "Lu-kang").
const STREET_WORDS_LAST = new Set([
  "lu", "jie", "dajie", "hutong", // Chinese (pinyin)
  "marg", "path", // India
  "ut", // Hungarian ("út" folded)
  "suji", // Japanese
]);

/// Street suffixes glued to a name ("Hauptstraße", "Kalverstraat",
/// "Drottninggatan", "Mannerheimintie"). The word must be at least 3 letters
/// longer than the suffix.
/// Skipped on purpose: "-lu" (Honolulu), "-kaido" (Hokkaido), "-tie" without
/// the Finnish genitive "n" (Carnoustie).
const STREET_SUFFIXES = [
  "strasse", "str", "gasse", "straat", "gracht", "laan", "steeg", "gatan", "vagen", "gade", "vej", "veien",
  "katu", "ntie", "utca", "allee", "platz", "daero", "damm", "ufer", "dajie", "hutong", "suji",
];

/// Street suffixes joined with a hyphen ("Teheran-ro", "Insadong-gil",
/// "Meiji-dori", "Kōshū-kaidō", "Mido-suji"). Only hyphenated: glued or
/// alone they are ordinary words ("San Gil", "Ro", "Hokkaido"). District
/// suffixes ("-gu", "-ku", "-dong") are not here.
const HYPHEN_SUFFIXES = new Set(["ro", "gil", "daero", "dori", "kaido", "suji"]);

/// Abbreviations that mark a street when they end a segment ("Main St", "İstiklal Cd").
const STREET_ABBREV_LAST = new Set([
  "st", "rd", "ave", "av", "blvd", "ln", "dr", "ct", "pl", "sq", "hwy", "pkwy", "ter", "cres",
  "cd", "cad", "sk", "sok", "blv", // Turkish
  "ул", "пр-т", "наб", "пер", // Russian
]);
/// The same, only with a dot ("Berliner Str.", "Váci u.", "Nevsky pr.", "Ленинградское ш.").
const STREET_ABBREV_LAST_DOT = new Set(["str", "u", "pr", "пр", "ш"]);
/// Abbreviations that mark a street when they start a segment ("Bd Haussmann", "C/ Mayor").
const STREET_ABBREV_FIRST = new Set([
  "av", "ave", "avda", "bd", "bld", "bvd", "blvd", "c/", "c/.", "cl", "pza", "pca", "ctra", "pº", "imp", "fbg", "fg", "rte", "vle", "pzza", "pzle",
  "pso", "pg", "rbla", "avgda", "ptge", "calz", "diag", "tv", "lgo", "pc", // Spanish, Catalan, Portuguese ("pc" is "Pç" folded)
  "jln", // Malay
  "ул", "наб", "пер", "пр-т", "просп", // Russian
]);
/// The same, only with a dot ("al. Jerozolimskie", "R. Augusta", "Jl.
/// Sudirman", "Jr. de la Unión", "Ch. des Vignes"): without one they are
/// ordinary words ("Al Ain").
const STREET_ABBREV_FIRST_DOT = new Set(["al", "ul", "pl", "r", "str", "trav", "av", "c", "pr", "sh", "jl", "jr", "sq", "all", "ch", "пр", "ш"]);
/// Abbreviations with a dot inside, matched on the whole first token
/// ("V.le Monza", "P.za Duomo", "C.so Buenos Aires", "P.º de la Castellana").
const STREET_ABBREV_DOTTED = new Set(["v.le", "p.za", "p.zza", "p.le", "c.so", "l.go", "p.º", "v.lo", "str.da"]);

/// Admin words: a segment starting or ending with one names a division, not a
/// street ("Kreis Bergstraße", "Lu County", "Caferağa Mahallesi").
const ADMIN_FIRST = new Set(["kreis", "landkreis", "bezirk", "stadtbezirk", "county", "comarca", "okrug"]);
const ADMIN_LAST = new Set(["county", "kreis", "mahallesi", "mahalle", "rayon", "okrug", "oblast", "prefecture", "parish", "borough"]);
/// Admin names that end in a street suffix, folded.
const ADMIN_NAMES = new Set(["landstrasse", "neustadt an der weinstrasse"]);

/// Generic words of an administrative division. When the ordinal before
/// one is dropped ("Paris 4e Arrondissement"), the word goes too: alone it
/// names nothing ("Paris Arrondissement"). Vietnamese `quận`, `phường`,
/// `huyện` (folded): "Quận 1" is "", not "Quận".
const DIVISION_WORDS = new Set(["arrondissement", "arrondissements", "arr", "district", "bezirk", "gemeindebezirk", "ward", "sector", "sektor", "distrito", "municipio", "kerulet", "obvod", "quan", "phuong", "huyen"]);

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

/// Lower-case, accents removed, ß -> ss, dotless ı -> i, đ -> d (for matching only).
export function fold(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss").replace(/ı/g, "i").replace(/đ/g, "d").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function wordsOf(seg: string): { raw: string[]; words: string[]; parts: string[] } {
  const raw = fold(seg).split(/\s+/).filter((w) => w.length > 0);
  const words = raw
    .flatMap((w) => w.split(/[.]+/))
    .map((w) => w.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}/]+$/gu, ""))
    .filter((w) => w.length > 0);
  const parts = words.flatMap((w) => w.split("-")).filter((p) => p.length > 0);
  return { raw, words, parts };
}

/// A segment that names an admin division ("Kreis Bergstraße", "Lu County").
function isAdminSegment(seg: string): boolean {
  const { words } = wordsOf(seg);
  if (words.length === 0) return false;
  if (ADMIN_NAMES.has(words.join(" "))) return true;
  return words.length > 1 && (ADMIN_FIRST.has(words[0]) || ADMIN_LAST.has(words[words.length - 1]));
}

/// A street abbreviation ("Main St", "Bd Haussmann", "ul. Długa", "Váci u.")
/// or a hyphenated street suffix ("Teheran-ro", "Meiji-dori"). Strong
/// evidence: no town is written that way, so the city mode drops these too.
/// `cityMode`: "ave" starts a street only with a dot ("Ave. Foch"), so the
/// town "Ave Maria" stays.
function hasStreetAbbrev(seg: string, cityMode = false): boolean {
  const { raw, words } = wordsOf(seg);
  for (const w of words) {
    const hp = w.split("-").filter((p) => p.length > 0);
    if (hp.length > 1 && HYPHEN_SUFFIXES.has(hp[hp.length - 1])) return true;
  }
  if (words.length < 2) return false;
  if (STREET_ABBREV_LAST.has(words[words.length - 1])) return true;
  const last = raw[raw.length - 1];
  if (last.endsWith(".") && STREET_ABBREV_LAST_DOT.has(last.slice(0, -1))) return true;
  const first = raw[0];
  if (STREET_ABBREV_FIRST.has(words[0]) && !(cityMode && words[0] === "ave" && !first.startsWith("ave."))) return true;
  if (STREET_ABBREV_DOTTED.has(first.replace(/\.$/, ""))) return true;
  if (first.endsWith(".") && STREET_ABBREV_FIRST_DOT.has(first.slice(0, -1))) return true;
  if (first.includes(".") && STREET_ABBREV_FIRST_DOT.has(first.split(".")[0])) return true;
  return false;
}

function isStreetSegment(seg: string, cityMode = false): boolean {
  if (isAdminSegment(seg)) return false;
  const { words, parts } = wordsOf(seg);
  if (words.length === 0) return false;
  // A street word needs a name next to it: "Rue de Rivoli", "Via Roma",
  // "Rue-de-la-Paix". Alone it is a place name ("Rue", "Largo").
  if (parts.length > 1) {
    for (const w of words) if (STREET_WORDS.has(w)) return true;
    for (const p of parts) if (STREET_WORDS.has(p)) return true;
  }
  if (words.length > 1) {
    if (STREET_WORDS_FIRST.has(words[0])) return true;
    if (STREET_WORDS_LAST.has(words[words.length - 1])) return true;
  }
  for (const w of parts) {
    for (const suf of STREET_SUFFIXES) if (w.length > suf.length + 2 && w.endsWith(suf)) return true;
  }
  return hasStreetAbbrev(seg, cityMode);
}

/// Any street word on its own (a numbered "Soi 11" is not a district "Soi").
function isStreetWord(w: string): boolean {
  return STREET_WORDS.has(w) || STREET_WORDS_FIRST.has(w) || STREET_WORDS_LAST.has(w) || STREET_ABBREV_FIRST.has(w) || STREET_ABBREV_LAST.has(w);
}

/// A lone street abbreviation ("Rd", "St", "ul."): it names nothing, skip it.
function isLoneAbbrev(seg: string): boolean {
  const { words } = wordsOf(seg);
  // Not the dot-only sets: "Ål" (Norway) folds to "al".
  return words.length === 1 && (STREET_ABBREV_LAST.has(words[0]) || STREET_ABBREV_FIRST.has(words[0]));
}

/// `whole`: the segment is the whole input, so "<word> <1-2 digits>" is a
/// numbered district ("Praha 1").
function cleanSegment(seg: string, whole: boolean): string {
  let s = seg;
  const numbered = /^\s*([\p{L}][\p{L}'’-]*)\s+(\d{1,2})\s*$/u.exec(s);
  if (whole && numbered) {
    const w = fold(numbered[1]);
    return DIVISION_WORDS.has(w) || NUMBER_MARKERS.has(w) || isStreetWord(w) ? "" : numbered[1];
  }
  for (const re of POSTCODES) s = s.replace(re, " ");
  // A house number ("77", "12b", "221B", "5-7") means the segment is an
  // address line even without a street word ("Unter den Linden 77"): drop it.
  // Ordinals ("4e", "17th") are not house numbers; their token is dropped below.
  if (s.split(/\s+/).some((t) => /^\d{1,4}([a-d]|-\d{1,4})?[.,]?$/i.test(t))) return "";
  const all = s.split(/\s+/).filter((t) => t.length > 0);
  // An ordinal went ("4e", "1st"): its division word goes with it, so
  // "Paris 4e Arrondissement" is "Paris" and "1st Arrondissement" is "".
  const droppedNumber = s !== seg || all.some((t) => /\d/.test(t));
  const tokens = all
    .filter((t) => !/\d/.test(t)) // before trimming: "4e" must go, not become "e"
    .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")) // edge punctuation (keeps inner hyphens and apostrophes)
    .filter((t) => t.length > 0 && !NUMBER_MARKERS.has(fold(t).replace(/\.$/, "")))
    .filter((t) => !(droppedNumber && DIVISION_WORDS.has(fold(t).replace(/\.$/, ""))));
  return tokens.join(" ");
}

function trimLen(clean: string): string {
  return clean.length > MAX_LEN ? clean.slice(0, MAX_LEN).replace(/\s+\S*$/, "").trim() || clean.slice(0, MAX_LEN) : clean;
}

function normalise(raw: string): string {
  return (
    String(raw)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .normalize("NFC")
      // Spanish "C/ Mayor" (calle) before "/" splits bilingual names ("Bruxelles/Brussel").
      .replace(/(^|[\s,;])c\/\s*/gi, "$1Calle ")
  );
}

/// A parenthesised qualifier kept by the city mode ("Saale", "Westf.",
/// "Oder"): letters, spaces, dots, hyphens and apostrophes only, not a street.
function qualifier(q: string): string {
  const t = q.trim().replace(/\s+/g, " ");
  if (!t || t.length > 30 || !/^[\p{L}][\p{L} .'’-]*$/u.test(t) || isStreetSegment(t)) return "";
  return t;
}

function sanitizeCity(text: string): string {
  const segments = text.split(/[,;/|\n[\]]|\s[-–—]\s/).map((s) => s.trim()).filter((s) => s.length > 0);
  let fallback = "";
  for (const seg of segments) {
    const quals: string[] = [];
    const base = seg
      .replace(/\(([^()]*)\)/g, (_, q: string) => {
        const k = qualifier(q);
        if (k) quals.push(k);
        return " ";
      })
      .replace(/[()]/g, " ")
      .trim();
    if (!base || hasStreetAbbrev(base, true)) continue;
    const clean = cleanSegment(base, segments.length === 1);
    if (!clean || hasStreetAbbrev(clean, true) || isLoneAbbrev(clean)) continue;
    const out = trimLen(quals.length ? `${clean} (${quals[0]})` : clean);
    if (!isStreetSegment(base, true) && !isStreetSegment(clean, true)) return out;
    // A street-looking segment is kept only when nothing better is left:
    // the city field is an admin name ("Strada in Chianti").
    if (!fallback) fallback = out;
  }
  return fallback;
}

/// A district (default) or city name safe for a stamp, a lore line or a
/// stored key ("" when nothing is left). Defence in depth: the caller must
/// already pass an admin field (see the input contract above).
export function sanitizePlace(raw: string | null | undefined, field: PlaceField = "district"): string {
  if (!raw || typeof raw !== "string") return "";
  const text = normalise(raw);
  if (field === "city") return sanitizeCity(text);
  const segments = text.split(/[,;/|\n()[\]]|\s[-–—]\s/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const seg of segments) {
    if (isStreetSegment(seg)) continue;
    const clean = cleanSegment(seg, segments.length === 1);
    if (clean.length === 0 || isLoneAbbrev(clean)) continue;
    // The cleaned segment may now read like a street ("12 Main St" -> "Main St").
    if (isStreetSegment(clean)) continue;
    return trimLen(clean);
  }
  return "";
}

/// The place shown on a stamp or in lore: "District, City", or the city
/// alone, or a generic name when both sanitise to nothing.
export function placeLabel(district: string, city: string): string {
  const d = sanitizePlace(district);
  const c = sanitizePlace(city, "city");
  if (d && c && fold(d) !== fold(c)) return `${d}, ${c}`;
  return d || c || "an unnamed district";
}

/// Whether a text looks like it contains a street, a number or a postcode
/// (the property the tests check on every stamp and lore line).
export function looksLikeAddress(text: string): boolean {
  if (/\d/.test(text)) return true;
  return text.split(/[,;()]/).some((seg) => seg.trim() && isStreetSegment(seg.trim()));
}

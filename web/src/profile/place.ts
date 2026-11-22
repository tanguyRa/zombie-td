// The place input contract (privacy, GAMEPLAY.md "Social": anything stored
// or shared names a district or a city, never a street or an address).
//
// `MatchSummary.city` / `.district` and `DailyEvent.city` / `.district` come
// ONLY from the place search's administrative fields, picked by
// `placeFromGeocoder`:
//   city      Nominatim `city`, then `town`, `village`, `municipality`
//   district  Nominatim `suburb`, then `city_district`, `borough`, `quarter`,
//             `neighbourhood`
// (or the same admin levels from another geocoder). Never from `road`,
// `house_number`, `postcode`, `display_name` or free text the player typed.
// `sanitizePlace` runs on them again as defence in depth; it is not the
// guarantee.
//
// `cityId` must be a city-level admin id: `osm:relation:<1-12 digits>` (the
// OSM boundary relation of the city). Anything else (a node or way id, a
// free string) is ignored and the city is keyed on its sanitised name.

import { fold, sanitizePlace } from "./sanitize";

/// The only accepted `cityId` form: an OSM admin relation.
export const CITY_ID_RE = /^osm:relation:\d{1,12}$/;

/// Whether `id` is an accepted city id (`osm:relation:<digits>`).
export function isCityId(id: unknown): id is string {
  return typeof id === "string" && CITY_ID_RE.test(id);
}

/// `id` when it is an accepted city id, else undefined (ignored).
export function validCityId(id: unknown): string | undefined {
  return isCityId(id) ? id : undefined;
}

/// Nominatim address keys for the city, most preferred first.
export const CITY_FIELDS = ["city", "town", "village", "municipality"] as const;
/// Nominatim address keys for the district, most preferred first.
export const DISTRICT_FIELDS = ["suburb", "city_district", "borough", "quarter", "neighbourhood"] as const;

/// The city-level search result, when the UI has it (a Nominatim result
/// whose `addresstype` is the city, or a lookup of the city itself). Only
/// `osm_type === "relation"` with a numeric `osm_id` and an `addresstype` of
/// city, town, village or municipality gives a `cityId`. Fail-closed: a
/// result without `addresstype` (Photon, older Nominatim `format=json`) may
/// be a building multipolygon relation, whose id would pin the address, so it
/// gives none.
export interface CityResult {
  osm_type?: unknown;
  osm_id?: unknown;
  addresstype?: unknown;
}

const CITY_ADDRESSTYPES = new Set(["city", "town", "village", "municipality"]);

/// City and district for a `MatchSummary`, from a Nominatim-style address
/// object (`result.address`). Reads only the admin fields above, in that
/// order: the first city field that sanitises to a name, then the first
/// district field that sanitises to a name different from the city ("" if
/// none). `road`, `house_number`, `postcode` and every other key are never
/// read. `cityResult`: the city-level result, for `cityId` (see `CityResult`);
/// its `addresstype` must be present and a city level, else no `cityId`.
export function placeFromGeocoder(address: Record<string, string>, cityResult?: CityResult): { city: string; district: string; cityId?: string } {
  const a: Record<string, unknown> = address && typeof address === "object" ? address : {};
  const pick = (keys: readonly string[], field: "city" | "district", not?: string) => {
    for (const k of keys) {
      const v = Object.hasOwn(a, k) ? a[k] : undefined;
      if (typeof v !== "string") continue;
      const s = sanitizePlace(v, field);
      if (s && (not === undefined || fold(s) !== fold(not))) return s;
    }
    return "";
  };
  const city = pick(CITY_FIELDS, "city");
  const district = pick(DISTRICT_FIELDS, "district", city);
  const out: { city: string; district: string; cityId?: string } = { city, district };
  const r = cityResult;
  if (city && r && r.osm_type === "relation" && typeof r.addresstype === "string" && CITY_ADDRESSTYPES.has(r.addresstype)) {
    const id = typeof r.osm_id === "number" && Number.isInteger(r.osm_id) && r.osm_id > 0 ? String(r.osm_id) : typeof r.osm_id === "string" ? r.osm_id : "";
    const cityId = `osm:relation:${id}`;
    if (isCityId(cityId)) out.cityId = cityId;
  }
  return out;
}

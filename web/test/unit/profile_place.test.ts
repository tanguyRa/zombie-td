import { describe, expect, it } from "vitest";
import { cityKeyOf } from "../../src/profile/coverage";
import { isCityId, placeFromGeocoder, validCityId } from "../../src/profile/place";

/// Nominatim-style `address` objects (reverse geocoding of a street address),
/// with the city and district the profile must get.
const NOMINATIM: { name: string; address: Record<string, string>; city: string; district: string }[] = [
  {
    name: "Paris",
    address: {
      house_number: "12", road: "Rue de Rivoli", quarter: "Quartier Saint-Merri", suburb: "Paris 4e Arrondissement", city_district: "Paris", city: "Paris",
      "ISO3166-2-lvl6": "FR-75", county: "Paris", state: "Île-de-France", "ISO3166-2-lvl4": "FR-IDF", postcode: "75004", country: "France", country_code: "fr",
    },
    city: "Paris",
    district: "Quartier Saint-Merri",
  },
  {
    name: "Barcelona",
    address: {
      house_number: "92", road: "Passeig de Gràcia", neighbourhood: "la Dreta de l'Eixample", suburb: "Eixample", city: "Barcelona", county: "Barcelonès",
      state: "Catalunya", postcode: "08008", country: "España", country_code: "es",
    },
    city: "Barcelona",
    district: "Eixample",
  },
  {
    name: "Tokyo (Japanese)",
    address: { road: "表参道", neighbourhood: "神宮前五丁目", suburb: "神宮前", city: "渋谷区", province: "東京都", postcode: "150-0001", country: "日本", country_code: "jp" },
    city: "渋谷区",
    district: "神宮前",
  },
  {
    name: "Tokyo (English)",
    address: { house_number: "4-12-10", road: "Omotesando", quarter: "Jingumae 4-chome", suburb: "Jingumae", city: "Shibuya", province: "Tokyo", postcode: "150-0001", country: "Japan", country_code: "jp" },
    city: "Shibuya",
    district: "Jingumae",
  },
  {
    name: "Seoul (Korean)",
    address: { house_number: "152", road: "테헤란로", quarter: "역삼1동", borough: "강남구", city: "서울", postcode: "06236", country: "대한민국", country_code: "kr" },
    city: "서울",
    district: "강남구",
  },
  {
    name: "Seoul (English)",
    address: { house_number: "152", road: "Teheran-ro", quarter: "Yeoksam 1(il)-dong", borough: "Gangnam-gu", city: "Seoul", postcode: "06236", country: "South Korea", country_code: "kr" },
    city: "Seoul",
    district: "Gangnam-gu",
  },
  {
    name: "Istanbul",
    address: {
      house_number: "145", road: "İstiklal Caddesi", suburb: "Tomtom Mahallesi", town: "Beyoğlu", province: "İstanbul", region: "Marmara Bölgesi",
      postcode: "34433", country: "Türkiye", country_code: "tr",
    },
    city: "Beyoğlu",
    district: "Tomtom Mahallesi",
  },
  {
    name: "Moscow",
    address: {
      house_number: "7", road: "Тверская улица", suburb: "Тверской район", city_district: "Центральный административный округ", city: "Москва",
      state: "Москва", postcode: "125009", country: "Россия", country_code: "ru",
    },
    city: "Москва",
    district: "Тверской район",
  },
  {
    name: "Shanghai",
    address: { road: "南京东路", quarter: "南京东路街道", suburb: "黄浦区", city: "上海市", postcode: "200001", country: "中国", country_code: "cn" },
    city: "上海市",
    district: "黄浦区",
  },
  {
    name: "Jakarta",
    address: {
      road: "Jalan Mohammad Husni Thamrin", village: "Kebon Sirih", suburb: "Menteng", city: "Jakarta Pusat", state: "Daerah Khusus Ibukota Jakarta",
      postcode: "10340", country: "Indonesia", country_code: "id",
    },
    city: "Jakarta Pusat",
    district: "Menteng",
  },
  {
    name: "London",
    address: {
      house_number: "221B", road: "Baker Street", suburb: "Marylebone", city: "London", state_district: "Greater London", state: "England",
      postcode: "NW1 6XE", country: "United Kingdom", country_code: "gb",
    },
    city: "London",
    district: "Marylebone",
  },
  {
    name: "New York",
    address: {
      house_number: "350", road: "5th Avenue", neighbourhood: "Midtown", suburb: "Manhattan", county: "New York County", city: "City of New York",
      state: "New York", postcode: "10118", country: "United States", country_code: "us",
    },
    city: "City of New York",
    district: "Manhattan",
  },
];

describe("placeFromGeocoder (the input contract)", () => {
  it("picks only the admin fields of real Nominatim addresses", () => {
    for (const { name, address, city, district } of NOMINATIM) {
      const out = placeFromGeocoder(address);
      expect(out, name).toEqual({ city, district });
      // Never road, house number or postcode data.
      for (const v of [out.city, out.district]) {
        expect(v, name).not.toMatch(/\d/);
        if (address.road) expect(v.includes(address.road), `${name}: ${v}`).toBe(false);
        if (address.house_number) expect(v.includes(address.house_number), `${name}: ${v}`).toBe(false);
        if (address.postcode) expect(v.includes(address.postcode), `${name}: ${v}`).toBe(false);
      }
    }
  });

  it("follows the documented priority order", () => {
    expect(placeFromGeocoder({ village: "V", town: "T", city: "C", municipality: "M" }).city).toBe("C");
    expect(placeFromGeocoder({ village: "V", town: "T", municipality: "M" }).city).toBe("T");
    expect(placeFromGeocoder({ village: "V", municipality: "M" }).city).toBe("V");
    expect(placeFromGeocoder({ municipality: "M" }).city).toBe("M");
    expect(placeFromGeocoder({ city: "C", neighbourhood: "N", quarter: "Q", borough: "B", city_district: "Cdist", suburb: "S" }).district).toBe("S");
    expect(placeFromGeocoder({ city: "C", neighbourhood: "N", quarter: "Q", borough: "B", city_district: "Cdist" }).district).toBe("Cdist");
    expect(placeFromGeocoder({ city: "C", neighbourhood: "N", quarter: "Q", borough: "B" }).district).toBe("B");
    expect(placeFromGeocoder({ city: "C", neighbourhood: "N", quarter: "Q" }).district).toBe("Q");
    expect(placeFromGeocoder({ city: "C", neighbourhood: "N" }).district).toBe("N");
  });

  it("never reads road, house number, postcode or display name, even with no admin field", () => {
    const out = placeFromGeocoder({ road: "Baker Street", house_number: "221B", postcode: "NW1 6XE", display_name: "221B, Baker Street, London", amenity: "Museum" });
    expect(out).toEqual({ city: "", district: "" });
    // A district field that is really a street is skipped for the next one.
    expect(placeFromGeocoder({ suburb: "Rue de Rivoli", quarter: "Le Marais", city: "Paris" })).toEqual({ city: "Paris", district: "Le Marais" });
    // Non-string values are ignored.
    expect(placeFromGeocoder({ city: 12 as unknown as string, town: "Town" }).city).toBe("Town");
    expect(placeFromGeocoder(null as unknown as Record<string, string>)).toEqual({ city: "", district: "" });
  });

  it("gives a cityId only from a city-level admin relation", () => {
    const addr = { city: "Paris", suburb: "Le Marais" };
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: 7444, addresstype: "city" }).cityId).toBe("osm:relation:7444");
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: "7444", addresstype: "municipality" }).cityId).toBe("osm:relation:7444");
    expect(placeFromGeocoder(addr, { osm_type: "node", osm_id: 17807753, addresstype: "city" }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "way", osm_id: 4372 }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: 123, addresstype: "road" }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: "12 Rue de Rivoli" }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: 1e13 }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr).cityId).toBeUndefined();
    expect(placeFromGeocoder({ road: "Baker Street" }, { osm_type: "relation", osm_id: 65606, addresstype: "city" }).cityId).toBeUndefined();
  });

  it("gives no cityId from a relation without an addresstype (fail-closed)", () => {
    // A building multipolygon relation from Photon or Nominatim format=json
    // has no addresstype: its id would pinpoint the address.
    const addr = { city: "Paris", suburb: "Le Marais" };
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: 3417226 }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: "7444" }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: 7444, addresstype: null }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: 7444, addresstype: "building" }).cityId).toBeUndefined();
    expect(placeFromGeocoder(addr, { osm_type: "relation", osm_id: "7444", addresstype: "town" }).cityId).toBe("osm:relation:7444");
  });
});

describe("cityId format", () => {
  it("accepts only osm:relation:<1-12 digits>", () => {
    for (const ok of ["osm:relation:7444", "osm:relation:1", "osm:relation:123456789012"]) expect(isCityId(ok), ok).toBe(true);
    for (const bad of ["osm:relation:", "osm:relation:1234567890123", "osm:way:7444", "osm:node:1", " osm:relation:7444", "osm:relation:7444 ", "12 Rue de Rivoli", "id:x", "", 7444, null, undefined]) {
      expect(isCityId(bad), String(bad)).toBe(false);
      expect(validCityId(bad), String(bad)).toBeUndefined();
    }
  });

  it("cityKeyOf ignores an unaccepted id and keys on the name", () => {
    expect(cityKeyOf("Paris", "osm:relation:7444")).toBe("id:osm:relation:7444");
    expect(cityKeyOf("Paris", "12 Rue de Rivoli, 75004 Paris")).toBe("name:paris");
    expect(cityKeyOf("Paris", "osm:way:1")).toBe("name:paris");
    expect(cityKeyOf("Halle (Saale)")).not.toBe(cityKeyOf("Halle (Westf.)"));
  });
});

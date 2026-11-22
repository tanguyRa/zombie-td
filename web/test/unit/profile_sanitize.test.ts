import { describe, expect, it } from "vitest";
import { looksLikeAddress, placeLabel, sanitizePlace } from "../../src/profile/sanitize";
import { DISTRICT_FIXTURES, STREET_FIXTURES } from "./profile_helpers";

describe("sanitizePlace on a fixed list of real names", () => {
  it("drops real street names (Catalan, dotted abbreviations, Japanese, Korean, Chinese)", () => {
    for (const { input, want, banned } of STREET_FIXTURES) {
      const out = sanitizePlace(input);
      expect(out, input).toBe(want);
      expect(out.toLowerCase(), input).not.toContain(banned.toLowerCase());
    }
  });

  it("keeps real district names that look a little like streets", () => {
    for (const name of DISTRICT_FIXTURES) expect(sanitizePlace(name), name).toBe(name);
  });

  it("Paris arrondissements keep the city, never a digit or a lone generic word", () => {
    const cases: [string, string][] = [
      ["Paris 4e Arrondissement", "Paris"],
      ["1st Arrondissement", ""],
      ["Marseille 13e Arrondissement", "Marseille"],
      ["4e Arrondissement, Paris", "Paris"],
      ["Bezirk 7, Wien", "Wien"],
      ["3. Bezirk, Wien", "Wien"],
      ["District 1, Ho Chi Minh City", "Ho Chi Minh City"],
      ["Arrondissement de Lyon", "Arrondissement de Lyon"],
    ];
    for (const [input, want] of cases) {
      const out = sanitizePlace(input);
      expect(out, input).toBe(want);
      expect(out, input).not.toMatch(/\d/);
    }
    expect(placeLabel("Paris 4e Arrondissement", "Paris")).toBe("Paris");
    expect(placeLabel("1st Arrondissement", "Paris")).toBe("Paris");
  });
});

describe("sanitizePlace", () => {
  it("keeps plain district and city names", () => {
    for (const name of [
      "Paris",
      "Le Marais",
      "Saint-Germain-des-Prés",
      "Champs-Élysées",
      "Kreuzberg",
      "Trastevere",
      "Al Ain",
      "Largo",
      "Rue",
      "St Albans",
      "Saint-Étienne",
      "Ixelles",
      "Москва",
      "Hackney",
      "L'Haÿ-les-Roses",
    ]) {
      expect(sanitizePlace(name), name).toBe(name);
    }
  });

  it("drops house numbers, postcodes and streets, keeping the place", () => {
    const cases: [string, string][] = [
      ["12 Rue de Rivoli, 75004 Paris", "Paris"],
      ["75004 Paris", "Paris"],
      ["Paris 4e Arrondissement", "Paris"],
      ["221B Baker Street, London NW1 6XE", "London"],
      ["London SW1A 1AA", "London"],
      ["1600 Pennsylvania Avenue NW, Washington, DC 20500", "Washington"],
      ["Hauptstraße 5, 10115 Berlin", "Berlin"],
      ["Unter den Linden 77, Berlin", "Berlin"],
      ["Strasse des 17. Juni, Tiergarten", "Tiergarten"],
      ["Kalverstraat 92, 1012 PH Amsterdam", "Amsterdam"],
      ["Prinsengracht 263, Amsterdam", "Amsterdam"],
      ["Calle de Alcalá 42, 28014 Madrid", "Madrid"],
      ["C/ Mayor 3, Madrid", "Madrid"],
      ["Avenida da Liberdade 110, 1250-146 Lisboa", "Lisboa"],
      ["Rua Augusta, Lisboa", "Lisboa"],
      ["Via del Corso 1, 00186 Roma", "Roma"],
      ["Piazza Navona, Roma", "Roma"],
      ["ul. Marszałkowska 10, 00-950 Warszawa", "Warszawa"],
      ["Drottninggatan 5, 111 51 Stockholm", "Stockholm"],
      ["Nørregade 7, København", "København"],
      ["Boulevard Haussmann, Paris", "Paris"],
      ["Bd Haussmann, Paris", "Paris"],
      ["10 Downing St, Westminster", "Westminster"],
      ["742 Evergreen Terrace, Springfield", "Springfield"],
      ["Main St, Springfield", "Springfield"],
      ["Av. Paulista 1578, São Paulo", "São Paulo"],
      ["Allée des Cygnes, Paris", "Paris"],
      ["Quai de la Tournelle, Paris", "Paris"],
      ["Impasse du Moulin, Lyon", "Lyon"],
      ["Chemin des Vignes, Bordeaux", "Bordeaux"],
      ["Place de la Concorde, Paris", "Paris"],
      ["12 bis, Montreuil", "Montreuil"],
      ["No. 5, Brooklyn", "Brooklyn"],
      ["Toronto ON M5V 2T6", "Toronto ON"],
      ["Tverskaya ulitsa, улица Тверская 7, Москва", "Tverskaya ulitsa"],
      ["İstiklal Caddesi, Beyoğlu", "Beyoğlu"],
      ["Hlavní třída 12, Ostrava", "Ostrava"],
    ];
    for (const [input, want] of cases) expect(sanitizePlace(input), input).toBe(want);
  });

  it("returns empty for a bare street or number", () => {
    for (const input of ["12 Rue de Rivoli", "Baker Street", "75004", "Hauptstraße 5", "Via Roma 10", "", "   ", null, undefined]) {
      expect(sanitizePlace(input as string), String(input)).toBe("");
    }
  });

  it("never outputs a digit or a street, on hostile inputs", () => {
    const parts = ["12", "221B", "Rue", "Street", "Avenue", "Straße", "Via", "Calle", "Rua", "ul.", "Paris", "London", "Le Marais", "75004", "SW1A 1AA", "1012 AB", "00-950", ",", " - ", "bis", "Platz", "Gasse", "Strada", "Main", "St", "Rd", "Blvd"];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const k = 1 + rnd(6);
      const input = Array.from({ length: k }, () => parts[rnd(parts.length)]).join(rnd(2) ? " " : ", ");
      const out = sanitizePlace(input);
      expect(/\d/.test(out), `${input} -> ${out}`).toBe(false);
      expect(looksLikeAddress(out), `${input} -> ${out}`).toBe(false);
    }
  });

  it("trims long names and control characters", () => {
    expect(sanitizePlace("Paris\u0000\u0007")).toBe("Paris");
    expect(sanitizePlace("A".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe("placeLabel", () => {
  it("joins district and city, falls back", () => {
    expect(placeLabel("Le Marais", "Paris")).toBe("Le Marais, Paris");
    expect(placeLabel("12 Rue des Rosiers", "Paris")).toBe("Paris");
    expect(placeLabel("Paris", "paris")).toBe("Paris");
    expect(placeLabel("", "")).toBe("an unnamed district");
  });
});

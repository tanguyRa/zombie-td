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
      ["Tverskaya ulitsa, улица Тверская 7, Москва", "Москва"],
      ["Tverskaya ulitsa", ""],
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

describe("sanitizePlace, defence in depth (T7a review 2)", () => {
  // Each street, alone and before a city: the street never survives in the
  // district field.
  const STREETS = [
    // Cyrillic and transliterated Russian
    "ул. Тверская", "ул Тверская", "пр. Мира", "Невский пр.", "наб. реки Фонтанки", "пер. Сивцев Вражек", "Ленинградское ш.",
    "улица Арбат", "проспект Мира", "Leninsky Prospekt", "ulitsa Arbat", "Tverskaya ulitsa",
    // Turkish
    "İstiklal Cd.", "Bağdat Cad.", "Gül Sk.", "Atatürk Blv.", "Atatürk Bulvarı", "İstiklal Caddesi", "Gül Sokak",
    // Hungarian
    "Andrássy út", "Váci u.", "Váci utca",
    // Southeast Asia
    "Jalan Thamrin", "Jln Ampang", "Jl. Sudirman", "Soi Nana", "Thanon Sukhumvit", "Đường Lê Lợi", "Phố Huế",
    // India, Israel
    "Netaji Subhash Marg", "Kartavya Path", "Rehov Dizengoff", "Sderot Rothschild",
    // Japanese
    "Kōshū-kaidō", "Koshu Kaido", "Mido-suji", "Midosuji",
    // German "Str." last
    "Berliner Str.",
    // Spanish, Catalan, Portuguese, French abbreviations
    "Pso. de la Castellana", "Pg. de Gràcia", "Rbla. de Catalunya", "Avgda. Diagonal", "Ptge. Permanyer", "Calz. de Tlalpan", "Calzada de Tlalpan",
    "Jr. de la Unión", "Jirón de la Unión", "Diag. Norte", "Tv. do Carmo", "Lgo. do Chiado", "Pç. do Comércio", "Calçada do Combro", "Ladeira da Glória",
    "Sq. Louvois", "All. des Brouillards", "Ch. des Vignes", "Fg Saint-Denis",
    // Venetian
    "Fondamenta Nove", "Salizada San Lio",
    // Glued suffixes
    "Kurfürstendamm", "Mainufer", "Wangfujingdajie", "Wudaoyinghutong",
  ];

  it("drops the added street forms, alone and before a city", () => {
    for (const s of STREETS) {
      expect(sanitizePlace(s), s).toBe("");
      expect(sanitizePlace(`${s}, Testville`), s).toBe("Testville");
      expect(placeLabel(s, "Testville"), s).toBe("Testville");
    }
  });

  it("keeps real district names (must-keep list)", () => {
    const cases: [string, string][] = [
      ["Carnoustie", "Carnoustie"],
      ["Landstraße", "Landstraße"],
      ["Kreis Bergstraße", "Kreis Bergstraße"],
      ["Caferağa Mahallesi", "Caferağa Mahallesi"],
      ["Praha 1", "Praha"],
      ["Wien 3", "Wien"],
      ["Lu County", "Lu County"],
      ["Lu-kang", "Lu-kang"],
    ];
    for (const [input, want] of cases) expect(sanitizePlace(input), input).toBe(want);
    for (const name of DISTRICT_FIXTURES) expect(sanitizePlace(name), name).toBe(name);
  });

  it("a numbered district keeps its name only when it is the whole field", () => {
    expect(sanitizePlace("Unter den Linden 77")).toBe("");
    expect(sanitizePlace("Strøget 4, København")).toBe("København");
    expect(sanitizePlace("Bezirk 7")).toBe("");
    expect(sanitizePlace("Soi 11")).toBe("");
    expect(sanitizePlace("Street 12")).toBe("");
    expect(placeLabel("Praha 1", "Praha")).toBe("Praha");
    // Vietnamese numbered divisions: the bare division word names nothing.
    for (const d of ["Quận 1", "Phường 12", "Huyện 3", "quan 7"]) expect(sanitizePlace(d), d).toBe("");
    expect(placeLabel("Quận 1", "Thành phố Hồ Chí Minh")).toBe("Thành phố Hồ Chí Minh");
    expect(sanitizePlace("Quận Ba Đình")).toBe("Quận Ba Đình");
  });

  it("the city field keeps real towns that start with a street word (must-keep list)", () => {
    for (const name of [
      "Neustadt an der Weinstraße",
      "Piazza Armerina",
      "Crescent City",
      "Road Town",
      "Plaza Huincul",
      "Passage West",
      "Cours-la-Ville",
      "Strada in Chianti",
      "Carnoustie",
      "Kreis Bergstraße",
      "Lu County",
      "Lu-kang",
      "Paris",
      "Москва",
      "St Albans",
    ]) {
      expect(sanitizePlace(name, "city"), name).toBe(name);
    }
    expect(sanitizePlace("Praha 1", "city")).toBe("Praha");
    expect(sanitizePlace("Wien 3", "city")).toBe("Wien");
    // "Ave" starts a street only when dotted in the city mode: "Ave Maria" is a town.
    expect(sanitizePlace("Ave Maria", "city")).toBe("Ave Maria");
    expect(sanitizePlace("Ave. Maria", "city")).toBe("");
    expect(sanitizePlace("Ave. Foch, Paris", "city")).toBe("Paris");
    expect(sanitizePlace("Ave Maria, Florida", "city")).toBe("Ave Maria");
    expect(sanitizePlace("Ave Maria")).toBe("");
    expect(placeLabel("", "Piazza Armerina")).toBe("Piazza Armerina");
  });

  it("the city field keeps a parenthesised qualifier: Halle (Saale) and Halle (Westf.) stay distinct", () => {
    expect(sanitizePlace("Halle (Saale)", "city")).toBe("Halle (Saale)");
    expect(sanitizePlace("Halle (Westf.)", "city")).toBe("Halle (Westf.)");
    expect(sanitizePlace("Frankfurt (Oder)", "city")).toBe("Frankfurt (Oder)");
    // A qualifier that is a street or holds a digit goes.
    expect(sanitizePlace("Halle (Rue de Rivoli)", "city")).toBe("Halle");
    expect(sanitizePlace("Halle (75004)", "city")).toBe("Halle");
    // Idempotent: a stored name sanitises to itself.
    expect(sanitizePlace(sanitizePlace("Halle (Saale)", "city"), "city")).toBe("Halle (Saale)");
  });

  it("the city field still drops numbers, postcodes, abbreviations and a street next to the city", () => {
    const cases: [string, string][] = [
      ["12 Rue de Rivoli, 75004 Paris", "Paris"],
      ["Rue de Rivoli, Paris", "Paris"],
      ["Tverskaya ulitsa, Москва", "Москва"],
      ["Paris 4e Arrondissement", "Paris"],
      ["London SW1A 1AA", "London"],
      ["Main St", ""],
      ["ul. Marszałkowska", ""],
      ["İstiklal Cd.", ""],
      ["Teheran-ro", ""],
      ["12 Rue de Rivoli", ""],
      ["Bezirk 7, Wien", "Wien"],
    ];
    for (const [input, want] of cases) expect(sanitizePlace(input, "city"), input).toBe(want);
  });

  it("the city field never outputs a digit, on hostile inputs", () => {
    const parts = ["12", "221B", "Rue", "Street", "Paris", "London", "75004", "SW1A 1AA", "1012 AB", "00-950", ",", " - ", "bis", "(Saale)", "(12)", "Main", "St", "Rd", "Blvd"];
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const input = Array.from({ length: 1 + rnd(6) }, () => parts[rnd(parts.length)]).join(rnd(2) ? " " : ", ");
      const out = sanitizePlace(input, "city");
      expect(/\d/.test(out), `${input} -> ${out}`).toBe(false);
      expect(/\b(St|Rd|Blvd)$/.test(out), `${input} -> ${out}`).toBe(false);
    }
  });
});

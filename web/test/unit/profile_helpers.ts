import type { Clock } from "../../src/profile/rewards";
import type { MatchSummary, Tier } from "../../src/profile/types";

/// A settable clock: epoch ms and a UTC offset in minutes (east positive).
export class FakeClock implements Clock {
  constructor(
    public t: number,
    public offset = 0,
  ) {}
  now() {
    return this.t;
  }
  utcOffsetMinutes() {
    return this.offset;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/// 2026-11-22 10:00 UTC.
export const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);

export const PARIS = { lat: 48.8566, lon: 2.3522 };

let n = 0;
/// A cleared (default) or abandoned match summary.
export function summary(over: Partial<MatchSummary> = {}): MatchSummary {
  const wavesWon = over.wavesWon ?? 8;
  const s: MatchSummary = {
    matchId: `m-${++n}`,
    center: PARIS,
    city: "Paris",
    district: "Le Marais",
    tier: "recruit" as Tier,
    wavesWon,
    furthestWave: Math.min(8, wavesWon + 1),
    savedPerWave: Array.from({ length: wavesWon }, (_, i) => 1000 * (i + 1)),
    retries: 0,
    mvpCard: "rifles",
    defendedRadiusM: wavesWon >= 8 ? 1300 : 0,
    runRecordId: `rr-${n}`,
    ...over,
  };
  return s;
}

/// Real street names and address lines, with the output a stamp must show
/// (written by hand, not derived from the sanitiser). `banned` is a word of
/// the street that must never reach a stamp or a lore line.
export const STREET_FIXTURES: { input: string; want: string; banned: string }[] = [
  // Catalan
  { input: "Carrer de Mallorca", want: "", banned: "Mallorca" },
  { input: "Carrer de Mallorca 401, Barcelona", want: "Barcelona", banned: "Mallorca" },
  { input: "Passeig de Gràcia", want: "", banned: "Passeig" },
  { input: "Passeig de Gràcia 92, 08008 Barcelona", want: "Barcelona", banned: "Passeig" },
  { input: "Avinguda Diagonal", want: "", banned: "Diagonal" },
  { input: "Plaça de Catalunya", want: "", banned: "Plaça" },
  { input: "Placa de Catalunya, Barcelona", want: "Barcelona", banned: "Placa" },
  { input: "La Rambla", want: "", banned: "Rambla" },
  { input: "La Rambla, Barcelona", want: "Barcelona", banned: "Rambla" },
  { input: "Travessera de Gràcia, Barcelona", want: "Barcelona", banned: "Travessera" },
  // Dotted and abbreviated forms
  { input: "V.le Monza", want: "", banned: "Monza" },
  { input: "V.le Monza 12, Milano", want: "Milano", banned: "Monza" },
  { input: "P.za Duomo", want: "", banned: "Duomo" },
  { input: "P.za Duomo, Milano", want: "Milano", banned: "Duomo" },
  { input: "C.so Buenos Aires, Milano", want: "Milano", banned: "Buenos" },
  { input: "Pº de la Castellana", want: "", banned: "Castellana" },
  { input: "P.º de la Castellana 89, Madrid", want: "Madrid", banned: "Castellana" },
  { input: "Ctra. de Valencia", want: "", banned: "Valencia" },
  { input: "Imp. des Lilas", want: "", banned: "Lilas" },
  { input: "Imp. des Lilas, Paris", want: "Paris", banned: "Lilas" },
  { input: "Fbg Saint-Antoine", want: "", banned: "Antoine" },
  { input: "Fbg Saint-Antoine, Paris", want: "Paris", banned: "Antoine" },
  { input: "Rte de Lyon, Grenoble", want: "Grenoble", banned: "Lyon" },
  // Japanese, Korean, Chinese
  { input: "Meiji-dori", want: "", banned: "Meiji" },
  { input: "Omotesando-dori", want: "", banned: "Omotesando" },
  { input: "Omotesandō-dōri, Shibuya", want: "Shibuya", banned: "Omotesand" },
  { input: "Teheran-ro", want: "", banned: "Teheran" },
  { input: "Teheran-ro, Gangnam-gu", want: "Gangnam-gu", banned: "Teheran" },
  { input: "Insadong-gil, Jongno-gu", want: "Jongno-gu", banned: "Insadong" },
  { input: "Sejong-daero, Seoul", want: "Seoul", banned: "Sejong" },
  { input: "Nanjing Lu", want: "", banned: "Nanjing" },
  { input: "Nanjing Lu, Shanghai", want: "Shanghai", banned: "Nanjing" },
  { input: "Chang'an Jie, Beijing", want: "Beijing", banned: "Chang" },
  // Already handled before, kept as fixtures
  { input: "12 Rue de Rivoli, 75004 Paris", want: "Paris", banned: "Rivoli" },
  { input: "221B Baker Street, London NW1 6XE", want: "London", banned: "Baker" },
  { input: "Hauptstraße 5, 10115 Berlin", want: "Berlin", banned: "Haupt" },
  { input: "Via del Corso 1, 00186 Roma", want: "Roma", banned: "Corso" },
  { input: "Kalverstraat 92, 1012 PH Amsterdam", want: "Amsterdam", banned: "Kalver" },
  { input: "Drottninggatan 5, 111 51 Stockholm", want: "Stockholm", banned: "Drottning" },
];

/// Real district and city names that look a little like streets: they must
/// come out unchanged.
export const DISTRICT_FIXTURES = [
  "Roppongi",
  "Gangnam-gu",
  "Jongno-gu",
  "Shibuya",
  "Shibuya-ku",
  "Le Marais",
  "Gràcia",
  "Montmartre",
  "Eixample",
  "Sant Gervasi",
  "Rambla",
  "Pudong",
  "Lujiazui",
  "Myeong-dong",
  "Navigli",
  "Brera",
  "Malasaña",
];

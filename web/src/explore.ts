// Map screen: a street map (MapLibre + OpenFreeMap tiles) where the player
// browses, searches an address (Nominatim) and drops a pin. "Start here"
// hands the pin to the game, which streams its map in blocks (the dashed
// circle is the wave-8 play area).
// The same map stays on screen during the game, under the deck.gl layers.
import maplibregl, { GeoJSONSource, LngLatLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PLAY_RADIUS_M } from "./stream";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const LAST_KEY = "ztd.lastPlace";

export interface Place {
  lat: number;
  lon: number;
  name: string;
  /// Committed level pack instead of a live download (the built-in levels).
  presetUrl?: string;
}

export interface ExploreOptions {
  presets: Place[];
  onStart: (p: Place) => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function circleGeoJson(lat: number, lon: number, r: number) {
  const coords: [number, number][] = [];
  const kx = 1 / (Math.cos((lat * Math.PI) / 180) * 111320);
  const ky = 1 / 110540;
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    coords.push([lon + r * Math.cos(t) * kx, lat + r * Math.sin(t) * ky]);
  }
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [coords] } };
}

function shortName(display: string): string {
  // Nominatim display names are long ("12, Rue X, Quartier, Paris, Île-de-France, 75004, France").
  return display.split(",").slice(0, 3).join(",").trim();
}

function loadLast(): Place | null {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return v ? (JSON.parse(v) as Place) : null;
  } catch {
    return null;
  }
}

function saveLast(p: Place) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ lat: p.lat, lon: p.lon, name: p.name }));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

export function createExplore(opts: ExploreOptions) {
  const last = loadLast();
  const start = last ?? opts.presets[0];
  let pick: Place | null = last ? { ...last } : null;
  let reverseSeq = 0;
  let active = true;

  const map = new maplibregl.Map({
    container: "map",
    style: STYLE_URL,
    center: [start.lon, start.lat],
    zoom: 15,
    attributionControl: { compact: true },
  });
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "bottom-right");
  const marker = new maplibregl.Marker({ color: "#e53935" });
  if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = map;

  map.on("load", () => {
    map.addSource("area", { type: "geojson", data: circleGeoJson(start.lat, start.lon, PLAY_RADIUS_M) });
    map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#e53935", "fill-opacity": 0.06 } });
    map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#e53935", "line-width": 2, "line-dasharray": [2, 2] } });
    render();
  });

  map.on("click", (e) => {
    if (!active) return;
    setPick({ lat: e.lngLat.lat, lon: e.lngLat.lng, name: "Dropped pin" }, false);
    reverse(e.lngLat.lat, e.lngLat.lng);
  });

  // Game mode hides every text label and icon (street names, POIs, shields)
  // but keeps buildings, roads, water and parks.
  function setLabels(visible: boolean) {
    const style = map.getStyle();
    if (!style) return;
    for (const l of style.layers) {
      if (l.type === "symbol") map.setLayoutProperty(l.id, "visibility", visible ? "visible" : "none");
    }
  }
  map.on("load", () => {
    if (!active) setLabels(false); // game started before the style finished loading
  });

  function render() {
    if (!active) {
      marker.remove();
      (map.getSource("area") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const card = $("pick-name");
    const go = $<HTMLButtonElement>("go");
    if (!pick) {
      marker.remove();
      card.textContent = "Search an address or click the map to drop a pin.";
      go.disabled = true;
    } else {
      marker.setLngLat([pick.lon, pick.lat]).addTo(map);
      card.textContent = pick.name;
      go.disabled = false;
    }
    const src = map.getSource("area") as GeoJSONSource | undefined;
    if (src) {
      src.setData(pick ? circleGeoJson(pick.lat, pick.lon, PLAY_RADIUS_M) : { type: "FeatureCollection", features: [] });
    }
  }

  function setPick(p: Place, fly: boolean) {
    pick = p;
    if (fly) map.flyTo({ center: [p.lon, p.lat] as LngLatLike, zoom: 14.6, speed: 1.6 });
    render();
  }

  async function reverse(lat: number, lon: number) {
    const seq = ++reverseSeq;
    try {
      const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=17&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { display_name?: string };
      if (seq === reverseSeq && pick && pick.lat === lat && j.display_name) {
        pick.name = shortName(j.display_name);
        render();
      }
    } catch {
      /* keep "Dropped pin" */
    }
  }

  // Search: one request per submit (Nominatim's usage policy forbids autocomplete).
  const form = $<HTMLFormElement>("search");
  const input = $<HTMLInputElement>("search-q");
  const list = $<HTMLUListElement>("results");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    list.innerHTML = "<li class='muted'>Searching…</li>";
    list.hidden = false;
    try {
      const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(`search failed (${r.status})`);
      const items = (await r.json()) as { lat: string; lon: string; display_name: string }[];
      list.innerHTML = "";
      if (!items.length) {
        list.innerHTML = "<li class='muted'>No results</li>";
        return;
      }
      for (const it of items) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        const parts = it.display_name.split(",");
        const strong = document.createElement("strong");
        strong.textContent = parts.slice(0, 2).join(",");
        const rest = document.createElement("span");
        rest.textContent = parts.slice(2).join(",");
        b.append(strong, rest);
        b.addEventListener("click", () => {
          list.hidden = true;
          input.value = shortName(it.display_name);
          setPick({ lat: Number(it.lat), lon: Number(it.lon), name: shortName(it.display_name) }, true);
        });
        li.appendChild(b);
        list.appendChild(li);
      }
      if (items.length === 1) (list.querySelector("button") as HTMLButtonElement).click();
    } catch (err) {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = `Search unavailable: ${String(err)}`;
      list.appendChild(li);
    }
  });
  input.addEventListener("focus", () => {
    if (list.children.length) list.hidden = false;
  });
  map.on("movestart", () => (list.hidden = true));

  // Built-in levels, playable without the network.
  const presetRow = $("presets");
  for (const p of opts.presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = p.name;
    b.addEventListener("click", () => {
      saveLast(p);
      opts.onStart(p);
    });
    presetRow.appendChild(b);
  }

  $("go").addEventListener("click", () => {
    if (!pick) return;
    saveLast(pick);
    opts.onStart({ ...pick });
  });

  render();
  return {
    map,
    /// Map screen on (pin, play-area circle, click-to-pick) or off (game).
    setActive(on: boolean) {
      active = on;
      if (map.isStyleLoaded()) setLabels(on);
      render();
    },
  };
}

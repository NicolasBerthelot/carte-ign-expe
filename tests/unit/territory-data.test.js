import { describe, expect, it } from "vitest";

import gisUtils from "../../src/js/utils/gis-utils.js";
import {
  distanceMeters,
  formatDistance,
  formatHours,
  htmlToText,
  parseDateRange,
  parseLatLon,
  tileImageUrl,
  tilesAround,
  toList,
  weatherFromCode,
  wmsAroundUrl,
} from "../../src/js/territory/territory-data.js";

describe("territory-data", () => {
  it("computes distances between two points", () => {
    // Gap → Embrun : ~34 km à vol d'oiseau
    const d = distanceMeters(44.5594, 6.0786, 44.5636, 6.4950);
    expect(d).toBeGreaterThan(32000);
    expect(d).toBeLessThan(35000);
    expect(distanceMeters(48, 2, 48, 2)).toBe(0);
  });

  it("formats distances in French", () => {
    expect(formatDistance(4)).toBe("10 m");
    expect(formatDistance(648)).toBe("650 m");
    expect(formatDistance(1830)).toBe("1,8 km");
    expect(formatDistance(12400)).toBe("12 km");
    expect(formatDistance(NaN)).toBe("");
  });

  it("formats durations given in hours", () => {
    expect(formatHours(2.25)).toBe("2h15");
    expect(formatHours(0.75)).toBe("45 min");
    expect(formatHours(3)).toBe("3h");
    expect(formatHours(0)).toBe("");
    expect(formatHours("abc")).toBe("");
  });

  it("parses « lat, lon » coordinates", () => {
    expect(parseLatLon("44.556138444316,6.07707246456252")).toEqual({ lat: 44.556138444316, lng: 6.07707246456252 });
    expect(parseLatLon("45.790491, 4.797411")).toEqual({ lat: 45.790491, lng: 4.797411 });
    expect(parseLatLon("")).toBeNull();
    expect(parseLatLon("n/a")).toBeNull();
  });

  it("parses DATAtourisme date ranges", () => {
    const range = parseDateRange("Du 3 janvier 2026 au 26 décembre 2026");
    expect(range.start).toEqual(new Date(2026, 0, 3));
    expect(range.end).toEqual(new Date(2026, 11, 26));

    const short = parseDateRange("Du 3 au 26 décembre 2026");
    expect(short.start).toEqual(new Date(2026, 11, 3));
    expect(short.end).toEqual(new Date(2026, 11, 26));

    const single = parseDateRange("Le 1er novembre 2026");
    expect(single.start).toEqual(new Date(2026, 10, 1));
    expect(single.end).toEqual(new Date(2026, 10, 1));

    expect(parseDateRange("Toute l'année")).toBeNull();
    expect(parseDateRange(null)).toBeNull();
  });

  it("turns HTML and JSON-encoded paragraphs into plain text", () => {
    expect(htmlToText("<p>Château&nbsp;<strong>médiéval</strong></p><p>XIIe siècle</p>")).toBe("Château médiéval\nXIIe siècle");
    expect(htmlToText("[\"<p>Premier</p>\",\"<p>Second</p>\"]")).toBe("Premier\nSecond");
    expect(htmlToText("<img src=x onerror=alert(1)>Texte")).toBe("Texte");
    expect(htmlToText(null)).toBe("");
  });

  it("normalises list values", () => {
    expect(toList("Archéologie;Arts décoratifs;Histoire")).toEqual(["Archéologie", "Arts décoratifs", "Histoire"]);
    expect(toList(["Privé", "Parc paysager"])).toEqual(["Privé", "Parc paysager"]);
    expect(toList("[\"0470663066\"]")).toEqual(["0470663066"]);
    expect(toList(null)).toEqual([]);
  });

  it("builds Géoplateforme tile and GetFeatureInfo URLs", () => {
    const url = tileImageUrl(44.56, 6.08, 17);
    expect(url).toContain("LAYER=ORTHOIMAGERY.ORTHOPHOTOS");
    const [tile] = gisUtils.latlngToTilePixel(44.56, 6.08, 17);
    expect(url).toContain(`TILEMATRIX=17&TILEROW=${tile.y}&TILECOL=${tile.x}`);
    expect(tileImageUrl(44.56, 6.08, 14, "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2")).toContain("FORMAT=image/png");

    const gfi = wmsAroundUrl("IGNF_SITES-UNESCO", 48.636, -1.511, 15);
    expect(gfi).toContain("REQUEST=GetFeatureInfo");
    expect(gfi).toContain("QUERY_LAYERS=IGNF_SITES-UNESCO");
    expect(gfi).toContain("BUFFER=60");
  });

  it("lists the tiles covering a radius", () => {
    const tiles = tilesAround(44.56, 6.08, 15, 10);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(9);
    tiles.forEach((t) => expect(t.z).toBe(10));
  });

  it("maps WMO weather codes", () => {
    expect(weatherFromCode(0)).toEqual({ label: "Ensoleillé", icon: "sun" });
    expect(weatherFromCode(0, false).icon).toBe("moon");
    expect(weatherFromCode(63).label).toBe("Pluie");
    expect(weatherFromCode(73).icon).toBe("snow");
    expect(weatherFromCode(95).icon).toBe("storm");
  });
});

import { describe, expect, it } from "vitest";

import { distanceMeters, parseLatLon } from "../../src/js/territory/territory-data.js";
import { indexRows, nearestRows, normalizeValue, parquetUrl } from "../../src/js/territory/parquet-source.js";

// Point de test : Bourg-la-Reine (Hauts-de-Seine)
const BLR = { lat: 48.7797, lng: 2.3166 };

const rows = [
  { Reference: "PARIS-CENTRE", coordonnees_au_format_WGS84: "48.8530,2.3499" }, // Notre-Dame, ~8,5 km
  { Reference: "BLR", coordonnees_au_format_WGS84: "48.7790,2.3170" }, // dans la commune
  { Reference: "SCEAUX", coordonnees_au_format_WGS84: "48.7726,2.3007" }, // ~1,4 km
  { Reference: "SANS-COORD", coordonnees_au_format_WGS84: null },
  { Reference: "LYON", coordonnees_au_format_WGS84: "45.7640,4.8357" },
];

describe("parquet-source", () => {
  const table = indexRows(rows, (r) => parseLatLon(r.coordonnees_au_format_WGS84));

  it("ignores rows without coordinates", () => {
    expect(table.rows).toHaveLength(4);
    expect(table.lats).toBeInstanceOf(Float64Array);
  });

  it("returns the nearest rows sorted by distance within the radius", () => {
    const hits = nearestRows(table, BLR.lat, BLR.lng, 20, 10);
    expect(hits.map((h) => h.row.Reference)).toEqual(["BLR", "SCEAUX", "PARIS-CENTRE"]);
    hits.forEach((h) => {
      const exact = distanceMeters(BLR.lat, BLR.lng, h.lat, h.lng);
      expect(Math.abs(h.distance - exact)).toBeLessThan(exact * 0.01 + 1);
    });
  });

  it("applies the limit and the radius", () => {
    expect(nearestRows(table, BLR.lat, BLR.lng, 20, 1).map((h) => h.row.Reference)).toEqual(["BLR"]);
    expect(nearestRows(table, BLR.lat, BLR.lng, 5, 10).map((h) => h.row.Reference)).toEqual(["BLR", "SCEAUX"]);
  });

  it("normalizes Parquet values like the tabular API", () => {
    expect(normalizeValue(2013n)).toBe(2013);
    expect(normalizeValue(new Date("2020-12-11T00:00:00Z"))).toBe("2020-12-11");
    expect(normalizeValue("x")).toBe("x");
    expect(normalizeValue(null)).toBe(null);
  });

  it("builds the data.gouv.fr Parquet conversion URL", () => {
    expect(parquetUrl("abc")).toBe("https://hydra.s3.rbx.io.cloud.ovh.net/parquet/abc.parquet");
  });
});

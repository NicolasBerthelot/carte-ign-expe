import { describe, expect, it } from "vitest";

import {
  apiUrl,
  bamUrl,
  circleWkt,
  commonsFileName,
  commonsThumb,
  facetCounts,
  interleaveGroups,
  monthHistogram,
  parseWikidataRows,
  pickFrenchName,
  seasonLabel,
  seasonMonths,
} from "../../src/js/territory/biodiversity-data.js";

/** Aire signée (formule du lacet) : positive si le contour tourne dans le sens inverse des aiguilles d'une montre */
function signedArea(wkt) {
  const pts = /\(\((.+)\)\)/.exec(wkt)[1].split(",").map((p) => p.split(" ").map(Number));
  let area = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return area / 2;
}

describe("biodiversity-data", () => {
  it("builds a closed counter-clockwise circle for the GBIF", () => {
    const wkt = circleWkt(45.05, 6.08, 1000, 16);
    expect(wkt.startsWith("POLYGON((")).toBe(true);
    const pts = /\(\((.+)\)\)/.exec(wkt)[1].split(",");
    expect(pts).toHaveLength(17);
    expect(pts[0]).toBe(pts[16]);
    expect(signedArea(wkt)).toBeGreaterThan(0);
    // ~1 km vers l'est
    const [lng0] = pts[0].split(" ").map(Number);
    expect((lng0 - 6.08) * 111320 * Math.cos(45.05 * Math.PI / 180)).toBeCloseTo(1000, -1);
  });

  it("repeats array parameters and skips empty ones", () => {
    const url = apiUrl("https://x/y", { classKey: [358, 131], month: undefined, limit: 0 });
    expect(url).toBe("https://x/y?classKey=358&classKey=131&limit=0");
  });

  it("computes the current season, wrapping around the year", () => {
    expect(seasonMonths(new Date(2026, 10, 26))).toEqual([10, 11, 12]);
    expect(seasonMonths(new Date(2026, 0, 5))).toEqual([12, 1, 2]);
    expect(seasonMonths(new Date(2026, 11, 5))).toEqual([11, 12, 1]);
    expect(seasonLabel([10, 11, 12])).toBe("octobre à décembre");
  });

  it("reads GBIF facets and month histograms", () => {
    const json = { facets: [{ field: "MONTH", counts: [{ name: "5", count: 12 }, { name: "11", count: 3 }] }] };
    const counts = facetCounts(json, "MONTH");
    expect(counts).toEqual([{ key: "5", count: 12 }, { key: "11", count: 3 }]);
    expect(facetCounts(json, "SPECIES_KEY")).toEqual([]);
    const months = monthHistogram(counts);
    expect(months).toHaveLength(12);
    expect(months[4]).toBe(12);
    expect(months[10]).toBe(3);
    expect(months[0]).toBe(0);
  });

  it("interleaves groups so that birds do not take the whole carousel", () => {
    const groups = {
      oiseaux: { species: [{ key: "o1" }, { key: "o2" }, { key: "o3" }] },
      plantes: { species: [{ key: "p1" }] },
      mammiferes: { species: [{ key: "m1" }, { key: "m2" }] },
    };
    expect(interleaveGroups(groups, 5).map((s) => s.key)).toEqual(["o1", "p1", "m1", "o2", "m2"]);
    expect(interleaveGroups({}, 5)).toEqual([]);
  });

  it("prefers TAXREF French vernacular names", () => {
    expect(pickFrenchName([
      { vernacularName: "herring gull", language: "eng", source: "TAXREF" },
      { vernacularName: "goéland argenté (CoL)", language: "fra", source: "Catalogue of Life" },
      { vernacularName: "goéland argenté", language: "fra", source: "TAXREF v17" },
    ])).toBe("Goéland argenté");
    expect(pickFrenchName([])).toBe("");
  });

  it("merges Wikidata rows per species", () => {
    const rows = [
      {
        gbif: { value: "2481139" },
        item: { value: "http://www.wikidata.org/entity/Q30276" },
        name: { value: "Larus argentatus" },
        fr: { value: "goéland argenté" },
        image: { value: "http://commons.wikimedia.org/wiki/Special:FilePath/Larus%20argentatus.jpg" },
        taxref: { value: "3558" },
        iucn: { value: "http://www.wikidata.org/entity/Q211005" },
      },
      { gbif: { value: "2481139" }, fr: { value: "autre nom" } },
    ];
    const out = parseWikidataRows(rows);
    expect(out["2481139"]).toMatchObject({
      wikidata: "Q30276",
      frName: "Goéland argenté",
      scientificName: "Larus argentatus",
      taxref: "3558",
      iucn: { code: "LC", label: "Préoccupation mineure" },
    });
  });

  it("builds Commons thumbnails and BAM links", () => {
    const url = "http://commons.wikimedia.org/wiki/Special:FilePath/Larus%20argentatus.jpg";
    expect(commonsThumb(url, 300)).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/Larus%20argentatus.jpg?width=300");
    expect(commonsThumb("")).toBe("");
    expect(commonsFileName(url)).toBe("Larus argentatus.jpg");
    const bam = bamUrl(45.05, 6.08, 1000);
    expect(bam.startsWith("https://bam.geonature.fr/#/?")).toBe(true);
    expect(decodeURIComponent(bam)).toContain("wkt=POINT(6.08000+45.05000)");
    expect(bam).toContain("buffer=1000");
  });
});

describe("biodiversity-data — replis", () => {
  it("removes the TAXREF trailing article from French names", async () => {
    const { capitalizeName, pickFrenchName } = await import("../../src/js/territory/biodiversity-data.js");
    expect(capitalizeName("crapaud épineux (Le)")).toBe("Crapaud épineux");
    expect(capitalizeName("Mésange bleue (La)")).toBe("Mésange bleue");
    expect(pickFrenchName([{ vernacularName: "Crapaud épineux (Le)", language: "fra", source: "TAXREF" }])).toBe("Crapaud épineux");
  });

  it("uses a reduced iNaturalist photo shared with an observation", async () => {
    const { photoFromOccurrences } = await import("../../src/js/territory/biodiversity-data.js");
    const photo = photoFromOccurrences([
      { key: 1, media: [] },
      {
        key: 42,
        publisher: "iNaturalist",
        media: [{
          type: "StillImage",
          identifier: "https://inaturalist-open-data.s3.amazonaws.com/photos/605616752/original.jpg",
          creator: "luluchouette",
          license: "http://creativecommons.org/licenses/by/4.0/",
          publisher: "iNaturalist",
        }],
      },
    ]);
    expect(photo).toEqual({
      url: "https://inaturalist-open-data.s3.amazonaws.com/photos/605616752/medium.jpg",
      thumb: "https://inaturalist-open-data.s3.amazonaws.com/photos/605616752/small.jpg",
      credit: "luluchouette · iNaturalist · CC BY 4.0",
      link: "https://www.gbif.org/occurrence/42",
    });
    expect(photoFromOccurrences([{ key: 3, media: [{ identifier: "http://insecure/x.jpg" }] }])).toBeNull();
  });
});

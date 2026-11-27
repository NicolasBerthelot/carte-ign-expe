import { describe, expect, it } from "vitest";

import ExternalGfi from "../../src/js/map-interactivity/external-gfi";

// Réponse au format msGMLOutput de MapServer (attributs relevés sur viirs.hs.query)
const GML = `<?xml version="1.0" encoding="UTF-8"?>
<msGMLOutput xmlns:gml="http://www.opengis.net/gml" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <all.hs.query_layer>
    <gml:name>all.hs.query</gml:name>
    <all.hs.query_feature>
      <gml:boundedBy><gml:Box srsName="EPSG:3857"><gml:coordinates>1,2 1,2</gml:coordinates></gml:Box></gml:boundedBy>
      <lon>1.4321</lon>
      <lat>43.1234</lat>
      <acq_date>2026-11-25 12:40:00</acq_date>
      <satellite>N20</satellite>
      <confidence>l</confidence>
      <frp>2.2</frp>
      <name_1>Occitanie</name_1>
      <name_2>Ariège</name_2>
    </all.hs.query_feature>
    <all.hs.query_feature>
      <lon>1.5</lon>
      <lat>43.2</lat>
      <acq_date>2026-11-24 01:10:00</acq_date>
      <satellite>N</satellite>
      <confidence>h</confidence>
      <frp>10</frp>
    </all.hs.query_feature>
  </all.hs.query_layer>
</msGMLOutput>`;

describe("external-gfi", () => {
  it("lit les entités d'une réponse GML MapServer", () => {
    const features = ExternalGfi.parseMapServerGml(GML);
    expect(features).toHaveLength(2);
    expect(features[0]).toMatchObject({ lon: "1.4321", acq_date: "2026-11-25 12:40:00", confidence: "l", name_2: "Ariège" });
    expect(features[0]).not.toHaveProperty("boundedBy");
  });

  it("renvoie une liste vide pour une réponse vide ou invalide", () => {
    expect(ExternalGfi.parseMapServerGml("<msGMLOutput></msGMLOutput>")).toEqual([]);
    expect(ExternalGfi.parseMapServerGml("pas du xml <")).toEqual([]);
  });

  it("normalise la confiance VIIRS et MODIS", () => {
    expect(ExternalGfi.normalizeConfidence("l")).toBe("low");
    expect(ExternalGfi.normalizeConfidence("Nominal")).toBe("nominal");
    expect(ExternalGfi.normalizeConfidence("High")).toBe("high");
    expect(ExternalGfi.normalizeConfidence("12")).toBe("low");
    expect(ExternalGfi.normalizeConfidence("55")).toBe("nominal");
    expect(ExternalGfi.normalizeConfidence("95")).toBe("high");
    expect(ExternalGfi.normalizeConfidence(null)).toBeNull();
  });

  it("met en forme le point le plus proche du clic, avec un avertissement si la confiance est faible", () => {
    const features = ExternalGfi.parseMapServerGml(GML);
    const result = ExternalGfi.renderEffisHotspot(features, { lng: 1.43, lat: 43.12 });
    expect(result.title).toContain("Point chaud détecté par satellite");
    expect(result.title).toContain("25 novembre 2026");
    expect(result.title).toContain("13:40"); // 12:40 UTC = 13:40 à Paris
    expect(result.html).toContain("faible");
    expect(result.html).toContain("faux positif");
    expect(result.html).toContain("NOAA-20 (VIIRS)");
    expect(result.html).toContain("Ariège, Occitanie");
    expect(result.html).toContain("2 détections");
    expect(result.lngLat).toEqual([1.4321, 43.1234]);
  });

  it("ne renvoie rien sans entité", () => {
    expect(ExternalGfi.renderEffisHotspot([], { lng: 0, lat: 0 })).toBeNull();
  });

  it("construit les URL GetMap et GetFeatureInfo", () => {
    const server = "https://maps.effis.emergency.copernicus.eu/gwis?SERVICE=WMS&";
    const bbox = [0, 0, 100, 100];
    const getMap = ExternalGfi.getMapUrl(server, "all.hs.week", bbox);
    expect(getMap).toContain("gwis?SERVICE=WMS&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap");
    expect(getMap).toContain("STYLES=&");
    expect(getMap).toContain("CRS=EPSG:3857");

    const gfi = ExternalGfi.getFeatureInfoUrl(server, { layer: "all.hs.query", days: 7 }, bbox, new Date("2026-11-27T10:00:00Z"));
    expect(gfi).toContain("QUERY_LAYERS=all.hs.query");
    expect(gfi).toContain("INFO_FORMAT=application/vnd.ogc.gml");
    expect(gfi).toContain("TIME=2026-11-21/2026-11-27");
    expect(gfi).toContain(`WIDTH=${ExternalGfi.GFI_IMAGE_SIZE}`);
  });

  it("détecte un pixel non transparent près du centre seulement", () => {
    const width = 101;
    const data = new Uint8ClampedArray(width * width * 4);
    expect(ExternalGfi.hasOpaquePixelNearCenter(data, width)).toBe(false);
    // pixel opaque loin du centre
    data[(0 * width + 0) * 4 + 3] = 255;
    expect(ExternalGfi.hasOpaquePixelNearCenter(data, width)).toBe(false);
    // pixel opaque à 8 px du centre
    data[(50 * width + 58) * 4 + 3] = 255;
    expect(ExternalGfi.hasOpaquePixelNearCenter(data, width)).toBe(true);
  });
});

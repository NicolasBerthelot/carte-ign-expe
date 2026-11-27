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

// Réponses réelles du MapServer GWIS (relevées le 27/11/2026, extraits)
const GML_HS_REAL = `<?xml version="1.0" encoding="UTF-8"?>
<msGMLOutput xmlns:gml="http://www.opengis.net/gml" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<all.hs.query_layer>
	<gml:name>all.hs.query</gml:name>
		<all.hs.query_feature>
			<gml:boundedBy><gml:Box srsName="EPSG:3857"><gml:coordinates>296908.006259,5352832.150250 296908.006259,5352832.150250</gml:coordinates></gml:Box></gml:boundedBy>
			<id>69923411970</id>
			<acq_at>2026-11-23 15:07:00</acq_at>
			<acq_date>2026-11-23</acq_date>
			<acq_time>15:07:00</acq_time>
			<lon>2.66717</lon>
			<lat>43.26786</lat>
			<frp>7.2000000000000000</frp>
			<confidence>Nominal</confidence>
			<satellite>MODIS AQUA</satellite>
			<name_0>France</name_0>
			<name_1>Occitanie</name_1>
			<name_2>Aude</name_2>
			<CLASS>7DAYS_A</CLASS>
		</all.hs.query_feature>
	</all.hs.query_layer>
</msGMLOutput>`;

const GML_BA_REAL = `<?xml version="1.0" encoding="UTF-8"?>
<msGMLOutput xmlns:gml="http://www.opengis.net/gml" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<nrt.ba.query_layer>
	<gml:name>nrt.ba.query</gml:name>
		<nrt.ba.query_feature>
			<gml:boundedBy><gml:Box srsName="EPSG:3857"><gml:coordinates>22261.738821,5084105.777779 24099.489510,5086401.800060</gml:coordinates></gml:Box></gml:boundedBy>
			<id>15356735</id>
			<fire_id>15356735</fire_id>
			<initialdate>2026-06-19 00:50:00</initialdate>
			<finaldate>2026-06-20 02:11:00</finaldate>
			<area_ha>186</area_ha>
		</nrt.ba.query_feature>
		<nrt.ba.query_feature>
			<gml:boundedBy><gml:Box srsName="EPSG:3857"><gml:coordinates>19227.102450,5148687.688746 20979.271235,5150798.810095</gml:coordinates></gml:Box></gml:boundedBy>
			<id>15382906</id>
			<initialdate>2026-06-22 13:53:00</initialdate>
			<finaldate>2026-07-03 13:46:00</finaldate>
			<area_ha>147</area_ha>
		</nrt.ba.query_feature>
		<nrt.ba.query_feature>
			<gml:boundedBy><gml:Box srsName="EPSG:3857"><gml:coordinates>19238.301451,5148532.103660 20972.525014,5150836.219006</gml:coordinates></gml:Box></gml:boundedBy>
			<id>15616459</id>
			<initialdate>2026-08-10 02:11:00</initialdate>
			<finaldate>2026-08-20 13:27:00</finaldate>
			<area_ha>157</area_ha>
		</nrt.ba.query_feature>
	</nrt.ba.query_layer>
</msGMLOutput>`;

describe("external-gfi (réponses réelles EFFIS)", () => {
  it("affiche la date et l'heure à partir de acq_at", () => {
    const features = ExternalGfi.parseMapServerGml(GML_HS_REAL);
    const result = ExternalGfi.renderEffisHotspot(features, { lng: 2.667, lat: 43.268 });
    expect(result.title).toContain("23 novembre 2026");
    expect(result.title).toContain("16:07"); // 15:07 UTC
    expect(result.html).toContain("moyenne");
    expect(result.html).toContain("MODIS AQUA");
    expect(result.html).toContain("Aude, Occitanie");
  });

  it("lit l'emprise des surfaces brûlées", () => {
    const features = ExternalGfi.parseMapServerGml(GML_BA_REAL);
    expect(features).toHaveLength(3);
    expect(features[0]._bbox).toEqual([22261.738821, 5084105.777779, 24099.489510, 5086401.800060]);
    expect(Object.keys(features[0])).not.toContain("_bbox");
  });

  it("garde la surface brûlée sous le clic", () => {
    const features = ExternalGfi.parseMapServerGml(GML_BA_REAL);
    const result = ExternalGfi.renderEffisBurntArea(features, { lng: 0.21, lat: 41.5 }, [23000, 5085000]);
    expect(result.title).toContain("Surface brûlée");
    expect(result.title).toContain("Du 19 juin 2026 au 20 juin 2026");
    expect(result.html).toContain("186 ha");
    expect(result.count).toBe(1);
  });

  it("prend la plus récente quand plusieurs surfaces se superposent", () => {
    const features = ExternalGfi.parseMapServerGml(GML_BA_REAL);
    const result = ExternalGfi.renderEffisBurntArea(features, { lng: 0.18, lat: 41.9 }, [20000, 5150000]);
    expect(result.title).toContain("10 août 2026");
    expect(result.html).toContain("157 ha");
    expect(result.html).toContain("2 surfaces brûlées");
  });

  it("prend la surface la plus proche si le clic est à côté", () => {
    const features = ExternalGfi.parseMapServerGml(GML_BA_REAL);
    const result = ExternalGfi.renderEffisBurntArea(features, { lng: 0, lat: 0 }, [25000, 5087000]);
    expect(result.html).toContain("186 ha");
  });

  it("utilise la saison en cours pour le paramètre TIME", () => {
    const url = ExternalGfi.getFeatureInfoUrl("https://x/wms?", { layer: "nrt.ba.query", season: true }, [0, 0, 1, 1], new Date("2026-11-27T10:00:00Z"));
    expect(url).toContain("TIME=2026-01-01/2026-11-27");
  });
});

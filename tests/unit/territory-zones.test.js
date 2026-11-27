import { describe, expect, it, vi } from "vitest";

import ZoneIndex, {
  buildTileUrl,
  COMMUNE_TYPE,
  departementLabel,
  normalizeZoneName,
  pointInGeometry,
  QUERY_TYPES,
  tileBounds,
  tileKey,
  toCommune,
} from "../../src/js/territory/territory-zones";
import { inFranceBoxes, peekTexts } from "../../src/js/territory/territory-peek";

vi.mock("../../src/js/globals", () => ({ default: {} }));
vi.mock("../../src/js/services/location", () => ({ default: {} }));
vi.mock("../../src/js/territory/territory-data", () => ({
  default: {},
  distanceMeters: () => 0,
}));

const square = (x0, y0, x1, y1) => ({
  type: "Polygon",
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

describe("géométrie", () => {
  it("point dans un polygone, trous compris", () => {
    const geom = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    };
    expect(pointInGeometry(1, 1, geom)).toBe(true);
    expect(pointInGeometry(5, 5, geom)).toBe(false);
    expect(pointInGeometry(11, 5, geom)).toBe(false);
  });

  it("multipolygone", () => {
    const geom = { type: "MultiPolygon", coordinates: [square(0, 0, 1, 1).coordinates, square(5, 5, 6, 6).coordinates] };
    expect(pointInGeometry(5.5, 5.5, geom)).toBe(true);
    expect(pointInGeometry(3, 3, geom)).toBe(false);
  });

  it("dalles", () => {
    const key = tileKey(44.86, 6.47);
    expect(key).toBe("897/129");
    expect(tileBounds(key)).toEqual([44.85, 6.45, 44.9, 6.5]);
  });
});

describe("libellés", () => {
  it("normalise les toponymes", () => {
    expect(normalizeZoneName("Parc Naturel Régional du Vexin Français")).toBe("Parc naturel régional du Vexin Français");
    expect(normalizeZoneName("Forêt Domaniale de Fontainebleau ")).toBe("Forêt domaniale de Fontainebleau");
    expect(normalizeZoneName("Parc National des Écrins")).toBe("Parc national des Écrins");
  });

  it("départements", () => {
    expect(departementLabel("05")).toBe("Hautes-Alpes (05)");
    expect(departementLabel("2A")).toBe("Corse-du-Sud (2A)");
    expect(departementLabel("974")).toBe("La Réunion (974)");
  });

  it("commune au format du volet « Mon territoire »", () => {
    expect(toCommune({ nom_officiel: "Vallouise-Pelvoux", population: 1138, code_insee: "05101", code_postal: "05290/05340", code_insee_du_departement: "05" }))
      .toEqual({ name: "Vallouise-Pelvoux", population: 1138, codeInsee: "05101", postcodes: ["05290", "05340"], codeDepartement: "05", departement: "Hautes-Alpes" });
  });

  it("textes du volet replié", () => {
    const commune = toCommune({ nom_officiel: "Vallouise-Pelvoux", code_insee: "05101", code_insee_du_departement: "05" });
    expect(peekTexts({ commune })).toEqual({ title: "Vallouise-Pelvoux", subtitle: "Hautes-Alpes (05)", kicker: "" });
    expect(peekTexts({ commune, zone: { type: "parc-national-adhesion", name: "Parc national des Écrins", kicker: "Aire d'adhésion du parc national" } }).subtitle)
      .toBe("Aire d'adhésion · Vallouise-Pelvoux (05)");
    expect(peekTexts({ commune, zone: { type: "foret", name: "Forêt domaniale du Pelvoux" } }).subtitle)
      .toBe("Vallouise-Pelvoux · Hautes-Alpes (05)");
    expect(peekTexts({})).toBeNull();
  });

  it("emprise de la France", () => {
    expect(inFranceBoxes(2.35, 48.85)).toBe(true);
    expect(inFranceBoxes(55.5, -21.1)).toBe(true);
    expect(inFranceBoxes(-74, 40.7)).toBe(false);
  });
});

describe("requêtes", () => {
  it("une requête par type, objets connus exclus", () => {
    const url = decodeURIComponent(buildTileUrl(QUERY_TYPES.filter((t) => t.request === "light"), "897/129", { commune: ["COMMUNE_1"] }));
    expect(url).toContain("typeName=BDCARTO_V5:commune,BDCARTO_V5:parc_ou_reserve");
    expect(url).toContain("BBOX(geometrie,44.85,6.45,44.9,6.5) AND NOT (cleabs IN ('COMMUNE_1'));BBOX(geometrie,44.85,6.45,44.9,6.5) AND nature IN");
    expect(url).toContain("propertyName=(cleabs,nom_officiel,code_insee,code_postal,code_insee_du_departement,population,geometrie)(cleabs,nature,toponyme,geometrie)");
  });
});

describe("ZoneIndex", () => {
  const lightResponse = {
    features: [
      { id: "commune.1", properties: { cleabs: "C1", nom_officiel: "Vallouise-Pelvoux", code_insee: "05101", code_insee_du_departement: "05" }, geometry: square(6.40, 44.80, 6.55, 44.95) },
      { id: "commune.2", properties: { cleabs: "C2", nom_officiel: "Les Vigneaux", code_insee: "05181", code_insee_du_departement: "05" }, geometry: square(6.55, 44.80, 6.60, 44.95) },
      { id: "parc_ou_reserve.1", properties: { cleabs: "P1", nature: "Parc national", toponyme: "Parc National des Écrins" }, geometry: square(6.30, 44.70, 6.46, 45.00) },
      { id: "parc_ou_reserve.2", properties: { cleabs: "P2", nature: "Parc national", toponyme: "Aire d'Adhésion du Parc National des Écrins" }, geometry: square(6.0, 44.5, 7.0, 45.5) },
    ],
  };
  const heavyResponse = {
    features: [
      { id: "foret_publique.1", properties: { cleabs: "F1", nature: "Forêt domaniale", toponyme: "Forêt Domaniale du Pelvoux" }, geometry: square(6.48, 44.86, 6.50, 44.88) },
    ],
  };
  const makeIndex = () => {
    const calls = [];
    const fetchJson = vi.fn((url) => {
      calls.push(decodeURIComponent(url));
      return Promise.resolve(url.includes("foret_publique") ? heavyResponse : lightResponse);
    });
    return { index: new ZoneIndex({ fetchJson }), calls, fetchJson };
  };

  it("charge une dalle en deux requêtes puis répond sans réseau", async () => {
    const { index, fetchJson } = makeIndex();
    const key = tileKey(44.87, 6.47);
    expect(index.tileState(key)).toBe("unknown");
    const { done } = index.loadTile(key);
    expect(index.tileState(key)).toBe("pending");
    await done;
    expect(index.tileState(key)).toBe("ready");
    expect(fetchJson).toHaveBeenCalledTimes(2);

    // forêt domaniale prioritaire
    expect(index.lookup(44.87, 6.49).zone).toMatchObject({ type: "foret", name: "Forêt domaniale du Pelvoux" });
    // cœur de parc
    expect(index.lookup(44.87, 6.455).zone).toMatchObject({ type: "parc-national", name: "Parc national des Écrins" });
    // aire d'adhésion
    const adhesion = index.lookup(44.87, 6.47);
    expect(adhesion.zone).toMatchObject({ type: "parc-national-adhesion", name: "Parc national des Écrins" });
    expect(adhesion.commune.name).toBe("Vallouise-Pelvoux");

    // dalle déjà chargée : aucune nouvelle requête
    index.loadTile(key);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("exclut les objets déjà connus de la dalle voisine", async () => {
    const { index, calls } = makeIndex();
    await index.loadTile(tileKey(44.87, 6.47)).done;
    await index.loadTile(tileKey(44.92, 6.47)).done;
    const second = calls.filter((u) => u.includes("BDCARTO_V5:commune"))[1];
    expect(second).toContain("NOT (cleabs IN ('C1'))");
    expect(second).toContain("NOT (cleabs IN ('P1','P2'))");
  });

  it("les requêtes simultanées pour une même dalle ne sont pas dupliquées", async () => {
    const { index, fetchJson } = makeIndex();
    const key = tileKey(44.87, 6.47);
    index.loadTile(key);
    index.loadTile(key);
    await index.loadTile(key).done;
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("commune seule hors zonage", async () => {
    const fetchJson = vi.fn((url) => Promise.resolve(url.includes("foret_publique") ? { features: [] } : {
      features: [{ id: "commune.9", properties: { cleabs: "C9", nom_officiel: "Lyon", code_insee: "69123", code_insee_du_departement: "69" }, geometry: square(4.8, 45.7, 4.9, 45.8) }],
    }));
    const index = new ZoneIndex({ fetchJson });
    await index.loadTile(tileKey(45.76, 4.83)).done;
    const result = index.lookup(45.76, 4.83);
    expect(result.zone).toBeNull();
    expect(result.commune).toMatchObject({ name: "Lyon", departement: "Rhône" });
  });

  it("erreur : la dalle est redemandée plus tard", async () => {
    const fetchJson = vi.fn(() => Promise.reject(new Error("HTTP 500")));
    const index = new ZoneIndex({ fetchJson });
    const key = tileKey(45.76, 4.83);
    await index.loadTile(key).done;
    expect(index.tileState(key)).toBe("error");
  });

  it("oublie les dalles les plus anciennes", async () => {
    const fetchJson = vi.fn(() => Promise.resolve({ features: [] }));
    const index = new ZoneIndex({ fetchJson, maxTiles: 3 });
    for (let i = 0; i < 5; i++) {
      await index.loadTile(`${900 + i}/100`).done;
    }
    expect(index.tiles.size).toBeLessThanOrEqual(4);
    expect(COMMUNE_TYPE.typeName).toBe("BDCARTO_V5:commune");
  });
});

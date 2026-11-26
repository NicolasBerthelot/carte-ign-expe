import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/js/services/commune-wiki-service", () => ({
  getCommuneWikiData: vi.fn(),
}));

import gfiRules from "../../src/js/map-interactivity/gfi-rules";
import layersConfig from "../../config/layers-config.json";

const LAYER_ID = "Aire-Parcellaire$WMTS";

// Réponse réelle du GetFeatureInfo WMTS Géoplateforme à Pauillac (z16)
const gfiResponse = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "aire_parcellaire.41",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {
        denom: "Bordeaux,Bordeaux supérieur,Crémant de Bordeaux,Haut-Médoc,Médoc,Pauillac",
        crinao: null,
      },
    },
  ],
};

describe("GFI de la couche AOC viticoles", () => {
  it("la couche est interrogeable au clic", () => {
    expect(layersConfig.layers[LAYER_ID]).toBeDefined();
    expect(layersConfig.layers[LAYER_ID].interactive).not.toBe(false);
  });

  it("affiche la liste des appellations", () => {
    const result = gfiRules.parseGFI(gfiRules[LAYER_ID], gfiResponse, 16);
    expect(result.title).toContain("Aire parcellaire AOC viticole");
    expect(result.title).toContain("INAO");
    expect(result.html).toContain("<li>Pauillac</li>");
    expect(result.html).toContain("<li>Bordeaux supérieur</li>");
    expect(result.html.match(/<li>/g)).toHaveLength(6);
  });

  it("ne renvoie rien hors d'une aire délimitée", () => {
    expect(gfiRules.parseGFI(gfiRules[LAYER_ID], { features: [] }, 16)).toBeUndefined();
  });
});

/**
 * Rendu du volet « Mon territoire » avec les thèmes « découverte » : données simulées, on vérifie
 * que chaque vue s'affiche et que la navigation fonctionne.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dom, globals } = vi.hoisted(() => {
  const territoryWindow = document.createElement("div");
  territoryWindow.innerHTML = "<div class=\"territoryContent\"></div>";
  document.body.appendChild(territoryWindow);
  const positionWindow = document.createElement("div");
  const tabClose = document.createElement("button");
  return {
    dom: { $territoryWindow: territoryWindow, $positionWindow: positionWindow, $tabClose: tabClose },
    globals: { menu: { open: () => {}, updateScrollAnchors: () => {} }, backButtonState: "territory", currentScrollIndex: 0 },
  };
});

vi.mock("maplibre-gl", () => ({ Marker: class { setLngLat() { return this; } addTo() { return this; } remove() {} }, LngLatBounds: class { extend() { return this; } } }));
vi.mock("@capacitor/share", () => ({ Share: { share: () => Promise.resolve() } }));
vi.mock("@capacitor/toast", () => ({ Toast: { show: () => Promise.resolve() } }));
vi.mock("@capacitor/clipboard", () => ({ Clipboard: { write: () => Promise.resolve() } }));
vi.mock("../../src/js/globals", () => ({ default: globals }));
vi.mock("../../src/js/dom", () => ({ default: dom }));
vi.mock("../../src/js/newsfeed", () => ({ default: {} }));
vi.mock("../../src/js/utils/image-carousel", () => ({ default: class {} }));
vi.mock("../../src/js/elevation-line-control/elevation-line-control", () => ({ default: class {} }));
vi.mock("../../src/js/utils/config-utils", () => ({ config: { newsfeed: [], comparePoiData: { features: [] } } }));
vi.mock("../../src/js/immersive-position", () => ({
  default: class extends EventTarget {
    constructor() { super(); this.data = {}; }
    computeAll() {}
  },
}));

vi.mock("../../src/js/territory/territory-data", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      getCommune: () => Promise.resolve({ name: "Dole", population: 23840, codeInsee: "39198", postcodes: ["39100"], codeDepartement: "39", departement: "Jura" }),
      getWeather: () => Promise.resolve(null),
      getPlaces: () => Promise.resolve({ places: [], errors: [] }),
      getOutings: () => Promise.resolve({ outings: [], errors: [] }),
    },
  };
});
vi.mock("../../src/js/territory/biodiversity-data", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { getBiodiversity: () => Promise.resolve({ total: 0, groups: {}, datasets: [], radius: 1000, since: 2016 }), enrichSpecies: () => Promise.resolve() } };
});

const mark = (id, kind, extra = {}) => ({
  id, kind, name: kind === "crue" ? "Crue du 4 juin 1856" : `Repère de nivellement ${id}`, category: "Repère cylindrique du nivellement général",
  commune: "Dole", altitude: 210.5, altitudeSystem: "NGF-IGN 1969", observed: 1950, visited: "2010", state: "Bon état", lost: false,
  access: ["Au pont"], placement: ["Mur du quai"], photo: "", image: "", photos: [], pdf: "https://data.geopf.fr/annexes/geodesie/x.pdf",
  lat: 47.09, lng: 5.49, distance: 300, river: kind === "crue" ? "le Doubs" : "", floodYear: 1856, raw: { nom: id }, ...extra,
});

vi.mock("../../src/js/territory/discovery-data", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      getCommuneStory: () => Promise.resolve({
        title: "Dole (Jura)", articleUrl: "https://fr.wikipedia.org/wiki/Dole_(Jura)", gentile: "Dolois",
        population: [{ year: 1793, population: 9000 }, { year: 1900, population: 14000 }, { year: 1975, population: 29295 }, { year: 2023, population: 23840 }],
        highlights: actual.populationHighlights([{ year: 1793, population: 9000 }, { year: 1900, population: 14000 }, { year: 1975, population: 29295 }, { year: 2023, population: 23840 }]),
        events: [{ date: "1953-04-16", year: 1953, text: "Azans et Saint-Ylie rejoignent la commune de Dole.", kind: "merge" }],
      }),
      getProducts: () => Promise.resolve({ total: 2, groups: { fromages: [{ name: "Comté", sign: "AOP" }], vins: [{ name: "Franche-Comté", sign: "IGP" }] } }),
      getGeology: () => Promise.resolve({ rock: "Sables", type: "Roches Sédimentaires", family: actual.rockFamily("Roches Sédimentaires"), sheet: { number: "529", name: "Dole" }, sites: [{ id: "inpg-1", name: "Grotte", url: "https://inpn.mnhn.fr/site/inpg/X", lat: 47, lng: 5.5, distance: 4000 }] }),
      getWaterStart: () => Promise.resolve({ zone: "Le Doubs", basin: "Rhône-Méditerranée", river: { id: "C1", name: "le Doubs" } }),
      traceWater: (start, { onStep }) => {
        const steps = [{ id: "C1", name: "le Doubs" }, { id: "C2", name: "la Saône" }, { id: "C3", name: "le Rhône" }, { id: "C4", name: "le Rhône" }];
        onStep(steps.slice(0, 2));
        return Promise.resolve({ steps, sea: { name: "la mer Méditerranée", abroad: false }, complete: true });
      },
      getPanorama: () => Promise.resolve({ observerZ: 220, candidates: 3, hidden: 1, visible: [
        { id: "summit-1", name: "Mont Blanc", importance: 1, lat: 45.83, lng: 6.86, distance: 180000, bearing: 135, altitude: 4748, angle: 1.1 },
        { id: "summit-2", name: "Mont Roland", importance: 4, lat: 47.12, lng: 5.43, distance: 5000, bearing: 300, altitude: 344, angle: 1.4 },
      ] }),
      getGeodesyMarks: () => Promise.resolve([mark("A1", "nivellement"), mark("A2", "geodesie")]),
      getFloodMarks: () => Promise.resolve([mark("F1", "crue", { category: "Repère de crue gravé" })]),
      getRiverGeometries: () => Promise.resolve([]),
    },
  };
});

const { default: Territory } = await import("../../src/js/territory/territory.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const content = () => dom.$territoryWindow.querySelector(".territoryContent");
const click = async (selector) => {
  const el = dom.$territoryWindow.querySelector(selector);
  expect(el, selector).not.toBeNull();
  el.click();
  await flush();
  await flush();
};

describe("volet Mon territoire : découverte", () => {
  let territory;
  let mapHandlers;
  beforeEach(async () => {
    // une fenêtre neuve par test : chaque instance écoute les clics de sa propre fenêtre
    dom.$territoryWindow.remove();
    dom.$territoryWindow = document.createElement("div");
    dom.$territoryWindow.innerHTML = "<div class=\"territoryContent\"></div>";
    document.body.appendChild(dom.$territoryWindow);
    const sources = {};
    mapHandlers = {};
    const map = {
      getSource: (id) => sources[id] || null, getLayer: () => null,
      addSource(id) { sources[id] = { setData() {} }; }, addLayer() {}, removeLayer() {}, removeSource(id) { delete sources[id]; },
      flyTo() {}, fitBounds() {}, getZoom: () => 12, once() {}, moveLayer() {},
      on(type, layer, handler) { mapHandlers[`${type}:${layer}`] = handler; }, getCanvas: () => ({ style: {} }),
    };
    territory = new Territory(map);
    territory.open({ lat: 47.09, lng: 5.49 });
    for (let i = 0; i < 5; i++) {
      await flush();
    }
  });

  it("affiche les thèmes sur l'accueil", () => {
    const html = content().innerHTML;
    expect(html).toContain("Explorer le territoire");
    expect(html).toContain("Que voit-on d'ici ?");
    expect(html).toContain("Saveurs du terroir");
    expect(html).toContain("Comté");
    expect(html).toContain("Repères de crues");
    expect(html).toContain("Bornes et repères de l'IGN");
    expect(html).toContain("Dolois");
    expect(html).toContain("Sous vos pieds");
    expect(html).toContain("rejoint le Doubs");
  });

  it("ouvre l'histoire de la commune", async () => {
    await click("[data-action=open-story]");
    const html = content().innerHTML;
    expect(html).toContain("Les habitants au fil du temps");
    expect(html).toContain("<svg class=\"territoryChart\"");
    expect(html).toContain("Azans et Saint-Ylie");
    expect(html).toContain("au plus haut, en 1975");
  });

  it("suit la goutte d'eau jusqu'à la mer", async () => {
    await click("[data-action=open-water]");
    const html = content().innerHTML;
    expect(html).toContain("la Saône");
    expect(html).toContain("La mer Méditerranée");
    // le Rhône découpé en deux objets n'apparaît qu'une fois
    expect(html.match(/>le Rhône</g)).toHaveLength(1);
    expect(html).toContain("traverse 3 cours d'eau");
  });

  it("calcule le panorama", async () => {
    await click("[data-action=open-panorama]");
    const html = content().innerHTML;
    expect(html).toContain("Mont Blanc");
    expect(html).toContain("2 sommets");
    expect(html).toContain("territoryPanorama");
  });

  it("affiche la géologie, le terroir et les repères", async () => {
    await click("[data-action=open-geology]");
    expect(content().innerHTML).toContain("Sables");
    expect(content().innerHTML).toContain("Feuille n° 529");
    await click("[data-action=back]");
    await click("[data-action=list-products]");
    expect(content().innerHTML).toContain("AOP, IGP : quelle différence ?");
    await click("[data-action=back]");
    await click("[data-action=open-floods]");
    expect(content().innerHTML).toContain("La mémoire des inondations");
    await click("[data-action=open-mark]");
    expect(content().innerHTML).toContain("Altitude atteinte par l'eau");
    await click("[data-action=back]");
    await click("[data-action=back]");
    await click("[data-action=open-marks]");
    await click("[data-action=open-mark]");
    expect(content().innerHTML).toContain("Où le trouver ?");
  });

  it("ouvre la fiche d'un repère touché sur la carte, avec le lien Géodésie de poche", async () => {
    await click("[data-action=open-marks]");
    expect(content().innerHTML).toContain("Géodésie de poche");
    await click("[data-action=show-marks]");
    const onPoint = mapHandlers["click:territory-highlight-points"];
    expect(onPoint).toBeTypeOf("function");
    onPoint({ features: [{ properties: { id: "A2" } }] });
    expect(content().innerHTML).toContain("Repère de nivellement A2");
    expect(content().innerHTML).toContain("Vous l'avez trouvé ?");
    // un second point remplace la fiche au lieu de l'empiler
    onPoint({ features: [{ properties: { id: "A1" } }] });
    await click("[data-action=back]");
    expect(content().innerHTML).toContain("2 repères à moins de 2 km");
  });
});

import { describe, expect, it } from "vitest";

import {
  bearingDegrees,
  cleanWikiValue,
  cogEventsToTimeline,
  compassLabel,
  curvatureDrop,
  dedupeSummits,
  fixInaoEncoding,
  geodesyToMark,
  geodesyTypeLabel,
  geometryCenter,
  gmlValue,
  groupProducts,
  indexProducts,
  normalizeName,
  parseFloodDate,
  parseGentile,
  parsePopulationModule,
  parsePopulationTemplate,
  lineEnds,
  pickOutlet,
  populationHighlights,
  productGroup,
  profileSamples,
  riverName,
  rockFamily,
  seaOfBasin,
  sightLine,
} from "../../src/js/territory/discovery-data.js";
import { acrToPlace } from "../../src/js/territory/territory-data.js";

describe("discovery-data : histoire de la commune", () => {
  const template = `<includeonly>{{#switch: {{{1|}}}
|insee=39198
|nom_WP_commune=Dole (Jura)
|max=29295
|nombre=4
|an1=1793|pop1=9000 |recens1=1
|an2=1800|pop2=8 235 |recens2=1
|an3=1975|pop3=29295 |recens3=1
|an4=2022|pop4=23 412 |recens4=1
|an5=|pop5= |recens5=1
}}</includeonly>`;

  it("lit le modèle Wikipédia d'évolution de la population", () => {
    expect(parsePopulationTemplate(template)).toEqual([
      { year: 1793, population: 9000 },
      { year: 1800, population: 8235 },
      { year: 1975, population: 29295 },
      { year: 2022, population: 23412 },
    ]);
    expect(parsePopulationTemplate("")).toEqual([]);
  });

  it("lit le module Lua de données de population", () => {
    const lua = `return
  {
    ["insee"] = "39198",
    ["division"] = "commune",
    ["nom"] = "Dole (Jura)",
    [1793] = { ["pop"] = 9000, ["ref"] = nil },
    [1800] = { ["pop"] = 8235, ["ref"] = nil },
    [2023] = { ["pop"] = 23840, ["ref"] = "https://www.insee.fr/fr/statistiques/8643952?geo=COM-39198" },
 }`;
    expect(parsePopulationModule(lua)).toEqual({
      insee: "39198",
      division: "commune",
      series: [{ year: 1793, population: 9000 }, { year: 1800, population: 8235 }, { year: 2023, population: 23840 }],
    });
  });

  it("résume la courbe de population", () => {
    const h = populationHighlights(parsePopulationTemplate(template));
    expect(h.first.year).toBe(1793);
    expect(h.peak).toEqual({ year: 1975, population: 29295 });
    expect(h.low.year).toBe(1800);
    expect(h.ratio).toBeCloseTo(23412 / 9000);
    expect(populationHighlights([])).toBeNull();
  });

  it("extrait le gentilé de l'infobox", () => {
    expect(parseGentile("{{Infobox Commune de France\n | nom = Dole\n | gentilé                  = Dolois\n | maire = X\n}}")).toBe("Dolois");
    expect(parseGentile("| gentilé = [[Gentilé|Parisiens]]<ref>Source</ref>\n")).toBe("Parisiens");
    expect(parseGentile("| nom = Sans gentilé\n")).toBe("");
    expect(cleanWikiValue("Valserhônois<br />{{lang|fr|Valserhônoises}} <!-- à vérifier -->")).toBe("Valserhônois, Valserhônoises");
  });

  it("raconte les fusions et changements de nom du COG", () => {
    const rows = [
      { COM_AV: "01033", COM_AP: "01033", DATE_EFF: "1956-10-19", MOD: 10, LIBELLE_AV: "Bellegarde", LIBELLE_AP: "Bellegarde-sur-Valserine", TYPECOM_AV: "COM", TYPECOM_AP: "COM" },
      { COM_AV: "01033", COM_AP: "01033", DATE_EFF: "2019-01-01", MOD: 32, LIBELLE_AV: "Bellegarde-sur-Valserine", LIBELLE_AP: "Valserhône", TYPECOM_AV: "COM", TYPECOM_AP: "COM" },
      { COM_AV: "01091", COM_AP: "01033", DATE_EFF: "2019-01-01", MOD: 32, LIBELLE_AV: "Châtillon-en-Michaille", LIBELLE_AP: "Valserhône", TYPECOM_AV: "COM", TYPECOM_AP: "COM" },
      { COM_AV: "01205", COM_AP: "01033", DATE_EFF: "2019-01-01", MOD: 32, LIBELLE_AV: "Lancrans", LIBELLE_AP: "Valserhône", TYPECOM_AV: "COM", TYPECOM_AP: "COM" },
      // ligne « commune déléguée » : ignorée
      { COM_AV: "01033", COM_AP: "01033", DATE_EFF: "2019-01-01", MOD: 32, LIBELLE_AV: "Bellegarde-sur-Valserine", LIBELLE_AP: "Bellegarde-sur-Valserine", TYPECOM_AV: "COM", TYPECOM_AP: "COMD" },
      { COM_AV: "01400", COM_AP: "01033", DATE_EFF: "1971-01-01", MOD: 31, LIBELLE_AV: "Coupy", LIBELLE_AP: "Bellegarde-sur-Valserine", TYPECOM_AV: "COM", TYPECOM_AP: "COM" },
      // fusion sans autre commune : rien à raconter
      { COM_AV: "01033", COM_AP: "01033", DATE_EFF: "1966-03-23", MOD: 31, LIBELLE_AV: "Bellegarde-sur-Valserine", LIBELLE_AP: "Bellegarde-sur-Valserine", TYPECOM_AV: "COM", TYPECOM_AP: "COM" },
    ];
    const events = cogEventsToTimeline(rows, "01033");
    expect(events.map((e) => e.year)).toEqual([1956, 1971, 2019]);
    expect(events[0].text).toBe("Bellegarde prend le nom de Bellegarde-sur-Valserine.");
    expect(events[1].text).toBe("Coupy rejoint la commune de Bellegarde-sur-Valserine.");
    expect(events[2].text).toBe("Création de la commune nouvelle de Valserhône, qui réunit Bellegarde-sur-Valserine, Châtillon-en-Michaille et Lancrans.");
  });
});

describe("discovery-data : voyage de la goutte d'eau", () => {
  it("trouve la mer d'arrivée d'après le bassin", () => {
    expect(seaOfBasin("Seine-Normandie").name).toBe("la Manche");
    expect(seaOfBasin("Rhône-Méditerranée").name).toBe("la mer Méditerranée");
    expect(seaOfBasin("Loire-Bretagne").name).toBe("l'océan Atlantique");
    expect(seaOfBasin("Adour-Garonne").name).toBe("l'océan Atlantique");
    expect(seaOfBasin("Rhin-Meuse")).toEqual({ name: "la mer du Nord", abroad: true });
    expect(seaOfBasin("Artois-Picardie", { lng: 1.6, lat: 50.2 }).name).toBe("la Manche");
    expect(seaOfBasin("Artois-Picardie", { lng: 2.4, lat: 51 }).name).toBe("la mer du Nord");
  });

  it("choisit le confluent qui mène au cours d'eau suivant", () => {
    const node = (z, categorie, aval) => ({ geometry: { type: "Point", coordinates: [5, 46, z] }, properties: { categorie, liens_vers_cours_d_eau_aval: aval } });
    const doubs = "COURDEAU_DOUBS";
    const outlet = pickOutlet([
      node(191.9, "Diffluent", doubs),
      node(185.1, "Confluent", doubs),
      node(171.7, "Confluent", "COURDEAU_SAONE"),
      node(933.8, "Exutoire", null),
    ], doubs);
    expect(outlet.properties.liens_vers_cours_d_eau_aval).toBe("COURDEAU_SAONE");
    // fin du réseau : exutoire en mer
    const sea = pickOutlet([node(59.5, "Confluent", "COURDEAU_RHONE"), node(-0.5, "Exutoire", null)], "COURDEAU_RHONE");
    expect(sea.properties.categorie).toBe("Exutoire");
    expect(pickOutlet([node(10, "Confluent", "X")], "X")).toBeNull();
    expect(pickOutlet([], "X")).toBeNull();
  });

  it("liste les extrémités d'un tracé", () => {
    expect(lineEnds({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1], [2, 2]], [[2, 2], [3, 3]]] })).toEqual([[0, 0], [2, 2], [3, 3]]);
    expect(lineEnds({ type: "LineString", coordinates: [[0, 0], [1, 1]] })).toEqual([[0, 0], [1, 1]]);
    expect(lineEnds(null)).toEqual([]);
  });
});

describe("discovery-data : panorama", () => {
  it("calcule azimuts et points cardinaux", () => {
    expect(bearingDegrees(46, 6, 47, 6)).toBeCloseTo(0, 0);
    expect(bearingDegrees(46, 6, 46, 7)).toBeCloseTo(90, 0);
    expect(bearingDegrees(46, 6, 45, 6)).toBeCloseTo(180, 0);
    expect(compassLabel(0)).toBe("nord");
    expect(compassLabel(130)).toBe("sud-est");
    expect(compassLabel(350)).toBe("nord");
    expect(compassLabel(275, true)).toBe("O");
  });

  it("tient compte de la courbure terrestre et de la réfraction", () => {
    // ~68 m d'abaissement apparent à 32 km avec k = 0,13
    expect(curvatureDrop(32000)).toBeGreaterThan(65);
    expect(curvatureDrop(32000)).toBeLessThan(72);
    expect(curvatureDrop(0)).toBe(0);
  });

  it("détermine si un sommet est masqué par le relief", () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({ d: (i + 1) * 500, z: 200 }));
    const summit = [...flat.slice(0, -1), { d: 10000, z: 900 }];
    expect(sightLine(summit, 201.7).visible).toBe(true);
    const ridge = summit.map((p) => (p.d === 5000 ? { ...p, z: 1200 } : p));
    expect(sightLine(ridge, 201.7).visible).toBe(false);
    // au ras du sol, la courbure cache un point bas lointain
    const far = Array.from({ length: 100 }, (_, i) => ({ d: (i + 1) * 1000, z: 0 }));
    expect(sightLine(far, 1.7).visible).toBe(false);
  });

  it("adapte l'échantillonnage à la distance", () => {
    expect(profileSamples(1000)).toBe(20);
    expect(profileSamples(15000)).toBe(100);
    expect(profileSamples(140000)).toBe(260);
  });

  it("écarte les sommets en doublon", () => {
    const s = (name, lat, importance, distance) => ({ name, lat, lng: 6, importance, distance });
    const kept = dedupeSummits([s("Pointe", 46.0001, 4, 1000), s("Mont", 46, 1, 1200), s("Loin", 46.2, 3, 5000)]);
    expect(kept.map((k) => k.name)).toEqual(["Mont", "Loin"]);
  });
});

describe("discovery-data : géologie", () => {
  it("lit les réponses GetFeatureInfo du BRGM", () => {
    const xml = "<msGMLOutput><LITHO_1M_SIMPLIFIEE_feature><DESCR>Argiles</DESCR><TYPE>Roches Sédimentaires</TYPE></LITHO_1M_SIMPLIFIEE_feature></msGMLOutput>";
    expect(gmlValue(xml, "DESCR")).toBe("Argiles");
    expect(gmlValue(xml, "numero")).toBe("");
    expect(rockFamily("Roches Sédimentaires").key).toBe("sedimentaire");
    expect(rockFamily("Roches plutoniques").key).toBe("plutonique");
    expect(rockFamily("")).toBeNull();
  });

  it("calcule le centre d'une géométrie", () => {
    expect(geometryCenter({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] })).toEqual([1, 1]);
    expect(geometryCenter(null)).toBeNull();
  });
});

describe("discovery-data : produits du terroir", () => {
  it("corrige l'encodage des fichiers de l'INAO", () => {
    expect(fixInaoEncoding("Crčme de Bresse")).toBe("Crème de Bresse");
    expect(fixInaoEncoding("Gruyčre (IGP)")).toBe("Gruyère (IGP)");
    expect(normalizeName("Bœuf de Chalosse")).toBe("boeuf de chalosse");
  });

  it("classe les produits par famille", () => {
    expect(productGroup("LAITIER", "Pâte pressée cuite")).toBe("fromages");
    expect(productGroup("AGROALIMENTAIRE", "Volaille")).toBe("viandes");
    expect(productGroup("AGROALIMENTAIRE", "Charcuterie")).toBe("viandes");
    expect(productGroup("VITICOLE", "Vin tranquille")).toBe("vins");
    expect(productGroup("VITICOLE", "Eaux-de-vie de vin")).toBe("boissons");
    expect(productGroup("AGROALIMENTAIRE", "Cidre")).toBe("boissons");
    expect(productGroup("AGROALIMENTAIRE", "Mollusque")).toBe("mer");
    expect(productGroup("AGROALIMENTAIRE", "Huile")).toBe("autres");
  });

  it("regroupe les aires de la commune sans doublons", () => {
    const index = indexProducts([
      { denomination: "Comté", appellation: "Comté", categorie: "Pâte pressée cuite", secteur: "LAITIER", signe_ue: "AOP  " },
      { denomination: "Franche-Comté", appellation: "Franche-Comté", categorie: "Vin tranquille", secteur: "VITICOLE", signe_ue: "IGP  " },
      { denomination: "Franche-Comté Buffard", appellation: "Franche-Comté", categorie: "Vin tranquille", secteur: "VITICOLE", signe_ue: "IGP  " },
      { denomination: "Gruyère", appellation: "Gruyère", categorie: "Pâte pressée cuite", secteur: "LAITIER", signe_ue: "IGP  " },
      { denomination: "Saucisse de Morteau ou Jésus de Morteau", appellation: "Saucisse de Morteau ou Jésus de Morteau", categorie: "Charcuterie", secteur: "AGROALIMENTAIRE", signe_ue: "IGP  " },
    ]);
    const groups = groupProducts([
      { name: "Comté", sign: "AOP" },
      { name: "Franche-Comté", sign: "IGP" },
      { name: "Franche-Comté Buffard", sign: "IGP" },
      { name: "Franche-Comté Vuillafans blanc", sign: "IGP" },
      { name: "Gruyčre (IGP)", sign: "IGP" },
      { name: "Saucisse de Morteau ou Jésus de Morteau", sign: "IGP" },
      { name: "Produit inconnu", sign: "IGP" },
    ], index);
    expect(groups.fromages).toEqual([{ name: "Comté", sign: "AOP" }, { name: "Gruyère", sign: "IGP" }]);
    expect(groups.vins).toEqual([{ name: "Franche-Comté", sign: "IGP" }]);
    expect(groups.viandes[0].name).toBe("Saucisse de Morteau ou Jésus de Morteau");
    expect(groups.autres).toEqual([{ name: "Produit inconnu", sign: "IGP" }]);
  });
});

describe("discovery-data : bornes et repères", () => {
  it("rend lisibles les types de points", () => {
    expect(geodesyTypeLabel("M   REPERE CYLINDRIQUE DU NIVELLEMENT GENERAL")).toBe("Repère cylindrique du nivellement général");
    expect(geodesyTypeLabel("Clocher : Campanile : Croix : Centre")).toBe("Clocher, Campanile, Croix, Centre");
    expect(geodesyTypeLabel("")).toBe("");
  });

  it("prépare une fiche de repère de nivellement", () => {
    const mark = geodesyToMark({
      geometry: { type: "Point", coordinates: [2.353, 48.8538] },
      properties: {
        id: 495921, domaine: "nivf", nom: "P.C.L3 - 155", type: "M   REPERE CYLINDRIQUE DU NIVELLEMENT GENERAL",
        commune: "Paris--4e--arrondissement", localisation: "\"A \"\"PARIS\"\" QUAI DE BOURBON\"", etat: "BON ETAT",
        obs_date: "1942/01/01", vis_date: "2026/07/05", cp1_coord3: 30.672, cp1_srv: "Système altimétrique : NGF-IGN 1969",
        support: "MUR DE SOUTENEMENT DU QUAI", rep_vert: "A 0.38 M AU-DESSUS DU SOL", img1_url: "https://data.geopf.fr/annexes/geodesie/pt-nivf-495921-photo1.jpg",
        img1_date: "2026/07/05", url_pdf: "https://data.geopf.fr/annexes/geodesie/pt-nivf-495921.pdf", diffusion: true,
      },
    }, 48.8566, 2.3522);
    expect(mark.kind).toBe("nivellement");
    expect(mark.name).toBe("Repère de nivellement P.C.L3 - 155");
    expect(mark.altitude).toBe(30.672);
    expect(mark.altitudeSystem).toBe("NGF-IGN 1969");
    expect(mark.observed).toBe(1942);
    expect(mark.visited).toBe("2026");
    expect(mark.lost).toBe(false);
    expect(mark.placement).toEqual(["Mur de soutènement du quai", "A 0.38 m au-dessus du sol"]);
    expect(mark.photos).toHaveLength(1);
    expect(mark.photos[0].credit).toBe("IGN, 2026");
    expect(mark.distance).toBeGreaterThan(250);
    expect(mark.distance).toBeLessThan(400);
  });

  it("prépare une fiche de repère de crue", () => {
    const mark = geodesyToMark({
      geometry: { type: "Point", coordinates: [0.2, 47.2] },
      properties: { id: 8587, domaine: "nive", nom: "LCI-R-286-524", type: "REPERE DE CRUE GRAVE", remarque: "Date inondation : 1/10/1866", voie_suivie: "LA LOIRE", localisation: "RN152, ROUTE DE SAUMUR, N°81", cp1_coord3: 34.999, etat: "BON ETAT" },
    }, 47.2, 0.21);
    expect(mark.kind).toBe("crue");
    expect(mark.name).toBe("Crue du 1er octobre 1866");
    expect(mark.river).toBe("la Loire");
    expect(mark.floodYear).toBe(1866);
    expect(mark.access).toEqual(["Rn152, route de saumur, n°81"]);
  });

  it("lit les dates d'inondation et les noms de rivières", () => {
    expect(parseFloodDate("Date inondation : 4/6/1856")).toEqual({ text: "4 juin 1856", year: 1856, exact: true });
    expect(parseFloodDate("Date inondation : 1910")).toEqual({ text: "1910", year: 1910, exact: false });
    expect(parseFloodDate("Date inondation : 1/1/1982")).toEqual({ text: "1982", year: 1982, exact: false });
    expect(parseFloodDate("")).toBeNull();
    expect(riverName("L' INDRE")).toBe("l'Indre");
    expect(riverName("LA SEINE")).toBe("la Seine");
    expect(riverName("LA SAONE-ET-LOIRE")).toBe("la Saone-et-Loire");
    expect(riverName("LE GAVE DE PAU")).toBe("le Gave de Pau");
  });

  it("repère les points détruits ou non retrouvés", () => {
    const mark = geodesyToMark({ geometry: { type: "Point", coordinates: [5.57, 46.88] }, properties: { id: 1, domaine: "nivf", nom: "X", etat: "NON RETROUVE" } }, 46.9, 5.55);
    expect(mark.lost).toBe(true);
    expect(geodesyToMark({ geometry: null, properties: {} }, 46, 5)).toBeNull();
  });
});

describe("territory-data : Architecture contemporaine remarquable", () => {
  it("prépare un lieu labellisé", () => {
    const place = acrToPlace({
      Reference_de_la_notice: "ACR0000002",
      Titre_courant: "Hôtel de ville ",
      Commune_forme_editoriale: "Valserhône",
      Coordonnees: "46.1077711035412,5.825944937722621",
      Denominations: "édifice de l'administration ou de la vie publique;mairie;hôtel de ville",
    });
    expect(place.id).toBe("acr-ACR0000002");
    expect(place.theme).toBe("acr");
    expect(place.name).toBe("Hôtel de ville");
    expect(place.category).toBe("Hôtel de ville");
    expect(place.lat).toBeCloseTo(46.1078, 3);
    expect(acrToPlace({ Coordonnees: "" })).toBeNull();
  });
});

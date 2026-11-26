/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Thèmes « découverte » du volet « Mon territoire ». Rien n'est hébergé par l'appli :
 * tout vient de sources publiques interrogées depuis l'appareil.
 *
 * - Histoire de la commune : populations depuis 1793 (Wikipédia, d'après la base Cassini de l'EHESS
 *   et l'INSEE), gentilé (Wikipédia), fusions et changements de nom (COG de l'INSEE, API tabulaire
 *   de data.gouv.fr). L'article Wikipédia est trouvé via Wikidata (code INSEE), avec repli sur la
 *   table commune → article déjà embarquée par l'appli.
 * - Voyage de la goutte d'eau : réseau hydrographique de la BD TOPO (Géoplateforme, WFS) :
 *   bassin versant topographique du point, puis nœuds de confluence de proche en proche.
 * - Géologie : BRGM (carte lithologique simplifiée au 1/1 000 000, carte géologique au 1/50 000),
 *   Inventaire national du patrimoine géologique (PatriNat, WFS Géoplateforme).
 * - Panorama : sommets de la BD TOPO et altitudes du RGE ALTI (service d'altimétrie de la
 *   Géoplateforme), calcul de visibilité sur l'appareil (courbure terrestre et réfraction).
 * - Produits du terroir : aires géographiques des AOC/AOP et IGP par commune et référentiel des
 *   produits de l'INAO (data.gouv.fr).
 * - Bornes et repères : points géodésiques et repères de nivellement de l'IGN (WFS Géoplateforme).
 * - Repères de crues : ceux que l'IGN a nivelés, dans la même base (repères posés par les services
 *   de l'État et les collectivités, avec la date de l'inondation et l'altitude atteinte par l'eau).
 *   La plateforme nationale des repères de crues, plus complète, n'offre pas d'accès ouvert
 *   interrogeable depuis l'appli.
 */

import { distanceMeters } from "./territory-data";
import { getParquetRows } from "./parquet-source";

const WFS = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&outputFormat=json";
const ALTI_ELEVATION = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";
const BRGM_WMS = "https://geoservices.brgm.fr/geologie";
const TABULAR_API = "https://tabular-api.data.gouv.fr/api/resources";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const FRWIKI_API = "https://fr.wikipedia.org/w/api.php";

/** Ressources data.gouv.fr */
export const DISCOVERY_RESOURCES = {
  // INAO
  aoc: "0ba4fed3-a5f7-4189-a1a3-2eebabc6296f",
  igp: "ad206892-29f9-49ae-8de1-d5804f4a2817",
  produits: "76e54568-9786-4e15-8e48-dc3b8f44011d",
  // INSEE, Code officiel géographique : événements survenus aux communes depuis 1943
  cogEvents: "1b96750d-08df-433b-a2d1-a8ea7545ece3",
};

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                 */
/* -------------------------------------------------------------------------- */

async function fetchJson(url, signal, options = {}) {
  const response = await fetch(url, { signal, ...options });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} pour ${url}`);
  }
  return response.json();
}

async function fetchText(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} pour ${url}`);
  }
  return response.text();
}

/**
 * Requête WFS Géoplateforme
 * @returns {Promise<Array<Object>>} entités GeoJSON
 */
export async function wfsFeatures(layer, cql, { count = 50, properties = null, signal, extra = "" } = {}) {
  let url = `${WFS}&typename=${layer}&count=${count}`;
  if (properties) {
    url += `&PROPERTYNAME=${properties.join(",")}`;
  }
  if (cql) {
    url += `&CQL_FILTER=${encodeURIComponent(cql)}`;
  }
  const json = await fetchJson(url + extra, signal);
  return json.features || [];
}

/** Échappe une chaîne pour un filtre CQL */
function cqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Azimut (degrés, 0 = nord) du point 1 vers le point 2 */
export function bearingDegrees(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const COMPASS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
const COMPASS_SHORT = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

/** « nord-est » pour un azimut en degrés */
export function compassLabel(bearing, short = false) {
  const i = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return (short ? COMPASS_SHORT : COMPASS)[i];
}

/** Supprime accents, casse et ponctuation pour comparer des noms */
export function normalizeName(value) {
  return String(value || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/œ/g, "oe").replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Majuscule initiale */
function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
}

/** Accents des mots fréquents des fiches géodésiques, saisies en majuscules sans accents */
const ACCENTS = {
  repere: "repère", reperes: "repères", general: "général", generale: "générale", eglise: "église", batiment: "bâtiment",
  ecole: "école", soutenement: "soutènement", facade: "façade", echelle: "échelle", elevation: "élévation",
  ecluse: "écluse", chateau: "château", deversoir: "déversoir", detruit: "détruit", retrouve: "retrouvé",
  etat: "état", tete: "tête", geodesique: "géodésique", scelle: "scellé", superieure: "supérieure",
};

/** « MUR DE SOUTENEMENT » → « Mur de soutènement » */
export function sentenceCase(value) {
  const s = String(value || "").replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/[a-z]+/g, (w) => ACCENTS[w] || w);
  return capitalize(s);
}

/* -------------------------------------------------------------------------- */
/* Histoire de la commune                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Lit le modèle Wikipédia « Données/<commune>/évolution population »
 * (|an1=1793|pop1=9000 …)
 * @returns {Array<{year: number, population: number}>} triées par année
 */
export function parsePopulationTemplate(wikitext) {
  const years = {};
  const pops = {};
  String(wikitext || "").replace(/\|\s*(an|pop)(\d+)\s*=\s*([^|\n}]*)/g, (match, key, index, raw) => {
    const value = Number(String(raw).replace(/[\s\u00a0.]/g, "").replace(",", "."));
    if (Number.isFinite(value) && String(raw).trim() !== "") {
      (key === "an" ? years : pops)[index] = value;
    }
    return match;
  });
  const out = [];
  Object.keys(years).forEach((index) => {
    const year = years[index];
    const population = pops[index];
    if (year > 1700 && year < 2100 && Number.isFinite(population) && population >= 0) {
      out.push({ year, population });
    }
  });
  out.sort((a, b) => a.year - b.year);
  // une seule valeur par année
  return out.filter((p, i) => i === 0 || p.year !== out[i - 1].year);
}

/**
 * Lit le module Lua Wikipédia « Module:Données/<commune>/évolution population »
 * ([1793] = { ["pop"] = 9000, … })
 * @returns {{insee: string, division: string, series: Array<{year: number, population: number}>}}
 */
export function parsePopulationModule(lua) {
  const text = String(lua || "");
  const insee = /\["insee"\]\s*=\s*"([^"]*)"/.exec(text)?.[1] || "";
  const division = /\["division"\]\s*=\s*"([^"]*)"/.exec(text)?.[1] || "";
  const series = [];
  text.replace(/\[(\d{4})\]\s*=\s*\{\s*\["pop"\]\s*=\s*(\d+)/g, (match, year, pop) => {
    series.push({ year: Number(year), population: Number(pop) });
    return match;
  });
  series.sort((a, b) => a.year - b.year);
  return { insee, division, series: series.filter((p, i) => i === 0 || p.year !== series[i - 1].year) };
}

/** Retire la syntaxe wiki d'une valeur d'infobox : liens, modèles, références, commentaires */
export function cleanWikiValue(value) {
  let s = String(value || "");
  s = s.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/<[^>]+>/g, "");
  // {{lang|x|texte}}, {{nobr|texte}} → texte ; autres modèles supprimés
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\{\{(?:lang|langue|nobr|nowrap|japonais)\|(?:[^|{}]*\|)?([^|{}]*)\}\}/gi, "$1")
      .replace(/\{\{[^{}]*\}\}/g, "");
  }
  s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/^[\s,;]+|[\s,;]+$/g, "");
  return s.trim();
}

/** Gentilé de l'infobox d'un article de commune */
export function parseGentile(wikitext) {
  const m = /\|\s*gentilé\s*=([^\n]*)/i.exec(String(wikitext || ""));
  if (!m) {
    return "";
  }
  const value = cleanWikiValue(m[1].split(/\n\s*\|/)[0]);
  return value.length > 120 ? "" : value;
}

const COG_MOD = {
  NAME: 10,
  CREATION: 20,
  RESTORE: 21,
  MERGE: 31,
  NEW_COMMUNE: 32,
  ASSOCIATION: 33,
  ASSOCIATION_TO_MERGE: 34,
};

function joinFrench(list) {
  if (list.length <= 1) {
    return list.join("");
  }
  return `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
}

/**
 * Événements du COG (lignes dont la commune résultante est codeInsee) → frise lisible
 * @returns {Array<{date: string, year: number, text: string, kind: string}>} du plus ancien au plus récent
 */
export function cogEventsToTimeline(rows, codeInsee) {
  const groups = new Map();
  (rows || []).forEach((row) => {
    if (row.COM_AP !== codeInsee || row.TYPECOM_AP !== "COM") {
      return;
    }
    const key = `${row.DATE_EFF}|${row.MOD}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  });
  const events = [];
  groups.forEach((list, key) => {
    const [date, modText] = key.split("|");
    const mod = Number(modText);
    const year = Number(String(date).slice(0, 4));
    const name = list[0].LIBELLE_AP;
    const others = [...new Set(list
      .filter((r) => r.COM_AV !== codeInsee && r.TYPECOM_AV === "COM")
      .map((r) => r.LIBELLE_AV)
      .filter(Boolean))];
    const formerNames = [...new Set(list
      .filter((r) => r.TYPECOM_AV === "COM")
      .map((r) => r.LIBELLE_AV)
      .filter(Boolean))];
    let text = "";
    let kind = "other";
    switch (mod) {
    case COG_MOD.NAME: {
      const self = list.find((r) => r.COM_AV === codeInsee && r.LIBELLE_AV && r.LIBELLE_AV !== r.LIBELLE_AP);
      if (self) {
        text = `${self.LIBELLE_AV} prend le nom de ${name}.`;
        kind = "name";
      }
      break;
    }
    case COG_MOD.CREATION:
      text = `Création de la commune de ${name}.`;
      kind = "creation";
      break;
    case COG_MOD.RESTORE:
      text = `${name} redevient une commune à part entière.`;
      kind = "creation";
      break;
    case COG_MOD.NEW_COMMUNE:
      if (formerNames.length > 1) {
        text = `Création de la commune nouvelle de ${name}, qui réunit ${joinFrench(formerNames)}.`;
        kind = "merge";
      }
      break;
    case COG_MOD.MERGE:
    case COG_MOD.ASSOCIATION_TO_MERGE:
      if (others.length) {
        text = `${others.length > 1 ? `${joinFrench(others)} rejoignent` : `${others[0]} rejoint`} la commune de ${name}.`;
        kind = "merge";
      }
      break;
    case COG_MOD.ASSOCIATION:
      if (others.length) {
        text = `${joinFrench(others)} ${others.length > 1 ? "s'associent" : "s'associe"} à ${name}.`;
        kind = "merge";
      }
      break;
    default:
      break;
    }
    if (text) {
      events.push({ date, year, text, kind });
    }
  });
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

/**
 * Faits marquants de la courbe de population
 * @param {Array<{year: number, population: number}>} series
 */
export function populationHighlights(series) {
  if (!series?.length) {
    return null;
  }
  const first = series[0];
  const last = series[series.length - 1];
  const peak = series.reduce((best, p) => (p.population > best.population ? p : best), first);
  const low = series.reduce((best, p) => (p.population < best.population ? p : best), first);
  const ratio = first.population > 0 ? last.population / first.population : null;
  return { first, last, peak, low, ratio };
}

async function wikidataCommune(codeInsee, signal) {
  const query = `SELECT ?item ?article ?dem WHERE {
    ?item wdt:P374 "${codeInsee.replace(/[^0-9AB]/gi, "")}".
    FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
    OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://fr.wikipedia.org/>. }
    OPTIONAL { ?item wdt:P1549 ?dem. FILTER(LANG(?dem) = "fr") }
  } LIMIT 5`;
  const json = await fetchJson(`${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`, signal, {
    headers: { Accept: "application/sparql-results+json" },
  });
  const rows = json.results?.bindings || [];
  const withArticle = rows.find((r) => r.article?.value) || rows[0];
  if (!withArticle) {
    return null;
  }
  const article = withArticle.article?.value || "";
  return {
    wikidata: withArticle.item?.value?.split("/").pop() || "",
    title: article ? decodeURIComponent(article.split("/wiki/")[1] || "").replace(/_/g, " ") : "",
    demonyms: [...new Set(rows.map((r) => r.dem?.value).filter(Boolean))],
  };
}

async function fallbackWikiTitle(codeInsee) {
  try {
    const { getCommuneWikiData } = await import("../services/commune-wiki-service");
    const data = await getCommuneWikiData();
    const url = data?.[codeInsee] || data?.[String(Number(codeInsee))];
    return url ? decodeURIComponent(url.split("/wiki/")[1] || "").replace(/_/g, " ") : "";
  } catch {
    return "";
  }
}

async function frwikiWikitext(title, signal, section) {
  const params = new URLSearchParams({
    action: "parse", format: "json", origin: "*", prop: "wikitext", redirects: "1", page: title,
  });
  if (section !== undefined) {
    params.set("section", String(section));
  }
  const json = await fetchJson(`${FRWIKI_API}?${params.toString()}`, signal);
  if (json.error) {
    return null;
  }
  return { title: json.parse?.title || title, wikitext: json.parse?.wikitext?.["*"] || "" };
}

async function frwikiRaw(title, signal) {
  const params = new URLSearchParams({
    action: "query", format: "json", origin: "*", prop: "revisions", rvprop: "content", rvslots: "main", redirects: "1", titles: title,
  });
  const json = await fetchJson(`${FRWIKI_API}?${params.toString()}`, signal);
  const page = Object.values(json.query?.pages || {})[0];
  return page?.revisions?.[0]?.slots?.main?.["*"] || "";
}

/** Série historique de population de l'article Wikipédia (module de données, sinon ancien modèle) */
async function wikiPopulation(title, codeInsee, signal) {
  const lua = await frwikiRaw(`Module:Données/${title}/évolution population`, signal).catch(() => "");
  if (lua) {
    const data = parsePopulationModule(lua);
    // Paris : données du département, identiques à celles de la commune
    const sameCommune = data.insee === codeInsee || (data.division === "département" && codeInsee === "75056" && data.insee === "75");
    if (sameCommune && data.series.length) {
      return data.series;
    }
  }
  const template = await frwikiWikitext(`Modèle:Données/${title}/évolution population`, signal).catch(() => null);
  return template ? parsePopulationTemplate(template.wikitext) : [];
}

async function cogEvents(codeInsee, signal) {
  const params = new URLSearchParams({ COM_AP__exact: codeInsee, page_size: "100" });
  const json = await fetchJson(`${TABULAR_API}/${DISCOVERY_RESOURCES.cogEvents}/data/?${params.toString()}`, signal);
  return cogEventsToTimeline(json.data || [], codeInsee);
}

/**
 * Histoire de la commune : gentilé, populations depuis 1793, fusions et changements de nom
 * @param {{codeInsee: string, name: string}} commune
 */
export async function getCommuneStory(commune, signal) {
  const code = String(commune.codeInsee || "");
  const [wd, events] = await Promise.all([
    wikidataCommune(code, signal).catch((err) => {
      if (err.name === "AbortError") {
        throw err;
      }
      console.warn("[territoire] Wikidata commune :", err);
      return null;
    }),
    cogEvents(code, signal).catch((err) => {
      if (err.name === "AbortError") {
        throw err;
      }
      console.warn("[territoire] COG :", err);
      return [];
    }),
  ]);
  let title = wd?.title || await fallbackWikiTitle(code);
  let gentile = "";
  let population = [];
  if (title) {
    const article = await frwikiWikitext(title, signal, 0).catch(() => null);
    if (article) {
      title = article.title;
      gentile = parseGentile(article.wikitext);
    }
    population = await wikiPopulation(title, code, signal);
  }
  if (!gentile && wd?.demonyms?.length) {
    gentile = wd.demonyms.join(", ");
  }
  return {
    title,
    articleUrl: title ? `https://fr.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : "",
    gentile,
    population,
    highlights: populationHighlights(population),
    events,
  };
}

/* -------------------------------------------------------------------------- */
/* Voyage de la goutte d'eau                                                   */
/* -------------------------------------------------------------------------- */

/** Mer ou océan où finit l'eau, d'après le bassin hydrographique (et le point d'arrivée) */
export function seaOfBasin(basin, end = null) {
  const b = normalizeName(basin);
  if (b.includes("seine")) return { name: "la Manche", abroad: false };
  if (b.includes("loire") || b.includes("adour") || b.includes("garonne")) return { name: "l'océan Atlantique", abroad: false };
  if (b.includes("rhone") || b.includes("corse")) return { name: "la mer Méditerranée", abroad: false };
  if (b.includes("rhin") || b.includes("meuse")) return { name: "la mer du Nord", abroad: true };
  if (b.includes("artois") || b.includes("picardie")) {
    if (end && end.lng < 1.9) {
      return { name: "la Manche", abroad: false };
    }
    return { name: "la mer du Nord", abroad: !end };
  }
  return { name: "la mer", abroad: false };
}

/**
 * Nœud où un cours d'eau se termine, parmi les nœuds de ses extrémités : de préférence un
 * confluent qui mène à un autre cours d'eau (le plus bas s'il y en a plusieurs), sinon un exutoire
 * @param {Array<Object>} features nœuds hydrographiques (GeoJSON) dont l'amont contient riverId
 * @param {string} riverId
 */
export function pickOutlet(features, riverId) {
  const z = (f) => {
    const v = f.geometry?.coordinates?.[2];
    return Number.isFinite(v) && v > -999 ? v : Infinity;
  };
  const lowest = (list) => list.reduce((best, f) => (!best || z(f) < z(best) ? f : best), null);
  const ends = (features || []).filter((f) => {
    if (f.geometry?.type !== "Point") {
      return false;
    }
    const aval = f.properties?.liens_vers_cours_d_eau_aval;
    return !aval || !String(aval).split("/").includes(riverId);
  });
  const onward = ends.filter((f) => f.properties?.liens_vers_cours_d_eau_aval);
  if (onward.length) {
    return lowest(onward);
  }
  return lowest(ends.filter((f) => /exutoire|embouchure/i.test(f.properties?.categorie || "")));
}

/** Extrémités (dédoublonnées) des lignes d'une géométrie */
export function lineEnds(geometry) {
  const lines = geometry?.type === "MultiLineString" ? geometry.coordinates : geometry?.type === "LineString" ? [geometry.coordinates] : [];
  const seen = new Set();
  const ends = [];
  lines.forEach((line) => {
    [line[0], line[line.length - 1]].forEach((c) => {
      const key = c ? `${c[0].toFixed(5)},${c[1].toFixed(5)}` : "";
      if (c && !seen.has(key)) {
        seen.add(key);
        ends.push([c[0], c[1]]);
      }
    });
  });
  return ends;
}

async function riverWithGeometry(id, signal) {
  const features = await wfsFeatures("BDTOPO_V3:cours_d_eau", `cleabs=${cqlString(id)}`, { count: 1, properties: ["toponyme", "geometrie"], signal });
  return { name: features[0]?.properties?.toponyme || "", geometry: features[0]?.geometry || null };
}

/** Nœuds hydrographiques aux extrémités d'un cours d'eau (requêtes spatiales, rapides) */
async function nodesAtEnds(riverId, ends, signal) {
  const chunks = [];
  for (let i = 0; i < ends.length; i += 12) {
    chunks.push(ends.slice(i, i + 12));
  }
  const results = await Promise.all(chunks.map((chunk) => {
    const spatial = chunk.map(([lng, lat]) => `DWITHIN(geometrie,Point(${lat.toFixed(6)} ${lng.toFixed(6)}),0.02,kilometers)`).join(" OR ");
    return wfsFeatures("BDTOPO_V3:noeud_hydrographique", `(${spatial}) AND liens_vers_cours_d_eau_amont LIKE ${cqlString(`%${riverId}%`)}`,
      { count: 50, properties: ["categorie", "liens_vers_cours_d_eau_aval", "geometrie"], signal });
  }));
  return results.flat();
}

/**
 * Premier cours d'eau rejoint par l'eau tombée au point : cours d'eau principal du bassin
 * versant topographique (zone hydrographique de la BD TOPO) qui contient le point
 */
export async function getWaterStart(lat, lng, signal) {
  const bv = await wfsFeatures("BDTOPO_V3:bassin_versant_topographique", `INTERSECTS(geometrie,Point(${lat} ${lng}))`, {
    count: 1,
    properties: ["toponyme", "code_bdcarthage", "liens_vers_cours_d_eau_principal", "libelle_du_bassin_hydrographique"],
    signal,
  });
  const p = bv[0]?.properties;
  if (!p?.liens_vers_cours_d_eau_principal) {
    return null;
  }
  const riverId = String(p.liens_vers_cours_d_eau_principal).split("/")[0];
  const rivers = await wfsFeatures("BDTOPO_V3:cours_d_eau", `cleabs=${cqlString(riverId)}`, { count: 1, properties: ["toponyme"], signal });
  return {
    zone: p.toponyme || "",
    basin: p.libelle_du_bassin_hydrographique || "",
    river: { id: riverId, name: rivers[0]?.properties?.toponyme || "" },
  };
}

/**
 * Suit l'eau de rivière en rivière jusqu'à la mer (ou jusqu'à la sortie du réseau) : pour chaque
 * cours d'eau, on cherche, aux extrémités de son tracé, le confluent qui mène au suivant
 * @param {{river: {id: string, name: string}, basin: string}} start résultat de getWaterStart
 * @param {Object} options
 * @param {function(Array): void} options.onStep appelée après chaque rivière trouvée
 * @returns {Promise<{steps: Array, sea: {name: string, abroad: boolean}, complete: boolean}>}
 */
export async function traceWater(start, { signal, onStep = () => {}, maxSteps = 12 } = {}) {
  const first = await riverWithGeometry(start.river.id, signal);
  const steps = [{ id: start.river.id, name: first.name || start.river.name, geometry: first.geometry, end: null }];
  const seen = new Set([start.river.id]);
  let complete = false;
  onStep(steps);
  for (let i = 0; i < maxSteps; i++) {
    const current = steps[steps.length - 1];
    const nodes = current.geometry ? await nodesAtEnds(current.id, lineEnds(current.geometry), signal) : [];
    const outlet = pickOutlet(nodes, current.id);
    if (outlet) {
      const [lng, lat, z] = outlet.geometry.coordinates;
      current.end = { lng, lat, z, category: outlet.properties.categorie };
    }
    const nextId = outlet?.properties?.liens_vers_cours_d_eau_aval?.split("/")[0];
    if (!nextId || seen.has(nextId)) {
      complete = true;
      break;
    }
    seen.add(nextId);
    const next = await riverWithGeometry(nextId, signal);
    steps.push({ id: nextId, name: next.name || "un cours d'eau sans nom", geometry: next.geometry, end: null });
    onStep(steps);
  }
  const last = steps[steps.length - 1];
  return { steps, sea: seaOfBasin(start.basin, last.end), complete };
}

/**
 * Tracés des cours d'eau du voyage (BD TOPO), pour la carte
 * @returns {Promise<Array<Object>>} entités GeoJSON LineString / MultiLineString
 */
export async function getRiverGeometries(steps, signal) {
  const results = await Promise.allSettled(steps.map((s) => (s.geometry
    ? Promise.resolve(s.geometry)
    : riverWithGeometry(s.id, signal).then((r) => r.geometry))));
  return results.flatMap((r, i) => (r.status === "fulfilled" && r.value ? [{
    type: "Feature",
    geometry: stripZ(r.value),
    properties: { name: steps[i].name, order: i },
  }] : []));
}

function stripZ(geometry) {
  if (!geometry) {
    return geometry;
  }
  const round = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
  if (geometry.type === "LineString") {
    return { type: "LineString", coordinates: geometry.coordinates.map(round) };
  }
  if (geometry.type === "MultiLineString") {
    return { type: "MultiLineString", coordinates: geometry.coordinates.map((line) => line.map(round)) };
  }
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Géologie                                                                    */
/* -------------------------------------------------------------------------- */

const ROCK_FAMILIES = [
  { match: /s[ée]diment/i, key: "sedimentaire", text: "Elles se sont formées par l'accumulation de dépôts (sables, boues, débris de coquillages…) au fond d'anciennes mers, de lacs ou de rivières, puis se sont durcies avec le temps." },
  { match: /plutoni/i, key: "plutonique", text: "Ce sont d'anciens magmas refroidis lentement en profondeur, comme le granite, puis remontés en surface par l'érosion." },
  { match: /volcan/i, key: "volcanique", text: "Elles viennent de laves ou de cendres volcaniques refroidies en surface." },
  { match: /m[ée]tamorph/i, key: "metamorphique", text: "Ce sont des roches transformées par la chaleur et la pression en profondeur, comme les schistes ou les gneiss." },
];

/** Famille de roches (type de la carte lithologique du BRGM) → explication simple */
export function rockFamily(type) {
  return ROCK_FAMILIES.find((f) => f.match.test(String(type || ""))) || null;
}

/** Valeur d'un élément d'une réponse GML GetFeatureInfo (MapServer) */
export function gmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(String(xml || ""));
  return m ? m[1].trim() : "";
}

function brgmFeatureInfoUrl(layer, lat, lng) {
  const d = 0.0005;
  return `${BRGM_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo&LAYERS=${layer}&QUERY_LAYERS=${layer}&STYLES=`
    + `&CRS=EPSG:4326&BBOX=${lat - d},${lng - d},${lat + d},${lng + d}&WIDTH=11&HEIGHT=11&I=5&J=5`
    + "&INFO_FORMAT=application/vnd.ogc.gml&FEATURE_COUNT=1";
}

/** Tuiles de la carte géologique harmonisée au 1/50 000 (BRGM), pour la carte */
export const GEOLOGY_TILES = `${BRGM_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=SCAN_H_GEOL50&STYLES=`
  + "&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true";

/** Centre approximatif (moyenne des sommets) d'une géométrie GeoJSON */
export function geometryCenter(geometry) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      sx += c[0];
      sy += c[1];
      n++;
    } else {
      c.forEach(walk);
    }
  };
  if (geometry?.coordinates) {
    walk(geometry.coordinates);
  }
  return n ? [sx / n, sy / n] : null;
}

/** Ordre des axes : on garde celui qui place l'objet le plus près du point demandé */
function lngLatNear(coords, lat, lng) {
  if (!coords) {
    return null;
  }
  const [a, b] = coords;
  return distanceMeters(lat, lng, b, a) <= distanceMeters(lat, lng, a, b) ? { lng: a, lat: b } : { lng: b, lat: a };
}

/** Sites de l'Inventaire national du patrimoine géologique autour du point */
async function getGeologicalSites(lat, lng, radiusKm, signal) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const bbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng},urn:ogc:def:crs:EPSG::4326`;
  const features = await wfsFeatures("patrinat_inpg:inpg", "", {
    count: 60,
    properties: ["id_mnhn", "nom_site", "url_fiche", "geom"],
    signal,
    extra: `&SRSNAME=EPSG:4326&BBOX=${bbox}`,
  });
  return features.map((f) => {
    const p = f.properties || {};
    const center = lngLatNear(geometryCenter(f.geometry), lat, lng);
    if (!center || !p.nom_site) {
      return null;
    }
    return {
      id: `inpg-${p.id_mnhn}`,
      name: p.nom_site,
      url: p.url_fiche || (p.id_mnhn ? `https://inpn.mnhn.fr/site/inpg/${p.id_mnhn}` : ""),
      ...center,
      distance: distanceMeters(lat, lng, center.lat, center.lng),
    };
  }).filter((s) => s && s.distance <= radiusKm * 1000).sort((a, b) => a.distance - b.distance);
}

/**
 * Géologie du point : nature de la roche (1/1 000 000), feuille géologique au 1/50 000, sites
 * géologiques remarquables à proximité
 */
export async function getGeology(lat, lng, signal) {
  const [litho, sheet, sites] = await Promise.allSettled([
    fetchText(brgmFeatureInfoUrl("LITHO_1M_SIMPLIFIEE", lat, lng), signal),
    fetchText(brgmFeatureInfoUrl("SCAN_F_GEOL50_CATALOG", lat, lng), signal),
    getGeologicalSites(lat, lng, 20, signal),
  ]);
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const rock = litho.status === "fulfilled" ? gmlValue(litho.value, "DESCR") : "";
  const type = litho.status === "fulfilled" ? gmlValue(litho.value, "TYPE") : "";
  const sheetNumber = sheet.status === "fulfilled" ? gmlValue(sheet.value, "numero") : "";
  const sheetName = sheet.status === "fulfilled" ? gmlValue(sheet.value, "nom") : "";
  if (!rock && !sheetNumber && (sites.status !== "fulfilled" || !sites.value.length)) {
    if (litho.status === "rejected" && sites.status === "rejected") {
      throw litho.reason;
    }
    return null;
  }
  return {
    rock,
    type,
    family: rockFamily(type),
    sheet: sheetNumber ? { number: sheetNumber, name: sheetName ? sheetName.split("-").map((w) => capitalize(w.toLowerCase())).join("-") : "" } : null,
    sites: sites.status === "fulfilled" ? sites.value : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Panorama : que voit-on d'ici ?                                              */
/* -------------------------------------------------------------------------- */

const EARTH_RADIUS = 6371000;
/** Coefficient de réfraction atmosphérique standard */
const REFRACTION = 0.13;
const EYE_HEIGHT = 1.7;
const NEAR_RADIUS_KM = 25;
const FAR_RADIUS_KM = 150;
const MAX_POINTS = 11000;
const ELEVATION_CHUNK = 4000;

/** Abaissement apparent d'un point à la distance d (m), courbure terrestre et réfraction comprises */
export function curvatureDrop(distance) {
  return (distance * distance) / (2 * EARTH_RADIUS) * (1 - REFRACTION);
}

/**
 * Visibilité d'une cible au bout d'un profil
 * @param {Array<{d: number, z: number}>} profile échantillons depuis l'observateur (exclu) jusqu'à la cible (dernier)
 * @param {number} observerZ altitude des yeux de l'observateur
 * @returns {{visible: boolean, angle: number, margin: number}} angle de la cible au-dessus de l'horizontale (degrés)
 */
export function sightLine(profile, observerZ) {
  const angle = (p) => Math.atan2(p.z - curvatureDrop(p.d) - observerZ, p.d);
  const target = profile[profile.length - 1];
  const targetAngle = angle(target);
  let maxObstacle = -Infinity;
  for (let i = 0; i < profile.length - 1; i++) {
    // ignore les abords immédiats de la cible (même relief)
    if (target.d - profile[i].d < Math.max(150, target.d * 0.01)) {
      continue;
    }
    maxObstacle = Math.max(maxObstacle, angle(profile[i]));
  }
  const tolerance = 0.0003;
  return {
    visible: targetAngle >= maxObstacle - tolerance,
    angle: targetAngle * 180 / Math.PI,
    margin: (targetAngle - maxObstacle) * 180 / Math.PI,
  };
}

/** Nombre d'échantillons d'un profil selon sa longueur */
export function profileSamples(distance) {
  if (distance <= NEAR_RADIUS_KM * 1000) {
    return Math.max(20, Math.min(110, Math.round(distance / 150)));
  }
  return Math.max(60, Math.min(260, Math.round(distance / 500)));
}

const PEAK_NATURES = ["Sommet", "Pic", "Montagne"];
const NOT_A_PEAK = /^(massif|cha[iî]ne|montagnes|les grandes|plateau|monts du|monts de)\b/i;

function summitFromFeature(f, lat, lng) {
  const p = f.properties || {};
  const [sLng, sLat] = f.geometry?.coordinates || [];
  if (!p.toponyme || !Number.isFinite(sLat) || NOT_A_PEAK.test(p.toponyme)) {
    return null;
  }
  return {
    id: `summit-${sLng.toFixed(5)},${sLat.toFixed(5)}`,
    name: capitalize(p.toponyme),
    nature: p.nature,
    importance: Number(p.importance) || 9,
    lat: sLat,
    lng: sLng,
    distance: distanceMeters(lat, lng, sLat, sLng),
    bearing: bearingDegrees(lat, lng, sLat, sLng),
  };
}

/** Écarte les doublons proches (même massif) en gardant le plus important */
export function dedupeSummits(summits, minDistance = 1500) {
  const kept = [];
  [...summits].sort((a, b) => a.importance - b.importance || a.distance - b.distance).forEach((s) => {
    if (!kept.some((k) => distanceMeters(k.lat, k.lng, s.lat, s.lng) < minDistance)) {
      kept.push(s);
    }
  });
  return kept;
}

async function getSummitCandidates(lat, lng, signal) {
  const natures = PEAK_NATURES.map(cqlString).join(",");
  const [near, far] = await Promise.all([
    wfsFeatures("BDTOPO_V3:detail_orographique",
      `DWITHIN(geometrie,Point(${lat} ${lng}),${NEAR_RADIUS_KM},kilometers) AND nature IN (${natures}) AND toponyme IS NOT NULL`,
      { count: 400, properties: ["toponyme", "nature", "importance", "geometrie"], signal }),
    wfsFeatures("BDTOPO_V3:detail_orographique",
      `DWITHIN(geometrie,Point(${lat} ${lng}),${FAR_RADIUS_KM},kilometers) AND nature IN (${natures}) AND importance='1'`,
      { count: 300, properties: ["toponyme", "nature", "importance", "geometrie"], signal }),
  ]);
  const nearSummits = dedupeSummits(near.map((f) => summitFromFeature(f, lat, lng)).filter((s) => s && s.distance > 300), 800)
    .slice(0, 45);
  const farSummits = dedupeSummits(far.map((f) => summitFromFeature(f, lat, lng))
    .filter((s) => s && s.distance > NEAR_RADIUS_KM * 1000), 4000)
    .slice(0, 30);
  return [...nearSummits, ...farSummits];
}

async function elevations(points, signal) {
  const chunks = [];
  for (let i = 0; i < points.length; i += ELEVATION_CHUNK) {
    chunks.push(points.slice(i, i + ELEVATION_CHUNK));
  }
  const results = await Promise.all(chunks.map(async (chunk) => {
    const json = await fetchJson(ALTI_ELEVATION, signal, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lon: chunk.map((p) => p[0].toFixed(6)).join("|"),
        lat: chunk.map((p) => p[1].toFixed(6)).join("|"),
        resource: "ign_rge_alti_wld",
        delimiter: "|",
        indent: "false",
        measures: "false",
        zonly: "true",
      }),
    });
    return json.elevations || [];
  }));
  return results.flat().map((z) => (typeof z === "object" && z !== null ? z.z : z));
}

/**
 * Sommets visibles depuis le point (relief seul : bâtiments et végétation ne sont pas pris en compte)
 * @returns {Promise<{observerZ: number, visible: Array, hidden: number, candidates: number}>}
 */
export async function getPanorama(lat, lng, { signal, onProgress = () => {} } = {}) {
  onProgress("summits");
  let candidates = await getSummitCandidates(lat, lng, signal);
  // budget de points d'altitude
  let total = 1;
  candidates = candidates.filter((c) => {
    const n = profileSamples(c.distance);
    if (total + n > MAX_POINTS) {
      return false;
    }
    total += n;
    return true;
  });
  const points = [[lng, lat]];
  const ranges = candidates.map((c) => {
    const n = profileSamples(c.distance);
    const startIndex = points.length;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      points.push([lng + (c.lng - lng) * t, lat + (c.lat - lat) * t]);
    }
    return { startIndex, n };
  });
  onProgress("elevations");
  const z = await elevations(points, signal);
  const ground = Number(z[0]);
  if (!Number.isFinite(ground) || ground < -900) {
    return { observerZ: null, visible: [], hidden: 0, candidates: candidates.length };
  }
  const observerZ = ground + EYE_HEIGHT;
  const visible = [];
  candidates.forEach((c, k) => {
    const { startIndex, n } = ranges[k];
    const profile = [];
    for (let i = 1; i <= n; i++) {
      const zi = Number(z[startIndex + i - 1]);
      if (Number.isFinite(zi) && zi > -900) {
        profile.push({ d: c.distance * i / n, z: zi });
      }
    }
    if (profile.length < n * 0.8) {
      return;
    }
    const result = sightLine(profile, observerZ);
    if (result.visible) {
      visible.push({ ...c, altitude: Math.round(profile[profile.length - 1].z), angle: result.angle });
    }
  });
  visible.sort((a, b) => a.bearing - b.bearing);
  return { observerZ: Math.round(ground), visible, hidden: candidates.length - visible.length, candidates: candidates.length };
}

/* -------------------------------------------------------------------------- */
/* Produits du terroir (AOP / IGP)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Les fichiers communes × aires de l'INAO sont encodés en Windows-1252 mais lus en
 * Windows-1250 : « Crčme » pour « Crème », « Gruyčre » pour « Gruyère »…
 */
export function fixInaoEncoding(value) {
  const map = { "č": "è", "Č": "È", "ę": "ê", "Ę": "Ê", "ŕ": "à", "Ŕ": "À", "ů": "ù", "ű": "û", "ď": "ï", "ś": "œ", "Ś": "Œ" };
  return String(value || "").replace(/[čČęĘŕŔůűďśŚ]/g, (c) => map[c]);
}

export const PRODUCT_GROUPS = {
  fromages: { label: "Fromages et produits laitiers", icon: "sprout" },
  viandes: { label: "Viandes, volailles et charcuteries", icon: "pawPrint" },
  mer: { label: "Produits de la mer", icon: "fish" },
  vins: { label: "Vins", icon: "leaf" },
  boissons: { label: "Spiritueux, cidres et liqueurs", icon: "leaf" },
  autres: { label: "Fruits, légumes et autres produits", icon: "leaf" },
};
export const PRODUCT_GROUP_ORDER = Object.keys(PRODUCT_GROUPS);

/** Groupe d'affichage d'un produit du référentiel INAO */
export function productGroup(secteur, categorie) {
  const s = String(secteur || "").toUpperCase();
  const c = normalizeName(categorie);
  if (s === "LAITIER" || /^(pate|beurre|creme$|lait|autres fromages)/.test(c) || c === "chevre") {
    return "fromages";
  }
  if (/eaux de vie|rhum|whisk|liqueur|creme de cassis|spiritueuse|genevrier|cidre|poire$/.test(c)) {
    return "boissons";
  }
  if (s === "VITICOLE") {
    return "vins";
  }
  if (/bovin|ovin|porc|volaille|lapin|charcuterie|salaison|viande|oeuf/.test(c)) {
    return "viandes";
  }
  if (/poisson|mollusque|crustace/.test(c)) {
    return "mer";
  }
  return "autres";
}

/**
 * Index du référentiel des produits : nom de dénomination / d'appellation → appellation et groupe
 * @param {Array<Object>} rows lignes du référentiel (denomination, appellation, categorie, secteur, signe_ue)
 */
export function indexProducts(rows) {
  const index = new Map();
  (rows || []).forEach((row) => {
    const info = {
      appellation: row.appellation || row.denomination,
      group: productGroup(row.secteur, row.categorie),
      sign: String(row.signe_ue || "").trim(),
      category: row.categorie || "",
    };
    [row.denomination, row.appellation].forEach((name) => {
      const key = normalizeName(name);
      if (key && !index.has(key)) {
        index.set(key, info);
      }
    });
  });
  return index;
}

/** Dénomination complémentaire (« Franche-Comté Vuillafans blanc ») → appellation la plus longue qui la préfixe */
function prefixMatch(index, key) {
  if (!index || !key) {
    return null;
  }
  let best = null;
  let bestLength = 0;
  index.forEach((info, name) => {
    if (name.length > bestLength && key.startsWith(`${name} `)) {
      best = info;
      bestLength = name.length;
    }
  });
  return best;
}

/**
 * Aires de la commune (AOC/AOP et IGP) → produits regroupés par famille, sans doublons
 * @param {Array<{name: string, sign: string}>} areas
 * @param {Map} index résultat de indexProducts
 * @returns {Object<string, Array<{name: string, sign: string}>>}
 */
export function groupProducts(areas, index) {
  const groups = {};
  const seen = new Set();
  areas.forEach((area) => {
    const raw = fixInaoEncoding(area.name).replace(/\s*\((AOP|AOC|IGP|IG)\)\s*$/i, "").trim();
    const info = index?.get(normalizeName(raw)) || index?.get(normalizeName(area.name)) || prefixMatch(index, normalizeName(raw));
    const name = info?.appellation ? fixInaoEncoding(info.appellation) : raw;
    const group = info?.group || "autres";
    const sign = info?.sign || area.sign;
    const key = `${group}|${normalizeName(name)}`;
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    (groups[group] = groups[group] || []).push({ name, sign: sign.replace(/\s+/g, "") });
  });
  Object.values(groups).forEach((list) => list.sort((a, b) => (a.sign === b.sign ? a.name.localeCompare(b.name, "fr") : (a.sign === "AOP" ? -1 : 1))));
  return groups;
}

async function tabularByCommune(resource, codeInsee, extraFilters, signal) {
  const params = new URLSearchParams({ CI__exact: codeInsee, page_size: "100", ...extraFilters });
  const json = await fetchJson(`${TABULAR_API}/${resource}/data/?${params.toString()}`, signal);
  return json.data || [];
}

/**
 * Produits sous AOC/AOP ou IGP dont l'aire géographique couvre la commune
 * @returns {Promise<{groups: Object, total: number}>}
 */
export async function getProducts(codeInsee, signal) {
  const code = String(codeInsee || "");
  const [aoc, igp, catalogue] = await Promise.all([
    tabularByCommune(DISCOVERY_RESOURCES.aoc, code, {}, signal),
    tabularByCommune(DISCOVERY_RESOURCES.igp, code, { Actual__exact: "1" }, signal),
    getParquetRows(DISCOVERY_RESOURCES.produits, ["denomination", "appellation", "categorie", "secteur", "signe_ue"])
      .catch((err) => {
        console.warn("[territoire] référentiel INAO :", err);
        return [];
      }),
  ]);
  const areas = [
    ...aoc.map((r) => ({ name: r["Aire géographique"], sign: "AOP" })),
    ...igp.map((r) => ({ name: r["Aire géographique"], sign: "IGP" })),
  ].filter((a) => a.name);
  const groups = groupProducts(areas, indexProducts(catalogue));
  const total = Object.values(groups).reduce((n, list) => n + list.length, 0);
  return { groups, total };
}

/* -------------------------------------------------------------------------- */
/* Bornes géodésiques et repères de nivellement                                */
/* -------------------------------------------------------------------------- */

const GEODESY_PROPERTIES = [
  "id", "domaine", "nom", "type", "commune", "localisation", "etat", "obs_date", "vis_date", "cp1_coord3",
  "cp1_srv", "support", "support_part", "rep_vert", "rep_hori", "voie_suivie", "voie_de", "voie_vers",
  "img1_url", "img1_date", "groupe_img1_url", "groupe_croquis1_url", "groupe_lieudit", "url_pdf", "diffusion", "remarque", "geom",
];
const FLOOD_TYPES = /crue/i;
const LOST_STATES = /non retrouv|detruit|détruit|disparu/i;

/** Libellé lisible du type d'un point (« M   REPERE CYLINDRIQUE… » → « Repère cylindrique… ») */
export function geodesyTypeLabel(type) {
  const t = String(type || "").replace(/^[A-Z]{1,3}\s{2,}/, "").trim();
  if (!t) {
    return "";
  }
  return t === t.toUpperCase() ? sentenceCase(t) : t.split(/\s*:\s*/).join(", ");
}

/** Point géodésique ou repère de nivellement (WFS GEODESIE:data_geod) → objet d'affichage */
export function geodesyToMark(feature, lat, lng) {
  const p = feature.properties || {};
  const [mLng, mLat] = feature.geometry?.coordinates || [];
  if (!Number.isFinite(mLat) || p.diffusion === false) {
    return null;
  }
  const leveling = /^niv/i.test(p.domaine || "");
  const altitude = Number(p.cp1_coord3);
  const observed = Number(String(p.obs_date || "").slice(0, 4)) || null;
  const photo = p.img1_url || p.groupe_img1_url || "";
  const flood = FLOOD_TYPES.test(p.type || "");
  const plain = (v) => {
    const t = String(v || "").replace(/"/g, "").trim();
    return t && t === t.toUpperCase() ? sentenceCase(t) : t;
  };
  const access = [
    plain(p.groupe_lieudit || p.localisation),
    !flood && p.voie_suivie ? `${sentenceCase(p.voie_suivie)}${p.voie_de && p.voie_vers ? ` (de ${sentenceCase(p.voie_de)} vers ${sentenceCase(p.voie_vers)})` : ""}` : "",
  ].filter(Boolean);
  const floodDate = flood ? parseFloodDate(p.remarque) : null;
  const placement = [p.support, p.support_part, p.rep_vert, p.rep_hori].filter(Boolean).map(sentenceCase);
  let kind = leveling ? "nivellement" : "geodesie";
  let name = leveling ? `Repère de nivellement ${p.nom}` : `Point géodésique ${p.nom}`;
  if (flood) {
    kind = "crue";
    name = floodDate ? `Crue ${floodDate.exact ? "du" : "de"} ${floodDate.text}` : "Repère de crue";
  }
  return {
    id: `geod-${p.id}`,
    kind,
    name,
    river: flood && p.voie_suivie ? riverName(p.voie_suivie) : "",
    floodYear: floodDate?.year || null,
    category: geodesyTypeLabel(p.type),
    commune: p.commune ? String(p.commune).replace(/--/g, " ").replace(/-(\d+)e-/g, " $1e ") : "",
    altitude: Number.isFinite(altitude) && altitude > -900 ? altitude : null,
    altitudeSystem: p.cp1_srv ? String(p.cp1_srv).replace(/^Système altimétrique\s*:\s*/i, "") : "",
    observed,
    visited: p.vis_date ? String(p.vis_date).slice(0, 4) : "",
    state: p.etat ? sentenceCase(p.etat) : "",
    lost: LOST_STATES.test(p.etat || ""),
    access,
    placement,
    photo,
    image: photo || "",
    photos: [
      photo ? { url: photo, credit: `IGN${p.img1_date ? `, ${String(p.img1_date).slice(0, 4)}` : ""}` } : null,
      p.groupe_croquis1_url ? { url: p.groupe_croquis1_url, credit: "Croquis de repérage, IGN" } : null,
    ].filter(Boolean),
    pdf: p.url_pdf || "",
    lat: mLat,
    lng: mLng,
    distance: distanceMeters(lat, lng, mLat, mLng),
    source: "IGN, géodésie et nivellement",
    raw: p,
  };
}

const FRENCH_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « Date inondation : 4/6/1856 » → { text: "4 juin 1856", year: 1856, exact: true } ; « … : 1910 » → { text: "1910" } */
export function parseFloodDate(remark) {
  const value = String(remark || "");
  const full = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  if (full) {
    const day = Number(full[1]);
    const month = Number(full[2]);
    const year = Number(full[3]);
    // « 1/1/1982 » : date inconnue saisie au 1er janvier
    if (month >= 1 && month <= 12 && !(day === 1 && month === 1)) {
      return { text: `${day === 1 ? "1er" : day} ${FRENCH_MONTHS[month - 1]} ${year}`, year, exact: true };
    }
    return { text: String(year), year, exact: false };
  }
  const year = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(value);
  return year ? { text: year[1], year: Number(year[1]), exact: false } : null;
}

/** « LA LOIRE » → « la Loire », « L' INDRE » → « l'Indre » */
export function riverName(value) {
  const t = String(value || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/^l'\s+/, "l'");
  const m = /^(la |le |les |l')?(.*)$/.exec(t);
  const particles = ["de", "du", "des", "la", "le", "les", "et", "sur", "en"];
  const words = (m[2] || "").split(/(\s+|-)/).map((w, i) => {
    if (!w.trim() || w === "-" || (i > 0 && particles.includes(w))) {
      return w;
    }
    return w.replace(/^(d'|l')?(.)/, (x, el, c) => `${el || ""}${c.toUpperCase()}`);
  }).join("");
  return `${m[1] || ""}${words}`;
}

/**
 * Bornes géodésiques et repères de nivellement autour du point, du plus proche au plus lointain
 * (les points signalés comme détruits ou non retrouvés sont écartés, les repères de crues sont à part)
 */
export async function getGeodesyMarks(lat, lng, signal, radiusKm = 2) {
  const features = await wfsFeatures("GEODESIE:data_geod",
    `DWITHIN(geom,Point(${lat} ${lng}),${radiusKm},kilometers) AND (type IS NULL OR NOT (type ILIKE '%crue%'))`, {
      count: 300, properties: GEODESY_PROPERTIES, signal,
    });
  const seen = new Set();
  return features.map((f) => geodesyToMark(f, lat, lng))
    .filter((m) => {
      if (!m || m.lost || seen.has(m.id)) {
        return false;
      }
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Repères de crues nivelés par l'IGN autour du point (dates et altitudes des grandes inondations)
 */
export async function getFloodMarks(lat, lng, signal, radiusKm = 10) {
  const features = await wfsFeatures("GEODESIE:data_geod",
    `DWITHIN(geom,Point(${lat} ${lng}),${radiusKm},kilometers) AND type ILIKE '%crue%'`, {
      count: 200, properties: GEODESY_PROPERTIES, signal,
    });
  const seen = new Set();
  return features.map((f) => geodesyToMark(f, lat, lng))
    .filter((m) => {
      if (!m || m.lost || seen.has(m.id)) {
        return false;
      }
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => a.distance - b.distance);
}

export default {
  getCommuneStory,
  getFloodMarks,
  getWaterStart,
  traceWater,
  getRiverGeometries,
  getGeology,
  getPanorama,
  getProducts,
  getGeodesyMarks,
};

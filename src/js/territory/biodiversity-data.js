/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Biodiversité observée autour d'un point, pour le volet « Mon territoire ».
 *
 * Même principe que BAM — Biodiversité autour de moi (https://bam.geonature.fr), outil libre des
 * parcs nationaux des Écrins et des Cévennes : pas de serveur, uniquement des API ouvertes.
 * - Observations : API du GBIF (Système mondial d'information sur la biodiversité). Les données
 *   sont collaboratives : naturalistes, associations, scientifiques et citoyens partagent leurs
 *   observations via des plateformes (iNaturalist, Faune-France, INPN Espèces…) qui les publient
 *   sur le GBIF.
 *   Plutôt que de paginer les observations comme BAM, on demande au GBIF des facettes
 *   (espèces les plus observées, par groupe) : une requête légère par groupe.
 * - Noms français, photos, statut UICN, lien INPN : Wikidata (une seule requête SPARQL pour toutes
 *   les espèces), avec repli sur les noms vernaculaires du GBIF (référentiel TAXREF en priorité) et,
 *   pour les photos, sur celles partagées avec les observations (iNaturalist…, licences CC0 / CC BY).
 * - Fiche espèce : calendrier d'observation et contributeurs (facettes GBIF), résumé Wikipédia,
 *   crédit de la photo (Wikimedia Commons).
 */

const GBIF_API = "https://api.gbif.org/v1";
const GBIF_MAPS = "https://api.gbif.org/v2/map/occurrence/density";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

/** Rayons essayés (m) : on élargit tant qu'il y a trop peu d'observations */
export const BIODIVERSITY_RADII = [1000, 3000, 10000];
const MIN_OBSERVATIONS = 300;
/** Période : les 10 dernières années */
export const BIODIVERSITY_YEARS = 10;
/** Nombre d'espèces demandées par groupe (le GBIF renvoie les plus observées d'abord) */
const SPECIES_PER_GROUP = 100;

/**
 * Groupes d'espèces (clés du référentiel taxonomique du GBIF)
 */
export const SPECIES_GROUPS = {
  oiseaux: { label: "Oiseaux", one: "Oiseau", icon: "bird", params: { classKey: [212] } },
  plantes: { label: "Plantes", one: "Plante", icon: "leaf", params: { kingdomKey: [6] } },
  insectes: { label: "Insectes et araignées", one: "Insecte ou araignée", icon: "bug", params: { classKey: [216, 367] } },
  mammiferes: { label: "Mammifères", one: "Mammifère", icon: "pawPrint", params: { classKey: [359] } },
  herpeto: { label: "Reptiles et amphibiens", one: "Reptile ou amphibien", icon: "pawPrint", params: { classKey: [358, 131] } },
  champignons: { label: "Champignons", one: "Champignon", icon: "sprout", params: { kingdomKey: [5] } },
  poissons: { label: "Poissons", one: "Poisson", icon: "fish", params: { classKey: [204] } },
};
export const SPECIES_GROUP_ORDER = Object.keys(SPECIES_GROUPS);

/** Statuts de la Liste rouge mondiale de l'UICN (éléments Wikidata) */
export const IUCN_STATUS = {
  Q211005: { code: "LC", label: "Préoccupation mineure" },
  Q719675: { code: "NT", label: "Quasi menacée" },
  Q278113: { code: "VU", label: "Vulnérable" },
  Q11394: { code: "EN", label: "En danger" },
  Q219127: { code: "CR", label: "En danger critique" },
  Q239509: { code: "EW", label: "Éteinte à l'état sauvage" },
  Q237350: { code: "EX", label: "Éteinte" },
  Q3245245: { code: "DD", label: "Données insuffisantes" },
};

/**
 * Plateformes de sciences participatives pour signaler une observation.
 * Leurs données rejoignent le GBIF (directement ou via l'INPN), et donc à terme Cartes IGN.
 */
export const CONTRIBUTE_PLATFORMS = {
  inaturalist: {
    name: "iNaturalist",
    desc: "Ajoutez une photo et la date : la communauté vous aide à confirmer l'espèce. Compte gratuit.",
    url: "https://www.inaturalist.org/observations/new",
  },
  inpn: {
    name: "INPN Espèces",
    desc: "Application mobile du Muséum national d'Histoire naturelle : vos observations sont vérifiées par des experts.",
    url: "https://inpn.mnhn.fr/accueil/participer/inpn-especes",
  },
  fauneFrance: {
    name: "Faune-France",
    desc: "Portail des associations naturalistes et de la LPO pour la faune : oiseaux, mammifères, reptiles, amphibiens, papillons, libellules…",
    url: "https://www.faune-france.org/",
  },
  plantnet: {
    name: "Pl@ntNet",
    desc: "Photographiez la plante : Pl@ntNet propose une identification, puis vous partagez l'observation.",
    url: "https://identify.plantnet.org/fr",
  },
};
const FAUNA_GROUPS = ["oiseaux", "mammiferes", "herpeto", "insectes", "poissons"];

/**
 * Lien vers le formulaire d'observation d'iNaturalist, pré-rempli (paramètres d'URL acceptés par
 * observations#new : taxon_name, latitude, longitude, place_guess, location_is_exact).
 * Sans compte, iNaturalist demande de se connecter puis revient sur ce même lien.
 */
export function inaturalistObservationUrl({ scientificName, lat, lng, place } = {}) {
  return apiUrl(CONTRIBUTE_PLATFORMS.inaturalist.url, {
    taxon_name: scientificName || undefined,
    latitude: Number.isFinite(lat) ? lat.toFixed(5) : undefined,
    longitude: Number.isFinite(lng) ? lng.toFixed(5) : undefined,
    location_is_exact: Number.isFinite(lat) ? false : undefined,
    place_guess: place || undefined,
  });
}

/**
 * Plateformes proposées pour signaler une espèce (ou une observation quelconque si group est vide),
 * de la plus adaptée à la plus générale
 * @returns {Array<{id: string, name: string, desc: string, url: string, prefilled: string}>}
 */
export function contributeOptions({ group, scientificName, lat, lng, place } = {}) {
  const options = [{
    id: "inaturalist",
    ...CONTRIBUTE_PLATFORMS.inaturalist,
    url: inaturalistObservationUrl({ scientificName, lat, lng, place }),
    prefilled: scientificName ? "Espèce et lieu déjà renseignés" : (Number.isFinite(lat) ? "Lieu déjà renseigné" : ""),
  }];
  if (group === "plantes") {
    options.push({ id: "plantnet", ...CONTRIBUTE_PLATFORMS.plantnet, prefilled: "" });
  }
  options.push({ id: "inpn", ...CONTRIBUTE_PLATFORMS.inpn, prefilled: "" });
  if (!group || FAUNA_GROUPS.includes(group)) {
    options.push({ id: "fauneFrance", ...CONTRIBUTE_PLATFORMS.fauneFrance, prefilled: "" });
  }
  return options;
}

/** Plateformes où chacun peut partager ses observations */
export const CONTRIBUTE_LINKS = [
  ["INPN Espèces (Muséum national d'Histoire naturelle)", "https://inpn.mnhn.fr/accueil/participer/inpn-especes"],
  ["iNaturalist", "https://www.inaturalist.org/"],
  ["Faune-France (oiseaux et faune)", "https://www.faune-france.org/"],
];

/* -------------------------------------------------------------------------- */
/* Utilitaires purs (testés unitairement)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Cercle approché en WKT, dans le sens inverse des aiguilles d'une montre (exigé par le GBIF)
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusM rayon en mètres
 * @param {number} sides nombre de côtés
 */
export function circleWkt(lat, lng, radiusM, sides = 24) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const points = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    points.push(`${(lng + dLng * Math.cos(a)).toFixed(5)} ${(lat + dLat * Math.sin(a)).toFixed(5)}`);
  }
  points.push(points[0]);
  return `POLYGON((${points.join(",")}))`;
}

/**
 * URL d'API avec paramètres (les tableaux deviennent des paramètres répétés, comme l'attend le GBIF)
 */
export function apiUrl(base, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    (Array.isArray(value) ? value : [value]).forEach((v) => search.append(key, String(v)));
  });
  return `${base}?${search.toString()}`;
}

/**
 * Mois « en ce moment » : le mois courant et ses deux voisins (1 à 12)
 * @param {Date} date
 */
export function seasonMonths(date = new Date()) {
  const m = date.getMonth() + 1;
  return [((m + 10) % 12) + 1, m, (m % 12) + 1];
}

/** Libellé des mois de la saison : « octobre à décembre » */
export function seasonLabel(months) {
  const names = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  return `${names[months[0] - 1]} à ${names[months[months.length - 1] - 1]}`;
}

/** Comptes d'une facette GBIF → [{ key, count }] */
export function facetCounts(json, field) {
  const facet = (json?.facets || []).find((f) => f.field === field);
  return (facet?.counts || []).map((c) => ({ key: String(c.name), count: Number(c.count) || 0 }));
}

/**
 * Calendrier d'observation : 12 valeurs (janvier → décembre) à partir de la facette MONTH
 */
export function monthHistogram(counts) {
  const months = Array(12).fill(0);
  counts.forEach(({ key, count }) => {
    const m = Number(key);
    if (m >= 1 && m <= 12) {
      months[m - 1] = count;
    }
  });
  return months;
}

/**
 * Mélange les espèces des groupes pour l'accueil : la plus observée de chaque groupe, puis la
 * deuxième… (sinon les oiseaux, très suivis par les naturalistes, occupent toute la liste)
 */
export function interleaveGroups(groups, max = 10) {
  const lists = SPECIES_GROUP_ORDER.map((g) => groups[g]?.species || []).filter((l) => l.length);
  const mixed = [];
  for (let i = 0; mixed.length < max && lists.some((l) => l[i]); i++) {
    lists.forEach((l) => {
      if (l[i] && mixed.length < max) {
        mixed.push(l[i]);
      }
    });
  }
  return mixed;
}

/**
 * Première lettre en capitale (les noms vernaculaires arrivent souvent en minuscules),
 * sans l'article final de TAXREF : « Crapaud épineux (Le) » → « Crapaud épineux »
 */
export function capitalizeName(name) {
  const s = String(name || "").replace(/\s*\((?:le|la|les|l')\)\s*$/i, "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/**
 * Choisit le nom français parmi les noms vernaculaires du GBIF (TAXREF en priorité)
 */
export function pickFrenchName(results = []) {
  const order = ["TAXREF", "EUNIS Biodiversity Database", "Catalogue of Life"];
  const rank = (r) => {
    const i = order.findIndex((src) => String(r.source || "").includes(src));
    return i < 0 ? order.length : i;
  };
  const fr = results.filter((r) => r.language === "fra" && r.vernacularName).sort((a, b) => rank(a) - rank(b));
  return fr.length ? capitalizeName(fr[0].vernacularName) : "";
}

/**
 * Lignes SPARQL Wikidata → { [gbifKey]: { frName, scientificName, image, taxref, iucn, wikipedia } }
 * (plusieurs lignes possibles par espèce : on garde la première valeur de chaque champ)
 */
export function parseWikidataRows(bindings = []) {
  const out = {};
  bindings.forEach((row) => {
    const key = row.gbif?.value;
    if (!key) {
      return;
    }
    const entry = out[key] || (out[key] = {});
    const set = (field, value) => {
      if (value && !entry[field]) {
        entry[field] = value;
      }
    };
    set("wikidata", row.item?.value?.split("/").pop());
    set("frName", capitalizeName(row.fr?.value));
    set("scientificName", row.name?.value);
    set("image", row.image?.value);
    set("taxref", row.taxref?.value);
    set("iucn", IUCN_STATUS[row.iucn?.value?.split("/").pop()] || null);
    set("wikipedia", row.article?.value);
  });
  return out;
}

/** Miniature d'une image Wikimedia Commons (URL Special:FilePath renvoyée par Wikidata) */
export function commonsThumb(url, width = 400) {
  if (!url) {
    return "";
  }
  const https = String(url).replace(/^http:/, "https:");
  return `${https}${https.includes("?") ? "&" : "?"}width=${width}`;
}

/** Nom du fichier Commons à partir de l'URL Special:FilePath */
export function commonsFileName(url) {
  const m = /Special:FilePath\/(.+?)(?:\?|$)/.exec(String(url || ""));
  return m ? decodeURIComponent(m[1]) : "";
}

const LICENSES = {
  "http://creativecommons.org/publicdomain/zero/1.0/": "CC0",
  "http://creativecommons.org/licenses/by/4.0/": "CC BY 4.0",
  CC0_1_0: "CC0",
  CC_BY_4_0: "CC BY 4.0",
};

/**
 * Photo partagée avec une observation GBIF (souvent iNaturalist) : repli quand Wikidata n'a pas d'image.
 * Les photos iNaturalist existent en plusieurs tailles : on prend « medium » (500 px) plutôt que l'original.
 * @returns {{url: string, thumb: string, credit: string, link: string}|null}
 */
export function photoFromOccurrences(results = []) {
  for (const occ of results) {
    const media = (occ.media || []).find((m) => /^https:\/\//.test(m.identifier || "") && (!m.type || m.type === "StillImage"));
    if (!media) {
      continue;
    }
    const inat = /\/original\.(jpe?g|png)$/i.test(media.identifier);
    const license = LICENSES[media.license] || LICENSES[occ.license] || "";
    const author = media.creator || media.rightsHolder || occ.recordedBy || "";
    const platform = media.publisher || occ.publisher || occ.datasetName || "";
    return {
      url: inat ? media.identifier.replace(/original\.(\w+)$/i, "medium.$1") : media.identifier,
      thumb: inat ? media.identifier.replace(/original\.(\w+)$/i, "small.$1") : media.identifier,
      credit: [author, platform, license].filter(Boolean).join(" · "),
      link: `https://www.gbif.org/occurrence/${encodeURIComponent(occ.key)}`,
    };
  }
  return null;
}

/** Tuiles de densité d'observations du GBIF pour une espèce (carte de répartition) */
export function speciesTilesUrl(speciesKey) {
  return `${GBIF_MAPS}/{z}/{x}/{y}@2x.png?srs=EPSG:3857&taxonKey=${encodeURIComponent(speciesKey)}`
    + "&bin=hex&hexPerTile=48&style=green2-noborder.poly";
}

/** Lien vers BAM centré sur le point, pour explorer plus loin */
export function bamUrl(lat, lng, radiusM) {
  const params = new URLSearchParams({
    wkt: `POINT(${lng.toFixed(5)} ${lat.toFixed(5)})`,
    buffer: String(radiusM),
    lang: "fr",
  });
  return `https://bam.geonature.fr/#/?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Requêtes                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchJson(url, signal, options = {}) {
  const response = await fetch(url, { signal, ...options });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} pour ${url}`);
  }
  return response.json();
}

/** Filtres communs : observations présentes, bien localisées, sur la période */
function baseParams(geometry, { months } = {}) {
  const year = new Date().getFullYear();
  return {
    geometry,
    occurrenceStatus: "PRESENT",
    hasCoordinate: true,
    hasGeospatialIssue: false,
    basisOfRecord: ["HUMAN_OBSERVATION", "MACHINE_OBSERVATION", "OBSERVATION", "OCCURRENCE"],
    year: `${year - BIODIVERSITY_YEARS},${year}`,
    month: months,
    limit: 0,
  };
}

function gbifSearch(params, signal) {
  return fetchJson(apiUrl(`${GBIF_API}/occurrence/search`, params), signal);
}

const datasetCache = {};
function getDatasetTitle(key, signal) {
  if (!datasetCache[key]) {
    datasetCache[key] = fetchJson(`${GBIF_API}/dataset/${encodeURIComponent(key)}`, signal)
      .then((json) => json.title || "")
      .catch((err) => {
        delete datasetCache[key];
        throw err;
      });
  }
  return datasetCache[key];
}

/** Jeux de données (contributeurs) les plus représentés, avec leur titre */
async function topDatasets(counts, max, signal) {
  const top = counts.slice(0, max);
  const titles = await Promise.all(top.map((d) => getDatasetTitle(d.key, signal).catch(() => "")));
  return top.map((d, i) => ({ ...d, title: titles[i] })).filter((d) => d.title);
}

/**
 * Choisit le rayon : le plus petit qui rassemble assez d'observations
 */
async function chooseRadius(lat, lng, signal) {
  let last = null;
  for (const radius of BIODIVERSITY_RADII) {
    const geometry = circleWkt(lat, lng, radius);
    const json = await gbifSearch(baseParams(geometry), signal);
    last = { radius, geometry, total: Number(json.count) || 0 };
    if (last.total >= MIN_OBSERVATIONS) {
      break;
    }
  }
  return last;
}

/**
 * Espèces les plus observées par groupe, dans une zone et (optionnellement) une saison
 * @returns {Promise<Object>} { [group]: { count, species: [{ key, count, group }], truncated } }
 */
export async function getSpeciesByGroup(geometry, { months, signal } = {}) {
  const entries = await Promise.all(SPECIES_GROUP_ORDER.map(async (group) => {
    const json = await gbifSearch({
      ...baseParams(geometry, { months }),
      ...SPECIES_GROUPS[group].params,
      facet: "speciesKey",
      facetLimit: SPECIES_PER_GROUP,
    }, signal);
    const species = facetCounts(json, "SPECIES_KEY").map((s) => ({ key: s.key, count: s.count, group }));
    return [group, { count: Number(json.count) || 0, species, truncated: species.length >= SPECIES_PER_GROUP }];
  }));
  return Object.fromEntries(entries);
}

/**
 * Biodiversité observée autour d'un point
 * @returns {Promise<{radius: number, geometry: string, total: number, groups: Object, datasets: Array, datasetCount: number, since: number}>}
 */
export async function getBiodiversity(lat, lng, signal) {
  const { radius, geometry, total } = await chooseRadius(lat, lng, signal);
  if (!total) {
    return { radius, geometry, total, groups: {}, datasets: [], datasetCount: 0, since: new Date().getFullYear() - BIODIVERSITY_YEARS };
  }
  const [groups, datasetJson] = await Promise.all([
    getSpeciesByGroup(geometry, { signal }),
    gbifSearch({ ...baseParams(geometry), facet: "datasetKey", facetLimit: 50 }, signal),
  ]);
  const datasetCounts = facetCounts(datasetJson, "DATASET_KEY");
  const datasets = await topDatasets(datasetCounts, 4, signal);
  return {
    radius,
    geometry,
    total,
    groups,
    datasets,
    datasetCount: datasetCounts.length,
    since: new Date().getFullYear() - BIODIVERSITY_YEARS,
  };
}

const speciesInfoCache = {};

/** Repli GBIF pour une espèce absente de Wikidata : nom scientifique et nom français */
async function gbifSpeciesInfo(key, signal) {
  const [species, names] = await Promise.all([
    fetchJson(`${GBIF_API}/species/${encodeURIComponent(key)}`, signal),
    fetchJson(`${GBIF_API}/species/${encodeURIComponent(key)}/vernacularNames?limit=100`, signal).catch(() => ({ results: [] })),
  ]);
  return {
    scientificName: species.canonicalName || species.scientificName || "",
    frName: pickFrenchName(names.results),
  };
}

/** Photo d'une observation partagée en France, sous licence libre (CC0, CC BY) */
async function gbifPhoto(key, signal) {
  const json = await gbifSearch({
    taxonKey: key,
    mediaType: "StillImage",
    country: "FR",
    license: ["CC0_1_0", "CC_BY_4_0"],
    limit: 5,
  }, signal);
  return photoFromOccurrences(json.results);
}

/**
 * Complète les espèces (nom français, nom scientifique, photo, statut UICN, liens).
 * Une requête Wikidata pour toutes les espèces non encore connues, puis repli GBIF.
 * @param {Array<{key: string}>} species
 */
export async function enrichSpecies(species, signal) {
  const missing = [...new Set(species.map((s) => s.key))].filter((k) => !speciesInfoCache[k]);
  if (missing.length) {
    const values = missing.map((k) => `"${k.replace(/[^0-9]/g, "")}"`).join(" ");
    const query = `SELECT ?gbif ?item ?name ?fr ?image ?taxref ?iucn ?article WHERE {
      VALUES ?gbif { ${values} }
      ?item wdt:P846 ?gbif .
      OPTIONAL { ?item wdt:P225 ?name }
      OPTIONAL { ?item wdt:P1843 ?fr FILTER(LANG(?fr) = "fr") }
      OPTIONAL { ?item wdt:P18 ?image }
      OPTIONAL { ?item wdt:P3186 ?taxref }
      OPTIONAL { ?item wdt:P141 ?iucn }
      OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://fr.wikipedia.org/> }
    }`;
    let found = {};
    try {
      const json = await fetchJson(WIKIDATA_SPARQL, signal, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
        body: new URLSearchParams({ query, format: "json" }).toString(),
      });
      found = parseWikidataRows(json.results?.bindings);
    } catch (err) {
      if (err.name === "AbortError") {
        throw err;
      }
      console.warn("[biodiversité] Wikidata :", err);
    }
    await Promise.all(missing.map(async (key) => {
      const info = found[key] || {};
      if (!info.frName || !info.scientificName) {
        try {
          const fallback = await gbifSpeciesInfo(key, signal);
          info.scientificName = info.scientificName || fallback.scientificName;
          info.frName = info.frName || fallback.frName;
        } catch (err) {
          if (err.name === "AbortError") {
            throw err;
          }
        }
      }
      if (!info.image) {
        try {
          info.photo = await gbifPhoto(key, signal);
        } catch (err) {
          if (err.name === "AbortError") {
            throw err;
          }
        }
      }
      speciesInfoCache[key] = info;
    }));
  }
  species.forEach((s) => Object.assign(s, speciesInfoCache[s.key] || {}, { enriched: true }));
  return species;
}

/**
 * Détail d'une espèce : calendrier d'observation et contributeurs autour du point
 * (calendrier sur toute la France s'il y a trop peu d'observations locales),
 * résumé Wikipédia et crédit de la photo
 */
export async function getSpeciesDetail(species, geometry, signal) {
  const local = await gbifSearch({
    ...baseParams(geometry),
    taxonKey: species.key,
    facet: ["month", "datasetKey"],
    facetLimit: 12,
  }, signal);
  let monthCounts = facetCounts(local, "MONTH");
  let seasonScope = "local";
  if ((Number(local.count) || 0) < 24) {
    const national = await gbifSearch({
      ...baseParams(undefined),
      country: "FR",
      taxonKey: species.key,
      facet: "month",
      facetLimit: 12,
    }, signal).catch(() => null);
    if (national && Number(national.count) > Number(local.count)) {
      monthCounts = facetCounts(national, "MONTH");
      seasonScope = "france";
    }
  }

  const [datasets, summary, photoCredit] = await Promise.all([
    topDatasets(facetCounts(local, "DATASET_KEY"), 3, signal).catch(() => []),
    species.wikipedia ? getWikipediaSummary(species.wikipedia, signal).catch(() => null) : null,
    species.image
      ? getCommonsCredit(commonsFileName(species.image), signal).catch(() => null)
      : (species.photo ? { text: species.photo.credit, url: species.photo.link, shared: true } : null),
  ]);

  return {
    months: monthHistogram(monthCounts),
    seasonScope,
    localCount: Number(local.count) || 0,
    datasets,
    summary,
    photoCredit,
  };
}

async function getWikipediaSummary(articleUrl, signal) {
  const title = decodeURIComponent(String(articleUrl).split("/wiki/")[1] || "");
  if (!title) {
    return null;
  }
  const json = await fetchJson(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, signal);
  return json.extract ? { text: json.extract, url: json.content_urls?.desktop?.page || articleUrl } : null;
}

function stripTags(html) {
  const div = document.createElement("div");
  div.innerHTML = String(html || "");
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

async function getCommonsCredit(fileName, signal) {
  if (!fileName) {
    return null;
  }
  const json = await fetchJson(apiUrl("https://commons.wikimedia.org/w/api.php", {
    action: "query",
    titles: `File:${fileName}`,
    prop: "imageinfo",
    iiprop: "extmetadata",
    format: "json",
    origin: "*",
  }), signal);
  const page = Object.values(json.query?.pages || {})[0];
  const meta = page?.imageinfo?.[0]?.extmetadata || {};
  const author = stripTags(meta.Artist?.value);
  const license = meta.LicenseShortName?.value || "";
  return {
    text: [author, license].filter(Boolean).join(" · ") || "Wikimedia Commons",
    url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`,
  };
}

export default {
  getBiodiversity,
  getSpeciesByGroup,
  enrichSpecies,
  getSpeciesDetail,
};

/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Lecture des conversions Parquet que data.gouv.fr publie pour chaque jeu tabulaire
 * (stockage « Hydra »). Le fichier est lu par plages d'octets : seules les colonnes
 * demandées sont téléchargées, puis gardées en mémoire le temps de la session.
 * Rien n'est écrit sur l'appareil.
 */

const HYDRA_PARQUET = "https://hydra.s3.rbx.io.cloud.ovh.net/parquet/";

const tableCache = {};

/** URL de la conversion Parquet d'une ressource data.gouv.fr */
export function parquetUrl(resource) {
  return `${HYDRA_PARQUET}${resource}.parquet`;
}

/**
 * Valeurs Parquet → mêmes formes que l'API tabulaire (nombres, dates ISO)
 */
export function normalizeValue(value) {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return value;
}

function normalizeRow(row) {
  const out = {};
  Object.entries(row).forEach(([key, value]) => {
    out[key] = normalizeValue(value);
  });
  return out;
}

/**
 * Prépare une table pour la recherche par distance
 * @param {Array<Object>} rows
 * @param {function(Object): ({lat: number, lng: number}|null)} getCoords
 * @returns {{rows: Array<Object>, lats: Float64Array, lngs: Float64Array}}
 */
export function indexRows(rows, getCoords) {
  const kept = [];
  const lats = [];
  const lngs = [];
  rows.forEach((row) => {
    const coords = getCoords(row);
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
      kept.push(row);
      lats.push(coords.lat);
      lngs.push(coords.lng);
    }
  });
  return { rows: kept, lats: Float64Array.from(lats), lngs: Float64Array.from(lngs) };
}

/**
 * Lignes les plus proches d'un point (distance équirectangulaire, suffisante à cette échelle)
 * @returns {Array<{row: Object, lat: number, lng: number, distance: number}>} triées par distance (m)
 */
export function nearestRows(table, lat, lng, radiusKm, limit) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(lat * toRad);
  const maxDist = radiusKm * 1000;
  const dLatMax = maxDist / (R * toRad);
  const hits = [];
  for (let i = 0; i < table.rows.length; i++) {
    const dLat = table.lats[i] - lat;
    if (dLat > dLatMax || dLat < -dLatMax) {
      continue;
    }
    const x = (table.lngs[i] - lng) * toRad * cosLat;
    const y = dLat * toRad;
    const distance = Math.sqrt(x * x + y * y) * R;
    if (distance <= maxDist) {
      hits.push({ row: table.rows[i], lat: table.lats[i], lng: table.lngs[i], distance });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits.slice(0, limit);
}

async function readParquet(resource, columns) {
  const [{ asyncBufferFromUrl, cachedAsyncBuffer, parquetReadObjects }, { decompress }] = await Promise.all([
    import(/* webpackChunkName: "hyparquet" */ "hyparquet"),
    import(/* webpackChunkName: "hyparquet" */ "fzstd"),
  ]);
  const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url: parquetUrl(resource) }));
  const rows = await parquetReadObjects({
    file,
    columns,
    compressors: {
      ZSTD: (input, outputLength) => decompress(input, new Uint8Array(outputLength)),
    },
  });
  return rows.map(normalizeRow);
}

/**
 * Table indexée d'une ressource, chargée une seule fois par session
 * @param {string} resource identifiant de ressource data.gouv.fr
 * @param {Array<string>|undefined} columns colonnes à lire (toutes si absent)
 * @param {function(Object): ({lat: number, lng: number}|null)} getCoords
 */
export function getParquetTable(resource, columns, getCoords) {
  const key = `${resource}|${(columns || []).join(",")}`;
  if (!tableCache[key]) {
    tableCache[key] = readParquet(resource, columns)
      .then((rows) => indexRows(rows, getCoords))
      .catch((err) => {
        delete tableCache[key];
        throw err;
      });
  }
  return tableCache[key];
}

#!/usr/bin/env python3
"""
Construit un index des photos Mémoire rattachées aux notices Mérimée / Palissy.

Source : « Mémoire – illustration Mérimée et Palissy (Monuments historiques) »,
ministère de la Culture, data.gouv.fr (CSV ~1,3 Go, mis à jour chaque semaine) :
https://www.data.gouv.fr/datasets/68e8bbfa16a41347e37c821c/

Sortie (un fichier par département, lu par le volet « Mon territoire ») :
    <out>/<code_departement>.json
    {
      "c": ["crédit 1", "crédit 2", ...],              # crédits dédupliqués
      "p": { "PA00080567": [["MHR93_.../xxx_p.jpg", 0], ...] }  # chemin sous memoire/, indice de crédit
    }
    <out>/index.json : métadonnées (date, source, compteurs)

URL d'une image : https://popcorn-prd-perf-assets.s3.gra.io.cloud.ovh.net/memoire/<chemin>

Usage : build_index.py --source <url|fichier.csv> --out <dossier> [--max-per-notice 6]
Uniquement la bibliothèque standard (lecture en flux, sans tout charger en mémoire).
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_SOURCE = "https://ministere-culture.s3.sbg.io.cloud.ovh.net/POP/memoire_palissy_merimee.csv"

# Colonnes recherchées (noms constatés sur les jeux Mémoire de data.gouv.fr), avec repli par motif
COLUMN_CANDIDATES = {
    "refs": ["References_Palissy_Merimee_lien_notice_en_cours", r"(?i)merimee.*lien|lien.*merimee|^LBASE$"],
    "image": ["Lien_vers_l_image", r"(?i)lien.*image|^IMG$"],
    "dept": ["Departement", r"(?i)^departement$|^DPT$"],
    "rank": ["Rang_d_affichage_de_l_image_dans_les_bases_Palissy_et_Merimee", r"(?i)rang"],
    "author": ["Auteur_de_la_photographie", r"(?i)auteur_de_la_photo|^AUTP$"],
    "photographer": ["Photographe", r"(?i)^photographe$"],
    "copyright": ["Copyright", r"(?i)^copy(right)?$"],
    "date": ["Date_de_la_prise_de_vue", r"(?i)prise_de_vue|^DATPV$"],
}

REF_PATTERN = re.compile(r"\b(?:PA|IA|EA|DN|PM|IM|EM|AP)[0-9A-Z]{8}\b")
DEPT_PATTERN = re.compile(r"^(?:\d{2}|2A|2B|97\d)$")
DEFAULT_COPYRIGHT = "© Ministère de la Culture (France), Médiathèque du patrimoine et de la photographie"


def resolve_columns(header):
    resolved = {}
    for key, (exact, pattern) in COLUMN_CANDIDATES.items():
        if exact in header:
            resolved[key] = exact
            continue
        regex = re.compile(pattern)
        match = next((h for h in header if regex.search(h)), None)
        resolved[key] = match
    return resolved


def open_source(source):
    if re.match(r"^https?://", source):
        req = urllib.request.Request(source, headers={"User-Agent": "cartes-ign-expe/merimee-photos"})
        raw = urllib.request.urlopen(req, timeout=120)
    else:
        raw = open(source, "rb")
    return io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")


def detect_delimiter(first_line):
    counts = {d: first_line.count(d) for d in [",", ";", "\t", "|"]}
    return max(counts, key=counts.get)


def to_int(value, default=9999):
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def credit_for(row, cols):
    parts = []
    author = (row.get(cols["author"]) or "").strip() if cols["author"] else ""
    photographer = (row.get(cols["photographer"]) or "").strip() if cols["photographer"] else ""
    who = author or photographer
    if who:
        parts.append(who)
    date = (row.get(cols["date"]) or "").strip() if cols["date"] else ""
    if date and len(date) <= 20:
        parts.append(date)
    copyright_ = (row.get(cols["copyright"]) or "").strip() if cols["copyright"] else ""
    parts.append(copyright_ if copyright_ else DEFAULT_COPYRIGHT)
    return " — ".join(parts)[:300]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-per-notice", type=int, default=6)
    parser.add_argument("--limit", type=int, default=0, help="nombre maximal de lignes lues (tests)")
    args = parser.parse_args()

    csv.field_size_limit(sys.maxsize)
    text = open_source(args.source)
    first_line = text.readline()
    delimiter = detect_delimiter(first_line)
    header = next(csv.reader([first_line], delimiter=delimiter))
    header = [h.strip() for h in header]
    cols = resolve_columns(header)

    print(f"[photos] {len(header)} colonnes, séparateur {delimiter!r}")
    print(f"[photos] colonnes : {', '.join(header)}")
    print(f"[photos] colonnes retenues : {json.dumps(cols, ensure_ascii=False)}")
    missing = [k for k in ("refs", "image", "dept") if not cols[k]]
    if missing:
        print(f"[photos] ERREUR : colonnes introuvables : {missing}", file=sys.stderr)
        sys.exit(2)

    reader = csv.DictReader(text, fieldnames=header, delimiter=delimiter)
    # photos[dept][ref] = [(rank, order, path, credit)]
    photos = defaultdict(lambda: defaultdict(list))
    stats = defaultdict(int)
    for n, row in enumerate(reader, start=1):
        if args.limit and n > args.limit:
            break
        stats["rows"] += 1
        image = (row.get(cols["image"]) or "").strip()
        if not image:
            stats["no_image"] += 1
            continue
        path = image.split("memoire/", 1)[1] if "memoire/" in image else image.lstrip("/")
        if not re.search(r"\.(jpe?g|png|gif|webp)$", path, re.I):
            stats["not_image"] += 1
            continue
        refs = REF_PATTERN.findall(row.get(cols["refs"]) or "")
        if not refs:
            stats["no_ref"] += 1
            continue
        dept = (row.get(cols["dept"]) or "").strip().upper()
        dept = dept.zfill(2) if dept.isdigit() and len(dept) == 1 else dept
        if not DEPT_PATTERN.match(dept):
            # Les références de l'Inventaire (IA05000618) contiennent le département
            ia = next((r for r in refs if r.startswith("IA")), None)
            dept = ia[2:4] if ia else ""
            if not DEPT_PATTERN.match(dept):
                stats["no_dept"] += 1
                continue
            stats["dept_from_ref"] += 1
        rank = to_int(row.get(cols["rank"])) if cols["rank"] else 9999
        credit = credit_for(row, cols)
        for ref in set(refs):
            photos[dept][ref].append((rank, n, path, credit))
        stats["kept"] += 1
        if n % 200000 == 0:
            print(f"[photos] {n} lignes lues…", flush=True)

    os.makedirs(args.out, exist_ok=True)
    total_notices = 0
    total_photos = 0
    files = {}
    for dept, notices in sorted(photos.items()):
        credits = []
        credit_index = {}
        out = {}
        for ref, items in notices.items():
            items.sort(key=lambda t: (t[0], t[1]))
            seen = set()
            kept = []
            for _, _, path, credit in items:
                if path in seen:
                    continue
                seen.add(path)
                if credit not in credit_index:
                    credit_index[credit] = len(credits)
                    credits.append(credit)
                kept.append([path, credit_index[credit]])
                if len(kept) >= args.max_per_notice:
                    break
            out[ref] = kept
            total_photos += len(kept)
        total_notices += len(out)
        filename = f"{dept}.json"
        with open(os.path.join(args.out, filename), "w", encoding="utf-8") as f:
            json.dump({"c": credits, "p": out}, f, ensure_ascii=False, separators=(",", ":"))
        files[dept] = {"notices": len(out), "size": os.path.getsize(os.path.join(args.out, filename))}

    meta = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": args.source,
        "dataset": "https://www.data.gouv.fr/datasets/68e8bbfa16a41347e37c821c/",
        "imageBaseUrl": "https://popcorn-prd-perf-assets.s3.gra.io.cloud.ovh.net/memoire/",
        "columns": cols,
        "stats": dict(stats),
        "notices": total_notices,
        "photos": total_photos,
        "departements": files,
    }
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"[photos] {json.dumps(dict(stats))}")
    print(f"[photos] {total_notices} notices, {total_photos} photos, {len(files)} départements")
    if total_notices == 0:
        print("[photos] ERREUR : index vide", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()

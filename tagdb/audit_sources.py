"""Cross-source collision audit (author-side, standalone — no ComfyUI).

Given the danbooru and gelbooru tag DBs, quantify how often the cross-source name
collisions from the gelbooru plan (decision #3) actually occur, so the merge policy
("danbooru authoritative") can be validated against real numbers instead of guesses.

Usage:
    python -m tagdb.audit_sources                       # defaults to tagdb_data/*
    python -m tagdb.audit_sources dan.sqlite gel.sqlite
    python -m tagdb.audit_sources --examples 20         # print sample collisions

Classes reported:
  1  same name, same category .......... trivial merge
  2  same name, DIFFERENT category int .. merge must pick one (danbooru wins)
  3  name is a live tag in one source but an ALIAS in the other (canonicalisation clash)
  4  one alias string → DIFFERENT canonicals across sources (ambiguous alias)
  5  same name, both live, one deprecated only on one side
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, Tuple

from . import db as _db

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

_CATEGORY_NAMES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}


def _load(path: Path) -> Tuple[Dict[str, Tuple[int, int]], Dict[str, str]]:
    """Return (tags: name → (category, is_deprecated), aliases: antecedent → canonical)."""
    conn = _db.connect_read(path)
    try:
        tags = {
            r["name"]: (r["category"], r["is_deprecated"])
            for r in conn.execute("SELECT name, category, is_deprecated FROM tags")
        }
        aliases = {
            r["alias"]: r["canonical"]
            for r in conn.execute("SELECT alias, canonical FROM aliases")
        }
    finally:
        conn.close()
    return tags, aliases


def audit(dan_path: Path, gel_path: Path, examples: int = 0) -> Dict[str, int]:
    dan_tags, dan_alias = _load(dan_path)
    gel_tags, gel_alias = _load(gel_path)

    dan_names = set(dan_tags)
    gel_names = set(gel_tags)
    both = dan_names & gel_names

    same_cat = diff_cat = dep_clash = 0
    cat_examples, dep_examples = [], []
    for n in both:
        dcat, ddep = dan_tags[n]
        gcat, gdep = gel_tags[n]
        if dcat == gcat:
            same_cat += 1
        else:
            diff_cat += 1
            if len(cat_examples) < examples:
                cat_examples.append(
                    f"{n}: danbooru={_CATEGORY_NAMES.get(dcat, dcat)} / "
                    f"gelbooru={_CATEGORY_NAMES.get(gcat, gcat)}")
        if bool(ddep) != bool(gdep):
            dep_clash += 1
            if len(dep_examples) < examples:
                dep_examples.append(
                    f"{n}: danbooru_dep={bool(ddep)} / gelbooru_dep={bool(gdep)}")

    # Class 3: a string that is a live tag in one source but an alias antecedent in the other.
    dan_tag_is_gel_alias = dan_names & set(gel_alias)
    gel_tag_is_dan_alias = gel_names & set(dan_alias)

    # Class 4: alias string present in both alias maps but pointing to different canonicals.
    shared_aliases = set(dan_alias) & set(gel_alias)
    ambiguous = {a for a in shared_aliases if dan_alias[a] != gel_alias[a]}

    def _head(it, k):
        return ", ".join(sorted(it)[:k]) if k else ""

    print(f"=== Cross-source collision audit ===")
    print(f"danbooru: {len(dan_names):,} tags, {len(dan_alias):,} aliases  ({dan_path.name})")
    print(f"gelbooru: {len(gel_names):,} tags, {len(gel_alias):,} aliases  ({gel_path.name})")
    print(f"danbooru-only tags: {len(dan_names - gel_names):,}")
    print(f"gelbooru-only tags: {len(gel_names - dan_names):,}")
    print(f"shared tag names:   {len(both):,}")
    print()
    print(f"[1] same name, same category ........ {same_cat:,}")
    print(f"[2] same name, DIFFERENT category ... {diff_cat:,}"
          f"  ({100*diff_cat/len(both):.2f}% of shared)" if both else "")
    if cat_examples:
        print("      e.g. " + "; ".join(cat_examples))
    print(f"[3a] danbooru tag is a gelbooru alias  {len(dan_tag_is_gel_alias):,}")
    if examples and dan_tag_is_gel_alias:
        print("      e.g. " + _head(dan_tag_is_gel_alias, examples))
    print(f"[3b] gelbooru tag is a danbooru alias  {len(gel_tag_is_dan_alias):,}")
    if examples and gel_tag_is_dan_alias:
        print("      e.g. " + _head(gel_tag_is_dan_alias, examples))
    print(f"[4] shared alias → DIFFERENT canonical {len(ambiguous):,}"
          f"  (of {len(shared_aliases):,} shared aliases)")
    if examples and ambiguous:
        print("      e.g. " + "; ".join(
            f"{a}: danbooru→{dan_alias[a]} / gelbooru→{gel_alias[a]}"
            for a in sorted(ambiguous)[:examples]))
    print(f"[5] same name, deprecated on one side only  {dep_clash:,}")
    if dep_examples:
        print("      e.g. " + "; ".join(dep_examples))
    print()
    print("Interpretation: if [2]/[3]/[4] are tiny vs shared names, 'danbooru "
          "authoritative + source badges' (no special per-class UI) is sufficient.")

    return {
        "shared": len(both), "same_cat": same_cat, "diff_cat": diff_cat,
        "dan_tag_is_gel_alias": len(dan_tag_is_gel_alias),
        "gel_tag_is_dan_alias": len(gel_tag_is_dan_alias),
        "ambiguous_alias": len(ambiguous), "dep_clash": dep_clash,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Audit cross-source tag collisions")
    ap.add_argument("danbooru", nargs="?", default="tagdb_data/danbooru.sqlite")
    ap.add_argument("gelbooru", nargs="?", default="tagdb_data/gelbooru.sqlite")
    ap.add_argument("--examples", type=int, default=0,
                    help="print up to N sample collisions per class")
    args = ap.parse_args()
    dan, gel = Path(args.danbooru), Path(args.gelbooru)
    if not dan.exists():
        sys.exit(f"danbooru DB not found: {dan}")
    if not gel.exists():
        sys.exit(f"gelbooru DB not found: {gel}")
    audit(dan, gel, examples=args.examples)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Scan skills with NVIDIA SkillEvaluator (Tier 1) and attach eval metadata to the skills index.

Prototype for the SkillEvaluator collab: runs the deterministic Tier 1 checks
(schema, pii, license, quality, unicode, lint — no API key needed) over skill
directories and produces a compact `eval` block per skill, suitable for
embedding in website/static/api/skills-index.json entries under `extra.eval`.

Modes:
    # Scan the bundled + optional skill trees (local dirs)
    python scripts/scan_skills_index.py --local

    # Scan a sample of N community skills from the live index (downloads via skills hub)
    python scripts/scan_skills_index.py --community 50

    # Both, then write an enriched sample index + demo search rendering
    python scripts/scan_skills_index.py --local --community 50 --enrich

Caching: results are cached in ~/.hermes/cache/skill-scans/<sha256-of-content>.json
so CI re-runs only rescan changed skills.

Requires: `skillevaluator` on PATH (uv tool install
"skillevaluator @ git+https://github.com/NVIDIA/SkillEvaluator.git").
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
os.environ.setdefault("HERMES_HOME", str(Path.home() / ".hermes"))

CACHE_DIR = Path(os.environ["HERMES_HOME"]) / "cache" / "skill-scans"
CHECKS = "schema,pii,license,quality,unicode,lint"
SCANNER = "skillevaluator-tier1"

# Advisory severity ordering for the worst-finding rollup
_SEV_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
_RISK_BY_SEV = {"critical": "DO_NOT_INSTALL", "high": "CAUTION", "medium": "CAUTION", "low": "SAFE", "info": "SAFE", None: "SAFE"}

# Validators whose findings are SECURITY signal (drive the risk badge).
# Schema/license/quality findings are hygiene — reported, but they don't
# make a skill "dangerous" (e.g. missing author metadata is high-severity
# in SkillEvaluator's scheme but is not a security problem).
_SECURITY_VALIDATORS = ("PII Scan", "Unicode Smuggling Detection", "Security", "Code Risk", "SCRIPT_LINT")


def _is_security_validator(name: str) -> bool:
    return any(name.startswith(v) or v in name for v in _SECURITY_VALIDATORS)


def skill_content_hash(skill_dir: Path) -> str:
    """Stable content hash over all files in a skill dir (name + bytes)."""
    h = hashlib.sha256()
    for p in sorted(skill_dir.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            h.update(str(p.relative_to(skill_dir)).encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def scanner_version() -> str:
    try:
        out = subprocess.run(["skillevaluator", "--version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip().split()[-1] if out.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def run_tier1(skill_dir: Path, timeout: int = 180) -> dict | None:
    """Run skillevaluator validate -r json on one skill dir; return parsed report."""
    with tempfile.TemporaryDirectory(prefix="skscan-") as outdir:
        try:
            subprocess.run(
                ["skillevaluator", "validate", str(skill_dir),
                 "--checks", CHECKS, "--no-dedup", "-r", "json", "-o", outdir],
                capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return None
        reports = sorted(Path(outdir).glob("skillevaluator-output-*.json"))
        if not reports:
            return None
        try:
            return json.loads(reports[-1].read_text())
        except (json.JSONDecodeError, OSError):
            return None


def compact_eval(report: dict, content_hash: str, sk_version: str) -> dict:
    """Reduce a full Tier 1 JSON report to the compact index eval block.

    Risk badge is driven by SECURITY findings only (PII/secrets, unicode
    smuggling, code risk, script lint). Schema/license/quality issues are
    kept as hygiene signal: check pass/fail map + quality grade.
    """
    checks = {}
    sec_findings = []
    hygiene_findings = []
    for res in report.get("results", []):
        validator = res.get("validator", "unknown")
        checks[validator] = "pass" if res.get("passed") else "fail"
        for f in res.get("findings", []) or []:
            fsev = str(f.get("severity", "")).lower()
            if fsev not in ("critical", "high"):
                continue
            item = {
                "check": validator,
                "severity": fsev,
                "message": str(f.get("message", f.get("title", "")))[:160],
            }
            (sec_findings if _is_security_validator(validator) else hygiene_findings).append(item)
    sec_findings.sort(key=lambda f: -_SEV_ORDER.get(f["severity"], 0))
    hygiene_findings.sort(key=lambda f: -_SEV_ORDER.get(f["severity"], 0))
    worst_sec = sec_findings[0]["severity"] if sec_findings else None
    quality = (report.get("quality_summary") or [{}])[0]
    return {
        "scanner": SCANNER,
        "scanner_version": sk_version,
        "scanned_at": report.get("generated_at"),
        "content_hash": content_hash,
        "passed": bool(report.get("overall_passed")),
        "risk": _RISK_BY_SEV.get(worst_sec, "SAFE"),
        "severity_counts": {k: v for k, v in (report.get("severity_counts") or {}).items() if v},
        "checks": checks,
        "quality_score": quality.get("overall_score"),
        "quality_grade": quality.get("grade"),
        "top_findings": sec_findings[:3],
        "hygiene_findings": hygiene_findings[:3],
    }


def scan_skill_dir(skill_dir: Path, sk_version: str, use_cache: bool = True) -> dict | None:
    """Scan one skill dir with content-hash caching."""
    chash = skill_content_hash(skill_dir)
    cache_file = CACHE_DIR / f"{chash}.json"
    if use_cache and cache_file.exists():
        try:
            return json.loads(cache_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    report = run_tier1(skill_dir)
    if report is None:
        return None
    block = compact_eval(report, chash, sk_version)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(block, indent=1))
    return block


def iter_local_skills() -> list[tuple[str, Path]]:
    out = []
    for tree in ("skills", "optional-skills"):
        for skill_md in sorted((REPO_ROOT / tree).rglob("SKILL.md")):
            d = skill_md.parent
            out.append((f"{tree}/{d.relative_to(REPO_ROOT / tree)}", d))
    return out


def fetch_community_sample(index_path: Path, n: int, workdir: Path) -> list[tuple[dict, Path]]:
    """Download n community skills via the skills hub into workdir; return (entry, dir) pairs."""
    from tools.skills_hub import ClawHubSource, GitHubAuth, SkillsShSource  # noqa: deferred heavy import

    index = json.loads(index_path.read_text())
    skills = index["skills"] if isinstance(index, dict) else index
    community = [s for s in skills if s.get("source") in ("clawhub", "skills.sh")]
    # Deterministic spread: stride across the list rather than head-N
    stride = max(1, len(community) // n)
    sample = community[::stride][:n]

    auth = GitHubAuth()
    sources = {"clawhub": ClawHubSource(), "skills.sh": SkillsShSource(auth)}
    fetched = []
    for entry in sample:
        src = sources[entry["source"]]
        try:
            bundle = src.fetch(entry["identifier"])
        except Exception as e:
            print(f"  fetch failed {entry['identifier']}: {e}", file=sys.stderr)
            continue
        if not bundle or not bundle.files:
            continue
        dest = workdir / entry["source"].replace(".", "_") / entry["name"]
        dest.mkdir(parents=True, exist_ok=True)
        for rel, content in bundle.files.items():
            f = dest / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                f.write_bytes(content)
            else:
                f.write_text(content)
        fetched.append((entry, dest))
        print(f"  fetched {entry['source']}/{entry['name']} ({len(bundle.files)} files)")
    return fetched


def render_search_row(name: str, source: str, ev: dict | None) -> str:
    """Demo of how `hermes skills search` output looks with eval badges."""
    if not ev:
        badge, extra = "· unscanned", ""
    else:
        icon = {"SAFE": "✔", "CAUTION": "◐", "DO_NOT_INSTALL": "✗"}[ev["risk"]]
        badge = f"{icon} {ev['risk']}"
        grade = ev.get("quality_grade") or "?"
        extra = f"  quality {grade}"
        if ev["top_findings"]:
            extra += f"  ⚠ {ev['top_findings'][0]['message'][:50]}"
    return f"  {name:38.38s} {source:10s} {badge:18s}{extra}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="scan bundled skills/ + optional-skills/")
    ap.add_argument("--community", type=int, default=0, metavar="N", help="scan N community skills from the live index")
    ap.add_argument("--index", default="/tmp/skills-index.json", help="path to skills-index.json for --community/--enrich")
    ap.add_argument("--enrich", action="store_true", help="write enriched sample index + demo search output")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--out", default="/tmp/skill-scan-results", help="output dir")
    args = ap.parse_args()

    if shutil.which("skillevaluator") is None:
        sys.exit("skillevaluator not on PATH — uv tool install \"skillevaluator @ git+https://github.com/NVIDIA/SkillEvaluator.git\"")

    sk_version = scanner_version()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict] = {}   # key -> {entry-ish info, eval}
    t0 = time.time()

    if args.local:
        local = iter_local_skills()
        print(f"Scanning {len(local)} local skills...")
        for i, (rel, d) in enumerate(local, 1):
            ev = scan_skill_dir(d, sk_version, use_cache=not args.no_cache)
            results[rel] = {"name": d.name, "source": "official", "eval": ev}
            status = ev["risk"] if ev else "SCAN_ERROR"
            print(f"  [{i}/{len(local)}] {rel}: {status}")

    if args.community:
        workdir = Path(tempfile.mkdtemp(prefix="sk-community-"))
        print(f"Fetching {args.community} community skills to {workdir} ...")
        fetched = fetch_community_sample(Path(args.index), args.community, workdir)
        print(f"Scanning {len(fetched)} community skills...")
        for i, (entry, d) in enumerate(fetched, 1):
            ev = scan_skill_dir(d, sk_version, use_cache=not args.no_cache)
            key = f"{entry['source']}/{entry['identifier']}"
            results[key] = {"name": entry["name"], "source": entry["source"], "entry": entry, "eval": ev}
            status = ev["risk"] if ev else "SCAN_ERROR"
            print(f"  [{i}/{len(fetched)}] {key}: {status}")

    # Persist raw results
    (out_dir / "scan-results.json").write_text(json.dumps(results, indent=1))

    # Summary
    evs = [r["eval"] for r in results.values() if r["eval"]]
    n_err = sum(1 for r in results.values() if not r["eval"])
    from collections import Counter
    risks = Counter(e["risk"] for e in evs)
    print(f"\n=== {len(evs)} scanned, {n_err} errors, {time.time()-t0:.0f}s ===")
    for k in ("SAFE", "CAUTION", "DO_NOT_INSTALL"):
        print(f"  {k}: {risks.get(k, 0)}")
    passed = sum(1 for e in evs if e["passed"])
    print(f"  tier1 all-checks pass: {passed}/{len(evs)}")

    if args.enrich:
        # Enriched sample index: community entries with extra.eval attached
        enriched = []
        for r in results.values():
            entry = dict(r.get("entry") or {"name": r["name"], "source": r["source"]})
            entry.setdefault("extra", {})
            entry["extra"]["eval"] = r["eval"]
            enriched.append(entry)
        (out_dir / "enriched-sample-index.json").write_text(json.dumps(
            {"version": 2, "note": "sample entries with extra.eval blocks", "skills": enriched}, indent=1))

        # Demo search rendering
        lines = ["hermes skills search <query>  (demo with eval badges)", ""]
        for r in sorted(results.values(), key=lambda r: (r["eval"] is None, -(_SEV_ORDER.get((r["eval"] or {}).get("risk", ""), 0) if r["eval"] else 0))):
            lines.append(render_search_row(r["name"], r["source"], r["eval"]))
        demo = "\n".join(lines)
        (out_dir / "search-demo.txt").write_text(demo)
        print("\n" + demo[:2000])
        print(f"\nWrote {out_dir}/scan-results.json, enriched-sample-index.json, search-demo.txt")


if __name__ == "__main__":
    main()

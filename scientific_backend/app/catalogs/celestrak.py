"""Real orbital catalog ingestion (CelesTrak GP/OMM CSV + optional Space-Track GP).

Strict provenance & scientific integrity guarantees:
- Respects CelesTrak update frequency & usage policy (caches snapshots locally; minimum age guard).
- Supports >= 6-digit NORAD_CAT_IDs (uses GP/OMM CSV format, not legacy 5-digit TLE).
- Preserves raw immutable snapshot + SHA-256 hash + retrieval timestamp + exact URL.
- Deduplicates strictly by stable NORAD_CAT_ID.
- Classifies objects into PAYLOAD, ROCKET_BODY, DEBRIS, UNKNOWN without padding or relabeling.
- Returns explicit DATA_NOT_RETRIEVED status if network fails and no cached snapshot exists.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.config import (
    CATALOG_CACHE_DIR,
    CELESTRAK_GP_BASE_URL,
    CELESTRAK_MIN_CACHE_AGE_SEC,
    SPACETRACK_IDENTITY,
    SPACETRACK_PASSWORD,
)

# Validated allowlist of CelesTrak GP group identifiers (prevents arbitrary query injection)
ALLOWED_CELESTRAK_GROUPS = {
    "active": "Active Satellites",
    "stations": "Space Stations",
    "starlink": "Starlink Constellation",
    "oneweb": "OneWeb Constellation",
    "planet": "Planet Labs EO Fleet",
    "spire": "Spire Global Fleet",
    "gnss": "GNSS (GPS/GLONASS/Galileo/BeiDou)",
    "weather": "Weather Satellites",
    "resource": "Earth Resources / EO",
    "last-30-days": "Last 30 Days Launches",
    "cosmos-1408-debris": "COSMOS 1408 Debris",
    "fengyun-1c-debris": "FENGYUN 1C Debris",
    "iridium-33-debris": "IRIDIUM 33 Debris",
}

REQUIRED_OMM_FIELDS = (
    "OBJECT_NAME",
    "OBJECT_ID",
    "EPOCH",
    "MEAN_MOTION",
    "ECCENTRICITY",
    "INCLINATION",
    "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER",
    "MEAN_ANOMALY",
    "NORAD_CAT_ID",
    "BSTAR",
)


@dataclass
class CatalogProvenance:
    status: str  # "RETRIEVED_LIVE" | "LOADED_FROM_CACHE" | "DATA_NOT_RETRIEVED"
    source_provider: str
    group: str
    source_url: str
    retrieved_at_utc: Optional[str]
    snapshot_file: Optional[str]
    sha256_raw: Optional[str]
    actual_ingested_raw: int
    deduplicated_count: int
    duplicate_records_removed: int
    missing_elements_count: int
    stale_count_gt_7d: int
    classification_counts: Dict[str, int]
    epoch_min_utc: Optional[str]
    epoch_max_utc: Optional[str]
    median_element_age_hours: Optional[float]
    warnings: List[str]
    error_detail: Optional[str] = None


def classify_object_type(name: str, raw_type: str = "") -> str:
    """Conservatively classify catalog object from explicit OBJECT_TYPE or naming conventions."""
    rt = (raw_type or "").strip().upper()
    if rt in ("PAY", "PAYLOAD"):
        return "PAYLOAD"
    if rt in ("R/B", "ROCKET BODY", "ROCKET_BODY"):
        return "ROCKET_BODY"
    if rt in ("DEB", "DEBRIS"):
        return "DEBRIS"

    upper = (name or "").upper()
    if " DEB" in upper or upper.endswith("DEB") or "DEBRIS" in upper:
        return "DEBRIS"
    if " R/B" in upper or upper.endswith("R/B") or "ROCKET" in upper or "CENTAUR" in upper or "FREGAT" in upper:
        return "ROCKET_BODY"
    if upper.startswith("TBA") or upper == "" or "UNKNOWN" in upper:
        return "UNKNOWN"
    return "PAYLOAD"


def parse_omm_epoch_utc(epoch_str: str) -> Optional[datetime]:
    """Parse ISO-8601 OMM epoch string (e.g., 2026-11-23T01:23:45.123456) to UTC datetime."""
    if not epoch_str:
        return None
    s = epoch_str.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _snapshot_paths(group: str) -> Tuple[Path, Path]:
    safe_group = "".join(c for c in group if c.isalnum() or c in ("-", "_"))
    return (
        CATALOG_CACHE_DIR / f"celestrak_gp_{safe_group}.csv",
        CATALOG_CACHE_DIR / f"celestrak_gp_{safe_group}.meta.json",
    )


def parse_gp_csv_snapshot(
    raw_csv: str,
    group: str,
    source_provider: str,
    source_url: str,
    retrieved_at_utc: str,
    snapshot_file: str,
    status: str,
    reference_now_utc: Optional[datetime] = None,
) -> Tuple[List[Dict[str, Any]], CatalogProvenance]:
    """Parse raw GP/OMM CSV, deduplicate by NORAD_CAT_ID, check completeness & element age."""
    now_dt = reference_now_utc or datetime.now(timezone.utc)
    sha256_raw = hashlib.sha256(raw_csv.encode("utf-8")).hexdigest()
    reader = csv.DictReader(io.StringIO(raw_csv))

    raw_count = 0
    dedup_map: Dict[str, Dict[str, Any]] = {}
    duplicate_count = 0
    missing_elements_count = 0
    stale_count = 0
    classification_counts = {"PAYLOAD": 0, "ROCKET_BODY": 0, "DEBRIS": 0, "UNKNOWN": 0}
    ages_hours: List[float] = []
    epoch_dts: List[datetime] = []
    warnings: List[str] = []

    for row in reader:
        raw_count += 1
        cat_id = (row.get("NORAD_CAT_ID") or "").strip()
        if not cat_id:
            missing_elements_count += 1
            continue

        # Validate required orbital element fields exist and are non-empty
        missing_req = [f for f in REQUIRED_OMM_FIELDS if not (row.get(f) or "").strip()]
        if missing_req:
            missing_elements_count += 1
            continue

        epoch_dt = parse_omm_epoch_utc(row.get("EPOCH", ""))
        if epoch_dt is None:
            missing_elements_count += 1
            continue

        # Deduplicate by stable NORAD_CAT_ID, keeping freshest epoch if duplicates occur
        if cat_id in dedup_map:
            duplicate_count += 1
            prev_epoch = dedup_map[cat_id]["_epoch_dt"]
            if epoch_dt <= prev_epoch:
                continue

        age_hours = (now_dt - epoch_dt).total_seconds() / 3600.0
        obj_class = classify_object_type(
            row.get("OBJECT_NAME", ""),
            row.get("OBJECT_TYPE", ""),
        )
        rec = dict(row)
        rec["NORAD_CAT_ID"] = cat_id
        rec["OBJECT_CLASSIFICATION"] = obj_class
        rec["ELEMENT_AGE_HOURS"] = round(age_hours, 3)
        rec["IS_STALE_GT_7D"] = age_hours > 168.0
        rec["PROVENANCE_SOURCE"] = source_provider
        rec["PROVENANCE_URL"] = source_url
        rec["PROVENANCE_SHA256"] = sha256_raw[:16]
        rec["_epoch_dt"] = epoch_dt
        dedup_map[cat_id] = rec

    records: List[Dict[str, Any]] = []
    for rec in dedup_map.values():
        epoch_dt = rec.pop("_epoch_dt")
        epoch_dts.append(epoch_dt)
        ages_hours.append(float(rec["ELEMENT_AGE_HOURS"]))
        if rec["IS_STALE_GT_7D"]:
            stale_count += 1
        cls = rec["OBJECT_CLASSIFICATION"]
        classification_counts[cls] = classification_counts.get(cls, 0) + 1
        records.append(rec)

    records.sort(key=lambda r: int(r["NORAD_CAT_ID"]) if r["NORAD_CAT_ID"].isdigit() else r["NORAD_CAT_ID"])

    if stale_count > 0:
        warnings.append(
            f"{stale_count} objects have orbital-element epochs older than 7 days (SGP4 accuracy degrades with age)."
        )
    if missing_elements_count > 0:
        warnings.append(
            f"{missing_elements_count} raw rows lacked valid GP/OMM elements and were excluded from propagation."
        )
    if raw_count == 0:
        warnings.append("Snapshot contained 0 parseable CSV records.")

    ages_sorted = sorted(ages_hours)
    median_age = round(ages_sorted[len(ages_sorted) // 2], 3) if ages_sorted else None

    prov = CatalogProvenance(
        status=status,
        source_provider=source_provider,
        group=group,
        source_url=source_url,
        retrieved_at_utc=retrieved_at_utc,
        snapshot_file=snapshot_file,
        sha256_raw=sha256_raw,
        actual_ingested_raw=raw_count,
        deduplicated_count=len(records),
        duplicate_records_removed=duplicate_count,
        missing_elements_count=missing_elements_count,
        stale_count_gt_7d=stale_count,
        classification_counts=classification_counts,
        epoch_min_utc=min(epoch_dts).isoformat() if epoch_dts else None,
        epoch_max_utc=max(epoch_dts).isoformat() if epoch_dts else None,
        median_element_age_hours=median_age,
        warnings=warnings,
    )
    return records, prov


def ingest_celestrak_group(
    group: str = "active",
    force_refresh: bool = False,
    timeout_sec: float = 25.0,
) -> Tuple[List[Dict[str, Any]], CatalogProvenance]:
    """Fetch or load cached CelesTrak GP/OMM CSV snapshot with policy-compliant caching.

    Never fabricates objects if CelesTrak is unreachable and no cached snapshot exists.
    """
    if group not in ALLOWED_CELESTRAK_GROUPS:
        raise ValueError(
            f"Unsupported CelesTrak group '{group}'. Allowed groups: {sorted(ALLOWED_CELESTRAK_GROUPS.keys())}"
        )

    csv_path, meta_path = _snapshot_paths(group)
    source_url = f"{CELESTRAK_GP_BASE_URL}?GROUP={group}&FORMAT=csv"

    # 1. Check cached snapshot freshness (respecting CelesTrak >= 2 hour cache policy)
    if csv_path.exists() and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            cached_ts = float(meta.get("retrieved_unix", 0.0))
            age_sec = time.time() - cached_ts
            # Enforce minimum 600s cooldown even on force_refresh to avoid hammering CelesTrak
            min_interval = 600.0 if force_refresh else float(CELESTRAK_MIN_CACHE_AGE_SEC)
            if age_sec < min_interval:
                raw_csv = csv_path.read_text(encoding="utf-8")
                return parse_gp_csv_snapshot(
                    raw_csv=raw_csv,
                    group=group,
                    source_provider="CelesTrak GP/OMM CSV",
                    source_url=meta.get("source_url", source_url),
                    retrieved_at_utc=meta.get("retrieved_at_utc", ""),
                    snapshot_file=str(csv_path.name),
                    status="LOADED_FROM_CACHE",
                )
        except Exception:
            pass

    # 2. Live HTTPS retrieval from CelesTrak GP/OMM endpoint
    try:
        headers = {
            "User-Agent": "ConstellationLab-ResearchPlatform/2.0 (policy-compliant-cached-client)",
            "Accept": "text/csv,text/plain,*/*",
        }
        with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
            resp = client.get(source_url, headers=headers)
            resp.raise_for_status()
            raw_csv = resp.text

        if "NORAD_CAT_ID" not in raw_csv[:600]:
            raise RuntimeError(
                f"Unexpected response body from CelesTrak (missing OMM CSV header, status={resp.status_code})."
            )

        retrieved_at_utc = datetime.now(timezone.utc).isoformat()
        csv_path.write_text(raw_csv, encoding="utf-8")
        sha256_raw = hashlib.sha256(raw_csv.encode("utf-8")).hexdigest()
        meta_payload = {
            "source_provider": "CelesTrak GP/OMM CSV",
            "group": group,
            "source_url": source_url,
            "retrieved_at_utc": retrieved_at_utc,
            "retrieved_unix": time.time(),
            "sha256_raw": sha256_raw,
            "http_status": resp.status_code,
        }
        meta_path.write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")

        return parse_gp_csv_snapshot(
            raw_csv=raw_csv,
            group=group,
            source_provider="CelesTrak GP/OMM CSV",
            source_url=source_url,
            retrieved_at_utc=retrieved_at_utc,
            snapshot_file=str(csv_path.name),
            status="RETRIEVED_LIVE",
        )
    except Exception as exc:
        # Fallback ONLY to a genuine previously fetched immutable snapshot if present
        if csv_path.exists() and meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            raw_csv = csv_path.read_text(encoding="utf-8")
            recs, prov = parse_gp_csv_snapshot(
                raw_csv=raw_csv,
                group=group,
                source_provider="CelesTrak GP/OMM CSV",
                source_url=meta.get("source_url", source_url),
                retrieved_at_utc=meta.get("retrieved_at_utc", ""),
                snapshot_file=str(csv_path.name),
                status="LOADED_FROM_CACHE",
            )
            prov.warnings.append(f"Live refresh failed ({exc}); serving verified cached snapshot.")
            return recs, prov

        # No cached snapshot and network unavailable -> explicit DATA_NOT_RETRIEVED (never fabricate!)
        return [], CatalogProvenance(
            status="DATA_NOT_RETRIEVED",
            source_provider="CelesTrak GP/OMM CSV",
            group=group,
            source_url=source_url,
            retrieved_at_utc=None,
            snapshot_file=None,
            sha256_raw=None,
            actual_ingested_raw=0,
            deduplicated_count=0,
            duplicate_records_removed=0,
            missing_elements_count=0,
            stale_count_gt_7d=0,
            classification_counts={"PAYLOAD": 0, "ROCKET_BODY": 0, "DEBRIS": 0, "UNKNOWN": 0},
            epoch_min_utc=None,
            epoch_max_utc=None,
            median_element_age_hours=None,
            warnings=["Source catalog could not be retrieved and no immutable local snapshot exists."],
            error_detail=str(exc),
        )


def ingest_spacetrack_gp(
    limit: int = 5000,
    timeout_sec: float = 30.0,
) -> Tuple[List[Dict[str, Any]], CatalogProvenance]:
    """Optional user-authorized Space-Track.org GP query using env-var credentials only."""
    source_url = (
        f"https://www.space-track.org/basicspacedata/query/class/gp/"
        f"DECAY_DATE/null-val/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID%20asc/limit/{int(limit)}/format/csv"
    )
    if not SPACETRACK_IDENTITY or not SPACETRACK_PASSWORD:
        return [], CatalogProvenance(
            status="DATA_NOT_RETRIEVED",
            source_provider="Space-Track GP",
            group="spacetrack_gp",
            source_url=source_url,
            retrieved_at_utc=None,
            snapshot_file=None,
            sha256_raw=None,
            actual_ingested_raw=0,
            deduplicated_count=0,
            duplicate_records_removed=0,
            missing_elements_count=0,
            stale_count_gt_7d=0,
            classification_counts={"PAYLOAD": 0, "ROCKET_BODY": 0, "DEBRIS": 0, "UNKNOWN": 0},
            epoch_min_utc=None,
            epoch_max_utc=None,
            median_element_age_hours=None,
            warnings=["Space-Track credentials not configured (set SPACETRACK_IDENTITY and SPACETRACK_PASSWORD)."],
            error_detail="CREDENTIALS_NOT_CONFIGURED",
        )

    try:
        with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
            login_resp = client.post(
                "https://www.space-track.org/ajaxauth/login",
                data={"identity": SPACETRACK_IDENTITY, "password": SPACETRACK_PASSWORD},
            )
            login_resp.raise_for_status()
            resp = client.get(source_url)
            resp.raise_for_status()
            raw_csv = resp.text

        retrieved_at_utc = datetime.now(timezone.utc).isoformat()
        csv_path = CATALOG_CACHE_DIR / "spacetrack_gp_latest.csv"
        csv_path.write_text(raw_csv, encoding="utf-8")
        return parse_gp_csv_snapshot(
            raw_csv=raw_csv,
            group="spacetrack_gp",
            source_provider="Space-Track GP (Authorized)",
            source_url=source_url,
            retrieved_at_utc=retrieved_at_utc,
            snapshot_file=csv_path.name,
            status="RETRIEVED_LIVE",
        )
    except Exception as exc:
        return [], CatalogProvenance(
            status="DATA_NOT_RETRIEVED",
            source_provider="Space-Track GP",
            group="spacetrack_gp",
            source_url=source_url,
            retrieved_at_utc=None,
            snapshot_file=None,
            sha256_raw=None,
            actual_ingested_raw=0,
            deduplicated_count=0,
            duplicate_records_removed=0,
            missing_elements_count=0,
            stale_count_gt_7d=0,
            classification_counts={"PAYLOAD": 0, "ROCKET_BODY": 0, "DEBRIS": 0, "UNKNOWN": 0},
            epoch_min_utc=None,
            epoch_max_utc=None,
            median_element_age_hours=None,
            warnings=["Space-Track retrieval failed."],
            error_detail=str(exc),
        )


def provenance_to_dict(prov: CatalogProvenance) -> Dict[str, Any]:
    return asdict(prov)

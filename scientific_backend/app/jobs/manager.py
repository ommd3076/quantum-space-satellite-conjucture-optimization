"""Background job queue with progress tracking, cancellation, and artifact metadata."""
from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional


class JobManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._cancel_flags: Dict[str, threading.Event] = {}

    def submit(
        self,
        job_type: str,
        params: Dict[str, Any],
        fn: Callable[[Callable[[float, str], None], Callable[[], bool]], Dict[str, Any]],
    ) -> Dict[str, Any]:
        job_id = f"JOB-{uuid.uuid4().hex[:10].upper()}"
        cancel_ev = threading.Event()
        rec = {
            "job_id": job_id,
            "job_type": job_type,
            "status": "QUEUED",
            "progress": 0.0,
            "message": "Queued",
            "params": params,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "started_at_utc": None,
            "finished_at_utc": None,
            "wall_time_sec": None,
            "result": None,
            "error": None,
        }
        with self._lock:
            self._jobs[job_id] = rec
            self._cancel_flags[job_id] = cancel_ev

        def _progress(frac: float, msg: str) -> None:
            with self._lock:
                j = self._jobs[job_id]
                j["progress"] = round(max(0.0, min(1.0, float(frac))), 4)
                j["message"] = msg

        def _is_cancelled() -> bool:
            return cancel_ev.is_set()

        def _runner() -> None:
            t0 = time.perf_counter()
            with self._lock:
                self._jobs[job_id]["status"] = "RUNNING"
                self._jobs[job_id]["started_at_utc"] = datetime.now(timezone.utc).isoformat()
                self._jobs[job_id]["message"] = "Running"
            try:
                res = fn(_progress, _is_cancelled)
                wall = round(time.perf_counter() - t0, 4)
                with self._lock:
                    j = self._jobs[job_id]
                    j["wall_time_sec"] = wall
                    j["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
                    j["result"] = res
                    if cancel_ev.is_set() or (isinstance(res, dict) and res.get("status") == "CANCELLED"):
                        j["status"] = "CANCELLED"
                        j["message"] = "Cancelled by request"
                    else:
                        j["status"] = "COMPLETED"
                        j["progress"] = 1.0
                        j["message"] = "Completed"
            except Exception as exc:
                wall = round(time.perf_counter() - t0, 4)
                with self._lock:
                    j = self._jobs[job_id]
                    j["status"] = "FAILED"
                    j["wall_time_sec"] = wall
                    j["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
                    j["error"] = str(exc)
                    j["message"] = f"Failed: {exc}"

        t = threading.Thread(target=_runner, daemon=True)
        t.start()
        return self.get(job_id)  # type: ignore[return-value]

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j) if j is not None else None

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [
                {k: v for k, v in j.items() if k != "result"}
                for j in sorted(self._jobs.values(), key=lambda x: x["created_at_utc"], reverse=True)
            ]

    def cancel(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            ev = self._cancel_flags.get(job_id)
            if ev is None:
                return None
            ev.set()
            j = self._jobs[job_id]
            if j["status"] in ("QUEUED", "RUNNING"):
                j["message"] = "Cancellation requested"
            return dict(j)

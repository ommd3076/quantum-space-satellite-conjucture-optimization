# Constellation Lab — Running the Python/C++ Scientific Backend

Constellation Lab separates the **interactive 3D frontend & Node API gateway** (port `3000`) from the **Python/C++ scientific computation service** (port `8000`).

> **Zero Silent Fallback Policy:** When the Python scientific service is offline, `/api/science/*` returns `503 Service Unavailable (BACKEND_OFFLINE)`. The Node gateway never fabricates 50,000-object states, SGP4 ephemerides, or OR-Tools optimization certificates when Python is unreachable.

---

## Option A — Local Python Virtual Environment

```bash
# 1. Create venv & install pinned dependencies
python3 -m venv scientific_backend/.venv
source scientific_backend/.venv/bin/activate
pip install -r scientific_backend/requirements.lock

# 2. Verify C++ SGP4 acceleration & run pytest
PYTHONPATH=scientific_backend pytest -v scientific_backend/tests/test_science_backend.py

# 3. Start the FastAPI scientific service (port 8000)
PYTHONPATH=scientific_backend uvicorn app.api.main:app --host 127.0.0.1 --port 8000

# 4. In a second terminal, start the Express + Vite gateway (port 3000)
PYTHON_SCIENCE_URL=http://127.0.0.1:8000 npm run dev
```

---

## Option B — Docker Compose

```bash
docker compose up --build
```
- Python FastAPI Scientific Service: `http://localhost:8000/health`
- Constellation Lab Web Workspace: `http://localhost:3000`

---

## Headless Reproducible CLI Commands

```bash
PY=scientific_backend/.venv/bin/python

# 1. Fetch & cache real CelesTrak GP/OMM CSV catalog + C++ SGP4 propagation check
$PY scientific_backend/scripts/fetch_catalog.py --group active

# 2. Run independent orbital physics validation (Vallado 2006 SGP4, RK4 vs SciPy DOP853, Maneuver Vis-Viva)
$PY scientific_backend/scripts/validate_orbits.py

# 3. Execute 50,000-object 24-hour chunked stress benchmark (5-min step = 14,450,000 samples)
$PY scientific_backend/scripts/bench_50k.py --horizon-sec 86400 --step-sec 300 --chunk-size 5000

# 4. Execute shorter 1-minute high-rate 50k stress test (1h @ 60s = 3,050,000 samples)
$PY scientific_backend/scripts/bench_50k.py --horizon-sec 3600 --step-sec 60 --chunk-size 2500 --tag bench_50k_1min

# 5. Execute reproducible OR-Tools CP-SAT + baseline scheduling experiment
$PY scientific_backend/scripts/run_experiments.py --sats 24 --targets 30 --horizon-sec 21600 --seed 20261123
```

---

## Optional User-Authorized Space-Track Credentials

Never hardcode Space-Track credentials. Export them in your shell or `.env` before starting `uvicorn`:

```bash
export SPACETRACK_IDENTITY="your-email@example.com"
export SPACETRACK_PASSWORD="your-password"
```

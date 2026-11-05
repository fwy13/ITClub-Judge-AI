# IT Club Judge — AI Online Grading Platform

A self-hosted AI/programming assessment platform using the *user-provided* DMOJ pages as a design reference, the IT Club May 2026 Brand Guideline for visual identity, the earlier Rust/Isolate online judge, and the supplied CSV Judge repository.

## Included components

- `web/`: React UI. Home, problem search, code/CSV detail, registration/login, live submission progress, personal history, ranking, and an administrator exercise editor. Contest page is intentionally a placeholder; contests management is **not implemented**.
- `platform-api/`: Node.js HTTP/WebSocket authentication and orchestration service, PostgreSQL persistence, queue and per-test events.
- `rust-judge/`: existing Rust/Isolate worker preserved, one API call per test case for immediate progress feedback. Runs Python 3 with NumPy and CPU PyTorch.
- `csv-judge/`: original Python CSV judging implementation, plus a minimal authenticated internal FastAPI adapter. Supports binary, multiclass, multilabel, regression, ranking, and text scoring datasets from the supplied source.

## Quick start (dedicated Linux host strongly recommended)

1. `cp .env.example .env`; set unique strong `POSTGRES_PASSWORD`, `JWT_SECRET` (at least 32 characters) and `CSV_INTERNAL_KEY`.
2. `docker compose up -d --build` (first build downloads the CPU-only PyTorch wheel and compiles Rust/Isolate).
3. Visit **http://localhost:8080**; sign in with the administrator bootstrap credentials from `.env` or register a regular student account. If deploying remotely, use an HTTPS reverse proxy and configure `WEB_BIND` / `FRONTEND_ORIGIN`.
4. For administrators, open **Admin → Exercise management** to create a Python exam (test cases entered as JSON), or a CSV challenge (scoring JSON + ground-truth CSV upload). Open Problems → choose **Two Sum** or a CSV challenge → submit. The result page receives WebSocket messages **as each case finishes**. If WebSocket is interrupted, the page also polls for persisted status.
5. Test: `curl http://localhost:8080/api/health`.

> **Critical sandbox warning:** Docker Desktop / Windows often cannot supply working cgroup delegation for `isolate`. Use a dedicated Linux VM/host. The Rust worker requires `privileged: true` in this proof-of-concept Docker deployment. Do **not** expose it publicly or run it on a multi-tenant host. Isolate is not by itself a sufficient security boundary for adversarial workloads: harden the host, network egress, seccomp profiles, kernel, quotas and operational monitoring before production.

## Administrator page: create and upload exercises

The previous release had no exercise upload page. This release adds **`/admin/problems`**, available only when logged in with a database-backed administrator role. Student accounts cannot access the admin endpoints even by making requests manually.

**Bootstrap the administrator on the first startup:** set `ADMIN_BOOTSTRAP_USERNAME=itclubadmin` (or another unused username) and `ADMIN_BOOTSTRAP_PASSWORD` to a unique random value of at least 16 characters in `.env`. Start `docker compose up -d --build`. The service creates the admin user only if that username does not yet exist. It **never promotes an existing student account** just because the username matches. If the name is already registered to a student, select another username. After first successful creation, remove the password variable from `.env` and recreate `auth-api` to avoid leaving the bootstrap secret in container environment. The existing database admin user remains an admin. The bootstrap email is a local placeholder; login using username and password. Do not use this bootstrap account for email-based workflows.

Navigate to **http://localhost:8080/admin/problems** or click **Admin** in the top navigation. You can:

- Create Python coding problems with slug, title, category, difficulty, description, function name, optional class name, starter source, and an array of 1–100 test cases (`[{"args":[2],"expected":4}]`). The first case is a public sample; other cases are hidden from the learner-facing API.
- Create CSV grading problems by providing an accepted `csv-judge` configuration JSON, a required ground-truth CSV, and an optional sample-submission CSV. Supported tasks include binary and multiclass classification, multilabel, regression, ranking, and text generation. Example scoring JSON is available in the `csv-judge/problems/example_*` directories. CSV files are restricted to 10 MB.
- Edit published problems (without changing slug/type), and archive problems without deleting historical student submissions.

New exercises are stored in PostgreSQL; uploaded CSV data lives in the persistent `csvdata` Docker volume shared between the API and CSV scorer. Seed exercises from `platform-api/problems.json` are imported once; editing does not require editing the JSON source or rebuilding images. Archived problems disappear from the public catalog, but historical submission records remain available.

**For real exams:** protect the administrator account with HTTPS and MFA, put ground-truth datasets on protected storage, implement auditing and review/preview before publication, and do not run the sandbox container on an ordinary shared host.

## How per-case WebSockets work

`POST /api/submissions/code` creates a queued record. A bounded API queue calls the **Rust worker** once per hidden test (its own fresh Isolate sandbox per call), stores results, emits `{type:"test_completed",submission_id,passed,total,results,status}` and finally `{type:"completed",...}`. The frontend opens `/ws` and sends a `subscribe` message containing its JWT and submission UUID. Server verifies ownership and replies with a snapshot. This architecture is real-time but **not optimized for high test counts**: per-test sandbox startup and repeated Python/Torch import overhead are substantial. In future, extend the Rust worker with a streaming protocol and a single sandbox process per submission to improve throughput.

CSV submissions emit one completed event after metric calculation, not per-row updates.

## REST endpoints

| Endpoint | Method | Auth | Description |
|--|--|--|--|
| `/api/auth/register` | POST | No | `{username,email,password}` |
| `/api/auth/login` | POST | No | `{username,password}` (username or email) |
| `/api/auth/me` | GET | Yes | Current user |
| `/api/problems` | GET | No | Public problem catalog |
| `/api/problems/:slug` | GET | No | Problem detail, only first sample test |
| `/api/submissions/code` | POST | Yes | `{slug,code}` |
| `/api/submissions/csv` | POST | Yes | `multipart/form-data` with `slug` and `file` |
| `/api/submissions` | GET | Yes | History |
| `/api/submissions/:id` | GET | Yes | Result |
| `/api/leaderboard` | GET | No | Accepted submission totals |
| `/api/contests` | GET | No | Empty until contests implemented |
| `/api/admin/problems` | GET | Admin | List exercises including full test definitions |
| `/api/admin/problems/:slug` | GET | Admin | Edit details |
| `/api/admin/problems` | POST | Admin | Create exercise (`multipart/form-data`) |
| `/api/admin/problems/:slug` | PUT | Admin | Update exercise (`multipart/form-data`) |
| `/api/admin/problems/:slug` | DELETE | Admin | Archive exercise |
| `/api/health` | GET | No | API status |
| `/ws` | WS | Message auth | `{"type":"subscribe","token":"<jwt>","submission_id":"<uuid>"}` |

API errors use JSON. Hidden expected outputs are not returned to the frontend (except for the public sample test); the original input tests are stored server-side in `platform-api/problems.json`. For real competitions, store test data in a separately permissioned dataset rather than in the image.

## Ubuntu Rust worker development

```bash
sudo apt-get update
sudo apt-get install -y git build-essential pkg-config libcap-dev libseccomp-dev libsystemd-dev uidmap asciidoc python3 python3-venv
# Follow upstream Isolate installation and configure its isolate user + non-overlapping /etc/subuid and /etc/subgid mappings.
git clone https://github.com/ioi/isolate.git
cd isolate && make -j"$(nproc)" && sudo make install
isolate --check-config
sudo systemctl daemon-reload
sudo systemctl enable --now isolate.service
isolate --box-id=900 --cg --init
isolate --box-id=900 --cg --cleanup
# Set up Python separately
sudo python3 -m venv /opt/venv
sudo /opt/venv/bin/pip install numpy
sudo /opt/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
cd ../rust-judge
PYTHON_BIN=/opt/venv/bin/python USE_CGROUPS=true cargo run --release -- worker
```

Note: `rust-judge` still supports `cargo run` (both its internal HTTP gateway and worker), but this full platform uses only the `worker` mode. The platform API handles registration, submissions and live events.

## UI and branding

The UI follows the supplied DMOJ pages' navigation and table-oriented structure but is newly implemented, not a byte-for-byte clone. Colors and typography use the PDF brand guide: `#023263`, `#50f8f7`, `#9ae5db`, `#ffffff`, secondary `#3b95e9`, `#9bc539`, `#d4965e`, `#b69be8`; **Open Sans**. The project contains a raster crop of the main logo from the *user-supplied* brand guideline PDF for reference; use the official source vector asset for production as the guide requests, and respect clear-space/minimum-size requirements. External font request falls back to Arial when offline.

## Important limitations / hardening checklist

This is a **working-source prototype**, not a production-certified university platform. Compilation and E2E Docker testing were not available during preparation. Do not deploy for real examinations without independently verifying:

- Rust worker / Isolate cgroup support on the actual Linux host; no direct internet exposure for the worker or CSV service.
- Authentication and authorization test coverage, CSRF/session strategy, HTTPS, secure cookie-based sessions if required, password resets/email verification, audit logs, administrator RBAC and abuse controls.
- Durable job queue (Redis/RabbitMQ/Postgres advisory locks), worker crash recovery, retry policy, multi-instance WebSocket fanout, backpressure and request budgets.
- Full contest scheduling, CSV dataset preview/validation before publication, user profiles, and classroom features are not yet implemented.
- CSV examples include original ground truth and are for demos only. Replace with private datasets and protect scoring endpoints for production.
- `privileged: true` and accessible writable filesystem are unacceptable on an ordinary shared host without additional security controls.
- Frontend stores access JWT in localStorage for simplicity. For production use short-lived session cookies with secure CSRF protection and rotating refresh tokens.

## Smoke tests

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/problems
# Registration and API submit example:
curl -X POST http://localhost:8080/api/auth/register -H 'Content-Type: application/json' -d '{"username":"student01","email":"student01@example.com","password":"change-me-123456"}'
```

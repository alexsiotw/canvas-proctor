# ProctorGuard - Project Handoff Summary

## 1. Project Overview
**ProctorGuard** is a Node.js/Express application acting as an LTI (Learning Tools Interoperability) Provider for Canvas LMS. It enforces a secure proctoring environment for Canvas quizzes. The tool provides a wide range of browser and system lockdown features, likely coordinated with a browser extension and potentially a companion app.

## 2. Tech Stack & Dependencies
* **Core:** Node.js (>=18.0.0), Express, Express-Session, Body-Parser, Cors, Multer.
* **Database:** PostgreSQL (via `pg`), hosted on Supabase (configured via connection pooler).
* **Hosting/Deployment:** Self-hosted on a Contabo VPS, deployed under `/opt/canvas-proctor/` with PM2/systemd. (Render is no longer used; `render.yaml` was removed.)
* **Sessions:** Stored in Postgres via `connect-pg-simple` (table `user_sessions`, auto-created on boot), not in process memory — a restart must not sign students out mid-exam.
* **LTI Integration:** `ims-lti` (LTI 1.0/1.1 implementation for Canvas).
* **Real-time Comm:** `socket.io` for live proctoring events, tracking mobile upload status, and active assemblies.
* **Media Processing:** `fluent-ffmpeg`, `ffmpeg-static`, `webm-duration-fix`, `archiver` for video chunk processing and session archiving.
* **External Integrations:** Google Drive API (`googleapis`) for uploading recorded video archives, session logs, and companion app files (via `services/googleDrive`).

## 3. Database Schema (`db.js`)
The application initializes several key tables on startup:
* `exams`: Stores exam configuration. Extensive feature flags are included (e.g., `require_mic`, `require_camera`, `disable_right_click`, `require_seb`, `disable_extensions`, `advanced_vm_detection`, etc.).
* `exam_sessions`: Tracks individual student attempts, their status, recording folder IDs on Drive, attempt numbers, and validation flags.
* `proctor_logs`: Granular tracking of proctoring events and violations for specific sessions.
* `lti_sessions`: Handles temporary tokens and user context for Canvas LTI launches.
* `video_chunks`: Temporarily stores WebM chunks before compilation and upload.
* `exam_overrides`, `exam_placements`, `session_annotations`, `api_debug_logs`.

## 4. Key Workflows
* **LTI Launch:** Received at `/lti/launch`, handled via `ims-lti`, storing user/course context in `lti_sessions`.
* **Proctoring Validation:** Enforces microphone, camera, and desktop capture depending on the `exams` table config. Also integrates mobile/room scan logic.
* **Video Archiving:** Intercepts video chunks via Multer memory storage, fixes WebM duration, optionally processes with FFmpeg, and uploads to Google Drive.
* **Logging:** Intercepts stdout/stderr locally to `/tmp/server.log` (or within `/opt/canvas-proctor/`) for remote debugging/diagnostics (`/api/server-logs`). That endpoint requires an instructor session **and** `ENABLE_DEV_ENDPOINTS=true`; it was previously unauthenticated and served exam activity, including student names and session identifiers, to anyone who requested it.

## 5. Security Context
* The `.gitignore` has been thoroughly updated to ignore all environment files (`.env`, `.env.*`), private keys (`*.pem`, `*.key`), and IDE configurations to prevent sensitive credential leaks to AI prompts or version control.
* Production deployments assume `process.env.SESSION_SECRET` and `DATABASE_URL`.
* The server uses a basic trust proxy for rate limiting or session continuity behind a reverse proxy (e.g., Nginx on VPS).

## Next Steps for AI Assistant
When resuming work, please reference this summary, `server.js`, and `db.js` to understand the data flow, especially how LTI context connects a Canvas Student to an `exam_session`.

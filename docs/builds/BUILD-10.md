# Build 10: Google Drive + media

## 10.0.0 (phase 10.1): Google Drive
- Scopes: James = Gmail modify + **Drive (full, his own account)**; owner = Gmail read-only + Calendar + **Drive read-only + drive.file** (write only files the app creates). Granted scopes are now stored per connection; accounts connected before this need **Reconnect … for Drive** (Settings → Google).
- `src/drive.js` (plain fetch via google.js auth): search, read (Docs → text, Sheets → CSV, Slides → text, text/CSV/JSON; 20k chars), create folder, create Doc (text/HTML) or Sheet (CSV), upload (a generated image, text, or a public URL via the browser's public-address check, 25 MB, media types only), rename/move, **trash** and **share** (risk high: owner approval every time; trash is recoverable, nothing is permanently deleted).
- Owner's Drive writes are confined in code to a "Sleeper Agent" folder (created once; parents walked up to check), on top of the drive.file scope.
- Reading file contents taints the run (later writes need approval). drive_search/drive_read are taint-safe (read-only). Tools load on demand (James's prefix unchanged).
- Studio: **Google Drive** card (recent files in James's Drive and the owner's Sleeper Agent folder, checked at most once a minute).
- 129 tests (test/drive.test.js: confinement, exports, uploads, SSRF block, approvals and taint).

## Owner setup
1. Settings → Google → **Reconnect James's Gmail for Drive** and **Reconnect my Google for Drive** (tick every box).
2. Check Google Cloud → OAuth consent screen: if the app is in **Testing**, Google expires refresh tokens for Drive/Gmail after 7 days. Publish it ("In production"; personal use, unverified warning is fine) so connections last.

## Next
- 10.2 video (ffmpeg, frame contact sheets + whisper.cpp transcript, structured edit spec, render, review, save to Drive; Mia on Sonnet).
- 10.3 images (convert/resize/thumbnails; generated images straight to Drive).

## 10.0.1: each tab has its own address
- /overview (or /), /memory, /vault, /money, /markets, /clients, /browser, /studio, /stats, /integrations, /guide, /settings all serve the dashboard and open that tab; switching tabs updates the address and the page title ("Vault · Sleeper Agent"), and back/forward work (history.pushState + popstate). Unknown paths get 404. Verified in Chrome on the demo copy.

## 10.1.0 (phase 10.2): video editing
- `src/video.js`. **Inspect:** downloads the Drive video into a scratch job folder (streamed, ≤1 GB, ≤10 min), probes it, makes up to 3 contact sheets (12 frames each, 512×288 tiles, timestamps described in text) and a timestamped transcript. Returns images to the model (the agent loop now passes `{ blocks }` tool results through, redacting the text parts). Inspecting taints the run.
- **Transcript:** OpenAI speech-to-text (`whisper-1`, the owner's OpenAI key from the vault, ~$0.006/min, cost recorded). Deviation from the plan (whisper.cpp on the server): far less server setup for under a cent per video; swap later if volume grows.
- **Edit:** the agent writes a spec (clips with start/end/speed 0.5–2 in output order, crop none/vertical/square, captions, up to 10 text overlays, fades, music with ducking); `plan()` validates it and builds the ffmpeg filter itself. Agent text goes into files (`textfile=`, captions.srt), never into the filter string. Render with `nice`, 2 threads, 10-minute timeout, output ≤200 MB mp4, saved as a **new** file in the Sleeper Agent Drive folder (originals untouched). Scratch job folders are deleted after a day.
- **Mia** (Sonnet) gets video_inspect, video_edit and drive_search (migration + seed) and the delegate tool points video work at her. Studio: **Videos** card.
- ffmpeg 8 + DejaVu fonts installed on the server (deploy.sh installs them if missing).
- Smoke test on the server: 20 s test clip → 10 s vertical edit with two cuts (one at 2×), burned captions, a title with an apostrophe, fades and ducked music; 1078×1920, correct duration, rendered in 8 s.
- Schema v26. 132 tests.

## Cost per 1-minute edit (estimate)
- Contact sheets ~7k image tokens + transcript text, on Sonnet: ~$0.02; planning + one review pass: ~$0.03–0.06; transcript $0.006; rendering free. About **$0.05–0.10**, revisions ~$0.02–0.05 each.

## 10.2.0 (phase 10.3): images
- `src/images.js`: **image_view** (a Drive image or a generated one, scaled to ≤1568 px before the model sees it; the API caps an image at ~1.6k tokens; taints the run) and **image_edit** (resize contain/cover-crop, 320 px thumbnail, convert jpg/png/webp; ffmpeg; ≤25 MB in, ≤8000 px; saved as a **new** file in a Drive's Sleeper Agent folder via `drive.saveBuffer`). Generated images to Drive already work through `drive_upload` (image source).
- Mia gets image_view, image_edit and drive_upload (migration + seed); both image tools are taint-safe (output stays private in Drive).
- Server check: a 3000×2000 image viewed at 1568×1045 (82 KB); a cover crop to 1200×630 gave exactly 1200×630.
- 133 tests.

## Build 10 summary
- Shipped: Drive for James (full) and the owner (read-only + app folder), approval-gated share/trash, Studio Drive card; video editing (inspect via contact sheets + transcript, validated edit spec, render to Drive, Videos card); image view/edit; plus per-tab dashboard addresses and agent flexibility (built alongside).
- Skipped / later: whisper.cpp on the server (OpenAI speech-to-text instead, $0.006/min); AI-generated B-roll; resumable uploads for files over 200 MB.
- Known gaps: Drive features are tested against a fake Google and on the server with local files, not yet end to end with the owner's real Drive (needs the Reconnect step). Video music ducking uses one fixed curve. Contact sheets show 36 frames at most (one every ~17 s for a 10-minute video).

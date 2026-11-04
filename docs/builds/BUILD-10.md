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

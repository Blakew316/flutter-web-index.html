# Media Viewer for Google Drive

Static web app (no build step) to browse, view and upload photos, videos, audio and PDFs in Google Drive.
Routes: `/` (sign in), `/main` (library + viewer), `/upload`, `/callback`.

## Deploy (Firebase Hosting)
```bash
npm i -g firebase-tools
firebase login
firebase deploy --only hosting     # project: photodrive-359504 (see .firebaserc)
```
Or push to `main` with the `FIREBASE_SERVICE_ACCOUNT` GitHub secret set (`.github/workflows/deploy.yml`).

## One-time Google Cloud setup (required for sign-in to work)
In project 36909538617 (Google Cloud Console):
1. **APIs & Services → Library**: enable **Google Drive API**.
2. **Credentials → OAuth client** `36909538617-f46fpdoghbui5bn3e5r04qp06m1p1tkh…` → *Authorized JavaScript origins*: add
   `https://photodrive-359504.web.app`, `https://photodrive-359504.firebaseapp.com`, your custom domain, and `http://localhost:8080` for local dev.
3. **OAuth consent screen**: add scopes `drive.readonly` and `drive.file`. While in "Testing" only listed test users can sign in;
   publishing for everyone requires Google's verification (Drive scopes are sensitive/restricted).

## Local development
```bash
node scripts/dev-server.js 8080
```

## Notes
- `flutter-template/index.html` is the supplied Flutter `web/index.html` fix (deferred `flutter.js`, LCP preload, safe loader). It only applies
  if you rebuild the original Flutter app; the Dart source and `main.dart.js` were not in the provided files, so this repo replaces the app with the static version in `public/`.
- Files up to 500 MB preview in-browser (fetched into memory); larger ones link out to Drive.
- Auth tokens live in `sessionStorage` only.

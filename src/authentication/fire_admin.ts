import admin from "firebase-admin";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Firebase Admin credentials, in order:
//   1. FIREBASE_SERVICE_ACCOUNT_BASE64 — the service-account JSON, base64-encoded
//      (best for containers / hosting dashboards: no key file in the image),
//   2. GOOGLE_APPLICATION_CREDENTIALS — path to the JSON file (Google's standard),
//   3. src/authentication/serviceAccountKey.json — local development.
function credential(): admin.credential.Credential {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
    if (b64) return admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as admin.ServiceAccount);
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return admin.credential.applicationDefault();
    for (const file of [path.join(__dirname, "serviceAccountKey.json"), path.resolve(process.cwd(), "src/authentication/serviceAccountKey.json")]) {
        if (existsSync(file)) return admin.credential.cert(JSON.parse(readFileSync(file, "utf8")) as admin.ServiceAccount);
    }
    throw new Error("Firebase Admin credentials not found: set FIREBASE_SERVICE_ACCOUNT_BASE64 or GOOGLE_APPLICATION_CREDENTIALS.");
}

admin.initializeApp({ credential: credential() });

export const firebaseAdmin = admin;

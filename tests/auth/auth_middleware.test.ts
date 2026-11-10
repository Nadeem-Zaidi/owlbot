// Every rule a signed-in request must pass (Firebase replaced by a fake).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { firebaseAdmin } from "../../src/authentication/fire_admin";
import { checkIdToken, forgetAccount, verifyToken } from "../../src/authentication/authentication_middleware";

// token → decoded claims; uid → account. Tokens "bad" fail verification.
const tokens = new Map<string, any>();
const users = new Map<string, { disabled: boolean; tokensValidAfterTime?: string }>();
let getUserCalls = 0;
const fakeAuth = {
    verifyIdToken: async (t: string) => {
        if (!tokens.has(t)) throw new Error("bad token");
        return tokens.get(t);
    },
    getUser: async (uid: string) => {
        getUserCalls++;
        const u = users.get(uid);
        if (!u) throw Object.assign(new Error("user not found"), { code: "auth/user-not-found" });
        if ((u as any).broken) throw Object.assign(new Error("invalid_grant: Invalid JWT Signature."), { code: "app/invalid-credential" });
        return u;
    },
};
Object.defineProperty(firebaseAdmin, "auth", { value: () => fakeAuth, configurable: true, writable: true });

const now = Math.floor(Date.now() / 1000);
const claims = (uid: string, extra: Record<string, any> = {}) => ({
    uid, sub: uid, iat: now, email: `${uid}@gmail.com`, email_verified: true, phone_number: "+919999999999",
    firebase: { sign_in_provider: "google.com" }, ...extra,
});
function account(uid: string, extra: Record<string, any> = {}, user: Partial<{ disabled: boolean; tokensValidAfterTime: string }> = {}) {
    tokens.set(uid, claims(uid, extra));
    users.set(uid, { disabled: false, ...user });
    forgetAccount(uid);
    return uid;
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => e.code ?? e.message);

describe("auth: token rules", () => {
    beforeEach(() => { tokens.clear(); users.clear(); getUserCalls = 0; });

    it("lets a Google user with a verified phone in", async () => {
        const d = await checkIdToken(account("alice"));
        assert.equal(d.uid, "alice");
    });

    it("refuses invalid or expired tokens", async () => {
        assert.equal(await code(checkIdToken("bad")), "token_invalid");
    });

    it("refuses accounts without a verified phone", async () => {
        assert.equal(await code(checkIdToken(account("nophone", { phone_number: undefined }))), "phone_required");
    });

    it("refuses email/password, anonymous and custom sign-ins", async () => {
        for (const p of ["password", "anonymous", "custom"]) {
            assert.equal(await code(checkIdToken(account(`u_${p}`, { firebase: { sign_in_provider: p } }))), "provider_not_allowed", p);
        }
        assert.equal(await code(checkIdToken(account("phoneonly", { email: undefined, firebase: { sign_in_provider: "phone" } }))), "ok", "older phone-only accounts still work");
    });

    it("refuses an unverified email (it could be someone else's, e.g. the owner's)", async () => {
        assert.equal(await code(checkIdToken(account("fake", { email_verified: false }))), "email_unverified");
    });

    it("refuses disabled and deleted accounts", async () => {
        assert.equal(await code(checkIdToken(account("off", {}, { disabled: true }))), "account_disabled");
        tokens.set("ghost", claims("ghost"));
        assert.equal(await code(checkIdToken("ghost")), "token_invalid");
    });

    it("reports a broken admin key as 'unavailable', not as an expired session", async () => {
        const errors: string[] = [];
        const orig = console.error;
        console.error = (m: string) => { errors.push(m); };
        try {
            assert.equal(await code(checkIdToken(account("anyone", {}, { broken: true } as any))), "auth_unavailable");
        } finally {
            console.error = orig;
        }
        assert.match(errors[0], /app\/invalid-credential/, "the log says why");
    });

    it("refuses tokens issued before 'sign out everywhere'", async () => {
        const later = new Date((now + 60) * 1000).toUTCString();
        assert.equal(await code(checkIdToken(account("revoked", {}, { tokensValidAfterTime: later }))), "token_revoked");
        const earlier = new Date((now - 60) * 1000).toUTCString();
        assert.equal(await code(checkIdToken(account("fresh", {}, { tokensValidAfterTime: earlier }))), "ok");
    });

    it("caches the account check (one Firebase lookup per minute, not per request)", async () => {
        const t = account("busy");
        for (let i = 0; i < 5; i++) await checkIdToken(t);
        assert.equal(getUserCalls, 1);
        forgetAccount("busy");
        await checkIdToken(t);
        assert.equal(getUserCalls, 2, "forgetAccount forces a fresh look (used after revoking)");
    });
});

describe("auth: middleware", () => {
    beforeEach(() => { tokens.clear(); users.clear(); });

    const call = async (authorization?: string) => {
        const req: any = { headers: authorization ? { authorization } : {} };
        let status = 200, body: any = null, nextCalled = false;
        const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; return res; } };
        await verifyToken(req, res, () => { nextCalled = true; });
        return { status, body, nextCalled, req };
    };

    it("needs a Bearer token", async () => {
        for (const h of [undefined, "Basic abc", "Bearer ", "bearer"]) {
            const r = await call(h);
            assert.equal(r.status, 401, String(h));
            assert.equal(r.nextCalled, false);
        }
    });

    it("answers with a machine-readable code the app can act on", async () => {
        account("nophone", { phone_number: undefined });
        const r = await call("Bearer nophone");
        assert.equal(r.status, 403);
        assert.equal(r.body.code, "phone_required");
    });

    it("sets req.user from the token only", async () => {
        account("alice");
        const r = await call("Bearer alice");
        assert.equal(r.nextCalled, true);
        assert.equal(r.req.user.uid, "alice");
    });
});

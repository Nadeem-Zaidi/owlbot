import express, { NextFunction, Request, Response, Router } from "express";
import { BillingService } from "../service/billing/billing_service";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
        const status = Number(err?.status ?? err?.statusCode) || 500;
        if (status >= 500) console.error("[billing] request failed:", err);
        // Razorpay SDK errors carry { error: { description } }.
        const message = err?.error?.description ?? err?.message ?? "Request failed";
        if (!res.headersSent) res.status(status).json({ message });
    });
};

// /api/billing — behind Firebase auth like the rest of the API.
export function createBillingRouter(billing: BillingService): Router {
    const r = Router();
    const uid = (req: Request) => req.user!.sub;
    r.get("/", h(async (req, res) => res.json(await billing.overview(uid(req), req.user?.email))));
    r.post("/subscribe", h(async (req, res) => res.json(await billing.subscribe(uid(req), req.user?.email, req.body?.plan, req.body?.period))));
    r.post("/verify", h(async (req, res) => res.json(await billing.verifyCheckout(uid(req), req.body))));
    r.post("/cancel", h(async (req, res) => res.json(await billing.cancel(uid(req)))));
    return r;
}

// /api/billing/webhook — called by Razorpay, so no Firebase auth; the
// signature over the raw body proves it's Razorpay. Mounted before the JSON
// parser so the body arrives untouched.
export function createBillingWebhookRouter(billing: BillingService): Router {
    const r = Router();
    r.post("/", express.raw({ type: "*/*", limit: "1mb" }), h(async (req, res) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
        const result = await billing.handleWebhook(raw, req.header("x-razorpay-signature"), req.header("x-razorpay-event-id"));
        res.json({ ok: true, ...result });
    }));
    return r;
}

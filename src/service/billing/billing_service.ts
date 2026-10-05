import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { BillingRepository, SubscriptionRow } from "../../repository/billing_repository";
import { AgentError } from "../agents/agent_service";
import { BillingPeriod, Plan, PlanId, planById, planForRazorpayPlan, plans } from "./plans";

// The parts of the Razorpay SDK used here (so tests can pass a fake).
export type RazorpayClient = {
    subscriptions: {
        create(body: any): Promise<any>;
        fetch(id: string): Promise<any>;
        cancel(id: string, cancelAtCycleEnd?: boolean): Promise<any>;
    };
};

export type QuotaStatus = { allowed: boolean; plan: PlanId; used: number; quota: number; resetsAt: Date };

const QUOTA_CACHE_MS = 20_000;
// Number of renewals Razorpay schedules up front (it needs a finite count).
const TOTAL_COUNT: Record<BillingPeriod, number> = { monthly: 120, yearly: 10 };

const toDate = (unix?: number | null) => (unix ? new Date(unix * 1000) : null);
const hmac = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");
const safeEqual = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};

// Subscriptions with Razorpay and the monthly token quota that comes with
// each plan. Stateless apart from Postgres (plus a short quota cache), so it
// scales across several backend instances.
export class BillingService {
    private razorpay: RazorpayClient | null;
    private quotaCache = new Map<string, { status: QuotaStatus; at: number }>();
    private knownUsers = new Set<string>();

    constructor(
        private repo: BillingRepository,
        private config = {
            keyId: process.env.RAZORPAY_KEY_ID ?? "",
            keySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
            webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
            // Quotas are only enforced when this is on, so turning billing on is a deliberate step.
            enforce: process.env.BILLING_ENABLED === "true",
            exemptEmails: (process.env.BILLING_EXEMPT_EMAILS ?? process.env.OWNER_EMAILS ?? "")
                .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
        },
        client?: RazorpayClient,
    ) {
        this.razorpay = client ?? (config.keyId && config.keySecret
            ? (new Razorpay({ key_id: config.keyId, key_secret: config.keySecret }) as unknown as RazorpayClient)
            : null);
    }

    get paymentsEnabled() { return !!this.razorpay; }

    // Remembers a signed-in user's email once per process (needed for exemptions).
    async rememberUser(userId: string, email?: string | null): Promise<void> {
        if (!email || this.knownUsers.has(userId)) return;
        this.knownUsers.add(userId);
        await this.repo.touchAccount(userId, email).catch(() => this.knownUsers.delete(userId));
    }

    // ── what the billing page shows ──
    async overview(userId: string, email?: string | null) {
        await this.repo.touchAccount(userId, email);
        await this.repo.expireStaleCreated(userId);
        const sub = await this.repo.currentSubscription(userId);
        const quota = await this.quota(userId, true);
        const payments = await this.repo.payments(userId);
        return {
            paymentsEnabled: this.paymentsEnabled,
            enforced: this.config.enforce,
            keyId: this.paymentsEnabled ? this.config.keyId : null, // public key for Razorpay Checkout
            plan: quota.plan,
            subscription: sub ? {
                id: sub.id, plan: sub.plan, period: sub.period, status: sub.status,
                currentEnd: sub.current_end, cancelAtCycleEnd: sub.cancel_at_cycle_end,
            } : null,
            usage: { used: quota.used, quota: quota.quota, resetsAt: quota.resetsAt, exempt: await this.isExempt(userId) },
            plans: plans().map((p) => ({
                id: p.id, name: p.name, tagline: p.tagline, monthlyTokens: p.monthlyTokens, price: p.price, features: p.features,
                available: { monthly: p.id === "free" || !!p.razorpayPlanId.monthly, yearly: p.id === "free" || !!p.razorpayPlanId.yearly },
            })),
            payments: payments.map((p) => ({ id: p.payment_id, plan: p.plan, amount: p.amount, currency: p.currency, status: p.status, createdAt: p.created_at })),
        };
    }

    // ── checkout ──
    // Creates the Razorpay subscription; the web app then opens Checkout with it.
    async subscribe(userId: string, email: string | null | undefined, planIdRaw: unknown, periodRaw: unknown) {
        const razorpay = this.requireRazorpay();
        const plan = planById(String(planIdRaw));
        const period: BillingPeriod = periodRaw === "yearly" ? "yearly" : "monthly";
        if (!plan || plan.id === "free") throw new AgentError("Choose a paid plan");
        const razorpayPlanId = plan.razorpayPlanId[period];
        if (!razorpayPlanId) throw new AgentError(`The ${plan.name} ${period} plan isn't set up yet`);

        await this.repo.touchAccount(userId, email);
        const current = await this.repo.currentSubscription(userId);
        if (current && current.plan !== "free" && !current.cancel_at_cycle_end && current.status !== "cancelled") {
            throw new AgentError(`You're already on ${planById(current.plan)?.name ?? current.plan}. Cancel it first to switch plans — the change applies when the current period ends.`, 409);
        }

        const created = await razorpay.subscriptions.create({
            plan_id: razorpayPlanId,
            total_count: TOTAL_COUNT[period],
            quantity: 1,
            customer_notify: 1,
            notes: { user_id: userId, plan: plan.id, period },
        });
        await this.repo.insertSubscription({ id: created.id, user_id: userId, plan: plan.id, period, razorpay_plan_id: razorpayPlanId, status: created.status ?? "created" });
        return { subscriptionId: created.id as string, keyId: this.config.keyId, plan: plan.id, period, amount: plan.price[period] };
    }

    // Checkout's success callback. The signature proves the payment came from
    // Razorpay for this subscription; the webhook confirms it again later.
    async verifyCheckout(userId: string, body: any) {
        const paymentId = String(body?.razorpay_payment_id ?? "");
        const subscriptionId = String(body?.razorpay_subscription_id ?? "");
        const signature = String(body?.razorpay_signature ?? "");
        if (!paymentId || !subscriptionId || !signature) throw new AgentError("Missing payment details");

        const sub = await this.repo.getSubscription(subscriptionId);
        if (!sub || sub.user_id !== userId) throw new AgentError("Subscription not found", 404);
        if (!safeEqual(hmac(this.config.keySecret, `${paymentId}|${subscriptionId}`), signature)) {
            throw new AgentError("Payment verification failed", 400);
        }

        const remote = await this.requireRazorpay().subscriptions.fetch(subscriptionId).catch(() => null);
        await this.repo.updateSubscription(subscriptionId, {
            status: remote?.status ?? "authenticated",
            current_start: toDate(remote?.current_start),
            current_end: toDate(remote?.current_end),
        });
        await this.repo.recordPayment({ payment_id: paymentId, user_id: userId, subscription_id: subscriptionId, plan: sub.plan,
            amount: planById(sub.plan)?.price[sub.period] ?? 0, currency: "INR", status: "captured" });
        this.quotaCache.delete(userId);
        return this.overview(userId);
    }

    // Stops renewal; the plan stays until the end of the period already paid.
    async cancel(userId: string) {
        const sub = await this.repo.currentSubscription(userId);
        if (!sub || sub.plan === "free") throw new AgentError("You don't have a paid plan to cancel");
        if (sub.cancel_at_cycle_end) return this.overview(userId);
        const remote = await this.requireRazorpay().subscriptions.cancel(sub.id, true);
        await this.repo.updateSubscription(sub.id, { cancel_at_cycle_end: true, status: remote?.status ?? undefined });
        return this.overview(userId);
    }

    // ── webhooks (Razorpay → us) ──
    // `raw` must be the exact request body; the signature is over those bytes.
    async handleWebhook(raw: Buffer, signature: string | undefined, eventId: string | undefined): Promise<{ handled: boolean; reason?: string }> {
        if (!this.config.webhookSecret) throw new AgentError("Webhook secret not configured", 503);
        if (!signature || !safeEqual(hmac(this.config.webhookSecret, raw.toString("utf8")), signature)) {
            throw new AgentError("Invalid webhook signature", 400);
        }
        const event = JSON.parse(raw.toString("utf8"));
        const id = eventId || `${event.event}:${event.created_at}:${event.payload?.subscription?.entity?.id ?? event.payload?.payment?.entity?.id ?? ""}`;
        if (!(await this.repo.claimEvent(id, String(event.event ?? "unknown")))) return { handled: false, reason: "duplicate" };

        try {
            const s = event.payload?.subscription?.entity;
            const p = event.payload?.payment?.entity;
            let sub: SubscriptionRow | null = null;
            if (s?.id) {
                sub = await this.repo.getSubscription(s.id);
                // A subscription created outside this app (e.g. the dashboard): adopt it if we know the user.
                if (!sub && s.notes?.user_id) {
                    const mapped = planForRazorpayPlan(s.plan_id);
                    if (mapped) {
                        await this.repo.insertSubscription({ id: s.id, user_id: String(s.notes.user_id), plan: mapped.plan.id, period: mapped.period, razorpay_plan_id: s.plan_id, status: s.status });
                        sub = await this.repo.getSubscription(s.id);
                    }
                }
                if (sub) {
                    await this.repo.updateSubscription(s.id, {
                        status: s.status,
                        current_start: toDate(s.current_start),
                        current_end: toDate(s.current_end),
                        ...(event.event === "subscription.cancelled" ? { cancel_at_cycle_end: true } : {}),
                    });
                    this.quotaCache.delete(sub.user_id);
                }
            }
            if (p?.id) {
                const userId = sub?.user_id ?? (p.notes?.user_id ? String(p.notes.user_id) : null);
                if (userId) {
                    await this.repo.recordPayment({ payment_id: p.id, user_id: userId, subscription_id: sub?.id ?? s?.id ?? null, plan: sub?.plan ?? null,
                        amount: Number(p.amount ?? 0), currency: String(p.currency ?? "INR"), status: String(p.status ?? event.event) });
                }
            }
            return { handled: true };
        } catch (err) {
            await this.repo.releaseEvent(id).catch(() => {}); // let Razorpay's retry run it again
            throw err;
        }
    }

    // ── quota ──
    // The plan's monthly tokens vs. tokens used this period. Paid plans count
    // from the start of the billing period; Free counts the calendar month (UTC).
    async quota(userId: string, fresh = false): Promise<QuotaStatus> {
        const cached = this.quotaCache.get(userId);
        if (!fresh && cached && Date.now() - cached.at < QUOTA_CACHE_MS) return cached.status;

        const sub = await this.repo.currentSubscription(userId);
        const plan: Plan = (sub && planById(sub.plan)) || planById("free")!;
        let since: Date, resetsAt: Date;
        if (sub?.current_start && sub.current_end) {
            // Yearly plans still get a monthly allowance: count from the latest monthly anniversary.
            since = new Date(sub.current_start);
            while (true) {
                const next = new Date(since); next.setUTCMonth(next.getUTCMonth() + 1);
                if (next > new Date()) { resetsAt = next < sub.current_end ? next : new Date(sub.current_end); break; }
                since = next;
            }
        } else {
            const now = new Date();
            since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        }
        const used = await this.repo.tokensSince(userId, since);
        const status: QuotaStatus = { allowed: used < plan.monthlyTokens, plan: plan.id, used, quota: plan.monthlyTokens, resetsAt };
        this.quotaCache.set(userId, { status, at: Date.now() });
        return status;
    }

    // Gate used before every model call. Returns a message when blocked.
    async checkAllowed(userId: string): Promise<string | null> {
        if (!this.config.enforce) return null;
        if (await this.isExempt(userId)) return null;
        const q = await this.quota(userId);
        if (q.allowed) return null;
        const name = planById(q.plan)?.name ?? q.plan;
        return `You've used your ${q.quota.toLocaleString("en-IN")} tokens for this month on the ${name} plan. ` +
            `Upgrade on the Plan & billing page, or wait until ${q.resetsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.`;
    }

    private async isExempt(userId: string): Promise<boolean> {
        if (!this.config.exemptEmails.length) return false;
        const email = await this.repo.emailOf(userId);
        return !!email && this.config.exemptEmails.includes(email.toLowerCase());
    }

    private requireRazorpay(): RazorpayClient {
        if (!this.razorpay) throw new AgentError("Payments aren't set up on this server yet (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).", 503);
        return this.razorpay;
    }
}

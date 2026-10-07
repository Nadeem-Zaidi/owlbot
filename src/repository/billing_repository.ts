import { IDatabaseAdapter } from "../database/idatabaseadapter";
import type { BillingPeriod, PlanId } from "../service/billing/plans";

export interface SubscriptionRow {
    id: string;
    user_id: string;
    plan: PlanId;
    period: BillingPeriod;
    razorpay_plan_id: string;
    status: string;
    current_start: Date | null;
    current_end: Date | null;
    cancel_at_cycle_end: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface PaymentRow {
    payment_id: string;
    user_id: string;
    subscription_id: string | null;
    plan: string | null;
    amount: number;
    currency: string;
    status: string;
    created_at: Date;
}

// Statuses that grant the plan (Razorpay keeps "pending" while it retries a
// failed renewal, so the user keeps access during the retries).
const ENTITLED = ["active", "authenticated", "pending"];

export class BillingRepository {
    constructor(private db: IDatabaseAdapter) {}

    async touchAccount(userId: string, email: string | null | undefined): Promise<void> {
        await this.db.query(
            `INSERT INTO billing_accounts (user_id, email) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, billing_accounts.email), updated_at = now()`,
            [userId, email ?? null]
        );
    }

    async emailOf(userId: string): Promise<string | null> {
        const { rows } = await this.db.query<{ email: string | null }>(`SELECT email FROM billing_accounts WHERE user_id = $1`, [userId]);
        return rows[0]?.email ?? null;
    }

    // The subscription that currently sets the user's plan: entitled, or
    // cancelled but still inside the period already paid for.
    async currentSubscription(userId: string): Promise<SubscriptionRow | null> {
        const { rows } = await this.db.query<SubscriptionRow>(
            `SELECT * FROM billing_subscriptions
             WHERE user_id = $1
               AND (status = ANY($2) OR (status IN ('cancelled', 'completed') AND current_end > now()))
             ORDER BY created_at DESC LIMIT 1`,
            [userId, ENTITLED]
        );
        return rows[0] ?? null;
    }

    async getSubscription(id: string): Promise<SubscriptionRow | null> {
        const { rows } = await this.db.query<SubscriptionRow>(`SELECT * FROM billing_subscriptions WHERE id = $1`, [id]);
        return rows[0] ?? null;
    }

    async insertSubscription(s: Pick<SubscriptionRow, "id" | "user_id" | "plan" | "period" | "razorpay_plan_id" | "status">): Promise<void> {
        await this.db.query(
            `INSERT INTO billing_subscriptions (id, user_id, plan, period, razorpay_plan_id, status) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (id) DO NOTHING`,
            [s.id, s.user_id, s.plan, s.period, s.razorpay_plan_id, s.status]
        );
    }

    async updateSubscription(id: string, patch: { status?: string; current_start?: Date | null; current_end?: Date | null; cancel_at_cycle_end?: boolean }): Promise<void> {
        await this.db.query(
            `UPDATE billing_subscriptions SET
                status = COALESCE($2, status),
                current_start = COALESCE($3, current_start),
                current_end = COALESCE($4, current_end),
                cancel_at_cycle_end = COALESCE($5, cancel_at_cycle_end),
                updated_at = now()
             WHERE id = $1`,
            [id, patch.status ?? null, patch.current_start ?? null, patch.current_end ?? null, patch.cancel_at_cycle_end ?? null]
        );
    }

    // Abandoned checkouts: subscriptions created here but never paid.
    async expireStaleCreated(userId: string): Promise<void> {
        await this.db.query(
            `UPDATE billing_subscriptions SET status = 'abandoned', updated_at = now()
             WHERE user_id = $1 AND status = 'created' AND created_at < now() - interval '1 hour'`,
            [userId]
        );
    }

    async recordPayment(p: Omit<PaymentRow, "created_at">): Promise<void> {
        await this.db.query(
            `INSERT INTO billing_payments (payment_id, user_id, subscription_id, plan, amount, currency, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (payment_id) DO UPDATE SET status = EXCLUDED.status`,
            [p.payment_id, p.user_id, p.subscription_id, p.plan, p.amount, p.currency, p.status]
        );
    }

    async payments(userId: string, limit = 12): Promise<PaymentRow[]> {
        const { rows } = await this.db.query<PaymentRow>(
            `SELECT * FROM billing_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
        return rows;
    }

    // true the first time an event id is seen.
    async claimEvent(eventId: string, type: string): Promise<boolean> {
        const { rows } = await this.db.query(
            `INSERT INTO billing_events (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
            [eventId, type]
        );
        return rows.length > 0;
    }

    async releaseEvent(eventId: string): Promise<void> {
        await this.db.query(`DELETE FROM billing_events WHERE event_id = $1`, [eventId]);
    }

    // Tokens used since `since` (all features), for the quota. Usage on the
    // user's own API keys (BYOK) is excluded — they pay their provider directly.
    async tokensSince(userId: string, since: Date): Promise<number> {
        const { rows } = await this.db.query<{ n: string | null }>(
            `SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::bigint AS n
             FROM token_usage WHERE user_id = $1 AND created_at >= $2 AND NOT byok`,
            [userId, since]
        );
        return Number(rows[0]?.n ?? 0);
    }
}

// Plans and their monthly token allowance. Prices are in paise (₹1 = 100).
// Every number can be overridden from .env, so pricing changes need no code.
// The Razorpay plan ids come from your Razorpay dashboard (or
// `npm run billing:create-plans`), one per paid plan and billing period.

export type PlanId = "free" | "pro" | "business";
export type BillingPeriod = "monthly" | "yearly";

export type Plan = {
    id: PlanId;
    name: string;
    tagline: string;
    monthlyTokens: number;
    price: Record<BillingPeriod, number>;     // paise
    razorpayPlanId: Record<BillingPeriod, string | null>;
    features: string[];
};

const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const planId = (name: string) => process.env[name]?.trim() || null;

export function plans(): Plan[] {
    return [
        {
            id: "free",
            name: "Free",
            tagline: "Try Owl Bot",
            monthlyTokens: num("BILLING_FREE_TOKENS", 100_000),
            price: { monthly: 0, yearly: 0 },
            razorpayPlanId: { monthly: null, yearly: null },
            features: ["Chat with documents", "Agents & pipelines", "Usage dashboard"],
        },
        {
            id: "pro",
            name: "Pro",
            tagline: "For regular use",
            monthlyTokens: num("BILLING_PRO_TOKENS", 2_000_000),
            price: { monthly: num("BILLING_PRO_MONTHLY_PAISE", 49_900), yearly: num("BILLING_PRO_YEARLY_PAISE", 4_99_000) },
            razorpayPlanId: { monthly: planId("RAZORPAY_PLAN_PRO_MONTHLY"), yearly: planId("RAZORPAY_PLAN_PRO_YEARLY") },
            features: ["Everything in Free", "20× the tokens", "WhatsApp, schedules & provider agents"],
        },
        {
            id: "business",
            name: "Business",
            tagline: "For heavy use",
            monthlyTokens: num("BILLING_BUSINESS_TOKENS", 10_000_000),
            price: { monthly: num("BILLING_BUSINESS_MONTHLY_PAISE", 1_99_900), yearly: num("BILLING_BUSINESS_YEARLY_PAISE", 19_99_000) },
            razorpayPlanId: { monthly: planId("RAZORPAY_PLAN_BUSINESS_MONTHLY"), yearly: planId("RAZORPAY_PLAN_BUSINESS_YEARLY") },
            features: ["Everything in Pro", "100× the tokens", "Priority support"],
        },
    ];
}

export const planById = (id: string): Plan | undefined => plans().find((p) => p.id === id);

// Razorpay plan id → our plan (used for webhooks about subscriptions we didn't create here).
export function planForRazorpayPlan(razorpayPlanId: string): { plan: Plan; period: BillingPeriod } | null {
    for (const plan of plans()) {
        for (const period of ["monthly", "yearly"] as const) {
            if (plan.razorpayPlanId[period] === razorpayPlanId) return { plan, period };
        }
    }
    return null;
}

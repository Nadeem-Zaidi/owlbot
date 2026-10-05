// Creates the paid plans in your Razorpay account (test or live, depending on
// the keys in .env) and prints the RAZORPAY_PLAN_* lines to paste into .env.
// Run once:  npm run billing:create-plans
// Razorpay plans can't be edited later — to change a price, create a new plan
// and update the id in .env (existing subscribers keep their old plan).
import "dotenv/config";
import Razorpay from "razorpay";
import { plans } from "../src/service/billing/plans";

(async () => {
    const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env first (use test-mode keys while trying it out).");
        process.exit(1);
    }
    const rp = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
    console.log(`Creating plans in ${RAZORPAY_KEY_ID.startsWith("rzp_live") ? "LIVE" : "test"} mode…\n`);
    const lines: string[] = [];
    for (const plan of plans()) {
        if (plan.id === "free") continue;
        for (const period of ["monthly", "yearly"] as const) {
            const envName = `RAZORPAY_PLAN_${plan.id.toUpperCase()}_${period.toUpperCase()}`;
            if (plan.razorpayPlanId[period]) {
                console.log(`${envName} already set — skipped`);
                continue;
            }
            const created = await rp.plans.create({
                period,
                interval: 1,
                item: {
                    name: `Owl Bot ${plan.name} (${period})`,
                    amount: plan.price[period],
                    currency: "INR",
                    description: `${plan.monthlyTokens.toLocaleString("en-IN")} tokens per month`,
                },
                notes: { app: "owlbot", plan: plan.id, period },
            });
            lines.push(`${envName}=${created.id}`);
            console.log(`Created ${plan.name} ${period}: ₹${plan.price[period] / 100} → ${created.id}`);
        }
    }
    if (lines.length) console.log(`\nAdd these to .env, then restart the backend:\n\n${lines.join("\n")}\n`);
})().catch((err) => {
    console.error("Failed:", err?.error?.description ?? err);
    process.exit(1);
});

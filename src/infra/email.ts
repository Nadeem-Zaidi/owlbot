import nodemailer, { Transporter } from "nodemailer";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

// Outgoing email over SMTP (Gmail app password, Outlook, Zoho, Amazon SES,
// Brevo…). Configured from .env; when SMTP_HOST is missing, email is simply
// off and the UI hides it.
//
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587              (465 → TLS from the start)
//   SMTP_SECURE=false          (optional; defaults to true only for 465)
//   SMTP_USER=you@gmail.com
//   SMTP_PASS=app-password
//   EMAIL_FROM="Owl Bot <you@gmail.com>"   (optional; defaults to SMTP_USER)
//   EMAIL_DAILY_LIMIT=100      (recipients per user per 24 h)

export const MAX_RECIPIENTS = 5;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export class EmailInputError extends Error {}

// Cleans a recipient list: trims, lowercases, de-duplicates, validates.
export function normalizeRecipients(v: unknown, max = MAX_RECIPIENTS): string[] {
    const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : [];
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") throw new EmailInputError("Email addresses must be text");
        const e = item.trim().toLowerCase();
        if (!e) continue;
        if (e.length > 254 || !EMAIL_RE.test(e)) throw new EmailInputError(`“${item.trim().slice(0, 60)}” isn't a valid email address`);
        if (!out.includes(e)) out.push(e);
    }
    if (out.length > max) throw new EmailInputError(`Up to ${max} email addresses`);
    return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Agent replies are Markdown: render the common parts (headings, bold,
// italics, inline/fenced code, lists, links) as simple, safe HTML.
export function markdownToHtml(md: string): string {
    const inline = (s: string) => escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code style="background:#f1f3f5;padding:1px 4px;border-radius:4px">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    const out: string[] = [];
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    let list: "ul" | "ol" | null = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^```/);
        if (fence) {
            closeList();
            const code: string[] = [];
            while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
            out.push(`<pre style="background:#f6f8fa;padding:10px;border-radius:6px;overflow:auto;font-size:13px"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        const ul = line.match(/^\s*[-*•]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (h) { closeList(); const n = Math.min(h[1].length + 1, 6); out.push(`<h${n} style="margin:14px 0 6px">${inline(h[2])}</h${n}>`); }
        else if (ul || ol) {
            const kind = ul ? "ul" : "ol";
            if (list !== kind) { closeList(); out.push(`<${kind} style="margin:6px 0;padding-left:22px">`); list = kind; }
            out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
        } else if (!line.trim()) { closeList(); out.push(""); }
        else { closeList(); out.push(`<p style="margin:6px 0">${inline(line)}</p>`); }
    }
    closeList();
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2328">${out.join("\n")}</div>`;
}

export type EmailMessage = { to: string[]; subject: string; text: string };
export type SendResult = { ok: true } | { ok: false; error: string };

// Sends mail for users, with a per-user daily recipient limit (so a
// schedule can't be used to spam people).
export class EmailService {
    private transport: Transporter | null = null;
    private from = "";
    readonly dailyLimit: number;

    constructor(private db: IDatabaseAdapter | null, env: NodeJS.ProcessEnv = process.env, transport?: Transporter) {
        this.dailyLimit = Math.max(1, Number(env.EMAIL_DAILY_LIMIT) || 100);
        const host = env.SMTP_HOST?.trim();
        if (!host && !transport) return;
        const port = Number(env.SMTP_PORT) || 587;
        this.from = env.EMAIL_FROM?.trim() || env.SMTP_USER?.trim() || "";
        this.transport = transport ?? nodemailer.createTransport({
            host,
            port,
            secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 30_000,
        });
    }

    get enabled(): boolean { return this.transport !== null && !!this.from; }

    async sentToday(userId: string): Promise<number> {
        if (!this.db) return 0;
        const { rows } = await this.db.query<{ n: string | number }>(
            `SELECT COALESCE(SUM(recipients), 0) AS n FROM email_log WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [userId]);
        return Number(rows[0]?.n ?? 0);
    }

    async sendForUser(userId: string, msg: EmailMessage): Promise<SendResult> {
        if (!this.enabled) return { ok: false, error: "Email isn't set up on this server" };
        let to: string[];
        try { to = normalizeRecipients(msg.to); } catch (e) { return { ok: false, error: (e as Error).message }; }
        if (!to.length) return { ok: false, error: "No email addresses" };
        if ((await this.sentToday(userId)) + to.length > this.dailyLimit) {
            return { ok: false, error: `Daily email limit reached (${this.dailyLimit} recipients per day)` };
        }
        const subject = msg.subject.replace(/[\r\n]+/g, " ").slice(0, 200);
        try {
            await this.transport!.sendMail({ from: this.from, to, subject, text: msg.text, html: markdownToHtml(msg.text) });
        } catch (err) {
            // Server-side detail stays in the log; users get a plain message.
            console.error("[email] send failed:", err instanceof Error ? err.message : err);
            return { ok: false, error: "The email couldn't be sent" };
        }
        if (this.db) await this.db.query(`INSERT INTO email_log (user_id, recipients) VALUES ($1, $2)`, [userId, to.length]).catch(() => {});
        return { ok: true };
    }
}

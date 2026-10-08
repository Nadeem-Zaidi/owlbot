import { SettingsRepository } from "../repository/settings_repository";
import { isOwner, ownerEmails } from "./agents/owner";
import { decryptSecret, encryptSecret } from "./agents/secrets";

// Server-wide settings the owner changes in the web app (Server settings),
// stored in Postgres instead of .env. .env values only seed the first value,
// so existing deployments keep working after upgrading.

export type WhatsAppSettings = {
    enabled: boolean;      // run the WhatsApp bot
    selfChat: boolean;     // the bot runs on your own number ("Message yourself")
    adminEmails: string[]; // who may pair the bot's number (owners always can)
};

// Telegram bot (Bot API). The token is stored encrypted and never sent back
// to the browser (only its last characters).
export type TelegramSettings = {
    enabled: boolean;
    botToken: string | null;
};
export type TelegramSettingsView = {
    enabled: boolean;
    hasToken: boolean;
    tokenHint: string | null;
    botUsername: string | null;
    updatedAt: Date | null;
    updatedBy: string | null;
};
// Checks a token with Telegram and returns the bot's username.
export type TelegramVerifier = (token: string) => Promise<{ username: string }>;

const WHATSAPP_KEY = "whatsapp";
const TELEGRAM_KEY = "telegram";
const TELEGRAM_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CACHE_MS = 10_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ADMINS = 50;

export class SettingsError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

const fromEnv = (): WhatsAppSettings => ({
    enabled: process.env.WHATSAPP_ENABLED === "true",
    selfChat: process.env.WHATSAPP_SELF_CHAT === "true",
    adminEmails: (process.env.WHATSAPP_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
});

export class SettingsService {
    private cache: { value: WhatsAppSettings & { updatedAt: Date | null; updatedBy: string | null }; at: number } | null = null;
    private listeners: Array<(s: WhatsAppSettings) => void> = [];
    private telegramListeners: Array<(s: TelegramSettings) => void> = [];

    constructor(private repo: SettingsRepository) {}

    // First boot after upgrading: copy the .env values into the database.
    async seedFromEnv(): Promise<void> {
        await this.repo.setIfMissing(WHATSAPP_KEY, fromEnv());
        const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
        if (token) {
            await this.repo.setIfMissing(TELEGRAM_KEY, { enabled: process.env.TELEGRAM_ENABLED !== "false", botToken: encryptSecret(token), botUsername: null });
        }
    }

    // ── Telegram ──
    // Internal: includes the decrypted token. Never send this to a browser.
    async telegram(): Promise<TelegramSettings & { botUsername: string | null }> {
        const row = await this.repo.get<{ enabled?: boolean; botToken?: string | null; botUsername?: string | null }>(TELEGRAM_KEY);
        const v = row?.value ?? {};
        let botToken: string | null = null;
        if (v.botToken) {
            try { botToken = decryptSecret(v.botToken); } catch { console.error("[settings] couldn't decrypt the Telegram bot token (AGENT_SECRETS_KEY changed?)"); }
        }
        return { enabled: v.enabled === true, botToken, botUsername: v.botUsername ?? null };
    }

    async telegramView(): Promise<TelegramSettingsView> {
        const row = await this.repo.get<{ enabled?: boolean; botToken?: string | null; botUsername?: string | null }>(TELEGRAM_KEY);
        const s = await this.telegram();
        return {
            enabled: s.enabled,
            hasToken: !!s.botToken,
            tokenHint: s.botToken ? `…${s.botToken.slice(-4)}` : null,
            botUsername: s.botUsername,
            updatedAt: row?.updated_at ?? null,
            updatedBy: row?.updated_by ?? null,
        };
    }

    // body: { enabled?: boolean, botToken?: string | null } — a new token is
    // checked with Telegram before it's saved; null removes it.
    async saveTelegram(body: any, updatedBy: string, verify: TelegramVerifier): Promise<TelegramSettings> {
        const current = await this.telegram();
        let botToken = current.botToken;
        let botUsername = current.botUsername;
        if (body?.botToken !== undefined) {
            if (body.botToken === null || body.botToken === "") {
                botToken = null;
                botUsername = null;
            } else {
                const token = String(body.botToken).trim();
                if (!TELEGRAM_TOKEN.test(token)) throw new SettingsError("That doesn't look like a bot token — copy it from @BotFather (it looks like 123456789:AA…).");
                try {
                    botUsername = (await verify(token)).username;
                } catch (err) {
                    throw new SettingsError(err instanceof Error ? err.message : "Couldn't check the token with Telegram.");
                }
                botToken = token;
            }
        }
        if (body?.enabled !== undefined && typeof body.enabled !== "boolean") throw new SettingsError("enabled must be true or false");
        const enabled = body?.enabled ?? current.enabled;
        if (enabled && !botToken) throw new SettingsError("Add the bot token first.");
        await this.repo.set(TELEGRAM_KEY, { enabled, botToken: botToken ? encryptSecret(botToken) : null, botUsername }, updatedBy);
        const next = { enabled, botToken };
        for (const fn of this.telegramListeners) {
            try { fn(next); } catch (err) { console.error("[settings] listener failed:", err); }
        }
        return next;
    }

    onTelegramChange(fn: (s: TelegramSettings) => void): void {
        this.telegramListeners.push(fn);
    }

    async whatsapp(fresh = false): Promise<WhatsAppSettings & { updatedAt: Date | null; updatedBy: string | null }> {
        if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
        const row = await this.repo.get<Partial<WhatsAppSettings>>(WHATSAPP_KEY);
        const base = fromEnv();
        const v = row?.value ?? {};
        const value = {
            enabled: typeof v.enabled === "boolean" ? v.enabled : base.enabled,
            selfChat: typeof v.selfChat === "boolean" ? v.selfChat : base.selfChat,
            adminEmails: Array.isArray(v.adminEmails) ? v.adminEmails.map(String) : base.adminEmails,
            updatedAt: row?.updated_at ?? null,
            updatedBy: row?.updated_by ?? null,
        };
        this.cache = { value, at: Date.now() };
        return value;
    }

    async saveWhatsApp(body: any, updatedBy: string): Promise<WhatsAppSettings> {
        const current = await this.whatsapp(true);
        const bool = (v: unknown, fallback: boolean, name: string) => {
            if (v === undefined) return fallback;
            if (typeof v !== "boolean") throw new SettingsError(`${name} must be true or false`);
            return v;
        };
        let adminEmails = current.adminEmails;
        if (body?.adminEmails !== undefined) {
            if (!Array.isArray(body.adminEmails)) throw new SettingsError("adminEmails must be a list");
            adminEmails = [...new Set(body.adminEmails.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean))] as string[];
            const bad = adminEmails.find((e) => !EMAIL.test(e));
            if (bad) throw new SettingsError(`"${bad}" isn't a valid email`);
            if (adminEmails.length > MAX_ADMINS) throw new SettingsError(`Up to ${MAX_ADMINS} admins`);
        }
        const next: WhatsAppSettings = {
            enabled: bool(body?.enabled, current.enabled, "enabled"),
            selfChat: bool(body?.selfChat, current.selfChat, "selfChat"),
            adminEmails,
        };
        await this.repo.set(WHATSAPP_KEY, next, updatedBy);
        this.cache = null;
        for (const fn of this.listeners) {
            try { fn(next); } catch (err) { console.error("[settings] listener failed:", err); }
        }
        return next;
    }

    // Called in this process when settings are saved here (other processes poll).
    onWhatsAppChange(fn: (s: WhatsAppSettings) => void): void {
        this.listeners.push(fn);
    }

    // Who may pair the bot's number: the listed admins plus the owners.
    // With neither configured (a personal setup), any signed-in user may.
    async canPairWhatsApp(email?: string | null): Promise<boolean> {
        const { adminEmails } = await this.whatsapp();
        const allowed = new Set([...adminEmails, ...ownerEmails()]);
        if (!allowed.size) return true;
        return !!email && (allowed.has(email.toLowerCase()) || isOwner(email));
    }
}

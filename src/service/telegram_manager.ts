import { ChatBridge } from "../channels/core/chat_bridge";
import { ChatAdapter } from "../channels/core/chat_adapter";
import { TelegramAdapter } from "../channels/telegram/telegram_adapter";
import { SettingsService, TelegramSettings } from "./settings_service";

// Starts, stops and reconfigures the Telegram bot from Server settings,
// without a restart. A bot token can be polled by only one process, so only
// a process allowed to host it does anything (primary worker; in a
// multi-server setup set TELEGRAM_HOST=false on all but one). Settings saved
// on another server are picked up by polling.

const POLL_MS = 15_000;

type Deps = {
    settings: SettingsService;
    canHost: boolean;
    makeBridge: (adapter: ChatAdapter) => ChatBridge;
    // Tests pass a fake; production uses the real Bot API adapter.
    makeAdapter?: (token: string) => ChatAdapter;
};

export class TelegramManager {
    private adapter: ChatAdapter | null = null;
    private _bridge: ChatBridge | null = null;
    private applying: Promise<void> = Promise.resolve();
    private poll: NodeJS.Timeout | null = null;
    private runningToken: string | null = null;

    constructor(private deps: Deps) {}

    // The running bridge, or null when Telegram is off (or hosted elsewhere).
    get bridge(): ChatBridge | null {
        return this._bridge;
    }

    get hosted(): boolean {
        return this.deps.canHost;
    }

    async init(): Promise<void> {
        if (!this.deps.canHost) return;
        this.deps.settings.onTelegramChange((s) => void this.apply(s));
        await this.apply(await this.deps.settings.telegram());
        this.poll = setInterval(() => {
            this.deps.settings.telegram().then((s) => this.apply(s)).catch((err) => console.error("[telegram] couldn't read settings:", err));
        }, POLL_MS);
        this.poll.unref();
    }

    // Serialized so a quick on/off/on can't start two pollers.
    apply(s: TelegramSettings): Promise<void> {
        this.applying = this.applying.then(() => this.applyNow(s)).catch((err) => console.error("[telegram] couldn't apply settings:", err));
        return this.applying;
    }

    private async applyNow(s: TelegramSettings): Promise<void> {
        if (!this.deps.canHost) return;
        const want = s.enabled && s.botToken ? s.botToken : null;
        if (want === this.runningToken) return;
        if (this.adapter) {
            console.log("[telegram] stopping the bot");
            const old = this.adapter;
            this.adapter = null;
            this._bridge = null;
            this.runningToken = null;
            await old.stop();
        }
        if (!want) return;
        const adapter = this.deps.makeAdapter?.(want) ?? new TelegramAdapter(want);
        const bridge = this.deps.makeBridge(adapter);
        bridge.start();
        this.adapter = adapter;
        this._bridge = bridge;
        this.runningToken = want;
        console.log("[telegram] enabled in server settings — starting");
        // Never block or crash the app if Telegram can't be reached.
        adapter.start().catch((err) => console.error("[telegram] failed to start:", err instanceof Error ? err.message : err));
    }

    // For ChannelControl: null when Telegram isn't running in this process.
    snapshot() {
        if (!this.adapter) return null;
        const s = this.adapter.status();
        return { state: s.state, botHandle: s.botHandle };
    }

    status() {
        return {
            hosted: this.deps.canHost,
            running: !!this.adapter,
            ...(this.adapter?.status() ?? { state: "disconnected" as const }),
        };
    }

    async stop(): Promise<void> {
        if (this.poll) clearInterval(this.poll);
        const adapter = this.adapter;
        this.adapter = null;
        this._bridge = null;
        this.runningToken = null;
        await adapter?.stop();
    }
}

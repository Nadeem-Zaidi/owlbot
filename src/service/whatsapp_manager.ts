import { WhatsAppChannel } from "../channels/whatsapp_channel";
import { WhatsAppBridge } from "./whatsapp_bridge";
import { SettingsService, WhatsAppSettings } from "./settings_service";

// Starts, stops and reconfigures the WhatsApp bot from the server settings,
// without a restart. Only a process allowed to host it does anything: one
// WhatsApp login can't run in two processes, so in a multi-server setup only
// the "jobs" instance hosts it (WHATSAPP_HOST=false everywhere else). Settings
// saved on another server are picked up by polling.

const POLL_MS = 15_000;

type Deps = {
    settings: SettingsService;
    canHost: boolean;
    makeBridge: (channel: WhatsAppChannel) => WhatsAppBridge;
    authDir?: string;
    // Tests pass a fake; production uses the real Baileys channel.
    makeChannel?: (selfChat: boolean) => WhatsAppChannel;
};

export class WhatsAppManager {
    private channel: WhatsAppChannel | null = null;
    private _bridge: WhatsAppBridge | null = null;
    private applying: Promise<void> = Promise.resolve();
    private poll: NodeJS.Timeout | null = null;
    private lastApplied = "";

    constructor(private deps: Deps) {}

    // The running bridge, or null when WhatsApp is off (or hosted elsewhere).
    get bridge(): WhatsAppBridge | null {
        return this._bridge;
    }

    get hosted(): boolean {
        return this.deps.canHost;
    }

    async init(): Promise<void> {
        if (!this.deps.canHost) return;
        this.deps.settings.onWhatsAppChange((s) => void this.apply(s));
        await this.apply(await this.deps.settings.whatsapp(true));
        this.poll = setInterval(() => {
            this.deps.settings.whatsapp(true).then((s) => this.apply(s)).catch((err) => console.error("[whatsapp] couldn't read settings:", err));
        }, POLL_MS);
        this.poll.unref();
    }

    // Serialized so a quick on/off/on can't start two channels.
    apply(s: WhatsAppSettings): Promise<void> {
        this.applying = this.applying.then(() => this.applyNow(s)).catch((err) => console.error("[whatsapp] couldn't apply settings:", err));
        return this.applying;
    }

    private async applyNow(s: WhatsAppSettings): Promise<void> {
        if (!this.deps.canHost) return;
        const signature = `${s.enabled}:${s.selfChat}`;
        if (signature === this.lastApplied && (!!this.channel === s.enabled)) return;
        this.lastApplied = signature;

        if (s.enabled && !this.channel) {
            const channel = this.deps.makeChannel?.(s.selfChat) ?? new WhatsAppChannel(this.deps.authDir, s.selfChat);
            const bridge = this.deps.makeBridge(channel);
            bridge.start();
            this.channel = channel;
            this._bridge = bridge;
            console.log("[whatsapp] enabled in server settings — starting");
            // Never block or crash the app if WhatsApp can't connect.
            channel.start().catch((err) => console.error("[whatsapp] failed to start:", err));
            return;
        }
        if (!s.enabled && this.channel) {
            console.log("[whatsapp] disabled in server settings — stopping");
            const channel = this.channel;
            this.channel = null;
            this._bridge = null;
            await channel.stop();
            return;
        }
        this.channel?.setSelfChat(s.selfChat);
    }

    // For ChannelControl: null when WhatsApp isn't running in this process.
    snapshot() {
        const bridge = this._bridge;
        if (!bridge) return null;
        const s = bridge.status() as { state: string; botNumber?: string; qr?: string };
        return { state: s.state, botNumber: s.botNumber, qr: s.state === "awaiting_qr" ? s.qr : undefined, selfChat: bridge.selfChatMode() };
    }

    status() {
        return {
            hosted: this.deps.canHost,
            running: !!this.channel,
            ...(this._bridge?.status() ?? { state: "disconnected" as const }),
        };
    }

    async stop(): Promise<void> {
        if (this.poll) clearInterval(this.poll);
        const channel = this.channel;
        this.channel = null;
        this._bridge = null;
        await channel?.stop();
    }
}

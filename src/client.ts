import WebSocket from "ws";
import * as readline from "readline";
import chalk from "chalk";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3000";

// ── JSON-RPC id counter ──
let rpcId = 1;
const pending = new Map<number, (result: any) => void>();

// ── Create WebSocket connection ──
const ws = new WebSocket(WS_URL);

// ── Send a JSON-RPC request and wait for response ──
function call(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const id = rpcId++;
        pending.set(id, resolve);

        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
        }));

        // timeout after 30 seconds
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`Request timed out: ${method}`));
            }
        }, 30_000);
    });
}

// ── Handle incoming messages from server ──
ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // JSON-RPC response — matches a pending call
    if (msg.id !== undefined) {
        const resolve = pending.get(msg.id);
        if (resolve) {
            pending.delete(msg.id);
            if (msg.error) {
                console.error(chalk.red("[error]"), msg.error.message);
            } else {
                resolve(msg.result);
            }
        }
        return;
    }

    // Server-sent event (no id) — broadcast from gateway
    if (msg.method) {
        handleEvent(msg.method, msg.params);
    }
});

// ── Handle server broadcast events ──
function handleEvent(method: string, params: any) {
    console.log(method)
    switch (method) {

        case "whatsapp.qr":
            console.log(chalk.yellow("\n[whatsapp] QR code received"));
            console.log(chalk.cyan("Scan this URL in your browser to get the QR image:"));
            console.log(chalk.blue(params.qrImageUrl));
            console.log(chalk.gray("Or check the server terminal for the QR code\n"));
            break;

        case "whatsapp.status":
            if (params.status === "connected") {
                console.log(chalk.green("\n[whatsapp] connected! You can now send messages.\n"));
                showMenu();
            } else if (params.status === "disconnected") {
                console.log(chalk.red(`\n[whatsapp] disconnected — reason: ${params.reason}`));
                if (params.willReconnect) {
                    console.log(chalk.yellow("[whatsapp] reconnecting automatically..."));
                }
            } else if (params.status === "error") {
                console.log(chalk.red(`\n[whatsapp] error — ${params.reason}`));
            }
            break;

        default:
            console.log(chalk.gray(`[event] ${method}`), params);
    }
}

// ── Simple terminal menu ──
function showMenu() {
    console.log(chalk.cyan("─────────────────────────────────"));
    console.log(chalk.white("Commands:"));
    console.log(chalk.white("  send <jid> <message>  — send a WhatsApp message"));
    console.log(chalk.white("  history.clear <jid>   — clear conversation history"));
    console.log(chalk.white("  channels              — list registered channels"));
    console.log(chalk.white("  ping                  — ping the server"));
    console.log(chalk.white("  exit                  — quit"));
    console.log(chalk.cyan("─────────────────────────────────\n"));
}

// ── Terminal input ──
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("> "),
});

async function handleInput(line: string) {
    const parts = line.trim().split(" ");
    const cmd = parts[0];

    switch (cmd) {

        case "ping": {
            const res = await call("ping");
            console.log(chalk.green("[pong]"), res);
            break;
        }

        case "send": {
            // send 919876543210@s.whatsapp.net hello there!
            const jid = parts[1];
            const text = parts.slice(2).join(" ");
            if (!jid || !text) {
                console.log(chalk.red("usage: send <jid> <message>"));
                break;
            }
            const res = await call("whatsapp.send", { jid, text });
            console.log(chalk.green("[sent]"), res);
            break;
        }

        case "channels": {
            const res = await call("channel.list");
            console.log(chalk.green("[channels]"), res.channels);
            break;
        }

        case "history.clear": {
            const jid = parts[1];
            if (!jid) {
                console.log(chalk.red("usage: history.clear <jid>"));
                break;
            }
            const res = await call("history.clear", {
                sessionKey: `whatsapp:${jid}`
            });
            console.log(chalk.green("[history]"), res);
            break;
        }

        case "exit": {
            console.log(chalk.yellow("bye!"));
            process.exit(0);
        }

        default:
            if (cmd) {
                console.log(chalk.red(`unknown command: ${cmd}`));
                showMenu();
            }
    }
}

// ── Main flow ──
ws.on("open", async () => {
    console.log(chalk.green(`[client] connected to ${WS_URL}`));

    // 1. ping to verify connection
    const pong = await call("ping");
    console.log(chalk.green("[client] server is alive"), pong);

    // 2. start WhatsApp
    console.log(chalk.cyan("[client] starting WhatsApp connection..."));
    await call("whatsapp.connect");
});

ws.on("error", (err) => {
    console.error(chalk.red("[client] connection error:"), err.message);
    console.error(chalk.red("is the server running? try: npm run dev"));
});

ws.on("close", () => {
    console.log(chalk.yellow("[client] disconnected from server"));
    process.exit(0);
});

// ── Start reading terminal input ──
rl.prompt();
rl.on("line", async (line) => {
    await handleInput(line);
    rl.prompt();
});
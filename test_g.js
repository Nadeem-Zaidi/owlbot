import WebSocket from "ws";
import readline from "readline";

const ws = new WebSocket("ws://localhost:3000");

let id = 0;
const pending = new Map();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "You> "
});

ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // fix: use != null instead of truthy check — handles id=0 correctly
    if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        if (resolve) {
            resolve(msg.result ?? msg.error);
            pending.delete(msg.id);
        }
    }

    if (msg.id == null && msg.method) {
        console.log(`\nEVENT: ${msg.method}`, JSON.stringify(msg.params, null, 2));
        rl.prompt();
    }
});

function call(method, params = {}) {
    return new Promise((resolve) => {
        const reqId = ++id;
        pending.set(reqId, resolve);

        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method,
            params,  // fix: no duplicate id inside params
        }));
    });
}

ws.on("open", () => {
    console.log("Connected to gateway");
    console.log("Commands: /ping  /wo <number>  /wa <text>  /connect  or just type to chat");
    rl.prompt();

    rl.on("line", async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        if (input === "exit") {
            console.log("Bye!");
            process.exit(0);
        }

        try {
            if (input === "/ping") {
                const res = await call("ping");
                console.log("Server>", res);

            } else if (input.startsWith("/wo ")) {
                const wonum = input.split(" ")[1];
                const res = await call("maximo.getWorkOrder", { wonum });
                console.log("WorkOrder>", JSON.stringify(res, null, 2));

            } else if (input.startsWith("/wa ")) {
                const text = input.slice(4);
                await call("whatsapp.send", { jid: "123@s.whatsapp.net", text });
                console.log("WhatsApp message sent");

            } else if (input === "/connect") {
                const res = await call("whatsapp.connect");
                console.log("WhatsApp>", res);

            } else {
                const res = await call("llm.chat", {
                    messages: [{ role: "user", content: input }]
                });
                // fix: guard against undefined res
                console.log("AI>", res?.content ?? res);
            }

        } catch (err) {
            console.error("Error:", err);
        }

        rl.prompt();
    });
});

ws.on("error", (err) => console.error("WebSocket error:", err.message));
ws.on("close", () => console.log("Disconnected from server"));
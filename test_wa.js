import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000");

ws.on("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "whatsapp.connect",
    params: { id: 1 }
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.id === 1) {
    console.log("✅ WhatsApp booting:", msg.result);
  }

  if (msg.method === "whatsapp.qr") {
    console.log("📱 Open this to scan QR:\n", msg.params.qrImageUrl);
  }

  if (msg.method === "whatsapp.status") {
    console.log("📶 Status:", msg.params.status);
    // ✅ Don't close — stay connected to receive incoming messages
  }

  // Incoming WhatsApp messages will arrive here
  if (msg.method === "whatsapp.message") {
    console.log("💬 New message from", msg.params.from, ":", msg.params.text);
  }
});

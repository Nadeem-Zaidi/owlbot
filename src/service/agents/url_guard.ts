import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Agents call URLs that users type in (HTTP functions, MCP servers). Without
// a check, an agent could be pointed at this server's own network — the
// database, cloud metadata (169.254.169.254), internal services. Only public
// http(s) addresses are allowed unless AGENT_ALLOW_PRIVATE_URLS=true (handy
// for a local MCP server during development).

const allowPrivate = () => process.env.AGENT_ALLOW_PRIVATE_URLS === "true";

function isPrivateIPv4(ip: string): boolean {
    const [a, b] = ip.split(".").map(Number);
    return (
        a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
        (a === 169 && b === 254) ||             // link-local / cloud metadata
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224                                 // multicast / reserved
    );
}

function isPrivateIPv6(ip: string): boolean {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

export function isPrivateAddress(ip: string): boolean {
    return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/** Throws a user-readable error unless `raw` is a public http(s) URL. */
export async function assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`"${raw}" isn't a valid URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Only http:// and https:// URLs are allowed");
    }
    if (url.username || url.password) throw new Error("Put credentials in a header, not in the URL");
    if (allowPrivate()) return url;

    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
        throw new Error("Private and local addresses aren't allowed (set AGENT_ALLOW_PRIVATE_URLS=true for local development)");
    }
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addresses.length) throw new Error(`Couldn't resolve ${host}`);
    if (addresses.some(isPrivateAddress)) {
        throw new Error("Private and local addresses aren't allowed (set AGENT_ALLOW_PRIVATE_URLS=true for local development)");
    }
    return url;
}

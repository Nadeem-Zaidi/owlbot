// Model details from the Hugging Face Hub (public API, no key): a short
// description from the model card, licence, context length and size — used to
// fill in the owner's catalogue entries for open models.

const hub = () => (process.env.HF_HUB_URL?.trim() || "https://huggingface.co").replace(/\/+$/, "");
const HF_ID = /^[\w.\-]+\/[\w.\-]+$/;

export type HfInfo = {
    huggingFaceId: string;
    description: string;
    license: string | null;
    contextLength: number | null;
    parameters: number | null;
    vision: boolean;
};

export const isHfId = (id: string) => HF_ID.test(id) && id.length <= 120;

async function getJson(url: string): Promise<any | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) return null;
    return res.json().catch(() => null);
}

// The first real paragraph of a model card (front matter, headings, badges and HTML removed).
export function cardSummary(readme: string, max = 600): string {
    const body = readme.replace(/^---[\s\S]*?\n---\s*/, "");
    for (const block of body.split(/\n\s*\n/)) {
        const text = block
            .replace(/<[^>]+>/g, " ")
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/[*_`>#|]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        if (text.length < 60 || /^(-|\d+\.)\s/.test(block.trim()) || /^#/.test(block.trim())) continue;
        return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text;
    }
    return "";
}

export async function huggingFaceInfo(hfId: string): Promise<HfInfo | null> {
    if (!isHfId(hfId)) return null;
    const enc = hfId.split("/").map(encodeURIComponent).join("/");
    const meta = await getJson(`${hub()}/api/models/${enc}`);
    if (!meta) return null;
    const [readme, config] = await Promise.all([
        fetch(`${hub()}/${enc}/raw/main/README.md`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
        getJson(`${hub()}/${enc}/raw/main/config.json`),
    ]);
    const ctx = Number(config?.max_position_embeddings ?? config?.text_config?.max_position_embeddings ?? config?.max_sequence_length ?? 0);
    const tags: string[] = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
    const license = meta.cardData?.license ?? tags.find((t) => t.startsWith("license:"))?.slice(8) ?? null;
    return {
        huggingFaceId: meta.id ?? hfId,
        description: cardSummary(readme.slice(0, 50_000)),
        license: license ? String(license) : null,
        contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
        parameters: Number(meta.safetensors?.total) || null,
        vision: meta.pipeline_tag === "image-text-to-text" || tags.includes("image-text-to-text") || !!config?.vision_config,
    };
}

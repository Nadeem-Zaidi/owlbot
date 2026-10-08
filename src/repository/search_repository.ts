import { IDatabaseAdapter } from "../database/idatabaseadapter";

export type SearchHit = {
    session_id: string;
    title: string | null;
    source: string | null;
    agent_icon: string | null;
    agent_name: string | null;
    updated_at: Date;
    title_match: boolean;
    match_count: number;
    snippets: { role: string; text: string; created_at: Date }[];
};

const SNIPPET_RADIUS = 80;
const MAX_SNIPPETS = 3;

// Escapes %, _ and \ so the user's text is matched literally in ILIKE.
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function snippet(text: string, query: string): string {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2);
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
    return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

// Full-text search over one user's chat titles and visible messages.
export class SearchRepository {
    constructor(private db: IDatabaseAdapter) {}

    // `offset` pages through the ranked results (infinite scroll); hasMore
    // says whether another page exists.
    async searchChats(userId: string, query: string, limit = 30, offset = 0): Promise<{ results: SearchHit[]; hasMore: boolean }> {
        const pattern = likePattern(query);
        // Cheap pre-filter on the whole message (uses the trigram index when
        // present) before expanding its parts. JSON escapes quotes/backslashes,
        // so skip it for queries containing them.
        const prefilter = /["\\]/.test(query) ? "" : "AND m.content::text ILIKE $2";
        const [titles, messages] = await Promise.all([
            this.db.query<{ id: string; title: string; source: string; agent_icon: string | null; agent_name: string | null; updated_at: Date }>(
                `SELECT s.id, s.title, s.source, a.icon AS agent_icon, a.name AS agent_name, s.updated_at
                 FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id
                 WHERE s.userid = $1 AND s.source <> 'pipeline' AND s.title ILIKE $2
                 ORDER BY s.updated_at DESC LIMIT $3`,
                [userId, pattern, offset + limit + 1]
            ),
            // Only what the user actually sees: user/assistant text, not hidden
            // instructions, attached documents or tool output.
            this.db.query<{ session_id: string; title: string; source: string; agent_icon: string | null; agent_name: string | null; updated_at: Date; role: string; text: string; created_at: Date }>(
                `SELECT s.id AS session_id, s.title, s.source, a.icon AS agent_icon, a.name AS agent_name, s.updated_at,
                        m.role, part->>'text' AS text, m.created_at
                 FROM sessions s
                 JOIN chat_messages m ON m.session_id = s.id
                 LEFT JOIN agents a ON a.id = s.agent_id
                 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.content) = 'array' THEN m.content ELSE '[]'::jsonb END) AS part
                 WHERE s.userid = $1 AND s.source <> 'pipeline'
                   AND m.role IN ('user', 'assistant')
                   ${prefilter}
                   AND part->>'type' IN ('text', 'output_text', 'input_text')
                   AND COALESCE(part->>'hidden', 'false') <> 'true'
                   AND part->>'documentName' IS NULL
                   AND part->>'text' ILIKE $2
                 ORDER BY m.created_at DESC
                 LIMIT 500`,
                [userId, pattern]
            ),
        ]);

        const hits = new Map<string, SearchHit>();
        const ensure = (r: { id?: string; session_id?: string; title: string | null; source: string | null; agent_icon: string | null; agent_name: string | null; updated_at: Date }) => {
            const id = (r.id ?? r.session_id)!;
            let hit = hits.get(id);
            if (!hit) {
                hit = { session_id: id, title: r.title, source: r.source, agent_icon: r.agent_icon, agent_name: r.agent_name, updated_at: r.updated_at, title_match: false, match_count: 0, snippets: [] };
                hits.set(id, hit);
            }
            return hit;
        };
        for (const t of titles.rows) ensure(t).title_match = true;
        for (const m of messages.rows) {
            const hit = ensure(m);
            hit.match_count++;
            if (hit.snippets.length < MAX_SNIPPETS) hit.snippets.push({ role: m.role, text: snippet(m.text, query), created_at: m.created_at });
        }

        // Title matches first, then by most matches, then most recent.
        const ranked = [...hits.values()]
            .sort((a, b) => Number(b.title_match) - Number(a.title_match) || b.match_count - a.match_count || +new Date(b.updated_at) - +new Date(a.updated_at));
        return { results: ranked.slice(offset, offset + limit), hasMore: ranked.length > offset + limit };
    }
}

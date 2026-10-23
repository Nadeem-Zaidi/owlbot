import { LOCAL_COMMAND_TOOL } from "../local_commands/local_command_tool";
import { AgentRepository, AgentRow } from "../../repository/agent_repository";
import { AgentService } from "../../service/agents/agent_service";
import { KnowledgeBase } from "../../service/knowledge_base";
import { SkillService } from "../skills";
import { StudioService } from "../studio/studio_service";
import { syncFromAgents } from "../studio/studio_canvas";
import type { StudioCanvas, StudioNode } from "../studio/studio_types";
import {
    AgentChoice, EXPORT_FORMAT, EXPORT_VERSION, ImportChoices, PortableAgent, PortableFile, PortableFunction, PortableProject,
} from "./portable_types";

const MAX_FILE_CHARS = 2_000_000;
const MAX_AGENTS = 50;
const MAX_PROJECTS = 20;

export class PortableError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
const arr = <T = any>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const fileName = (key: string) => key.split("/").pop() || key;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";

type Deps = {
    agentRepo: AgentRepository;
    agents: AgentService;
    studio: StudioService;
    skills: SkillService;
    kb: KnowledgeBase;
};

// Export and import of agents and Agent Studio projects (JSON files).
// Import is all-or-nothing: everything is checked first — including a test
// connection to each MCP server — then created; a failure rolls back what
// was created.
export class PortableService {
    constructor(private deps: Deps) {}

    // ── export ──
    async exportAgent(userId: string, agentId: string): Promise<PortableFile> {
        const agent = await this.portableAgent(userId, agentId, new Set());
        return this.file([agent], []);
    }

    async exportProject(userId: string, projectId: string): Promise<PortableFile> {
        const project = await this.deps.studio.get(userId, projectId);
        const canvas = project.canvas as StudioCanvas;
        const refs = new Map<string, string>();       // agent id → ref
        const agents: PortableAgent[] = [];
        const used = new Set<string>();
        for (const n of canvas.nodes) {
            if (n.type !== "agent" || !n.agent_id || refs.has(n.agent_id)) continue;
            const a = await this.portableAgent(userId, n.agent_id, used);
            refs.set(n.agent_id, a.ref);
            agents.push(a);
        }
        const skillNames = new Map((await this.deps.skills.list(userId)).map((s: any) => [s.id, s.name]));
        const nodes = canvas.nodes.map((n): Record<string, unknown> => {
            switch (n.type) {
                case "agent": {
                    const { agent_id, agent, ...rest } = n;
                    // A new, never-saved agent can't be exported; the project is saved first, so this is rare.
                    return { ...rest, agent_ref: agent_id ? refs.get(agent_id) : null, agent_name: agent.name };
                }
                case "knowledge":
                    return { id: n.id, type: n.type, position: n.position, documents: n.document_keys.map(fileName) };
                case "skill":
                    return { id: n.id, type: n.type, position: n.position, skill_name: n.skill_id === "*" ? "*" : skillNames.get(n.skill_id) ?? null };
                default:
                    return n as unknown as Record<string, unknown>;
            }
        });
        const p: PortableProject = { name: project.name, description: project.description, deliver_result: project.deliver_result, nodes, edges: canvas.edges as unknown as Record<string, unknown>[] };
        return this.file(agents, [p]);
    }

    private file(agents: PortableAgent[], projects: PortableProject[]): PortableFile {
        return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), agents, projects };
    }

    private async portableAgent(userId: string, agentId: string, usedRefs: Set<string>): Promise<PortableAgent> {
        const a: any = await this.deps.agents.get(userId, agentId).catch(() => { throw new PortableError("Agent not found", 404); });
        let ref = slug(a.name);
        for (let i = 2; usedRefs.has(ref); i++) ref = `${slug(a.name)}-${i}`;
        usedRefs.add(ref);
        const items = [];
        if (a.skill_mode === "selected") {
            for (const id of a.skill_ids ?? []) {
                const s: any = await this.deps.skills.get(userId, id).catch(() => null);
                if (s) items.push({ name: s.name, description: s.description, content: s.content });
            }
        }
        const helpers: string[] = [];
        for (const id of a.helper_agent_ids ?? []) {
            const h = await this.deps.agentRepo.getAgent(id, userId);
            if (h) helpers.push(h.name);
        }
        const notExported = (a.codeFunctions ?? []).length ? [`${a.codeFunctions.length} Python code function${a.codeFunctions.length === 1 ? "" : "s"}`] : [];
        return {
            ref,
            name: a.name,
            icon: a.icon,
            description: a.description ?? "",
            instructions: a.instructions ?? "",
            starters: a.starters ?? [],
            instruction_files: (a.instruction_files ?? []).map((f: any) => ({ name: f.name, content: f.content, enabled: f.enabled !== false })),
            model: a.provider ? { provider: a.provider, model: a.model ?? null } : null,
            builtin_tools: a.builtin_tools ?? [],
            limits: a.limits ?? {},
            documents: (a.document_keys ?? []).map(fileName),
            skills: { mode: a.skill_mode ?? "all", items },
            functions: (a.functions ?? []).map((f: any): PortableFunction => ({
                name: f.name, description: f.description, method: f.method, url: f.url, parameters: f.parameters ?? [], enabled: f.enabled,
                // Secret values never leave the server.
                headers: (f.headers ?? []).map((h: any) => ({ key: h.key, secret: !!h.secret, value: h.secret ? null : h.value })),
            })),
            mcp_servers: (a.mcpServers ?? []).map((s: any) => ({
                name: s.name, url: s.url, needs_token: !!s.hasToken,
                enabled_tools: (s.tools ?? []).filter((t: any) => t.enabled).map((t: any) => t.name),
            })),
            ...(helpers.length ? { helpers } : {}),
            ...(notExported.length ? { not_exported: notExported } : {}),
        };
    }

    // ── import: read and check the file's shape ──
    parse(raw: unknown): PortableFile {
        if (typeof raw === "string") {
            if (raw.length > MAX_FILE_CHARS) throw new PortableError("The file is too large (max 2 MB)");
            try {
                raw = JSON.parse(raw);
            } catch {
                throw new PortableError("That isn't a valid JSON file");
            }
        } else if (JSON.stringify(raw ?? null).length > MAX_FILE_CHARS) {
            throw new PortableError("The file is too large (max 2 MB)");
        }
        const f = raw as any;
        if (f?.format !== EXPORT_FORMAT) throw new PortableError("This isn't an Owl Bot export file");
        if (typeof f.version !== "number" || f.version > EXPORT_VERSION) throw new PortableError("This file comes from a newer version of Owl Bot — update the app to import it");
        const agents = arr(f.agents, MAX_AGENTS + 1);
        const projects = arr(f.projects, MAX_PROJECTS + 1);
        if (agents.length > MAX_AGENTS) throw new PortableError(`A file can hold at most ${MAX_AGENTS} agents`);
        if (projects.length > MAX_PROJECTS) throw new PortableError(`A file can hold at most ${MAX_PROJECTS} projects`);
        if (!agents.length && !projects.length) throw new PortableError("The file has nothing to import");
        const refs = new Set<string>();
        const cleanAgents: PortableAgent[] = agents.map((a: any, i: number) => {
            const ref = str(a?.ref, 60);
            if (!ref || refs.has(ref)) throw new PortableError(`Agent ${i + 1} has a missing or duplicate "ref"`);
            refs.add(ref);
            if (!str(a?.name, 60).trim()) throw new PortableError(`Agent ${i + 1} has no name`);
            return {
                ref,
                name: str(a.name, 60).trim(),
                icon: str(a.icon, 8) || "🤖",
                description: str(a.description, 300),
                instructions: str(a.instructions, 20_000),
                starters: arr<string>(a.starters, 6).filter((s) => typeof s === "string"),
                instruction_files: arr(a.instruction_files, 10).map((x: any) => ({ name: str(x?.name, 100), content: str(x?.content, 100_000), enabled: x?.enabled !== false })),
                model: a.model && typeof a.model.provider === "string" ? { provider: str(a.model.provider, 80), model: typeof a.model.model === "string" ? str(a.model.model, 200) : null } : null,
                // Never imported: local commands run on the importer's computer, so they turn it on themselves.
                builtin_tools: arr<string>(a.builtin_tools, 20).filter((t) => typeof t === "string" && t !== LOCAL_COMMAND_TOOL),
                limits: a.limits && typeof a.limits === "object" && !Array.isArray(a.limits) ? a.limits : {},
                documents: arr<string>(a.documents, 200).filter((d) => typeof d === "string").map((d) => d.slice(0, 300)),
                skills: {
                    mode: ["all", "selected", "none"].includes(a?.skills?.mode) ? a.skills.mode : "all",
                    items: arr(a?.skills?.items, 100).map((s: any) => ({ name: str(s?.name, 64), description: str(s?.description, 500), content: str(s?.content, 50_000) })).filter((s) => s.name),
                },
                functions: arr(a.functions, 30).map((fn: any) => ({
                    name: str(fn?.name, 64), description: str(fn?.description, 1024), method: str(fn?.method, 10) || "GET", url: str(fn?.url, 2000),
                    parameters: arr(fn?.parameters, 30), enabled: fn?.enabled !== false,
                    headers: arr(fn?.headers, 20).map((h: any) => ({ key: str(h?.key, 100), secret: !!h?.secret, value: h?.secret ? null : str(h?.value, 2000) })),
                })),
                mcp_servers: arr(a.mcp_servers, 10).map((s: any) => ({
                    name: str(s?.name, 40), url: str(s?.url, 2000), needs_token: !!s?.needs_token,
                    enabled_tools: arr<string>(s?.enabled_tools, 500).filter((t) => typeof t === "string"),
                })).filter((s) => s.name && s.url),
                helpers: arr<string>(a.helpers, 5).filter((h) => typeof h === "string" && h.trim()).map((h) => h.slice(0, 60)),
            };
        });
        const cleanProjects: PortableProject[] = projects.map((p: any, i: number) => {
            if (!str(p?.name, 80).trim()) throw new PortableError(`Project ${i + 1} has no name`);
            const nodes = arr<Record<string, unknown>>(p.nodes, 120);
            for (const n of nodes) {
                if (n?.type === "agent" && n.agent_ref && !refs.has(String(n.agent_ref))) {
                    throw new PortableError(`Project "${p.name}" uses an agent ("${n.agent_ref}") that isn't in the file`);
                }
            }
            return { name: str(p.name, 80).trim(), description: str(p.description, 300), deliver_result: p.deliver_result === true, nodes, edges: arr(p.edges, 250) };
        });
        return { format: EXPORT_FORMAT, version: f.version, exported_at: str(f.exported_at, 40), agents: cleanAgents, projects: cleanProjects };
    }

    // ── import: what would happen (nothing is created) ──
    async preview(userId: string, raw: unknown, email?: string) {
        const file = this.parse(raw);
        const ctx = await this.context(userId, email);
        const agents = file.agents.map((a) => {
            const existing = ctx.agentsByName.get(a.name.toLowerCase()) ?? null;
            const warnings: string[] = [];
            if (a.model && !ctx.providers.has(a.model.provider)) warnings.push(`Its model (${a.model.model ?? a.model.provider}) isn't available here — your default model will be used.`);
            const missingDocs = a.documents.filter((d) => !ctx.docsByName.has(d.toLowerCase()));
            if (missingDocs.length) warnings.push(`${missingDocs.length} knowledge document${missingDocs.length === 1 ? " is" : "s are"} not in your knowledge base: ${missingDocs.slice(0, 5).join(", ")}${missingDocs.length > 5 ? "…" : ""}`);
            if (a.not_exported?.length) warnings.push(`Not included in the file: ${a.not_exported.join(", ")}.`);
            const fileNames = new Set(file.agents.map((x) => x.name.toLowerCase()));
            const lostHelpers = (a.helpers ?? []).filter((h) => !fileNames.has(h.toLowerCase()) && !ctx.agentsByName.has(h.toLowerCase()));
            if (lostHelpers.length) warnings.push(`It can ask ${lostHelpers.join(", ")}, which ${lostHelpers.length === 1 ? "isn't" : "aren't"} in the file or your agents — that link is skipped.`);
            return {
                ref: a.ref, name: a.name, icon: a.icon, description: a.description,
                existing: existing ? { id: existing.id, name: existing.name } : null,
                tools: a.builtin_tools.length, functions: a.functions.length,
                mcp_servers: a.mcp_servers.map((s) => ({ name: s.name, url: s.url, needs_token: s.needs_token, tools: s.enabled_tools.length })),
                secret_headers: a.functions.flatMap((fn) => fn.headers.filter((h) => h.secret).map((h) => ({ function: fn.name, header: h.key, key: `${fn.name}:${h.key}` }))),
                skills_to_create: a.skills.mode === "selected" ? a.skills.items.filter((s) => !ctx.skillsByName.has(s.name.toLowerCase())).map((s) => s.name) : [],
                missing_documents: missingDocs,
                warnings,
            };
        });
        const projects = file.projects.map((p) => ({ name: p.name, final_name: this.projectName(p.name, ctx.projectNames), ...this.triggerNote(p, ctx.commands) }));
        return { exported_at: file.exported_at, agents, projects };
    }

    // ── import: create everything (all or nothing) ──
    async import(userId: string, raw: unknown, choices: ImportChoices = {}, email?: string) {
        const file = this.parse(raw);
        const ctx = await this.context(userId, email);
        const warnings: string[] = [];
        const chosen = (a: PortableAgent): AgentChoice => choices.agents?.[a.ref] ?? { mode: ctx.agentsByName.has(a.name.toLowerCase()) ? "existing" : "create" };

        // 1. Check everything; nothing is written yet.
        type Plan = { a: PortableAgent; existingId?: string; body?: any; functions: any[]; mcp: { name: string; url: string; token: string | null; enabledTools: string[] }[]; skillsToCreate: PortableAgent["skills"]["items"] };
        const plans: Plan[] = [];
        for (const a of file.agents) {
            const c = chosen(a);
            if (c.mode === "existing") {
                const id = c.existing_id ?? ctx.agentsByName.get(a.name.toLowerCase())?.id;
                if (!id || !(await this.deps.agentRepo.getAgent(id, userId))) throw new PortableError(`"${a.name}": the existing agent to use wasn't found`);
                plans.push({ a, existingId: id, functions: [], mcp: [], skillsToCreate: [] });
                continue;
            }
            const where = `"${a.name}"`;
            // Model: keep it when it's available here.
            let model = a.model && ctx.providers.has(a.model.provider) ? a.model : null;
            if (a.model && !model) warnings.push(`${where}: its model isn't available here — using your default model.`);
            const document_keys = a.documents.flatMap((d) => (ctx.docsByName.has(d.toLowerCase()) ? [ctx.docsByName.get(d.toLowerCase())!] : []));
            if (document_keys.length < a.documents.length) warnings.push(`${where}: ${a.documents.length - document_keys.length} knowledge document(s) weren't found in your knowledge base.`);
            const skillsToCreate = a.skills.mode === "selected" ? a.skills.items.filter((s) => !ctx.skillsByName.has(s.name.toLowerCase())) : [];
            const body: any = {
                name: a.name, icon: a.icon, description: a.description, instructions: a.instructions, starters: a.starters,
                instruction_files: a.instruction_files, provider: model?.provider ?? null, model: model?.model ?? null,
                builtin_tools: a.builtin_tools, document_keys, skill_mode: a.skills.mode, skill_ids: [],
                ...(a.limits && Object.keys(a.limits).length ? { limits: a.limits } : {}),
            };
            await this.deps.agents.checkInput(userId, body).catch(async (err) => {
                // A model the server rejects → fall back to the default model.
                if (model && /model|provider/i.test(err.message)) {
                    warnings.push(`${where}: ${err.message} — using your default model.`);
                    model = null;
                    body.provider = null;
                    body.model = null;
                    return this.deps.agents.checkInput(userId, body);
                }
                throw new PortableError(`${where}: ${err.message}`);
            }).catch((err) => { throw err instanceof PortableError ? err : new PortableError(`${where}: ${err.message}`); });

            const functions = [];
            const names = new Set<string>();
            for (const fn of a.functions) {
                if (names.has(fn.name.toLowerCase())) throw new PortableError(`${where}: two functions are called "${fn.name}"`);
                names.add(fn.name.toLowerCase());
                let missingSecret = false;
                const headers = fn.headers.map((h) => {
                    if (!h.secret) return { key: h.key, value: h.value ?? "", secret: false };
                    const v = c.secrets?.[`${fn.name}:${h.key}`] ?? "";
                    if (!v) missingSecret = true;
                    return { key: h.key, value: v, secret: true };
                });
                const fnBody = { ...fn, headers, enabled: fn.enabled && !missingSecret };
                try {
                    this.deps.agents.normalizeFunction(fnBody, null);
                } catch (err: any) {
                    throw new PortableError(`${where} → function "${fn.name}": ${err.message}`);
                }
                if (missingSecret && fn.enabled) warnings.push(`${where}: function "${fn.name}" was imported switched off — enter its secret header on the Agents page.`);
                functions.push(fnBody);
            }

            const mcp = [];
            for (const s of a.mcp_servers) {
                if (c.skip_mcp?.includes(s.name)) {
                    warnings.push(`${where}: MCP server "${s.name}" was skipped — add it later on the Agents page.`);
                    continue;
                }
                const token = c.mcp_tokens?.[s.name]?.trim() || null;
                if (s.needs_token && !token) throw new PortableError(`${where} → MCP server "${s.name}" needs its access token (or choose to skip it)`);
                // A test connection now, so a bad token stops the import before anything is created.
                const tools = await this.deps.agents.discoverMcp({ url: s.url, token }).catch((err: any) => {
                    throw new PortableError(`${where} → MCP server "${s.name}": ${err.message}`);
                });
                const available = new Set(tools.map((t) => t.name));
                const enabledTools = s.enabled_tools.length ? s.enabled_tools.filter((t) => available.has(t)) : [...available];
                mcp.push({ name: s.name, url: s.url, token, enabledTools });
            }
            plans.push({ a, body, functions, mcp, skillsToCreate });
        }

        // 2. Create — undone if anything fails.
        const created = { agents: [] as string[], skills: [] as string[], projects: [] as string[] };
        try {
            const skillIds = new Map(ctx.skillsByName);
            for (const p of plans) {
                for (const s of p.skillsToCreate) {
                    if (skillIds.has(s.name.toLowerCase())) continue;
                    const row: any = await this.deps.skills.create(userId, { name: s.name, description: s.description, content: s.content, enabled: true });
                    created.skills.push(row.id);
                    skillIds.set(s.name.toLowerCase(), row.id);
                }
            }
            const idByRef = new Map<string, string>();
            const result: { ref: string; id: string; name: string; created: boolean }[] = [];
            for (const p of plans) {
                if (p.existingId) {
                    idByRef.set(p.a.ref, p.existingId);
                    result.push({ ref: p.a.ref, id: p.existingId, name: p.a.name, created: false });
                    continue;
                }
                p.body.skill_ids = p.a.skills.mode === "selected" ? p.a.skills.items.flatMap((s) => (skillIds.has(s.name.toLowerCase()) ? [skillIds.get(s.name.toLowerCase())!] : [])) : [];
                const agent = await this.deps.agents.create(userId, p.body);
                created.agents.push(agent.id);
                idByRef.set(p.a.ref, agent.id);
                for (const fn of p.functions) await this.deps.agents.createFunction(userId, agent.id, fn);
                for (const s of p.mcp) await this.deps.agents.addMcpServer(userId, agent.id, { name: s.name, url: s.url, token: s.token ?? undefined, enabledTools: s.enabledTools });
                result.push({ ref: p.a.ref, id: agent.id, name: p.a.name, created: true });
            }

            // Helpers, now that every agent in the file exists: by name — an agent in
            // the file first, else one of the importer's own agents.
            const idByName = new Map<string, string>();
            for (const [name, row] of ctx.agentsByName) idByName.set(name, row.id);
            for (const p of plans) idByName.set(p.a.name.toLowerCase(), idByRef.get(p.a.ref)!);
            for (const p of plans) {
                if (p.existingId || !(p.a.helpers ?? []).length) continue;
                const own = idByRef.get(p.a.ref)!;
                const ids = [...new Set((p.a.helpers ?? []).flatMap((h) => { const id = idByName.get(h.toLowerCase()); return id && id !== own ? [id] : []; }))].slice(0, 5);
                const lost = (p.a.helpers ?? []).length - ids.length;
                if (lost > 0) warnings.push(`"${p.a.name}": ${lost} agent(s) it can ask weren't found — add them on its page.`);
                if (ids.length) await this.deps.agents.update(userId, own, { ...p.body, helper_agent_ids: ids });
            }

            const projects: { id: string; name: string }[] = [];
            for (const proj of file.projects) {
                const { canvas, notes } = await this.projectCanvas(userId, proj, idByRef, skillIds, ctx);
                warnings.push(...notes.map((n) => `"${proj.name}": ${n}`));
                const name = this.projectName(proj.name, ctx.projectNames);
                ctx.projectNames.add(name.toLowerCase());
                const saved: any = await this.deps.studio.save(userId, null, { name, description: proj.description, deliver_result: proj.deliver_result, canvas });
                created.projects.push(saved.id);
                projects.push({ id: saved.id, name: saved.name });
            }
            return { agents: result, projects, warnings };
        } catch (err: any) {
            // Undo, newest first.
            for (const id of created.projects) await this.deps.studio.remove(userId, id).catch(() => {});
            for (const id of created.agents) await this.deps.agents.remove(userId, id).catch(() => {});
            for (const id of created.skills) await this.deps.skills.remove(userId, id).catch(() => {});
            throw err instanceof PortableError ? err : new PortableError(`Import failed, nothing was saved: ${err?.message ?? err}`, Number(err?.status) || 400);
        }
    }

    // The project's canvas for this account: agents by id, documents and
    // skills mapped by name, then made consistent with the agents (so saving
    // doesn't change an existing agent).
    private async projectCanvas(userId: string, p: PortableProject, idByRef: Map<string, string>, skillIds: Map<string, string>, ctx: Awaited<ReturnType<PortableService["context"]>>) {
        const notes: string[] = [];
        const nodes: any[] = [];
        for (const raw of p.nodes) {
            const n: any = { ...raw };
            if (n.type === "agent") {
                const id = n.agent_ref ? idByRef.get(String(n.agent_ref)) : undefined;
                delete n.agent_ref;
                const name = String(n.agent_name ?? "Agent");
                delete n.agent_name;
                nodes.push({ ...n, agent_id: id ?? null, agent: { name, icon: "🤖", description: "", instructions: "" } });
            } else if (n.type === "knowledge") {
                const keys = arr<string>(n.documents, 50).flatMap((d) => (ctx.docsByName.has(String(d).toLowerCase()) ? [ctx.docsByName.get(String(d).toLowerCase())!] : []));
                nodes.push({ id: n.id, type: "knowledge", position: n.position, document_keys: keys });
            } else if (n.type === "skill") {
                const sid = n.skill_name === "*" ? "*" : skillIds.get(String(n.skill_name ?? "").toLowerCase());
                if (sid) nodes.push({ id: n.id, type: "skill", position: n.position, skill_id: sid });
            } else if (n.type === "trigger") {
                nodes.push({ ...n, trigger: this.importTrigger(n.trigger, ctx.commands, notes) });
            } else {
                nodes.push(n);
            }
        }
        const kept = new Set(nodes.map((n) => n.id));
        const edges = p.edges.filter((e: any) => kept.has(e?.from) && kept.has(e?.to));
        const rows = new Map<string, AgentRow>();
        for (const id of new Set(idByRef.values())) {
            const row = await this.deps.agentRepo.getAgent(id, userId);
            if (row) rows.set(id, row);
        }
        return { canvas: syncFromAgents({ version: 1, nodes: nodes as StudioNode[], edges: edges as any }, rows), notes };
    }

    // Schedules start switched off (run manually) and a chat command already
    // in use is dropped — nothing starts on its own after an import.
    private importTrigger(t: any, commands: Set<string>, notes: string[]) {
        if (t?.type === "schedule") {
            notes.push("its schedule was turned off — set it again on the trigger to start it");
            return { type: "manual" };
        }
        if (t?.type === "chat" && commands.has(String(t.command).toLowerCase())) {
            notes.push(`the chat command /${t.command} is already used by another project — it was set to run manually`);
            return { type: "manual" };
        }
        return t ?? { type: "manual" };
    }

    private triggerNote(p: PortableProject, commands: Set<string>) {
        const t: any = p.nodes.find((n: any) => n?.type === "trigger")?.trigger;
        if (t?.type === "schedule") return { trigger_note: "Its schedule starts switched off — turn it on after importing." };
        if (t?.type === "chat" && commands.has(String(t.command).toLowerCase())) return { trigger_note: `/${t.command} is already in use — it will run manually.` };
        if (t?.type === "webhook") return { trigger_note: "It gets a new webhook URL." };
        return {};
    }

    private projectName(name: string, taken: Set<string>) {
        if (!taken.has(name.toLowerCase())) return name;
        for (let i = 1; ; i++) {
            const n = `${name} (imported${i > 1 ? ` ${i}` : ""})`;
            if (!taken.has(n.toLowerCase())) return n;
        }
    }

    // What the importing account already has, by name.
    private async context(userId: string, email?: string) {
        const [agents, docs, skills, projects, commands, catalog] = await Promise.all([
            this.deps.agentRepo.listAgents(userId),
            this.deps.kb.listDocuments(userId).catch(() => []),
            this.deps.skills.list(userId),
            this.deps.studio.list(userId),
            this.deps.studio.commands(userId),
            this.deps.agents.catalog(email, userId),
        ]);
        return {
            agentsByName: new Map(agents.map((a: AgentRow) => [a.name.toLowerCase(), a])),
            docsByName: new Map(docs.map((d) => [d.name.toLowerCase(), d.key])),
            skillsByName: new Map((skills as any[]).map((s) => [String(s.name).toLowerCase(), String(s.id)])),
            projectNames: new Set(projects.map((p) => p.name.toLowerCase())),
            commands: new Set(commands.map((c) => c.command.toLowerCase())),
            providers: new Set<string>(catalog.providers.map((p: any) => p.id)),
        };
    }
}

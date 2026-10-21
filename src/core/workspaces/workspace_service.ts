import { createHash, randomBytes } from "node:crypto";
import { InviteRow, MemberRow, Profile, WorkspaceRepository, WorkspaceRole } from "../../repository/workspace_repository";

// Team workspaces. A workspace shares agents and a knowledge base between
// its members; chats and memory stay private to each person.
//
// Roles:
//   owner  — everything, incl. deleting the workspace and transferring it
//   admin  — rename, invite, remove members, edit or delete any agent/file
//   member — use the team's agents and files, create agents, upload files
//
// Limits are configurable: WORKSPACE_MAX_MEMBERS (default 50),
// WORKSPACE_MAX_OWNED (workspaces a user can own, default 10).

export class WorkspaceError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export type Membership = { id: string; role: WorkspaceRole };

const RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 };
export const atLeast = (role: WorkspaceRole, min: WorkspaceRole) => RANK[role] >= RANK[min];

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isWorkspaceId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

const MAX_MEMBERS = () => Math.max(2, Number(process.env.WORKSPACE_MAX_MEMBERS) || 50);
const MAX_OWNED = () => Math.max(1, Number(process.env.WORKSPACE_MAX_OWNED) || 10);
const MAX_ACTIVE_INVITES = 50;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX = 5000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const cleanName = (v: unknown): string => {
    const name = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    if (!name) throw new WorkspaceError("Give the workspace a name");
    if (name.length > 60) throw new WorkspaceError("Workspace names can be up to 60 characters");
    return name;
};

// What teammates see about each other: a name, the email, and only the last
// digits of the phone number.
export function profileFrom(token: { name?: string; email?: string; phone_number?: string } | undefined): Profile {
    const email = token?.email?.trim() || null;
    const phone = token?.phone_number?.replace(/\s+/g, "") || "";
    const phoneHint = phone.length >= 4 ? `•••• ${phone.slice(-4)}` : null;
    const displayName = token?.name?.trim() || (email ? email.split("@")[0] : "") || (phoneHint ? `Member ${phoneHint}` : "Member");
    return { displayName: displayName.slice(0, 80), email, phoneHint };
}

export const kbScopeFor = (workspaceId: string | null | undefined, userId: string) => (workspaceId ? `ws_${workspaceId}` : userId);

export class WorkspaceService {
    // user:workspace → role (or null), for the per-request membership check.
    private cache = new Map<string, { role: WorkspaceRole | null; at: number }>();

    constructor(private repo: WorkspaceRepository) {}

    // ── membership (used on every team request) ──
    async membership(userId: string, workspaceId: string): Promise<Membership | null> {
        if (!isWorkspaceId(workspaceId)) return null;
        const key = `${userId}:${workspaceId}`;
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.role ? { id: workspaceId, role: hit.role } : null;
        const role = await this.repo.role(workspaceId, userId);
        if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { role, at: Date.now() });
        return role ? { id: workspaceId, role } : null;
    }

    private forget(workspaceId: string, userId?: string) {
        if (userId) { this.cache.delete(`${userId}:${workspaceId}`); return; }
        for (const k of [...this.cache.keys()]) if (k.endsWith(`:${workspaceId}`)) this.cache.delete(k);
    }

    private async require(userId: string, workspaceId: string, min: WorkspaceRole = "member"): Promise<WorkspaceRole> {
        if (!isWorkspaceId(workspaceId)) throw new WorkspaceError("Workspace not found", 404);
        const role = await this.repo.role(workspaceId, userId);
        if (!role) throw new WorkspaceError("Workspace not found", 404);
        if (!atLeast(role, min)) throw new WorkspaceError(min === "owner" ? "Only the workspace owner can do that" : "Only workspace admins can do that", 403);
        return role;
    }

    // ── workspaces ──
    async list(userId: string, profile: Profile) {
        // Keeps the name/email teammates see in step with the login.
        await this.repo.refreshProfile(userId, profile).catch(() => undefined);
        const rows = await this.repo.listForUser(userId);
        return rows.map((w) => ({ id: w.id, name: w.name, role: w.role, memberCount: w.member_count, createdAt: w.created_at }));
    }

    async create(userId: string, profile: Profile, body: any) {
        const name = cleanName(body?.name);
        if ((await this.repo.countOwned(userId)) >= MAX_OWNED()) throw new WorkspaceError(`You can own up to ${MAX_OWNED()} workspaces`);
        const w = await this.repo.create(name, userId, profile);
        await this.repo.audit(w.id, userId, "workspace.created", null, { name });
        return { id: w.id, name: w.name, role: "owner" as const, memberCount: 1, createdAt: w.created_at };
    }

    async detail(userId: string, workspaceId: string) {
        const role = await this.require(userId, workspaceId);
        const [w, members, invites] = await Promise.all([
            this.repo.get(workspaceId),
            this.repo.members(workspaceId),
            atLeast(role, "admin") ? this.repo.listInvites(workspaceId) : Promise.resolve([]),
        ]);
        if (!w) throw new WorkspaceError("Workspace not found", 404);
        return {
            id: w.id, name: w.name, role, createdAt: w.created_at,
            maxMembers: MAX_MEMBERS(),
            members: members.map((m) => memberDto(m, atLeast(role, "admin"))),
            invites: invites.map(inviteDto),
        };
    }

    async rename(userId: string, workspaceId: string, body: any) {
        await this.require(userId, workspaceId, "admin");
        const name = cleanName(body?.name);
        const w = await this.repo.rename(workspaceId, name);
        if (!w) throw new WorkspaceError("Workspace not found", 404);
        await this.repo.audit(workspaceId, userId, "workspace.renamed", null, { name });
        return { id: w.id, name: w.name };
    }

    // Deletes the workspace with its agents (the database cascades). The
    // caller cleans up the team's files (see onDeleted).
    async delete(userId: string, workspaceId: string, confirmName: unknown, onDeleted?: (workspaceId: string) => Promise<void>) {
        await this.require(userId, workspaceId, "owner");
        const w = await this.repo.get(workspaceId);
        if (!w) throw new WorkspaceError("Workspace not found", 404);
        if (typeof confirmName !== "string" || confirmName.trim() !== w.name) throw new WorkspaceError("Type the workspace name to confirm");
        await this.repo.delete(workspaceId);
        this.forget(workspaceId);
        if (onDeleted) await onDeleted(workspaceId).catch((err) => console.error(`[workspaces] cleanup of ${workspaceId} failed:`, err));
    }

    // ── members ──
    async setRole(actor: string, workspaceId: string, target: string, body: any) {
        await this.require(actor, workspaceId, "owner");
        const role = body?.role;
        if (role !== "admin" && role !== "member") throw new WorkspaceError("Role must be admin or member");
        if (target === actor) throw new WorkspaceError("You're the owner — transfer ownership to change your own role");
        if (!(await this.repo.setRole(workspaceId, target, role))) throw new WorkspaceError("Member not found", 404);
        this.forget(workspaceId, target);
        await this.repo.audit(workspaceId, actor, "member.role_changed", target, { role });
    }

    async removeMember(actor: string, workspaceId: string, target: string) {
        const actorRole = await this.require(actor, workspaceId);
        if (target === actor) {
            if (actorRole === "owner") throw new WorkspaceError("Transfer ownership to someone else before leaving");
            await this.repo.removeMember(workspaceId, actor);
            this.forget(workspaceId, actor);
            await this.repo.audit(workspaceId, actor, "member.left", actor);
            return;
        }
        if (!atLeast(actorRole, "admin")) throw new WorkspaceError("Only workspace admins can remove people", 403);
        const targetRole = await this.repo.role(workspaceId, target);
        if (!targetRole) throw new WorkspaceError("Member not found", 404);
        if (targetRole === "owner") throw new WorkspaceError("The owner can't be removed");
        if (targetRole === "admin" && actorRole !== "owner") throw new WorkspaceError("Only the owner can remove an admin", 403);
        await this.repo.removeMember(workspaceId, target);
        this.forget(workspaceId, target);
        await this.repo.audit(workspaceId, actor, "member.removed", target);
    }

    async transfer(actor: string, workspaceId: string, body: any) {
        await this.require(actor, workspaceId, "owner");
        const to = typeof body?.userId === "string" ? body.userId : "";
        if (!to || to === actor) throw new WorkspaceError("Pick another member to make the owner");
        if (!(await this.repo.transferOwnership(workspaceId, actor, to))) throw new WorkspaceError("Member not found", 404);
        this.forget(workspaceId, actor); this.forget(workspaceId, to);
        await this.repo.audit(workspaceId, actor, "ownership.transferred", to);
    }

    // ── invites ──
    // The token is shown once; only its SHA-256 is stored.
    async createInvite(actor: string, workspaceId: string, body: any) {
        const actorRole = await this.require(actor, workspaceId, "admin");
        const role = body?.role === "admin" ? "admin" : "member";
        if (role === "admin" && actorRole !== "owner") throw new WorkspaceError("Only the owner can invite admins", 403);
        const maxUses = Math.trunc(Number(body?.maxUses ?? 1));
        if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 100) throw new WorkspaceError("Uses must be between 1 and 100");
        const days = Math.trunc(Number(body?.expiresInDays ?? 7));
        if (!Number.isFinite(days) || days < 1 || days > 30) throw new WorkspaceError("Links can last 1 to 30 days");
        if ((await this.repo.activeInviteCount(workspaceId)) >= MAX_ACTIVE_INVITES) throw new WorkspaceError("Too many open invite links — revoke some first");
        if ((await this.repo.memberCount(workspaceId)) >= MAX_MEMBERS()) throw new WorkspaceError(`This workspace is full (${MAX_MEMBERS()} members)`);
        const token = randomBytes(24).toString("base64url");
        const invite = await this.repo.createInvite({ workspaceId, tokenHash: hashToken(token), role, createdBy: actor, maxUses, expiresAt: new Date(Date.now() + days * 86_400_000) });
        await this.repo.audit(workspaceId, actor, "invite.created", invite.id, { role, maxUses, days });
        return { ...inviteDto(invite), token };
    }

    async revokeInvite(actor: string, workspaceId: string, inviteId: string) {
        await this.require(actor, workspaceId, "admin");
        if (!(await this.repo.revokeInvite(workspaceId, inviteId))) throw new WorkspaceError("Invite not found", 404);
        await this.repo.audit(workspaceId, actor, "invite.revoked", inviteId);
    }

    // What the join page shows before accepting.
    async previewInvite(userId: string, token: unknown) {
        const invite = typeof token === "string" && token.length >= 20 && token.length <= 64 ? await this.repo.inviteByHash(hashToken(token)) : null;
        if (!invite) throw new WorkspaceError("This invite link isn't valid", 404);
        const usable = !invite.revoked_at && invite.expires_at > new Date() && invite.uses < invite.max_uses;
        const role = await this.repo.role(invite.workspace_id, userId);
        return { workspaceId: invite.workspace_id, workspaceName: invite.workspace_name, role: invite.role, usable, alreadyMember: !!role, expiresAt: invite.expires_at };
    }

    async acceptInvite(userId: string, profile: Profile, token: unknown) {
        if (typeof token !== "string" || token.length < 20 || token.length > 64) throw new WorkspaceError("This invite link isn't valid", 404);
        const r = await this.repo.acceptInvite(hashToken(token), userId, profile, MAX_MEMBERS());
        if (!r.ok) throw new WorkspaceError(r.reason === "full" ? "This workspace is full" : "This invite link has expired or was already used", r.reason === "full" ? 409 : 410);
        this.forget(r.workspaceId, userId);
        if (!r.already) await this.repo.audit(r.workspaceId, userId, "member.joined", userId, { role: r.role });
        return { workspaceId: r.workspaceId, role: r.role, already: r.already };
    }

    // ── audit ──
    async auditLog(userId: string, workspaceId: string, beforeId?: unknown) {
        await this.require(userId, workspaceId, "admin");
        const before = Number(beforeId);
        const rows = await this.repo.auditLog(workspaceId, 50, Number.isInteger(before) && before > 0 ? before : undefined);
        const names = new Map((await this.repo.members(workspaceId)).map((m) => [m.user_id, m.display_name]));
        return rows.map((r) => ({
            id: r.id, action: r.action, details: r.details, createdAt: r.created_at,
            actor: names.get(r.actor_id) ?? "Former member",
            target: r.target ? names.get(r.target) ?? r.target : null,
        }));
    }

    // Recorded by other features (e.g. agents created/deleted in a workspace).
    async record(workspaceId: string, actor: string, action: string, target: string | null, details: Record<string, unknown> = {}) {
        await this.repo.audit(workspaceId, actor, action, target, details).catch((err) => console.error("[workspaces] audit write failed:", err));
    }
}

function memberDto(m: MemberRow, showContact: boolean) {
    return {
        userId: m.user_id, role: m.role, name: m.display_name,
        // Contact details for admins only; members see names.
        email: showContact ? m.email : null,
        phoneHint: showContact ? m.phone_hint : null,
        joinedAt: m.joined_at,
    };
}

function inviteDto(i: InviteRow) {
    return { id: i.id, role: i.role, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at, createdAt: i.created_at };
}

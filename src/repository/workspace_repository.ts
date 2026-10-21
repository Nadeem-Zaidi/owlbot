import { randomUUID } from "node:crypto";
import { IDatabaseAdapter } from "../database/idatabaseadapter";

// SQL for team workspaces: the workspace, its members (owner / admin /
// member), invite links (only a hash of each token is stored) and an audit
// log. Permission rules live in WorkspaceService; this file only stores.

export type WorkspaceRole = "owner" | "admin" | "member";

export type WorkspaceRow = { id: string; name: string; created_by: string; created_at: Date; updated_at: Date };
export type MemberRow = {
    workspace_id: string; user_id: string; role: WorkspaceRole; display_name: string;
    email: string | null; phone_hint: string | null; invited_by: string | null; joined_at: Date;
};
export type InviteRow = {
    id: string; workspace_id: string; token_hash: string; role: Exclude<WorkspaceRole, "owner">; created_by: string;
    max_uses: number; uses: number; expires_at: Date; revoked_at: Date | null; created_at: Date;
};
export type AuditRow = { id: number; workspace_id: string; actor_id: string; action: string; target: string | null; details: Record<string, unknown>; created_at: Date };
export type Profile = { displayName: string; email: string | null; phoneHint: string | null };

export class WorkspaceRepository {
    constructor(private db: IDatabaseAdapter) {}

    // ── workspaces ──
    async listForUser(userId: string): Promise<(WorkspaceRow & { role: WorkspaceRole; member_count: number })[]> {
        const { rows } = await this.db.query(
            `SELECT w.*, m.role, (SELECT count(*)::int FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count
             FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = $1 ORDER BY w.name`, [userId]);
        return rows;
    }

    async get(id: string): Promise<WorkspaceRow | null> {
        const { rows } = await this.db.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1`, [id]);
        return rows[0] ?? null;
    }

    async countOwned(userId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1 AND role = 'owner'`, [userId]);
        return rows[0]?.n ?? 0;
    }

    async create(name: string, owner: string, profile: Profile): Promise<WorkspaceRow> {
        return this.db.withTransaction(async () => {
            const id = randomUUID();
            const { rows } = await this.db.query<WorkspaceRow>(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3) RETURNING *`, [id, name, owner]);
            await this.db.query(
                `INSERT INTO workspace_members (workspace_id, user_id, role, display_name, email, phone_hint) VALUES ($1, $2, 'owner', $3, $4, $5)`,
                [id, owner, profile.displayName, profile.email, profile.phoneHint]);
            return rows[0];
        });
    }

    async rename(id: string, name: string): Promise<WorkspaceRow | null> {
        const { rows } = await this.db.query<WorkspaceRow>(`UPDATE workspaces SET name = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, name]);
        return rows[0] ?? null;
    }

    async delete(id: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
        return r.rowCount > 0;
    }

    // ── members ──
    async role(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
        const { rows } = await this.db.query<{ role: WorkspaceRole }>(
            `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
        return rows[0]?.role ?? null;
    }

    async members(workspaceId: string): Promise<MemberRow[]> {
        const { rows } = await this.db.query<MemberRow>(
            `SELECT * FROM workspace_members WHERE workspace_id = $1
             ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, display_name, joined_at`, [workspaceId]);
        return rows;
    }

    async memberCount(workspaceId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
        return rows[0]?.n ?? 0;
    }

    // Keeps the name/email shown to teammates current (they come from the login token).
    async refreshProfile(userId: string, p: Profile): Promise<void> {
        await this.db.query(
            `UPDATE workspace_members SET display_name = $2, email = $3, phone_hint = $4
             WHERE user_id = $1 AND (display_name IS DISTINCT FROM $2 OR email IS DISTINCT FROM $3 OR phone_hint IS DISTINCT FROM $4)`,
            [userId, p.displayName, p.email, p.phoneHint]);
    }

    async setRole(workspaceId: string, userId: string, role: Exclude<WorkspaceRole, "owner">): Promise<boolean> {
        const r = await this.db.query(
            `UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'`, [workspaceId, userId, role]);
        return r.rowCount > 0;
    }

    async removeMember(workspaceId: string, userId: string): Promise<boolean> {
        const r = await this.db.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'`, [workspaceId, userId]);
        return r.rowCount > 0;
    }

    // Owner → admin, new owner → owner, in one transaction (the unique index
    // allows only one owner, so the old one steps down first).
    async transferOwnership(workspaceId: string, from: string, to: string): Promise<boolean> {
        return this.db.withTransaction(async () => {
            const target = await this.db.query(`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, to]);
            if (!target.rowCount) return false;
            const down = await this.db.query(`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`, [workspaceId, from]);
            if (!down.rowCount) return false;
            await this.db.query(`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, to]);
            return true;
        });
    }

    // ── invites ──
    async createInvite(i: { workspaceId: string; tokenHash: string; role: Exclude<WorkspaceRole, "owner">; createdBy: string; maxUses: number; expiresAt: Date }): Promise<InviteRow> {
        const { rows } = await this.db.query<InviteRow>(
            `INSERT INTO workspace_invites (id, workspace_id, token_hash, role, created_by, max_uses, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [randomUUID(), i.workspaceId, i.tokenHash, i.role, i.createdBy, i.maxUses, i.expiresAt]);
        return rows[0];
    }

    async listInvites(workspaceId: string): Promise<InviteRow[]> {
        const { rows } = await this.db.query<InviteRow>(
            `SELECT * FROM workspace_invites WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses
             ORDER BY created_at DESC`, [workspaceId]);
        return rows;
    }

    async activeInviteCount(workspaceId: string): Promise<number> {
        const { rows } = await this.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM workspace_invites WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses`, [workspaceId]);
        return rows[0]?.n ?? 0;
    }

    async inviteByHash(tokenHash: string): Promise<(InviteRow & { workspace_name: string }) | null> {
        const { rows } = await this.db.query(
            `SELECT i.*, w.name AS workspace_name FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = $1`, [tokenHash]);
        return rows[0] ?? null;
    }

    async revokeInvite(workspaceId: string, id: string): Promise<boolean> {
        const r = await this.db.query(
            `UPDATE workspace_invites SET revoked_at = now() WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`, [workspaceId, id]);
        return r.rowCount > 0;
    }

    // Joins with an invite, atomically: the workspace row is locked so two
    // people can't both take the last seat or the last use of a link.
    async acceptInvite(tokenHash: string, userId: string, profile: Profile, maxMembers: number):
        Promise<{ ok: true; workspaceId: string; role: WorkspaceRole; already: boolean } | { ok: false; reason: "invalid" | "full" }> {
        return this.db.withTransaction(async () => {
            const { rows } = await this.db.query<InviteRow>(
                `SELECT * FROM workspace_invites WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses`, [tokenHash]);
            const invite = rows[0];
            if (!invite) return { ok: false, reason: "invalid" };
            await this.db.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [invite.workspace_id]);
            const existing = await this.db.query<{ role: WorkspaceRole }>(
                `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [invite.workspace_id, userId]);
            if (existing.rows[0]) return { ok: true, workspaceId: invite.workspace_id, role: existing.rows[0].role, already: true };
            const count = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1`, [invite.workspace_id]);
            if ((count.rows[0]?.n ?? 0) >= maxMembers) return { ok: false, reason: "full" };
            const used = await this.db.query(
                `UPDATE workspace_invites SET uses = uses + 1 WHERE id = $1 AND uses < max_uses AND revoked_at IS NULL AND expires_at > now()`, [invite.id]);
            if (!used.rowCount) return { ok: false, reason: "invalid" };
            await this.db.query(
                `INSERT INTO workspace_members (workspace_id, user_id, role, display_name, email, phone_hint, invited_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [invite.workspace_id, userId, invite.role, profile.displayName, profile.email, profile.phoneHint, invite.created_by]);
            return { ok: true, workspaceId: invite.workspace_id, role: invite.role, already: false };
        });
    }

    // ── audit ──
    async audit(workspaceId: string, actorId: string, action: string, target: string | null = null, details: Record<string, unknown> = {}): Promise<void> {
        await this.db.query(
            `INSERT INTO workspace_audit (workspace_id, actor_id, action, target, details) VALUES ($1, $2, $3, $4, $5)`,
            [workspaceId, actorId, action, target, JSON.stringify(details)]);
    }

    async auditLog(workspaceId: string, limit: number, beforeId?: number): Promise<AuditRow[]> {
        const { rows } = await this.db.query<AuditRow>(
            `SELECT * FROM workspace_audit WHERE workspace_id = $1 ${beforeId ? "AND id < $3" : ""} ORDER BY id DESC LIMIT $2`,
            beforeId ? [workspaceId, limit, beforeId] : [workspaceId, limit]);
        return rows;
    }
}

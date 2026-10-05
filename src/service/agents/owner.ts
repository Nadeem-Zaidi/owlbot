// Code functions run arbitrary Python on the server, so only the app owner
// may write, edit or test them: OWNER_EMAILS=you@example.com in .env.
// While it's empty the feature is off entirely (existing code functions
// aren't offered to the model either).

export function ownerEmails(): string[] {
    return (process.env.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export const codeFunctionsEnabled = () => ownerEmails().length > 0;

export function isOwner(email?: string | null): boolean {
    return !!email && ownerEmails().includes(email.toLowerCase());
}

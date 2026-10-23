import { NextFunction, Request, Response, Router } from "express";
import { LocalCommandBroker, LocalCommandError } from "../core/local_commands/local_command_broker";

// Mounted at /api/local-commands behind Firebase auth. The Owl Bot desktop
// app posts the outcome of a command the user approved (or denied) here.
export function createLocalCommandRouter(broker: LocalCommandBroker): Router {
    const r = Router();
    r.post("/:requestId", (req: Request, res: Response, _next: NextFunction) => {
        broker.answer(req.user!.sub, String(req.params.requestId), req.body)
            .then((out) => res.json(out))
            .catch((err: unknown) => {
                const status = err instanceof LocalCommandError ? err.status : 500;
                if (status >= 500) console.error("[local-commands] answer failed:", err);
                res.status(status).json({ message: err instanceof Error && status < 500 ? err.message : "Something went wrong. Please try again." });
            });
    });
    return r;
}

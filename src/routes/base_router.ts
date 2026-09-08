import { SessionRepository } from "../repository/sessiopn_repository";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { Application, NextFunction, Request, RequestHandler, Response, Router } from "express";

export abstract class BaseRouter<T> {
    protected router:Router;
    constructor(public readonly prefix:string,protected service:T) {
        this.router=Router()
        this.registerRouter()
        this.getRouter = this.getRouter.bind(this); // ← defensive fix
    }

    public getRouter(){
        return this.router;
    }

    abstract registerRouter(): void;
    protected asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void | Response>) {
        return (req: Request, res: Response, next: NextFunction) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        }
    }
}






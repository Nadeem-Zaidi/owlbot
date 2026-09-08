

export class AppError extends Error{
    constructor(public message:string,public statusCode:number){
        super(message);
        this.name="AppError"
        
    }
}

export class NotFoundError extends AppError {
  constructor(message = "request not found") {
    super(message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message = "invalid request") {
    super(message, 400);
  }
}

export class SessionValidationError extends AppError{
  constructor(message="invalid sessionid"){
    super(message,400)
  }
}

export class InvalidSession extends AppError{
  constructor(message="invalid sessionid"){
    super(message,400)
  }
}

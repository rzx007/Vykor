import { ApplicationError } from "../../shared/application-error.js";

export class SessionApplicationError extends ApplicationError {
  constructor(
    status: 400 | 404 | 409 | 500,
    message: string,
  ) {
    super(status, message);
    this.name = "SessionApplicationError";
  }
}

/** Raised before prompt admission when a session cannot expose Computer. */
export class ComputerSessionUnavailableError extends SessionApplicationError {
  constructor(message = "Computer Use requires an authorized Desktop root session in execution mode") {
    super(409, message);
  }
}

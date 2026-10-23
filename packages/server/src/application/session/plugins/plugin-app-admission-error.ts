import type { PluginAppAdmissionRejection } from "./plugin-app-query-models.js";
import { ApplicationError } from "../../../shared/application-error.js";

/** Emitted only inside the original serialized admission after verifying no durable record exists. */
export class PluginAppAdmissionError extends ApplicationError {
  constructor(readonly rejection: PluginAppAdmissionRejection) {
    super(409, "应用请求未接纳，请检查当前状态后重新确认");
  }
}

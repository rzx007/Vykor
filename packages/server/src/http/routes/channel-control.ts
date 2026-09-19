import {
  parseChannelRuntimeControlInput,
  parseFeishuAllowInput,
  parseFeishuConnectInput,
  parseFeishuPatchInput,
  parseFeishuRegistrationStartInput,
  ProtocolValidationError,
} from "@openharness/protocol";
import { Hono } from "hono";

import type { ChannelRuntimeService } from "../../daemon/channel-runtime-service.js";
import { ChannelRuntimeError } from "../../daemon/channel-runtime-service.js";
import {
  ChannelOnboardingError,
  type ChannelOnboardingService,
} from "../../application/channel/channel-onboarding-service.js";
import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
} from "../support.js";

export interface ChannelControlRoutesContext {
  runtime?: ChannelRuntimeService;
  onboarding?: ChannelOnboardingService;
  /** 未配置 bearer token 的 daemon 拒绝渠道写路由（涉及密钥与 ACL）。 */
  tokenConfigured: boolean;
}

function isValidationMessage(message: string): boolean {
  return (
    message.includes(" must be ") ||
    message.includes(" is required") ||
    message.includes("unknown field") ||
    message.includes("at least one")
  );
}

function controlError(
  error: unknown,
  options: { unknownConnectorStatus?: number } = {},
): Response {
  if (error instanceof ChannelRuntimeError) {
    const status =
      error.code === "unknown_connector"
        ? (options.unknownConnectorStatus ?? 404)
        : error.code === "closed"
          ? 503
          : 409;
    return errorResponse(status, error.message);
  }
  if (error instanceof ChannelOnboardingError) {
    const status = error.code === "not_configured" ? 409 : 400;
    return errorResponse(status, error.message);
  }
  if (error instanceof ProtocolValidationError || error instanceof SyntaxError) {
    return protocolValidationErrorResponse(error);
  }
  if (error instanceof Error && error.name === "ChannelConfigStoreError") {
    return errorResponse(400, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isValidationMessage(message)) return protocolValidationErrorResponse(error);
  return applicationErrorResponse(error);
}

export function createChannelControlRoutes(
  context: ChannelControlRoutesContext,
): Hono {
  const requireRuntime = (): Response | undefined =>
    context.runtime ? undefined : errorResponse(503, "Channel runtime is unavailable");
  const requireOnboarding = (): Response | undefined =>
    context.onboarding
      ? undefined
      : errorResponse(503, "Channel onboarding is unavailable");
  const requireWritable = (): Response | undefined =>
    context.tokenConfigured
      ? undefined
      : errorResponse(503, "Channel write API requires a daemon token");

  return new Hono()
    .get("/runtime/status", () => {
      const missing = requireRuntime();
      return missing ?? jsonResponse(context.runtime!.status());
    })
    .post("/runtime/start", async (c) => {
      const missing = requireRuntime() ?? requireWritable();
      if (missing) return missing;
      try {
        await context.runtime!.start(parseChannelRuntimeControlInput(await readJson(c)).connector);
        return jsonResponse(context.runtime!.status());
      } catch (error) {
        // 启动时未知 connector 视为可操作冲突（409），停止才是 404。
        return controlError(error, { unknownConnectorStatus: 409 });
      }
    })
    .post("/runtime/stop", async (c) => {
      const missing = requireRuntime() ?? requireWritable();
      if (missing) return missing;
      try {
        await context.runtime!.stop(parseChannelRuntimeControlInput(await readJson(c)).connector);
        return jsonResponse(context.runtime!.status());
      } catch (error) {
        return controlError(error);
      }
    })
    .get("/feishu", async () => {
      const missing = requireOnboarding();
      return missing ?? jsonResponse(await context.onboarding!.snapshot());
    })
    .patch("/feishu", async (c) => {
      const missing = requireOnboarding() ?? requireRuntime() ?? requireWritable();
      if (missing) return missing;
      try {
        const feishu = await context.onboarding!.patch(
          parseFeishuPatchInput(await readJson(c)),
        );
        return jsonResponse({ feishu, runtime: context.runtime!.status() });
      } catch (error) {
        return controlError(error);
      }
    })
    .post("/feishu/connect", async (c) => {
      const missing = requireOnboarding() ?? requireRuntime() ?? requireWritable();
      if (missing) return missing;
      try {
        const feishu = await context.onboarding!.connectManual(
          parseFeishuConnectInput(await readJson(c)),
        );
        return jsonResponse({ feishu, runtime: context.runtime!.status() });
      } catch (error) {
        return controlError(error);
      }
    })
    .delete("/feishu", async () => {
      const missing = requireOnboarding() ?? requireRuntime() ?? requireWritable();
      if (missing) return missing;
      try {
        const feishu = await context.onboarding!.remove();
        return jsonResponse({ feishu, runtime: context.runtime!.status() });
      } catch (error) {
        return controlError(error);
      }
    })
    .post("/feishu/allow", async (c) => {
      const missing = requireOnboarding() ?? requireWritable();
      if (missing) return missing;
      try {
        return jsonResponse(
          await context.onboarding!.allowAdd(parseFeishuAllowInput(await readJson(c))),
        );
      } catch (error) {
        return controlError(error);
      }
    })
    .delete("/feishu/allow/:key", async (c) => {
      const missing = requireOnboarding() ?? requireWritable();
      if (missing) return missing;
      try {
        return jsonResponse(await context.onboarding!.allowRemove(c.req.param("key")));
      } catch (error) {
        return controlError(error);
      }
    })
    .post("/feishu/registration", async (c) => {
      const missing = requireOnboarding() ?? requireWritable();
      if (missing) return missing;
      try {
        return jsonResponse(
          await context.onboarding!.startRegistration(
            parseFeishuRegistrationStartInput(await readJson(c)),
          ),
        );
      } catch (error) {
        return controlError(error);
      }
    })
    .get("/feishu/registration", () => {
      const missing = requireOnboarding();
      return missing ?? jsonResponse(context.onboarding!.registrationStatus());
    })
    .delete("/feishu/registration", () => {
      const missing = requireOnboarding() ?? requireWritable();
      return missing ?? jsonResponse(context.onboarding!.cancelRegistration());
    });
}

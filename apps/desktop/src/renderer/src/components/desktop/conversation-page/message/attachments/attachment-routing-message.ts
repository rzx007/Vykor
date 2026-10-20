export function attachmentRoutingMessage(code: string): string {
  switch (code) {
    case "attachment_model_capability_unknown":
      return "当前模型没有声明图片能力，请切换支持图片的模型后重试。"
    case "attachment_model_unsupported":
      return "当前模型不支持图片，请切换支持图片的模型后重试。"
    case "attachment_provider_capability_unknown":
      return "当前提供商没有声明图片能力，请检查模型配置后重试。"
    case "attachment_provider_unsupported":
      return "当前提供商不支持图片输入，请切换提供商后重试。"
    case "attachment_intent_unavailable":
      return "当前阶段还不能执行 OCR 或文档处理，请移除附件处理方式后重试。"
    case "attachment_kind_unsupported":
      return "当前阶段只支持把图片直接发送给模型。"
    case "attachment_media_type_unsupported":
      return "当前图片格式不受支持，请改用 PNG、JPEG、GIF 或 WebP。"
    case "attachment_ocr_tool_unavailable":
      return "本地 OCR 工具被当前 Agent 配置禁用，请允许 ImageToText 后重试。"
    case "attachment_ocr_host_unavailable":
      return "本地 OCR 服务暂不可用，请重启应用后重试。"
    case "attachment_materialization_failed":
      return "附件内容不可用，请重新上传后重试。"
    case "attachment_routing_aborted":
      return "附件处理已取消。"
    default:
      return "附件处理失败，请检查附件和模型设置后重试。"
  }
}

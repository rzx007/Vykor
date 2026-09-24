import { loadOutputStyles } from "@vykor/output-styles";

import type { OutputStyleService } from "../settings-api.js";

export function createDefaultOutputStyleService(): OutputStyleService {
  return {
    list() {
      return loadOutputStyles().map((style) => ({
        name: style.name,
        content: style.content,
        source: style.source,
      }));
    },
  };
}

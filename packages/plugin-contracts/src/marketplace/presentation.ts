/** Author-provided presentation, separate from live installation and authorization state. */
export interface PluginPresentation {
  icon?: string;
  description?: string;
  introduction?: string;
  prompts?: Array<{ title: string; prompt: string }>;
  author?: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

export function isPluginWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isPluginIconSource(value: string): boolean {
  if (value.length > 1_048_576) return false;
  if (isPluginWebUrl(value)) return true;
  if (!/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,/.test(value)) return false;
  const encoded = value.slice(value.indexOf(",") + 1);
  return encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded);
}

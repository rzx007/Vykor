import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename } from "node:path";

const MAX_REMOTE_BYTES = 40 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface ImportedImageSource {
  displayName: string;
  declaredMediaType?: string;
  content: ReadableStream<Uint8Array>;
}

export async function downloadRemoteImage(
  initialUrl: URL,
  signal?: AbortSignal,
): Promise<ImportedImageSource> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    signal?.throwIfAborted();
    if (url.username || url.password) throw new Error("image_url 不允许包含登录凭据");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("image_url 只允许 HTTP(S) 地址");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await lookup(hostname, { all: true, verbatim: true });
    const publicAddress = addresses.find((item) => isPublicAddress(item.address));
    if (!publicAddress || addresses.some((item) => !isPublicAddress(item.address))) {
      throw new Error("image_url 不能访问本机或内网地址");
    }
    const response = await get(url, publicAddress, signal);
    if (response.redirect) {
      if (redirects === MAX_REDIRECTS) throw new Error("image_url 重定向次数过多");
      url = new URL(response.redirect, url);
      continue;
    }
    const mediaType = response.mediaType.split(";", 1)[0]!.trim().toLowerCase();
    if (!mediaType.startsWith("image/")) throw new Error("image_url 返回的不是图片");
    return {
      displayName: basename(decodeURIComponent(url.pathname)) || "remote-image",
      declaredMediaType: mediaType,
      content: streamOf(response.bytes),
    };
  }
  throw new Error("image_url 重定向次数过多");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      a! >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%", 1)[0]!;
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
    if (/^fe[89ab]/.test(normalized)) return false;
    if (/^fe[c-f]/.test(normalized) || normalized.startsWith("ff")) return false;
    const mapped = mappedIpv4(normalized);
    return mapped ? isPublicAddress(mapped) : true;
  }
  return false;
}

function mappedIpv4(address: string): string | undefined {
  const dotted = address.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hexadecimal = address.match(/^::(?:ffff:)?([\da-f]{1,4}):([\da-f]{1,4})$/);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

async function get(
  url: URL,
  target: { address: string; family: number },
  signal?: AbortSignal,
): Promise<{ redirect?: string; mediaType: string; bytes: Uint8Array }> {
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: { accept: "image/*", "user-agent": "OpenHarness-ImageToText/1" },
      lookup: (_hostname, _options, callback) => callback(
        null,
        target.address,
        target.family as 4 | 6,
      ),
      signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: response.headers.location, mediaType: "", bytes: new Uint8Array() });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`image_url 请求失败（HTTP ${status}）`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > MAX_REMOTE_BYTES) {
        response.destroy();
        reject(new Error("image_url 图片超过 40 MiB 限制"));
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_REMOTE_BYTES) {
          response.destroy(new Error("image_url 图片超过 40 MiB 限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({
        mediaType: String(response.headers["content-type"] ?? ""),
        bytes: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

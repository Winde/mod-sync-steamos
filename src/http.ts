import http from "node:http";
import path from "node:path";

/**
 * HTTP helpers shared by the pack server, the PC console, and the TV agent.
 *
 * Files, content types, and JSON request bodies follow the same rules on every
 * listener; only their body size limits differ.
 */

export function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    case ".json": return "application/json";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".desktop": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

/** Read a JSON object body, rejecting arrays, non-objects, and oversized input. */
export function readJsonBody<T extends Record<string, unknown> = Record<string, unknown>>(
  req: http.IncomingMessage,
  limit = 1_000_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      data += chunk;
      if (data.length > limit) {
        failed = true;
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (failed) return;
      if (!data) return resolve({} as T);
      try {
        const parsed = JSON.parse(data) as unknown;
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

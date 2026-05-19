const TRACKING_PARAMS = new Set(["gclid", "fbclid"]);

export type NormalizedUrl = {
  url: string;
  urlHash: string;
  domain: string;
};

export async function normalizeUrl(rawUrl: string): Promise<NormalizedUrl> {
  const parsed = new URL(rawUrl);
  parsed.hash = "";

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
    }
  }

  parsed.searchParams.sort();

  const normalized = parsed.toString();

  return {
    url: normalized,
    urlHash: await sha256Hex(normalized),
    domain: parsed.hostname,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

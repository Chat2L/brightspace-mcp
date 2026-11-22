// Small readers for JSON from Brightspace, which is untyped until checked.

export type Obj = Record<string, unknown>;

export function obj(value: unknown): Obj | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from Brightspace HTML: tags dropped, common entities decoded. */
export function plain(value: unknown): string | null {
  const html = str(value);
  if (!html) return null;
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (!code.startsWith("#")) return ENTITIES[code.toLowerCase()] ?? entity;
      const point = /^#x/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    });
}

/** Text on one line, cut to `max` characters. */
export function clip(value: unknown, max: number): string | null {
  const text = str(value)?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = items.map((item, index) => ({ item, index }));
  const results = new Array<R>(items.length);
  const lane = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      results[job.index] = await fn(job.item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, lane));
  return results;
}

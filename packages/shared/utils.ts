import crypto from 'node:crypto';

export const now = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
export const normalizeText = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isUuid(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ''));
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectLanguage(text: string): string | null {
  if (!text.trim()) return null;
  const jaChars = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;
  return jaChars / text.length > 0.05 ? 'ja' : 'en';
}

export function relativeWindowStart(relative: string, reference: Date = new Date()): string | null {
  const days = { recent_7d: 7, recent_30d: 30, recent_90d: 90 }[relative as 'recent_7d' | 'recent_30d' | 'recent_90d'];
  if (!days) return null;
  return new Date(reference.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// PostgreSQL array literal (works as an unknown-typed parameter on pg and PGlite alike).
export function pgArrayLiteral(values: readonly unknown[]): string {
  const encoded = values.map((value) => {
    if (value == null) return 'NULL';
    const text = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${text}"`;
  });
  return `{${encoded.join(',')}}`;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

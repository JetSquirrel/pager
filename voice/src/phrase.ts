// What the board says when a page arrives: severity, number, service and title, short enough to hear between two
// cycles of the siren. The title is the alert's own words; it goes to the speech provider and nowhere else.

export type Lang = "zh" | "en";
export type Severity = "critical" | "error" | "warning" | "info";

export interface Page {
  severity: Severity;
  number: number;
  title: string;
  service: string;
  /** Unacknowledged incidents paging the board's user, this one included. */
  count: number;
}

const SEVERITY: Record<Lang, Record<Severity, string>> = {
  zh: { critical: "严重告警", error: "错误告警", warning: "警告", info: "通知" },
  en: { critical: "Critical page", error: "Error page", warning: "Warning", info: "Notice" },
};

/** About eight seconds of speech at most: longer titles are cut at a word. */
export const TITLE_MAX = 48;

export function clip(text: string, max = TITLE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if ([...t].length <= max) return t;
  const cut = [...t].slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,，.。:：;；-]+$/, "");
}

export function announcement(p: Page, lang: Lang): string {
  const title = clip(p.title);
  const service = clip(p.service, 24);
  if (lang === "en") {
    const others = p.count > 1 ? ` ${p.count - 1} more waiting.` : "";
    return `${SEVERITY.en[p.severity]}. Incident ${p.number}${service ? `, ${service}` : ""}: ${title}.${others}`;
  }
  const others = p.count > 1 ? `另有${p.count - 1}个待处理。` : "";
  return `${SEVERITY.zh[p.severity]}。${p.number}号事件${service ? `，${service}` : ""}：${title}。${others}`;
}

/** Checks a page from the board; returns the reason it is unusable, or null. */
export function invalidPage(b: unknown): string | null {
  const p = b as Partial<Page> | null;
  if (!p || typeof p !== "object") return "body must be a JSON object";
  if (!p.severity || !(p.severity in SEVERITY.en)) return "severity must be critical, error, warning or info";
  if (!Number.isInteger(p.number) || (p.number as number) < 0) return "number must be a whole number";
  if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 500) return "title must be 1 to 500 characters";
  if (p.service !== undefined && (typeof p.service !== "string" || p.service.length > 200)) return "service must be a string";
  if (p.count !== undefined && (!Number.isInteger(p.count) || (p.count as number) < 0)) return "count must be a whole number";
  return null;
}

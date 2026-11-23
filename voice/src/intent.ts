// What a spoken command asks the pager to do. Words are matched, not guessed: a pager must not act on a sentence it
// only half understood, so anything unclear is "none" and the board asks again.

export type Intent =
  | { intent: "ack" }
  | { intent: "snooze"; minutes: number }
  | { intent: "resolve" }
  | { intent: "repeat" }
  | { intent: "none" };

export const SNOOZE_DEFAULT = 30;
const SNOOZE_MAX = 240; // the pager's own limit (POST /v1/device/snooze)

const ACK = [/确认/, /收到/, /知道了/, /我来/, /我看/, /认领/, /接了/, /\back(nowledge[ds]?)?\b/, /\bgot it\b/, /\bon it\b/, /\bmine\b/];
const SNOOZE = [/稍后/, /等会/, /等一会/, /一会儿?再/, /延后/, /推迟/, /贪睡/, /晚点/, /过\S{0,4}再/, /后再/, /\bsnooze\b/, /\blater\b/, /\bin \S+ minutes?\b/];
// Not 关闭 or "close": "关闭警报" means "silence it", not "it is fixed".
const RESOLVE = [/已?解决/, /修好/, /搞定/, /\bresolved?\b/, /\bfixed\b/];
const REPEAT = [/再说一[遍次]/, /重复/, /什么/, /没听清/, /\brepeat\b/, /\bagain\b/, /\bwhat\b/, /\bsay that\b/];

// "没解决", "还没修好", "not fixed", "isn't resolved": the opposite of resolving.
const NOT_RESOLVED = /(没|未|不|没有|还没)(有)?(解决|修好|搞定)|\bnot (yet )?(resolved|fixed)\b|n't (been |yet )?(resolved|fixed)\b|\bdon't resolve\b/;
const NOT_ACK = /(不|别)(确认|认领)|\bdon't ack/;

const any = (res: RegExp[], s: string) => res.some((r) => r.test(s));

/** Reads the command in a transcript (Chinese or English). */
export function parseIntent(transcript: string): Intent {
  const s = transcript.toLowerCase().replace(/[，。！？、,.!?]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return { intent: "none" };

  const resolve = any(RESOLVE, s) && !NOT_RESOLVED.test(s);
  const snooze = any(SNOOZE, s);
  const ack = any(ACK, s) && !NOT_ACK.test(s);
  const repeat = any(REPEAT, s);
  if (NOT_RESOLVED.test(s) && !snooze && !ack) return { intent: "none" };

  // Closing an incident is the one command that cannot be taken back here: it has to be the only thing said.
  if (resolve) return snooze || ack ? { intent: "none" } : { intent: "resolve" };
  // "收到，半小时后再提醒" means snooze: it is the narrower of the two, and the page comes back if it was wrong.
  if (snooze) return { intent: "snooze", minutes: minutesIn(s) };
  if (ack) return { intent: "ack" };
  if (repeat) return { intent: "repeat" };
  return { intent: "none" };
}

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const EN_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, "forty five": 45,
  fifty: 50, sixty: 60, ninety: 90, an: 1,
};

/** 一, 十, 十五, 二十, 四十五, 两 → a number; null when it is not one. */
export function chineseNumber(s: string): number | null {
  if (!s || [...s].some((c) => c !== "十" && !(c in CN_DIGIT))) return null;
  const i = s.indexOf("十");
  if (i < 0) return s.length === 1 ? CN_DIGIT[s] : null;
  const tens = i === 0 ? 1 : CN_DIGIT[s.slice(0, i)];
  const ones = s.slice(i + 1) ? CN_DIGIT[s.slice(i + 1)] : 0;
  return tens === undefined || ones === undefined || i > 1 || s.length - i > 2 ? null : tens * 10 + ones;
}

/** How long a snooze the words ask for, in minutes; 30 when they name none. */
export function minutesIn(s: string): number {
  const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : (chineseNumber(w) ?? EN_NUMBER[w] ?? null));
  let m: RegExpMatchArray | null;
  let minutes: number | null = null;
  if ((m = s.match(/(\d+|[零一二两三四五六七八九十]+)\s*(个)?\s*(半)?\s*(小时|钟头)/))) {
    const n = num(m[1]);
    minutes = n === null ? null : n * 60 + (m[3] ? 30 : 0);
  } else if (/半(个)?(小时|钟头)|half an hour/.test(s)) minutes = 30;
  else if ((m = s.match(/(\d+|[零一二两三四五六七八九十]+)\s*(分钟|分)/))) minutes = num(m[1]);
  else if ((m = s.match(/\b(\d+|forty[- ]five|[a-z]+)\s*(hours?|hrs?)\b/))) {
    const n = num(m[1]);
    minutes = n === null ? null : n * 60;
  } else if ((m = s.match(/\b(\d+|forty[- ]five|[a-z]+)\s*(minutes?|mins?)\b/))) minutes = num(m[1]);
  if (minutes === null || minutes < 1) return SNOOZE_DEFAULT;
  return Math.min(minutes, SNOOZE_MAX);
}

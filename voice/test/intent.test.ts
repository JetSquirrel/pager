import { describe, expect, it } from "bun:test";
import { chineseNumber, minutesIn, parseIntent } from "../src/intent";

describe("parseIntent", () => {
  const cases: [string, ReturnType<typeof parseIntent>][] = [
    ["收到", { intent: "ack" }],
    ["确认。", { intent: "ack" }],
    ["我来看看", { intent: "ack" }],
    ["我看看是什么问题", { intent: "ack" }],
    ["Acknowledge.", { intent: "ack" }],
    ["OK, I'm on it", { intent: "ack" }],
    ["稍后提醒我", { intent: "snooze", minutes: 30 }],
    ["二十分钟后再说", { intent: "snooze", minutes: 20 }],
    ["收到，半小时后再提醒", { intent: "snooze", minutes: 30 }],
    ["推迟一个小时", { intent: "snooze", minutes: 60 }],
    ["一个半小时以后再说", { intent: "snooze", minutes: 90 }],
    ["snooze 15 minutes", { intent: "snooze", minutes: 15 }],
    ["snooze for an hour", { intent: "snooze", minutes: 60 }],
    ["later", { intent: "snooze", minutes: 30 }],
    ["推迟十个小时", { intent: "snooze", minutes: 240 }],
    ["已解决", { intent: "resolve" }],
    ["修好了", { intent: "resolve" }],
    ["It's resolved.", { intent: "resolve" }],
    ["再说一遍", { intent: "repeat" }],
    ["什么？", { intent: "repeat" }],
    ["Say that again", { intent: "repeat" }],
  ];
  for (const [said, want] of cases) it(`"${said}"`, () => expect(parseIntent(said)).toEqual(want));

  it("never resolves on a negation or a mixed sentence", () => {
    expect(parseIntent("还没解决")).toEqual({ intent: "none" });
    expect(parseIntent("没有修好")).toEqual({ intent: "none" });
    expect(parseIntent("It's not fixed yet")).toEqual({ intent: "none" });
    expect(parseIntent("isn't resolved")).toEqual({ intent: "none" });
    expect(parseIntent("收到，等会解决")).toEqual({ intent: "none" });
  });

  it("does not take 关闭 or close for resolve", () => {
    expect(parseIntent("关闭警报")).toEqual({ intent: "none" });
    expect(parseIntent("close it")).toEqual({ intent: "none" });
  });

  it("is none for silence and for anything else", () => {
    expect(parseIntent("")).toEqual({ intent: "none" });
    expect(parseIntent("今天天气不错")).toEqual({ intent: "none" });
    expect(parseIntent("hello")).toEqual({ intent: "none" });
  });
});

describe("numbers", () => {
  it("reads Chinese numerals", () => {
    expect([..."一二两五十"].map(chineseNumber)).toEqual([1, 2, 2, 5, 10]);
    expect(["十五", "二十", "四十五", "九十九"].map(chineseNumber)).toEqual([15, 20, 45, 99]);
    expect(["", "百", "十十", "一二"].map(chineseNumber)).toEqual([null, null, null, null]);
  });
  it("defaults the snooze to 30 minutes and keeps it within the pager's limit", () => {
    expect(minutesIn("稍后")).toBe(30);
    expect(minutesIn("零分钟")).toBe(30);
    expect(minutesIn("500 minutes")).toBe(240);
    expect(minutesIn("forty-five minutes")).toBe(45);
    expect(minutesIn("2 hours")).toBe(120);
  });
});

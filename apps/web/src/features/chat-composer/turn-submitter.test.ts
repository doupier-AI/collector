import { describe, expect, it } from "vitest";
import type { ResearchTurnAccepted } from "@collector/capture-contracts";
import { NetworkError } from "../../api/errors";
import { makeMessage, makeSession, makeTask } from "../../test/fakes";
import { TurnSubmitter } from "./turn-submitter";

function makeTurn(): ResearchTurnAccepted {
  return {
    session: makeSession(),
    inputMessage: makeMessage({ role: "user" }),
    outputMessage: makeMessage({ role: "assistant", status: "pending" }),
    task: makeTask(),
  };
}

describe("TurnSubmitter 幂等键", () => {
  it("网络重试复用同一幂等键", async () => {
    const keys: string[] = [];
    let calls = 0;
    const submitter = new TurnSubmitter({
      generateKey: () => "key-1",
      submit: async () => {
        calls += 1;
        keys.push("key-1");
        if (calls === 1) throw new NetworkError();
        return makeTurn();
      },
    });

    await expect(submitter.send("问题")).rejects.toThrow();
    await expect(submitter.send("问题")).resolves.toBeDefined();

    expect(calls).toBe(2);
    expect(keys).toEqual(["key-1", "key-1"]);
  });

  it("网络重试沿用首次会话选项", async () => {
    const choices: Array<{ allowWebSearch: boolean; thinkingEnabled: boolean }> = [];
    let calls = 0;
    const submitter = new TurnSubmitter({
      generateKey: () => "key-1",
      submit: async (_content, _key, options) => {
        choices.push(options);
        calls += 1;
        if (calls === 1) throw new NetworkError();
        return makeTurn();
      },
    });

    await expect(submitter.send("问题", { allowWebSearch: false, thinkingEnabled: true })).rejects.toThrow();
    await expect(submitter.send("问题", { allowWebSearch: true, thinkingEnabled: false })).resolves.toBeDefined();

    expect(choices).toEqual([
      { allowWebSearch: false, thinkingEnabled: true },
      { allowWebSearch: false, thinkingEnabled: true },
    ]);
  });

  it("确认成功后，用户下一次明确发送生成新键", async () => {
    const usedKeys: string[] = [];
    const generated = ["key-a", "key-b"];
    const submitter = new TurnSubmitter({
      generateKey: () => generated.shift() ?? "key-x",
      submit: async (_content, key) => {
        usedKeys.push(key);
        return makeTurn();
      },
    });

    await submitter.send("第一个问题");
    await submitter.send("第二个问题");

    expect(usedKeys).toEqual(["key-a", "key-b"]);
  });

  it("提交进行中重复调用共享同一请求，双击不产生两个任务", async () => {
    let calls = 0;
    let release!: (turn: ResearchTurnAccepted) => void;
    const gate = new Promise<ResearchTurnAccepted>((resolve) => {
      release = resolve;
    });
    const submitter = new TurnSubmitter({
      generateKey: () => "key-1",
      submit: async () => {
        calls += 1;
        return gate;
      },
    });

    const first = submitter.send("问题");
    const second = submitter.send("问题");
    expect(calls).toBe(1);

    const turn = makeTurn();
    release(turn);
    await expect(first).resolves.toBe(turn);
    await expect(second).resolves.toBe(turn);
    expect(calls).toBe(1);
  });

  it("外部指定的幂等键用于首次提交，并在失败重试时保留", async () => {
    const usedKeys: string[] = [];
    let calls = 0;
    const submitter = new TurnSubmitter({
      submit: async (_content, key) => {
        calls += 1;
        usedKeys.push(key);
        if (calls === 1) throw new NetworkError();
        return makeTurn();
      },
    });

    await expect(submitter.send("首问", { idempotencyKey: "first-turn-key" })).rejects.toThrow();
    await submitter.send("首问");

    expect(usedKeys).toEqual(["first-turn-key", "first-turn-key"]);
  });
});

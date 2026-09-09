import test from "node:test";
import assert from "node:assert/strict";
import { calculateAlpha, routeMessage, scoreIntent } from "./dynamic-alpha-router.js";

const NOW = "2026-08-26T12:00:00.000Z";
const PREVIOUS = "2026-08-26T11:59:00.000Z";

test("scores work and love axes independently", () => {
  assert.deepEqual(scoreIntent("帮我排期：我好累"), { work: 65, love: 15 });
  assert.deepEqual(scoreIntent("我喜欢这个，真的好可爱！"), { work: 0, love: 70 });
});

test("uses square-root anti-collapse formula and instance bias", () => {
  const alpha = calculateAlpha({
    scores: { work: 50, love: 0 },
    timestamp: NOW,
    lastLogTimestamp: PREVIOUS,
  });
  assert.equal(alpha.alphaRaw, Math.sqrt(0.5 * 0.5));
  assert.ok(alpha.alphaWork < alpha.alphaDecayed);
  assert.ok(alpha.alphaLove > alpha.alphaDecayed);
});

test("routes a strong signal to parallel high fidelity under the default bias", () => {
  const result = routeMessage({
    userInput: "请分析这个数据。",
    timestamp: NOW,
    lastLogTimestamp: PREVIOUS,
  });
  assert.equal(result.decision, "parallel-high-fidelity");
  assert.deepEqual(result.placements, { work: "high", love: "high" });
});

test("routes low-confidence input to the shared summary", () => {
  const result = routeMessage({
    userInput: "嗯",
    timestamp: NOW,
    lastLogTimestamp: PREVIOUS,
  });
  assert.equal(result.decision, "shared-summary");
});

test("anchors bypass scoring decay and remain locked", () => {
  const result = routeMessage({
    userInput: "我的生日安排",
    timestamp: NOW,
    lastLogTimestamp: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(result.decision, "anchor");
  assert.equal(result.alphaWork, 1);
  assert.equal(result.alphaLove, 1);
  assert.deepEqual(result.placements, { work: "anchor", love: "anchor" });
});

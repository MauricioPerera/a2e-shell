import { describe, it, expect } from "vitest";
import { createLifecycle } from "../../src/http/lifecycle.js";
import { A2EError } from "../../src/errors.js";

describe("lifecycle", () => {
  it("defaults to accepting", () => {
    const lc = createLifecycle();
    expect(lc.state()).toBe("accepting");
    expect(lc.inFlight()).toBe(0);
  });

  it("increments and decrements in-flight counter", () => {
    const lc = createLifecycle();
    lc.checkAndIncrement("POST", "/sessions");
    expect(lc.inFlight()).toBe(1);
    lc.decrement();
    expect(lc.inFlight()).toBe(0);
  });

  it("accepts all methods while accepting", () => {
    const lc = createLifecycle();
    for (const m of ["POST", "PATCH", "DELETE", "GET"]) {
      expect(() => lc.checkAndIncrement(m, "/sessions")).not.toThrow();
      lc.decrement();
    }
  });

  it("rejects mutating methods during drain, allows reads", () => {
    const lc = createLifecycle();
    lc.beginDrain();
    for (const m of ["POST", "PATCH", "DELETE", "PUT"]) {
      expect(() => lc.checkAndIncrement(m, "/sessions")).toThrowError(A2EError);
    }
    expect(() => lc.checkAndIncrement("GET", "/sessions/x/state")).not.toThrow();
    lc.decrement();
  });

  it("always allows /healthz and /metrics even for mutating methods", () => {
    const lc = createLifecycle();
    lc.beginDrain();
    // (POST on those paths is weird, but the path bypass is explicit)
    expect(() => lc.checkAndIncrement("POST", "/healthz")).not.toThrow();
    lc.decrement();
    expect(() => lc.checkAndIncrement("POST", "/metrics")).not.toThrow();
    lc.decrement();
  });

  it("waitForDrain resolves immediately when in-flight is 0", async () => {
    const lc = createLifecycle();
    lc.beginDrain();
    const ok = await lc.waitForDrain(1000);
    expect(ok).toBe(true);
    expect(lc.state()).toBe("stopped");
  });

  it("waitForDrain resolves when last request finishes", async () => {
    const lc = createLifecycle();
    lc.checkAndIncrement("POST", "/sessions/x/exec");
    lc.beginDrain();
    const p = lc.waitForDrain(5000);
    expect(lc.state()).toBe("draining");
    lc.decrement();
    const ok = await p;
    expect(ok).toBe(true);
    expect(lc.state()).toBe("stopped");
  });

  it("waitForDrain returns false on timeout when requests outlast grace period", async () => {
    const lc = createLifecycle();
    lc.checkAndIncrement("POST", "/sessions/x/exec");
    lc.beginDrain();
    const ok = await lc.waitForDrain(50);
    expect(ok).toBe(false);
    // State stays "draining" after timeout; caller decides what to do.
    expect(lc.state()).toBe("draining");
  });

  it("beginDrain is idempotent", () => {
    const lc = createLifecycle();
    lc.beginDrain();
    lc.beginDrain();
    expect(lc.state()).toBe("draining");
  });

  it("stopped state rejects mutating ops too (post-drain, pre-close window)", async () => {
    const lc = createLifecycle();
    lc.beginDrain();
    await lc.waitForDrain(1000);
    expect(lc.state()).toBe("stopped");
    expect(() => lc.checkAndIncrement("POST", "/sessions")).toThrowError(A2EError);
    expect(() => lc.checkAndIncrement("GET", "/healthz")).not.toThrow();
    lc.decrement();
  });
});

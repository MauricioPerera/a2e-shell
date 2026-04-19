import { describe, it, expect } from "vitest";
import { buildRedactor, REPLACEMENT, MIN_SECRET_LEN } from "../../src/credentials/redactor.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("buildRedactor", () => {
  it("redacts a single secret value", () => {
    const r = buildRedactor(["API_KEY"], { API_KEY: "sk_live_abc123xyz" });
    const out = r.redact(enc.encode("token is sk_live_abc123xyz done"));
    expect(dec.decode(out)).toBe(`token is ${REPLACEMENT} done`);
  });

  it("redacts multiple secrets, longest first", () => {
    const r = buildRedactor(["A", "B"], {
      A: "prefix_secret_A",
      B: "secret_B_12",
    });
    const out = r.redact(enc.encode("prefix_secret_A and secret_B_12"));
    const s = dec.decode(out);
    expect(s).toContain(REPLACEMENT);
    expect(s).not.toContain("prefix_secret_A");
    expect(s).not.toContain("secret_B_12");
  });

  it("skips values shorter than MIN_SECRET_LEN", () => {
    const r = buildRedactor(["TINY"], { TINY: "x".repeat(MIN_SECRET_LEN - 1) });
    const payload = "x".repeat(MIN_SECRET_LEN - 1);
    const out = r.redact(enc.encode(payload));
    expect(dec.decode(out)).toBe(payload);
    expect(r.secrets).toHaveLength(0);
  });

  it("skips missing env keys", () => {
    const r = buildRedactor(["MISSING"], {});
    expect(r.secrets).toHaveLength(0);
    const out = r.redact(enc.encode("noop"));
    expect(dec.decode(out)).toBe("noop");
  });

  it("no-op on empty buffer", () => {
    const r = buildRedactor(["K"], { K: "longenoughsecret" });
    const out = r.redact(new Uint8Array(0));
    expect(out.length).toBe(0);
  });

  it("redacts multiple occurrences of the same secret", () => {
    const r = buildRedactor(["K"], { K: "longsecretXYZ" });
    const out = r.redact(enc.encode("longsecretXYZ and longsecretXYZ"));
    expect(dec.decode(out)).toBe(`${REPLACEMENT} and ${REPLACEMENT}`);
  });

  it("does not mutate buffer when no secrets configured", () => {
    const r = buildRedactor([], {});
    const payload = enc.encode("anything here");
    const out = r.redact(payload);
    expect(out).toBe(payload);
  });
});

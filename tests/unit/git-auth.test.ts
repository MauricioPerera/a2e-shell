import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildGitAuth } from "../../src/catalog/bootstrap.js";
import { A2EError } from "../../src/errors.js";

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

describe("buildGitAuth", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv();
  });

  it("returns empty args+env when spec is undefined", () => {
    const r = buildGitAuth(undefined);
    expect(r.extraArgs).toEqual([]);
    expect(r.extraEnv).toEqual({});
  });

  it("token auth: emits http.extraheader with Basic base64(user:token)", () => {
    setEnv("MY_TOK", "secret-value-xyz");
    const r = buildGitAuth({ type: "token", env_var: "MY_TOK", username: "x-access-token" });
    expect(r.extraEnv).toEqual({});
    expect(r.extraArgs[0]).toBe("-c");
    const header = r.extraArgs[1] ?? "";
    expect(header.startsWith("http.extraheader=Authorization: Basic ")).toBe(true);
    const b64 = header.replace(/^http\.extraheader=Authorization: Basic /, "");
    expect(Buffer.from(b64, "base64").toString()).toBe("x-access-token:secret-value-xyz");
  });

  it("token auth: missing env var → CAPABILITY_DENIED", () => {
    expect(() =>
      buildGitAuth({ type: "token", env_var: "NOT_SET_TOK", username: "x-access-token" }),
    ).toThrowError(A2EError);
  });

  it("ssh_key auth: builds GIT_SSH_COMMAND with key path", () => {
    const keyPath = path.join(tmp, "id_ed25519");
    fs.writeFileSync(keyPath, "dummy");
    setEnv("MY_KEY_PATH", keyPath);
    const r = buildGitAuth({ type: "ssh_key", key_path_env_var: "MY_KEY_PATH" });
    expect(r.extraArgs).toEqual([]);
    expect(r.extraEnv.GIT_SSH_COMMAND).toBeDefined();
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain(`-i ${keyPath}`);
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=accept-new");
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });

  it("ssh_key auth: with known_hosts uses strict checking", () => {
    const keyPath = path.join(tmp, "k");
    const knownHosts = path.join(tmp, "kh");
    fs.writeFileSync(keyPath, "");
    fs.writeFileSync(knownHosts, "github.com ssh-rsa ...");
    setEnv("MY_KEY", keyPath);
    setEnv("MY_KH", knownHosts);
    const r = buildGitAuth({
      type: "ssh_key",
      key_path_env_var: "MY_KEY",
      known_hosts_env_var: "MY_KH",
    });
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain(`UserKnownHostsFile=${knownHosts}`);
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(r.extraEnv.GIT_SSH_COMMAND).not.toContain("accept-new");
  });

  it("ssh_key auth: missing key env var → CAPABILITY_DENIED", () => {
    expect(() =>
      buildGitAuth({ type: "ssh_key", key_path_env_var: "NOT_SET_KEY" }),
    ).toThrowError(A2EError);
  });

  it("ssh_key auth: key file does not exist → CAPABILITY_DENIED", () => {
    setEnv("MISSING_FILE_KEY", "/does/not/exist/id_rsa");
    expect(() =>
      buildGitAuth({ type: "ssh_key", key_path_env_var: "MISSING_FILE_KEY" }),
    ).toThrowError(A2EError);
  });

  it("ssh_key auth: missing known_hosts env var → CAPABILITY_DENIED", () => {
    const keyPath = path.join(tmp, "k");
    fs.writeFileSync(keyPath, "");
    setEnv("MK", keyPath);
    expect(() =>
      buildGitAuth({
        type: "ssh_key",
        key_path_env_var: "MK",
        known_hosts_env_var: "NOT_SET_KH",
      }),
    ).toThrowError(A2EError);
  });

  it("ssh_key auth: shell-escapes paths with spaces", () => {
    const dir = path.join(tmp, "dir with spaces");
    fs.mkdirSync(dir);
    const keyPath = path.join(dir, "key");
    fs.writeFileSync(keyPath, "");
    setEnv("SPACY_KEY", keyPath);
    const r = buildGitAuth({ type: "ssh_key", key_path_env_var: "SPACY_KEY" });
    // path with spaces → single-quoted in the assembled command
    expect(r.extraEnv.GIT_SSH_COMMAND).toContain(`'${keyPath}'`);
  });
});

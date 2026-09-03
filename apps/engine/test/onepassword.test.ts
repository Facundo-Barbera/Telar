/**
 * The `op` adapter — driven entirely through the injected exec seam. NO TEST
 * HERE EVER SPAWNS A PROCESS: the machine this was written on has no `op`,
 * and that absence is itself a case under test.
 */
import { expect, test } from "bun:test";
import {
  createOnePasswordSecrets,
  OP_NOT_INSTALLED,
  registrableDomain,
  registrableDomainOfUrl,
  type OpExec,
} from "../src/secrets/onepassword";

const SENTINEL = "SENTINEL-hunter2-9f8e7d";

function enoent(): OpExec {
  return async () => {
    const error = new Error("spawn op ENOENT") as Error & { code: string };
    error.code = "ENOENT";
    throw error;
  };
}

const loginList = JSON.stringify([
  { id: "item_gh", title: "GitHub", vault: { name: "Personal" }, urls: [{ href: "https://github.com", primary: true }] },
  { id: "item_gh_login", title: "GitHub (work)", urls: [{ href: "https://login.github.com/session" }] },
  { id: "item_other", title: "Example", urls: [{ href: "https://example.com" }] },
  { id: "item_no_url", title: "No website" },
]);

test("registrable domain: subdomains group, two-part suffixes hold, IPs and localhost never match", () => {
  expect(registrableDomain("github.com")).toBe("github.com");
  expect(registrableDomain("login.github.com")).toBe("github.com");
  expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
  expect(registrableDomain("localhost")).toBeNull();
  expect(registrableDomain("127.0.0.1")).toBeNull();
  expect(registrableDomainOfUrl("https://Login.GitHub.com/path")).toBe("github.com");
  expect(registrableDomainOfUrl("file:///etc/passwd")).toBeNull();
  expect(registrableDomainOfUrl("not a url")).toBeNull();
});

test("op missing answers the install sentence, not a stack trace", async () => {
  const secrets = createOnePasswordSecrets(enoent());
  const listed = await secrets.listLoginCandidates("https://github.com");
  expect(listed).toEqual({ ok: false, error: OP_NOT_INSTALLED });
  const read = await secrets.readItemFields("item_gh", [{ kind: "password" }]);
  expect(read).toEqual({ ok: false, error: OP_NOT_INSTALLED });
});

test("a locked vault (non-zero exit) answers about the LOCK — stderr is dropped, not relayed", async () => {
  // stderr from a credential tool is not journal-safe prose; the adapter's
  // sentence is. The stderr here contains a sentinel that must not surface.
  const secrets = createOnePasswordSecrets(async () => ({ code: 1, stdout: "", stderr: `account ${SENTINEL} locked` }));
  const listed = await secrets.listLoginCandidates("https://github.com");
  expect(listed.ok).toBe(false);
  if (!listed.ok) {
    expect(listed.error).toContain("locked");
    expect(listed.error).not.toContain(SENTINEL);
  }
});

test("candidates are the domain-matched Logins and carry METADATA ONLY", async () => {
  const calls: string[][] = [];
  const secrets = createOnePasswordSecrets(async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: loginList, stderr: "" };
  });
  const listed = await secrets.listLoginCandidates("https://login.github.com");
  expect(calls[0]).toEqual(["item", "list", "--categories", "Login", "--format", "json"]);
  expect(listed).toEqual({
    ok: true,
    candidates: [
      { id: "item_gh", title: "GitHub", vault: "Personal", domain: "github.com" },
      { id: "item_gh_login", title: "GitHub (work)", domain: "github.com" },
    ],
  });
});

test("an origin with no registrable domain is refused before op is ever run", async () => {
  let ran = 0;
  const secrets = createOnePasswordSecrets(async () => {
    ran += 1;
    return { code: 0, stdout: loginList, stderr: "" };
  });
  const listed = await secrets.listLoginCandidates("http://localhost:3000");
  expect(listed.ok).toBe(false);
  expect(ran).toBe(0);
});

test("readItemFields maps username/password by purpose, otp by type, field by label", async () => {
  const item = JSON.stringify({
    fields: [
      { id: "u", label: "username", purpose: "USERNAME", type: "STRING", value: "facundo" },
      { id: "p", label: "password", purpose: "PASSWORD", type: "CONCEALED", value: SENTINEL },
      { id: "t", label: "one-time password", type: "OTP", totp: "123456" },
      { id: "c", label: "Recovery code", type: "CONCEALED", value: "rc-1" },
    ],
  });
  const secrets = createOnePasswordSecrets(async (args) => {
    expect(args).toEqual(["item", "get", "item_gh", "--format", "json", "--reveal"]);
    return { code: 0, stdout: item, stderr: "" };
  });
  const read = await secrets.readItemFields("item_gh", [
    { kind: "username" },
    { kind: "password" },
    { kind: "otp" },
    { kind: "field", label: "recovery CODE" },
  ]);
  expect(read).toEqual({
    ok: true,
    values: [
      { want: { kind: "username" }, value: "facundo" },
      { want: { kind: "password" }, value: SENTINEL },
      { want: { kind: "otp" }, value: "123456" },
      { want: { kind: "field", label: "recovery CODE" }, value: "rc-1" },
    ],
  });
});

test("a missing wanted field is named by KIND — the error never quotes item content", async () => {
  const secrets = createOnePasswordSecrets(async () => ({
    code: 0,
    stdout: JSON.stringify({ fields: [{ label: "password", purpose: "PASSWORD", value: SENTINEL }] }),
    stderr: "",
  }));
  const read = await secrets.readItemFields("item_gh", [{ kind: "otp" }]);
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.error).toContain("otp");
    expect(read.error).not.toContain(SENTINEL);
  }
});

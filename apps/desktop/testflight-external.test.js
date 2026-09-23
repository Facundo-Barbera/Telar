// apps/ios/testflight-external.sh, RUN FOR REAL AGAINST A STUBBED App Store
// Connect. The script is the step between "altool said UPLOAD SUCCEEDED" and
// "external testers can install it": poll processing, find the external
// group, add the build, submit for Beta App Review. None of that can be tried
// against Apple without publishing a build to people, so `curl` is shadowed
// on PATH by a stub that answers from a canned sequence and records what it
// was asked — and the script is run by /bin/bash, the 3.2 the macOS runner
// images report, for the same reason shell-array-expansion.test.js does.
//
// It lives beside that file because `test:desktop:unit`'s glob is the shell
// suite CI actually runs (#760 §7 is what happens to a test outside a glob).
//
// What is proved, in order of how much it would cost to be wrong about:
//
//   - THE TOKEN NEVER REACHES THE LOG. The stub captures the Authorization
//     header; the script's output — under `bash -x`, which prints every
//     command — must not contain it, nor the word Bearer, nor a line of the
//     .p8. A nightly's log is public to everyone with read access.
//   - THE JWT IS ONE APPLE WOULD ACCEPT: ES256 header with the key id, the
//     issuer and audience in the payload, a 20-minute life, and a signature
//     that VERIFIES against the key's public half in raw r||s form — the DER
//     walk in the script is the one piece of it that could be subtly wrong.
//   - "ALREADY" IS SUCCESS on both writes, so a re-run after a dead step
//     finishes instead of failing on what the first attempt got done.
//   - A MISSING EXTERNAL GROUP fails and says what it found instead, and
//     nothing is POSTed after it.
//
// No test waits on a real clock: the poll interval is set to 0 and the
// give-up test sets the budget to 0 as well.

const { beforeAll, describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "ios", "testflight-external.sh");
const API = "https://api.appstoreconnect.apple.com";
const APP_ID = "6807300090";
const BUILD_NUMBER = "202609230300";
const KEY_ID = "ABC123DEF4";
const ISSUER_ID = "69a6de70-0000-47e3-e053-5b8c7c11a4d1";

// A real P-256 key in the PKCS#8 PEM shape Apple's .p8 files have, so the
// script signs with exactly the openssl invocation it will use in CI.
let keyDir;
let keyPath;
let publicKeyDer;
beforeAll(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "asc-key-"));
  keyPath = path.join(keyDir, "AuthKey_TEST.p8");
  const generated = spawnSync("/bin/bash", ["-c", `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "${keyPath}"`], {
    encoding: "utf8",
  });
  if (generated.status !== 0) throw new Error(`could not generate a test key: ${generated.stderr}`);
  const pub = spawnSync("openssl", ["pkey", "-in", keyPath, "-pubout", "-outform", "DER"]);
  if (pub.status !== 0) throw new Error(`could not export the test public key: ${pub.stderr}`);
  publicKeyDer = pub.stdout;
});

/** A stub `curl` that answers from `$STUB_DIR/responses/N` and records the request. */
const CURL_STUB = `#!/bin/bash
# Test double for curl: the Nth invocation answers with responses/N (first
# line the status, the rest the body), the way --fail-with-body + -w would.
n=$(cat "$STUB_DIR/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/n"
method=GET; url=""; data=""; out=/dev/null
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift 2 ;;
    -H) printf '%s\\n' "$2" >> "$STUB_DIR/headers.log"; shift 2 ;;
    --data) data=$2; shift 2 ;;
    -o) out=$2; shift 2 ;;
    -w | --max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\t%s\\t%s\\n' "$method" "$url" "$data" >> "$STUB_DIR/calls.log"
f="$STUB_DIR/responses/$n"
if [ ! -f "$f" ]; then echo "curl stub: no canned response #$n for $method $url" >&2; exit 99; fi
status=$(head -n 1 "$f")
tail -n +2 "$f" > "$out"
printf '%s' "$status"
case "$status" in
  2*|3*) exit 0 ;;
  *) echo "curl: (22) The requested URL returned error: $status" >&2; exit 22 ;;
esac
`;

const reply = (status, body = "") => `${status}\n${typeof body === "string" ? body : JSON.stringify(body)}`;

const build = (processingState) => ({
  data: [{ type: "builds", id: "b-1", attributes: { processingState } }],
});
const NO_BUILD = { data: [] };
const EXTERNAL_GROUP = { data: [{ type: "betaGroups", id: "g-ext", attributes: { name: "Nightly", isInternalGroup: false } }] };
const ONLY_INTERNAL_GROUP = { data: [{ type: "betaGroups", id: "g-int", attributes: { name: "Nightly", isInternalGroup: true } }] };
const ALREADY_IN_GROUP = {
  errors: [{ code: "ENTITY_ERROR.RELATIONSHIP.INVALID", status: "409", detail: "The build is already in this beta group." }],
};
const ALREADY_SUBMITTED = {
  errors: [{ code: "STATE_ERROR.ENTITY_STATE_INVALID", status: "409", detail: "A beta app review submission already exists for this build." }],
};
const APPLE_DOWN = { errors: [{ code: "SERVICE_UNAVAILABLE", status: "503", detail: "Try again later." }] };

const WHATS_NEW =
  "Nightly build of Telar Mobile. Pair with a Mac running the current Telar nightly, then follow a session, read its transcript and answer an approval from the phone. Report anything that looks wrong or stalls.";
const NO_LOCALIZATIONS = { data: [] };
const localization = (id, locale) => ({ type: "betaBuildLocalizations", id, attributes: { locale, whatsNew: null } });

const BUILDS_URL = `${API}/v1/builds?filter[app]=${APP_ID}&filter[version]=${BUILD_NUMBER}&fields[builds]=processingState`;
const LOCALIZATIONS_URL = `${API}/v1/builds/b-1/betaBuildLocalizations`;
const CREATE_LOCALIZATION_URL = `${API}/v1/betaBuildLocalizations`;
const GROUPS_URL = `${API}/v1/apps/${APP_ID}/betaGroups?filter[name]=Nightly&filter[isInternalGroup]=false&fields[betaGroups]=name,isInternalGroup`;
const ADD_URL = `${API}/v1/betaGroups/g-ext/relationships/builds`;
const SUBMIT_URL = `${API}/v1/betaAppReviewSubmissions`;
const CREATE_LOCALIZATION_BODY = {
  data: {
    type: "betaBuildLocalizations",
    attributes: { locale: "en-US", whatsNew: WHATS_NEW },
    relationships: { build: { data: { type: "builds", id: "b-1" } } },
  },
};
const patchLocalizationBody = (id) => ({ data: { type: "betaBuildLocalizations", id, attributes: { whatsNew: WHATS_NEW } } });
const ADD_BODY = JSON.stringify({ data: [{ type: "builds", id: "b-1" }] });
const SUBMIT_BODY = JSON.stringify({
  data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: "b-1" } } } },
});

/**
 * The full happy sequence: Apple hiccups once, the build appears, processes,
 * gets its What to Test text, is added and submitted.
 */
const HAPPY = [
  reply(503, APPLE_DOWN),
  reply(200, NO_BUILD),
  reply(200, build("PROCESSING")),
  reply(200, build("VALID")),
  reply(200, NO_LOCALIZATIONS),
  reply(201, { data: localization("loc-new", "en-US") }),
  reply(200, EXTERNAL_GROUP),
  reply(204),
  reply(201, { data: { type: "betaAppReviewSubmissions", id: "s-1" } }),
];
const ADD_AT = HAPPY.length - 2;
const SUBMIT_AT = HAPPY.length - 1;

/**
 * Run the script by /bin/bash with `curl` shadowed. `responses` is what the
 * stub answers, in order; `env` overrides; `trace` runs it under `bash -x`.
 */
const run = ({ responses, env = {}, trace = false }) => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "asc-stub-"));
  fs.mkdirSync(path.join(stubDir, "bin"));
  fs.mkdirSync(path.join(stubDir, "responses"));
  fs.writeFileSync(path.join(stubDir, "bin", "curl"), CURL_STUB, { mode: 0o755 });
  responses.forEach((body, index) => fs.writeFileSync(path.join(stubDir, "responses", String(index + 1)), body));

  const result = spawnSync("/bin/bash", [...(trace ? ["-x"] : []), SCRIPT, BUILD_NUMBER], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${path.join(stubDir, "bin")}:${process.env.PATH}`,
      STUB_DIR: stubDir,
      TELAR_ASC_KEY_ID: KEY_ID,
      TELAR_ASC_ISSUER_ID: ISSUER_ID,
      TELAR_ASC_KEY_PATH: keyPath,
      TELAR_ASC_POLL_SECONDS: "0",
      TELAR_ASC_POLL_TIMEOUT_SECONDS: "1800",
      ...env,
    },
  });

  const readLog = (name) => {
    const file = path.join(stubDir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  const calls = readLog("calls.log").map((line) => {
    const [method, url, data] = line.split("\t");
    return { method, url, data };
  });
  const tokens = readLog("headers.log")
    .filter((line) => line.startsWith("Authorization: Bearer "))
    .map((line) => line.slice("Authorization: Bearer ".length));
  fs.rmSync(stubDir, { recursive: true, force: true });
  return { ...result, output: `${result.stdout}\n${result.stderr}`, calls, tokens };
};

const fromBase64Url = (text) => Buffer.from(text, "base64url");

describe("testflight-external.sh offers a processed build to the external group", () => {
  test("a hiccup, then absent, then processing, then VALID proceeds to add and submit", () => {
    const outcome = run({ responses: HAPPY });
    expect(outcome.stderr).not.toContain("::error::");
    expect(outcome.status).toBe(0);

    expect(outcome.calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", BUILDS_URL],
      ["GET", BUILDS_URL],
      ["GET", BUILDS_URL],
      ["GET", BUILDS_URL],
      ["GET", LOCALIZATIONS_URL],
      ["POST", CREATE_LOCALIZATION_URL],
      ["GET", GROUPS_URL],
      ["POST", ADD_URL],
      ["POST", SUBMIT_URL],
    ]);
    expect(JSON.parse(outcome.calls[5].data)).toEqual(CREATE_LOCALIZATION_BODY);
    expect(outcome.calls[ADD_AT].data).toBe(ADD_BODY);
    expect(outcome.calls[SUBMIT_AT].data).toBe(SUBMIT_BODY);

    // Status codes are what it prints, and the 503 was said and survived.
    expect(outcome.stdout).toContain("-> 503");
    expect(outcome.stdout).toContain("-> 200");
    expect(outcome.stdout).toContain("-> 204");
    expect(outcome.stdout).toContain("-> 201");
    expect(outcome.stdout).toContain("is processed");
    expect(outcome.stdout).toContain("has its en-US What to Test text");
    expect(outcome.stdout).toContain("submitted for Beta App Review");
  });

  test("an existing en-US localization is PATCHed with What to Test rather than duplicated", () => {
    const responses = [...HAPPY];
    responses[4] = reply(200, { data: [localization("loc-de", "de-DE"), localization("loc-en", "en-US")] });
    responses[5] = reply(200, { data: localization("loc-en", "en-US") });
    const outcome = run({ responses });
    expect(outcome.stderr).not.toContain("::error::");
    expect(outcome.status).toBe(0);
    expect(outcome.calls[5]).toMatchObject({ method: "PATCH", url: `${API}/v1/betaBuildLocalizations/loc-en` });
    expect(JSON.parse(outcome.calls[5].data)).toEqual(patchLocalizationBody("loc-en"));
    expect(outcome.calls.filter((call) => call.url === CREATE_LOCALIZATION_URL)).toEqual([]);
    expect(outcome.calls.at(-1)).toMatchObject({ method: "POST", url: SUBMIT_URL });
  });

  test("a localization in another locale only does not count: en-US is POSTed", () => {
    const responses = [...HAPPY];
    responses[4] = reply(200, { data: [localization("loc-de", "de-DE")] });
    const outcome = run({ responses });
    expect(outcome.stderr).not.toContain("::error::");
    expect(outcome.status).toBe(0);
    expect(outcome.calls[5]).toMatchObject({ method: "POST", url: CREATE_LOCALIZATION_URL });
    expect(JSON.parse(outcome.calls[5].data)).toEqual(CREATE_LOCALIZATION_BODY);
  });

  test("a refused What to Test text is an error before anything is added or submitted", () => {
    const responses = [...HAPPY];
    responses[5] = reply(409, { errors: [{ code: "ENTITY_ERROR.ATTRIBUTE.INVALID", status: "409", detail: "whatsNew is too long." }] });
    const outcome = run({ responses });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("::error::");
    expect(outcome.stderr).toContain("whatsNew is too long.");
    expect(outcome.calls.filter((call) => call.url === ADD_URL || call.url === SUBMIT_URL)).toEqual([]);
  });

  test("a 409 saying the build is already in the group counts as success, and it still submits", () => {
    const responses = [...HAPPY];
    responses[ADD_AT] = reply(409, ALREADY_IN_GROUP);
    const outcome = run({ responses });
    expect(outcome.stderr).not.toContain("::error::");
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("already in 'Nightly'");
    expect(outcome.stdout).toContain(ALREADY_IN_GROUP.errors[0].detail);
    expect(outcome.calls.at(-1)).toMatchObject({ method: "POST", url: SUBMIT_URL, data: SUBMIT_BODY });
  });

  test("a review submission that already exists counts as success", () => {
    const responses = [...HAPPY];
    responses[SUBMIT_AT] = reply(409, ALREADY_SUBMITTED);
    const outcome = run({ responses });
    expect(outcome.stderr).not.toContain("::error::");
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("needs no new Beta App Review submission");
    expect(outcome.stdout).toContain(ALREADY_SUBMITTED.errors[0].detail);
  });

  test("an ENTITY_ERROR saying the build is already approved counts as success too", () => {
    const responses = [...HAPPY];
    responses[SUBMIT_AT] = reply(422, {
      errors: [{ code: "ENTITY_ERROR.ATTRIBUTE.INVALID", status: "422", detail: "This build has already been approved for external testing." }],
    });
    const outcome = run({ responses });
    expect(outcome.stderr).not.toContain("::error::");
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("already been approved");
  });

  test("any other refusal of the submission is an error carrying Apple's detail", () => {
    const responses = [...HAPPY];
    responses[SUBMIT_AT] = reply(409, {
      errors: [{ code: "STATE_ERROR.ENTITY_STATE_INVALID", status: "409", detail: "Missing export compliance information." }],
    });
    const outcome = run({ responses });
    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain("::error::");
    expect(outcome.stderr).toContain("Missing export compliance information.");
  });

  test("no external group named Nightly fails, names what was found, and adds or submits nothing", () => {
    const outcome = run({
      responses: [reply(200, build("VALID")), reply(200, NO_LOCALIZATIONS), reply(201, { data: localization("loc-new", "en-US") }), reply(200, ONLY_INTERNAL_GROUP)],
    });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("::error::");
    expect(outcome.stderr).toContain("no EXTERNAL beta group named 'Nightly'");
    expect(outcome.stderr).toContain("'Nightly' (internal, id g-int)");
    expect(outcome.calls.filter((call) => call.url === ADD_URL || call.url === SUBMIT_URL)).toEqual([]);
  });

  test("a build that processed as INVALID is an error, not a wait", () => {
    const outcome = run({ responses: [reply(200, build("PROCESSING")), reply(200, build("INVALID"))] });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("::error::");
    expect(outcome.stderr).toContain("INVALID");
    expect(outcome.calls).toHaveLength(2);
  });

  test("outrunning the processing wait is a warning and exit 0, with nothing added", () => {
    const outcome = run({
      responses: [reply(200, build("PROCESSING"))],
      env: { TELAR_ASC_POLL_TIMEOUT_SECONDS: "0" },
    });
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("::warning::");
    expect(outcome.stdout).toContain("NOT offered to the external group");
    expect(outcome.calls).toHaveLength(1);
  });

  test("it refuses to run without a build number or the credentials", () => {
    const noBuild = spawnSync("/bin/bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, TELAR_ASC_KEY_ID: KEY_ID, TELAR_ASC_ISSUER_ID: ISSUER_ID, TELAR_ASC_KEY_PATH: keyPath } });
    expect(noBuild.status).toBe(2);
    expect(noBuild.stderr).toContain("usage:");

    const noKey = spawnSync("/bin/bash", [SCRIPT, BUILD_NUMBER], { encoding: "utf8", env: { ...process.env, TELAR_ASC_KEY_ID: "", TELAR_ASC_ISSUER_ID: ISSUER_ID, TELAR_ASC_KEY_PATH: keyPath } });
    expect(noKey.status).not.toBe(0);
    expect(noKey.stderr).toContain("TELAR_ASC_KEY_ID");
  });
});

describe("the token", () => {
  test("never appears in the output, even under bash -x", () => {
    const outcome = run({ responses: HAPPY, trace: true });
    expect(outcome.status).toBe(0);
    // Every call carried one, so the stub saw as many as there were calls; if
    // this were 0 the check below would be vacuous.
    expect(outcome.tokens).toHaveLength(HAPPY.length);
    for (const token of outcome.tokens) {
      expect(outcome.output).not.toContain(token);
      // Nor any one segment of it — the signature alone is enough to reuse.
      for (const part of token.split(".")) expect(outcome.output).not.toContain(part);
    }
    expect(outcome.output).not.toContain("Bearer");
    expect(outcome.output).not.toContain("Authorization");
    // The key itself: any body line of the PEM.
    const pemLines = fs.readFileSync(keyPath, "utf8").split("\n").filter((line) => line && !line.startsWith("-----"));
    expect(pemLines.length).toBeGreaterThan(0);
    for (const line of pemLines) expect(outcome.output).not.toContain(line);
    // The trace proves the run was traced and the guard engaged, and the
    // status lines prove the calls went through — the curl line itself is
    // exactly what `set +x` keeps out of the trace.
    expect(outcome.stderr).toContain("+ set +x");
    expect(outcome.stderr).not.toContain("+ curl");
    expect(outcome.stdout).toContain("-> 201");
  });

  test("is an ES256 JWT Apple would accept, whose signature verifies against the key", async () => {
    const outcome = run({ responses: [reply(200, build("INVALID"))] });
    expect(outcome.tokens).toHaveLength(1);
    const [headerB64, payloadB64, signatureB64] = outcome.tokens[0].split(".");

    expect(JSON.parse(fromBase64Url(headerB64).toString())).toEqual({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
    const payload = JSON.parse(fromBase64Url(payloadB64).toString());
    expect(payload.iss).toBe(ISSUER_ID);
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.exp - payload.iat).toBe(1200);
    expect(Math.abs(payload.iat - Math.floor(Date.now() / 1000))).toBeLessThan(60);

    // Raw r||s, 64 bytes — not the DER openssl produced.
    const signature = fromBase64Url(signatureB64);
    expect(signature).toHaveLength(64);
    const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      Buffer.from(`${headerB64}.${payloadB64}`),
    );
    expect(verified).toBe(true);
  });
});

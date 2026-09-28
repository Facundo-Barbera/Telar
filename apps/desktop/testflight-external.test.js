const { beforeAll, describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "ios", "testflight-external.sh");
const APP_SCRIPT = path.join(__dirname, "..", "ios", "testflight-app.sh");
const API = "https://api.appstoreconnect.apple.com";
const APP_ID = "6807300090";
const BUILD_NUMBER = "202609230300";
const KEY_ID = "ABC123DEF4";
const ISSUER_ID = "69a6de70-0000-47e3-e053-5b8c7c11a4d1";

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
const GROUPS_URL = `${API}/v1/betaGroups?filter[app]=${APP_ID}&filter[name]=Nightly&filter[isInternalGroup]=false&fields[betaGroups]=name,isInternalGroup`;
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

const run = ({ responses, env = {}, trace = false, script = SCRIPT, args = [BUILD_NUMBER] }) => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "asc-stub-"));
  fs.mkdirSync(path.join(stubDir, "bin"));
  fs.mkdirSync(path.join(stubDir, "responses"));
  fs.writeFileSync(path.join(stubDir, "bin", "curl"), CURL_STUB, { mode: 0o755 });
  responses.forEach((body, index) => fs.writeFileSync(path.join(stubDir, "responses", String(index + 1)), body));

  const result = spawnSync("/bin/bash", [...(trace ? ["-x"] : []), script, ...args], {
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
      TELAR_ASC_APP_ID: APP_ID,
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

    expect(outcome.tokens).toHaveLength(HAPPY.length);
    for (const token of outcome.tokens) {
      expect(outcome.output).not.toContain(token);

      for (const part of token.split(".")) expect(outcome.output).not.toContain(part);
    }
    expect(outcome.output).not.toContain("Bearer");
    expect(outcome.output).not.toContain("Authorization");

    const pemLines = fs.readFileSync(keyPath, "utf8").split("\n").filter((line) => line && !line.startsWith("-----"));
    expect(pemLines.length).toBeGreaterThan(0);
    for (const line of pemLines) expect(outcome.output).not.toContain(line);

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

const NEW_BUNDLE = "io.github.novarix.telar";
const NEW_APP = { data: [{ type: "apps", id: "a-new", attributes: { bundleId: NEW_BUNDLE } }] };
const HOLDER_EMAIL = "holder@example.com";
const HOLDER = { data: [{ type: "users", id: "u-1", attributes: { username: HOLDER_EMAIL, firstName: "Ada", lastName: "Lovelace" } }] };
const TEMPLATE_LOCALIZATIONS = {
  data: [{ type: "betaAppLocalizations", id: "l-old", attributes: { locale: "en-US", description: "Telar on the phone.", feedbackEmail: "fb@example.com", privacyPolicyUrl: "https://example.com/privacy", marketingUrl: null } }],
};
const TEMPLATE_DETAIL = {
  data: { type: "betaAppReviewDetails", id: "6807300090", attributes: { contactFirstName: "Ada", contactLastName: "Lovelace", contactPhone: "+1 555 0100", contactEmail: "review@example.com", notes: null, demoAccountRequired: false } },
};
const APPS_URL = `${API}/v1/apps?filter[bundleId]=${NEW_BUNDLE}&fields[apps]=bundleId`;
const runApp = (responses) => run({ responses, script: APP_SCRIPT, args: [], env: { TELAR_ASC_APP_ID: "" } });

describe("testflight-app.sh makes a brand-new app ready for nightlies", () => {
  test("creates the internal group with the account holder, copies the review info and creates the external group", () => {
    const outcome = runApp([
      reply(200, NEW_APP),
      reply(200, { data: [] }),
      reply(201, { data: { type: "betaGroups", id: "g-int" } }),
      reply(200, HOLDER),
      reply(200, { data: [] }),
      reply(201, { data: { type: "betaTesters", id: "t-1" } }),
      reply(200, { data: [] }),
      reply(200, TEMPLATE_LOCALIZATIONS),
      reply(201, { data: { type: "betaAppLocalizations", id: "l-new" } }),
      reply(200, { data: { type: "betaAppReviewDetails", id: "a-new", attributes: { contactEmail: null } } }),
      reply(200, TEMPLATE_DETAIL),
      reply(200, { data: { type: "betaAppReviewDetails", id: "a-new" } }),
      reply(200, { data: [] }),
      reply(201, { data: { type: "betaGroups", id: "g-ext" } }),
    ]);
    expect(outcome.output).not.toContain("::error::");
    expect(outcome.output).not.toContain("::warning::");
    expect(outcome.status).toBe(0);
    expect(outcome.calls.map((call) => call.method)).toEqual(["GET", "GET", "POST", "GET", "GET", "POST", "GET", "GET", "POST", "GET", "GET", "PATCH", "GET", "POST"]);
    expect(outcome.calls[0].url).toBe(APPS_URL);
    expect(outcome.calls[1].url).toContain("filter[app]=a-new&filter[isInternalGroup]=true");

    const internal = JSON.parse(outcome.calls[2].data).data;
    expect(internal.attributes).toEqual({ name: "Internal", isInternalGroup: true, hasAccessToAllBuilds: true });
    expect(internal.relationships.app.data.id).toBe("a-new");

    expect(outcome.calls[4].url).toContain(`filter[email]=${encodeURIComponent(HOLDER_EMAIL)}&filter[apps]=a-new`);
    const tester = JSON.parse(outcome.calls[5].data).data;
    expect(tester.attributes).toEqual({ email: HOLDER_EMAIL, firstName: "Ada", lastName: "Lovelace" });
    expect(tester.relationships.betaGroups.data).toEqual([{ type: "betaGroups", id: "g-int" }]);

    expect(outcome.output).not.toContain(HOLDER_EMAIL);

    expect(outcome.calls[7].url).toBe(`${API}/v1/apps/6807300090/betaAppLocalizations`);
    const localization = JSON.parse(outcome.calls[8].data).data;
    expect(localization.attributes).toEqual({ locale: "en-US", description: "Telar on the phone.", feedbackEmail: "fb@example.com", privacyPolicyUrl: "https://example.com/privacy" });
    expect(localization.relationships.app.data.id).toBe("a-new");

    expect(outcome.calls[11].url).toBe(`${API}/v1/betaAppReviewDetails/a-new`);
    expect(JSON.parse(outcome.calls[11].data).data.attributes).toEqual({
      contactFirstName: "Ada", contactLastName: "Lovelace", contactPhone: "+1 555 0100", contactEmail: "review@example.com", demoAccountRequired: false,
    });

    const external = JSON.parse(outcome.calls[13].data).data;
    expect(external.attributes).toEqual({ name: "Nightly", isInternalGroup: false });
  });

  test("an app already set up costs only reads, and an existing tester is added to the group", () => {
    const outcome = runApp([
      reply(200, NEW_APP),
      reply(200, { data: [{ type: "betaGroups", id: "g-int", attributes: { name: "Internal", isInternalGroup: true, hasAccessToAllBuilds: true } }] }),
      reply(200, HOLDER),
      reply(200, { data: [{ type: "betaTesters", id: "t-1" }] }),
      reply(409, { errors: [{ code: "ENTITY_ERROR", status: "409", detail: "The tester is already in this group." }] }),
      reply(200, { data: [{ type: "betaAppLocalizations", id: "l-new", attributes: { locale: "en-US" } }] }),
      reply(200, TEMPLATE_LOCALIZATIONS),
      reply(200, { data: { type: "betaAppReviewDetails", id: "a-new", attributes: { contactEmail: "review@example.com" } } }),
      reply(200, EXTERNAL_GROUP),
    ]);
    expect(outcome.output).not.toContain("::warning::");
    expect(outcome.status).toBe(0);
    expect(outcome.calls.filter((call) => call.method !== "GET").map((call) => call.url)).toEqual([`${API}/v1/betaGroups/g-int/relationships/betaTesters`]);
  });

  test("no app record for the bundle is an error, and nothing else is asked", () => {
    const outcome = runApp([reply(200, { data: [] })]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(`no single app with bundle id ${NEW_BUNDLE}`);
    expect(outcome.calls).toHaveLength(1);
  });
});

describe("testflight-external.sh without TELAR_ASC_APP_ID", () => {
  test("finds the app by bundle id and polls that app's builds", () => {
    const outcome = run({ responses: [reply(200, NEW_APP), reply(200, NO_BUILD)], env: { TELAR_ASC_APP_ID: "", TELAR_ASC_POLL_TIMEOUT_SECONDS: "0" } });
    expect(outcome.status).toBe(0);
    expect(outcome.calls.map((call) => call.url)).toEqual([APPS_URL, `${API}/v1/builds?filter[app]=a-new&filter[version]=${BUILD_NUMBER}&fields[builds]=processingState`]);
  });
});

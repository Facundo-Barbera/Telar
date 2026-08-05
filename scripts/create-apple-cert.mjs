#!/usr/bin/env node
// One-time tool: submit a CSR to Apple's Certificates API and save the signed
// certificate. Requires an App Store Connect API key (the same one used for
// notarization) with certificate-management access.
//
// Usage:
//   node scripts/create-apple-cert.mjs \
//     --key-id <KEY_ID> --issuer-id <ISSUER_ID> \
//     --p8 /path/to/AuthKey_XXXX.p8 \
//     --csr /path/to/developerID_application.csr \
//     [--out /path/to/developerID_application.cer]

import { readFileSync, writeFileSync } from "node:fs";
import { createSign, createPrivateKey } from "node:crypto";

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (required && !value) throw new Error(`missing --${name}`);
  return value;
}

const keyId = arg("key-id");
const issuerId = arg("issuer-id");
const p8Path = arg("p8");
const csrPath = arg("csr");
const outPath = arg("out", false) ?? csrPath.replace(/\.csr$/, ".cer");

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt() {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  // Apple caps token lifetime at 20 minutes; this is a one-shot request so a
  // short-lived token is fine.
  const payload = { iss: issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  const privateKey = createPrivateKey(readFileSync(p8Path, "utf8"));
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // JWS ES256 needs raw R||S, not the DER encoding Node produces by default.
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
}

async function main() {
  const csrContent = readFileSync(csrPath, "utf8");
  const jwt = buildJwt();

  const res = await fetch("https://api.appstoreconnect.apple.com/v1/certificates", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "certificates",
        attributes: {
          certificateType: "DEVELOPER_ID_APPLICATION",
          csrContent,
        },
      },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error(`Apple API error (${res.status}):`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const attrs = body.data.attributes;
  writeFileSync(outPath, Buffer.from(attrs.certificateContent, "base64"));
  console.log(`Certificate written to ${outPath}`);
  console.log(`type: ${attrs.certificateType}  serial: ${attrs.serialNumber ?? "n/a"}`);
  console.log(`expires: ${attrs.expirationDate ?? "n/a"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

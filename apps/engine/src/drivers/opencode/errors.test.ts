import { expect, test } from "bun:test";
import { openCodeFailure, openCodeFailureText } from "./errors";

test("THE LIVE FAILURE: a token-refresh 401 says what happened and what to do", () => {
  const failure = openCodeFailure({ name: "UnknownError", data: { message: "Token refresh failed: 401" } });
  expect(failure).toEqual({
    name: "UnknownError",
    message: "Token refresh failed: 401",
    hint: "Reconnect this provider in OpenCode (opencode auth login).",
  });
  expect(openCodeFailureText(failure!)).toBe(
    "OpenCode: UnknownError: Token refresh failed: 401. Reconnect this provider in OpenCode (opencode auth login).",
  );
});

test("ProviderAuthError keeps the connection id — which provider failed, when several are configured", () => {
  const failure = openCodeFailure({
    name: "ProviderAuthError",
    data: { providerID: "openai", message: "No credentials found for openai" },
  });
  expect(failure?.providerID).toBe("openai");
  expect(failure?.hint).toBe("Reconnect this provider in OpenCode (opencode auth login).");
  expect(openCodeFailureText(failure!)).toContain("OpenCode (openai): ProviderAuthError");
});

test("an APIError NEVER carries response headers or body — the allow-list, not a redactor", () => {
  const failure = openCodeFailure({
    name: "APIError",
    data: {
      message: "Rate limit reached for gpt-6-astra",
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { authorization: "Bearer sk-live-REALTOKENVALUE0123456789", "set-cookie": "session=abc" },
      responseBody: '{"error":{"message":"quota","key":"sk-live-REALTOKENVALUE0123456789"}}',
    },
  });
  const rendered = JSON.stringify(failure) + openCodeFailureText(failure!);
  expect(rendered).not.toContain("REALTOKENVALUE");
  expect(rendered).not.toContain("set-cookie");
  expect(rendered).not.toContain("responseBody");
  expect(rendered).not.toContain("Bearer");
  expect(failure?.statusCode).toBe(429);
  expect(failure?.hint).toBe("Rate limited. Wait and try again, or switch model.");
});

test("a secret embedded in the MESSAGE itself is redacted — the second lock", () => {
  const failure = openCodeFailure({
    name: "UnknownError",
    data: { message: "Auth failed for key sk-live-ABCDEFGHIJKLMNOPQRST and Bearer eyJhbGciOi.eyJzdWIiOi.QQQQQQQQ" },
  });
  expect(failure?.message).toContain("[redacted]");
  expect(failure?.message).not.toContain("ABCDEFGHIJKLMNOPQRST");
  expect(failure?.message).not.toContain("eyJhbGciOi");
});

test("an unavailable model reads as one, from the status and from the sentence", () => {
  const byStatus = openCodeFailure({ name: "APIError", data: { message: "not found", statusCode: 404, isRetryable: false } });
  expect(byStatus?.hint).toBe("This model is not available on the connection. Pick another in the model picker.");
  const bySentence = openCodeFailure({ name: "UnknownError", data: { message: "unknown model: openai/gpt-6-astra" } });
  expect(bySentence?.hint).toBe("This model is not available on the connection. Pick another in the model picker.");
});

test("MessageOutputLengthError has no message field at all and still reports usefully", () => {
  const failure = openCodeFailure({ name: "MessageOutputLengthError", data: {} });
  expect(failure?.message).toBeUndefined();
  expect(failure?.hint).toBe("The reply hit the model's output limit. Ask for a shorter answer, or split the task.");
  expect(openCodeFailureText(failure!)).toBe(
    "OpenCode: MessageOutputLengthError. The reply hit the model's output limit. Ask for a shorter answer, or split the task.",
  );
});

test("a STOP is not offered a remedy — nothing went wrong", () => {
  const failure = openCodeFailure({ name: "MessageAbortedError", data: { message: "aborted" } });
  expect(failure?.hint).toBeUndefined();
});

test("an unrecognised shape falls back without inventing anything", () => {
  expect(openCodeFailure({ name: "SomeNewError", data: {} })).toEqual({ name: "SomeNewError" });
  expect(openCodeFailure({ name: { evil: true }, data: { message: "x" } })?.name).toBe("UnknownError");
  expect(openCodeFailure(undefined)).toBeUndefined();
});

test("the message is BOUNDED, and truncation cannot expose the front of a secret", () => {
  const long = `${"a".repeat(500)} sk-live-ABCDEFGHIJKLMNOPQRST`;
  const failure = openCodeFailure({ name: "UnknownError", data: { message: long } });
  expect(failure!.message!.length).toBeLessThanOrEqual(300);
  expect(failure?.message).not.toContain("sk-live-A");
});

test("a hostile providerID cannot smuggle prose into the line", () => {
  const failure = openCodeFailure({
    name: "ProviderAuthError",
    data: { providerID: "openai — Bearer sk-live-ABCDEFGHIJKLMNOPQRST", message: "nope" },
  });
  expect(failure?.providerID).toBeUndefined();
  expect(openCodeFailureText(failure!)).not.toContain("Bearer");
});

test("a nonsense statusCode is dropped rather than rendered", () => {
  expect(openCodeFailure({ name: "APIError", data: { message: "x", statusCode: 99 } })?.statusCode).toBeUndefined();
  expect(openCodeFailure({ name: "APIError", data: { message: "x", statusCode: "401" } })?.statusCode).toBeUndefined();
});

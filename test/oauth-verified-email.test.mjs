import assert from "node:assert/strict";
import test from "node:test";

import {
  default as callbackHandler,
  verifiedGoogleEmail,
} from "../api/auth/callback.js";
import { createOAuthState } from "../api/_auth.js";

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    end(body = "") {
      this.body = String(body);
      this.ended = true;
      return this;
    },
  };
}

function preserveEnv(names) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("Google identity accepts only a nonempty email with boolean verification", () => {
  assert.equal(
    verifiedGoogleEmail({ email: " Person@Example.com ", email_verified: true }),
    "person@example.com"
  );
  assert.equal(
    verifiedGoogleEmail({ email: "person@example.com", email_verified: false }),
    null
  );
  assert.equal(
    verifiedGoogleEmail({ email: "person@example.com", email_verified: "true" }),
    null
  );
  assert.equal(verifiedGoogleEmail({ email_verified: true }), null);
});

test("OAuth callback rejects an unverified Google email before creating a session", async () => {
  const restoreEnv = preserveEnv([
    "AUTH_SECRET",
    "NEXTAUTH_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ]);
  const priorFetch = globalThis.fetch;
  try {
    process.env.AUTH_SECRET = "oauth-verification-test-secret-value-123456";
    delete process.env.NEXTAUTH_SECRET;
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          async json() {
            return { access_token: "test-access-token" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            sub: "google-subject",
            email: "member@example.com",
            email_verified: false,
          };
        },
      };
    };

    const state = createOAuthState();
    const req = {
      method: "GET",
      url: `/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      headers: {
        host: "bigbricey.com",
        "x-forwarded-proto": "https",
        cookie: `bigbricey_oauth_state=${encodeURIComponent(state)}`,
      },
    };
    const res = responseRecorder();
    await callbackHandler(req, res);

    assert.equal(calls, 2);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body), { error: "google_email_not_verified" });
    const setCookie = res.getHeader("Set-Cookie");
    assert.equal(typeof setCookie, "string");
    assert.doesNotMatch(setCookie, /bigbricey_session=/);
    assert.match(setCookie, /bigbricey_oauth_state=/);
  } finally {
    globalThis.fetch = priorFetch;
    restoreEnv();
  }
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  GITHUB_PROVIDER,
  mintAgentKeyWithAccessToken,
  pollForToken,
  refreshAccessTokenWithRefreshToken,
  requestDeviceCode,
} from "../../dist/lib/oauth-device-code";

describe("pollForToken", () => {
  it("rejects successful token responses missing an access token", async () => {
    await expect(
      pollForToken(
        {
          device_code: "device-1",
          user_code: "USER-1",
          verification_uri: "https://portal.example/verify",
          expires_in: 900,
          interval: 1,
        },
        {
          sleep: async () => {},
          log: () => {},
          fetch: (async () =>
            new Response(
              JSON.stringify({
                refresh_token: "refresh-1",
                expires_in: 900,
                token_type: "Bearer",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )) as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({
      name: "OAuthError",
      code: "token_response_missing_tokens",
    });
  });
});

describe("refreshAccessTokenWithRefreshToken", () => {
  it("sends the refresh token in x-nous-refresh-token instead of the form body", async () => {
    const calls: Array<{
      url: string;
      body: string;
      refreshHeader: string | null;
      signal: AbortSignal | null;
    }> = [];
    const token = await refreshAccessTokenWithRefreshToken("refresh-1", {
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          body: String(init?.body ?? ""),
          refreshHeader: headers.get("x-nous-refresh-token"),
          signal: init?.signal instanceof AbortSignal ? init.signal : null,
        });
        return new Response(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 900,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(token.access_token).toBe("access-2");
    expect(token.refresh_token).toBe("refresh-2");
    expect(calls[0]?.url).toBe(
      "https://portal.nousresearch.com/api/oauth/token",
    );
    expect(new URLSearchParams(calls[0]?.body).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(new URLSearchParams(calls[0]?.body).get("refresh_token")).toBeNull();
    expect(calls[0]?.refreshHeader).toBe("refresh-1");
    expect(new URLSearchParams(calls[0]?.body).get("client_id")).toBe(
      "hermes-cli",
    );
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces refresh-token grant errors", async () => {
    await expect(
      refreshAccessTokenWithRefreshToken("bad-refresh", {
        fetch: (async () =>
          new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "refresh token expired",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "OAuthError",
      code: "invalid_grant",
      description: "refresh token expired",
    });
  });
});

describe("mintAgentKeyWithAccessToken", () => {
  it("mints a short-lived agent key with Authorization bearer auth", async () => {
    const calls: Array<{
      url: string;
      auth: string | null;
      body: string;
      signal: AbortSignal | null;
    }> = [];
    const key = await mintAgentKeyWithAccessToken("access-1", {
      minTtlSeconds: 120,
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          auth: headers.get("authorization"),
          body: String(init?.body ?? ""),
          signal: init?.signal instanceof AbortSignal ? init.signal : null,
        });
        return new Response(
          JSON.stringify({
            api_key: "agent-key-1",
            key_id: "key-1",
            expires_in: 1800,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(key.api_key).toBe("agent-key-1");
    expect(calls[0]?.url).toBe(
      "https://portal.nousresearch.com/api/oauth/agent-key",
    );
    expect(calls[0]?.auth).toBe("Bearer access-1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      min_ttl_seconds: 120,
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GitHub provider (multi-provider device flow)", () => {
  it("requests the device code from the GitHub App endpoint", async () => {
    const calls: string[] = [];
    await requestDeviceCode({
      provider: GITHUB_PROVIDER,
      clientId: "gh-client",
      fetch: (async (url) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(calls[0]).toBe("https://github.com/login/device/code");
  });

  it("accepts a token response without a refresh_token (expiring tokens off)", async () => {
    const calls: string[] = [];
    const token = await pollForToken(
      {
        device_code: "d",
        user_code: "U",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      },
      {
        provider: GITHUB_PROVIDER,
        clientId: "gh-client",
        sleep: async () => {},
        log: () => {},
        fetch: (async (url) => {
          calls.push(String(url));
          return new Response(
            JSON.stringify({
              access_token: "gho_x",
              expires_in: 28800,
              token_type: "bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
      },
    );

    expect(calls[0]).toBe("https://github.com/login/oauth/access_token");
    expect(token.access_token).toBe("gho_x");
    expect(token.refresh_token).toBeUndefined();
  });

  it("refreshes via the body form with client_secret and no Nous header", async () => {
    const calls: Array<{ url: string; body: string; nousHeader: string | null }> = [];
    const token = await refreshAccessTokenWithRefreshToken("ghr_1", {
      provider: GITHUB_PROVIDER,
      clientId: "gh-client",
      clientSecret: "gh-secret",
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          body: String(init?.body ?? ""),
          nousHeader: headers.get("x-nous-refresh-token"),
        });
        return new Response(
          JSON.stringify({
            access_token: "gho_2",
            refresh_token: "ghr_2",
            expires_in: 28800,
            token_type: "bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(token.access_token).toBe("gho_2");
    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ghr_1");
    expect(body.get("client_secret")).toBe("gh-secret");
    expect(body.get("client_id")).toBe("gh-client");
    expect(calls[0]?.nousHeader).toBeNull();
  });
});

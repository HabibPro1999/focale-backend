import { describe, expect, it } from "vitest";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { trustedProxyAddresses } from "./app.factory";

describe("TRUST_PROXY", () => {
  it("requires an explicit proxy configuration in production", () => {
    expect(() => trustedProxyAddresses({ NODE_ENV: "production" })).toThrow(
      /TRUST_PROXY is required in production/,
    );
    expect(() =>
      trustedProxyAddresses({ NODE_ENV: "production", TRUST_PROXY: " " }),
    ).toThrow(/actual proxy peer addresses/);
  });

  it.each([
    ["127.0.0.1", ["127.0.0.1"]],
    ["10.0.0.0/24, 2001:db8::1", ["10.0.0.0/24", "2001:db8::1"]],
  ])("parses explicit proxy addresses %s", (value, addresses) => {
    expect(
      trustedProxyAddresses({ NODE_ENV: "production", TRUST_PROXY: value }),
    ).toEqual(addresses);
  });

  it.each([
    "0",
    "1",
    "2",
    "true",
    "*",
    "loopback",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "not-an-ip",
    "127.0.0.1,",
    "127.0.0.1,,192.0.2.1",
  ])("rejects unsafe or invalid proxy trust value %s", (value) => {
    expect(() =>
      trustedProxyAddresses({ NODE_ENV: "production", TRUST_PROXY: value }),
    ).toThrow(/TRUST_PROXY/);
  });

  it("allows an explicit no-proxy production mode", () => {
    expect(
      trustedProxyAddresses({ NODE_ENV: "production", TRUST_PROXY: "false" }),
    ).toBe(false);
  });

  it.each(["development", "test"])(
    "uses the socket address in %s when unset",
    (NODE_ENV) => {
      expect(trustedProxyAddresses({ NODE_ENV })).toBe(false);
    },
  );

  it("defaults to no trusted proxies when NODE_ENV is unset", () => {
    expect(trustedProxyAddresses({})).toBe(false);
  });

  it("honors X-Forwarded-For only from a configured immediate peer", async () => {
    const trustedPeerFastify = new FastifyAdapter({
      trustProxy: trustedProxyAddresses({
        NODE_ENV: "test",
        TRUST_PROXY: "127.0.0.0/8",
      }),
    }).getInstance();
    trustedPeerFastify.get("/client-ip", async (request) => ({ ip: request.ip }));

    const untrustedPeerFastify = new FastifyAdapter({
      trustProxy: trustedProxyAddresses({
        NODE_ENV: "test",
        TRUST_PROXY: "192.0.2.1",
      }),
    }).getInstance();
    untrustedPeerFastify.get("/client-ip", async (request) => ({ ip: request.ip }));

    try {
      const headers = { "x-forwarded-for": "198.51.100.24" };
      const trustedResponse = await trustedPeerFastify.inject({
        method: "GET",
        url: "/client-ip",
        remoteAddress: "127.0.0.1",
        headers,
      });
      const untrustedResponse = await untrustedPeerFastify.inject({
        method: "GET",
        url: "/client-ip",
        remoteAddress: "203.0.113.9",
        headers,
      });

      expect(trustedResponse.json()).toEqual({ ip: "198.51.100.24" });
      expect(untrustedResponse.json()).toEqual({ ip: "203.0.113.9" });
    } finally {
      await Promise.all([
        trustedPeerFastify.close(),
        untrustedPeerFastify.close(),
      ]);
    }
  });
});

describe("unit-test environment", () => {
  it("replaces an inherited database URL with the local dummy URL", () => {
    expect(process.env.DATABASE_URL).toBe(
      "postgresql://test_user:test_password@localhost:5432/focale_unit_test",
    );
  });
});

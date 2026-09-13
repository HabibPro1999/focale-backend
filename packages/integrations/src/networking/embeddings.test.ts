import { describe, expect, it, vi } from "vitest";
import {
  NetworkingEmbeddingClient,
  profileEmbeddingInput,
  NETWORKING_EMBEDDING_DIMENSIONS,
} from "./embeddings";

const profile = {
  company: "Example",
  jobTitle: "Founder",
  sector: "Healthcare",
  bio: "Medical imaging",
  city: "Tunis",
  country: "Tunisia",
  interests: ["Radiology"],
  offers: "Clinical pilot sites",
  seeks: "Seed funding",
  email: "private@example.com",
  phone: "private-phone",
};
const vector = (index: number) =>
  Array.from({ length: NETWORKING_EMBEDDING_DIMENSIONS }, (_, i) =>
    i === index ? 1 : 0,
  );

describe("networking embeddings", () => {
  it("separates complementary needs and offers and excludes private contact fields", () => {
    const result = profileEmbeddingInput(profile);
    expect(result.documents.find((value) => value.kind === "NEED")?.text).toBe(
      "Seed funding",
    );
    expect(result.documents.find((value) => value.kind === "OFFER")?.text).toBe(
      "Clinical pilot sites",
    );
    expect(JSON.stringify(result)).not.toContain(profile.email);
    expect(JSON.stringify(result)).not.toContain(profile.phone);
    expect(
      profileEmbeddingInput({ ...profile, seeks: "Distribution partners" })
        .hash,
    ).not.toBe(result.hash);
    const changedEmail = { ...profile, email: "other@example.com" };
    expect(profileEmbeddingInput(changedEmail).hash).toBe(result.hash);
  });
  it("validates and restores the provider's embedding batch order", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector(1) },
            { index: 0, embedding: vector(0) },
          ],
        }),
      ),
    );
    const client = new NetworkingEmbeddingClient({
      apiKey: "test-key",
      fetch: transport,
    });
    const result = await client.embed(["Need", "Offer"]);
    expect(result).toEqual([vector(0), vector(1)]);
    expect(JSON.parse(transport.mock.calls[0]![1].body)).toMatchObject({
      dimensions: 1536,
      encoding_format: "float",
      model: "text-embedding-3-small",
    });
  });
  it("rejects duplicate indexes and invalid vectors", async () => {
    const client = new NetworkingEmbeddingClient({
      apiKey: "test-key",
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: vector(0) },
              { index: 0, embedding: vector(1) },
            ],
          }),
        ),
      ),
    });
    await expect(client.embed(["Need", "Offer"])).rejects.toThrow(
      "Invalid embedding response shape",
    );
  });
  it("does not expose provider bodies containing sensitive data", async () => {
    const client = new NetworkingEmbeddingClient({
      apiKey: "test-key",
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response("private profile text", { status: 429 }),
        ),
    });
    await expect(client.embed(["Example"])).rejects.toThrow(
      "Embedding provider returned HTTP 429",
    );
  });
  it("requires a secure external provider URL", () => {
    expect(
      () =>
        new NetworkingEmbeddingClient({
          apiKey: "test-key",
          baseUrl: "http://public.example.com/v1",
        }),
    ).toThrow("HTTPS");
  });
});

import { createHash } from "node:crypto";
import { networkingConfig } from "../config";

export const NETWORKING_EMBEDDING_DIMENSIONS = 1536;
export const NETWORKING_EMBEDDING_VERSION = 1;
export type EmbeddingKind = "PROFILE" | "OFFER" | "NEED";
export interface EmbeddableProfile {
  company: string;
  jobTitle: string;
  sector: string;
  bio: string;
  city: string;
  country: string;
  interests: string[];
  offers: string;
  seeks: string;
}
export interface ProfileEmbeddingInput {
  hash: string;
  documents: Array<{ kind: EmbeddingKind; text: string }>;
}

function boundedEmbeddingText(value: string): string {
  let text = "";
  let bytes = 0;
  for (const character of value.normalize("NFKC")) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 6000) break;
    text += character;
  }
  return text;
}

/** Only professional fields selected for networking leave the application. */
export function profileEmbeddingInput(
  profile: EmbeddableProfile,
): ProfileEmbeddingInput {
  const context = [profile.jobTitle, profile.sector, profile.company]
    .filter(Boolean)
    .join("; ");
  const documents = (
    [
      {
        kind: "PROFILE",
        text:
          [
            context,
            profile.bio,
            profile.interests.join("; "),
            profile.city,
            profile.country,
          ]
            .filter(Boolean)
            .join("\n") || "Professional event participant",
      },
      {
        kind: "OFFER",
        text: profile.offers.trim() || "No professional offering specified",
      },
      {
        kind: "NEED",
        text: profile.seeks.trim() || "No professional need specified",
      },
    ] satisfies ProfileEmbeddingInput["documents"]
  ).map((document) => ({
    ...document,
    text: boundedEmbeddingText(document.text),
  }));
  return {
    documents,
    hash: createHash("sha256")
      .update(
        JSON.stringify({ version: NETWORKING_EMBEDDING_VERSION, documents }),
      )
      .digest("hex"),
  };
}

export interface EmbeddingClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}
export class NetworkingEmbeddingClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;
  constructor(private readonly options: EmbeddingClientOptions) {
    this.model = options.model || "text-embedding-3-small";
    const url = new URL(options.baseUrl || "https://api.openai.com/v1");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    ) {
      throw new Error("Embedding endpoint must use HTTPS");
    }
    if (url.username || url.password)
      throw new Error("Embedding endpoint must not include credentials");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.transport = options.fetch || fetch;
  }
  async embed(documents: string[]): Promise<number[][]> {
    if (!this.options.apiKey)
      throw new Error("Networking embeddings are not configured");
    if (
      !documents.length ||
      documents.length > 96 ||
      documents.some(
        (document) =>
          !document.trim() || Buffer.byteLength(document, "utf8") > 6000,
      )
    ) {
      throw new Error("Invalid embedding batch");
    }
    const response = await this.transport(`${this.baseUrl}/embeddings`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: documents,
        encoding_format: "float",
        dimensions: NETWORKING_EMBEDDING_DIMENSIONS,
      }),
    });
    // Never put provider error bodies, request text, or credentials in queue logs.
    if (!response.ok)
      throw new Error(`Embedding provider returned HTTP ${response.status}`);
    const payload = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    if (
      !Array.isArray(payload.data) ||
      payload.data.length !== documents.length
    )
      throw new Error("Invalid embedding response count");
    const seen = new Set<number>();
    const vectors = new Array<number[]>(documents.length);
    for (const row of payload.data) {
      if (
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index >= documents.length ||
        seen.has(row.index) ||
        !Array.isArray(row.embedding) ||
        row.embedding.length !== NETWORKING_EMBEDDING_DIMENSIONS ||
        row.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("Invalid embedding response shape");
      }
      const norm = Math.hypot(...row.embedding);
      if (norm === 0)
        throw new Error("Embedding provider returned a zero vector");
      vectors[row.index] = row.embedding.map((value) => value / norm);
      seen.add(row.index);
    }
    return vectors;
  }
}

export function configuredNetworkingEmbeddingClient(): NetworkingEmbeddingClient | null {
  const { apiKey, model, baseUrl } = networkingConfig().embedding;
  if (!apiKey) return null;
  return new NetworkingEmbeddingClient({ apiKey, model, baseUrl });
}

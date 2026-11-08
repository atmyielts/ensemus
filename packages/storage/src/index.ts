// S3-compatible object storage, so the same code runs against any approved store (ADR-017, ADR-021).
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type StorageConfig = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** How long one request may take. Only tests have a reason to set this. */
  requestTimeoutMs?: number;
  /** How many times the client tries. A caller that has its own retries can ask for just one. */
  maxAttempts?: number;
};

/**
 * One request, connecting included, gets this long, and the client tries at most this many times.
 * These bound the caller's wait; a failed or timed-out request can still have an ambiguous provider
 * outcome. Durable writer/deletion receipts must settle that ambiguity before replay or completion.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;

/** Implements the ObjectStore port from @ensemus/application. */
export class S3ObjectStore {
  readonly #client: S3Client;
  readonly #deleteClient: S3Client;
  readonly #bucket: string;

  constructor(config: StorageConfig) {
    this.#bucket = config.bucket;
    const options = {
      endpoint: config.endpoint,
      region: 'us-east-1', // Required by the SDK, and unused by self-hosted stores.
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      maxAttempts: config.maxAttempts ?? MAX_ATTEMPTS,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    };
    this.#client = new S3Client(options);
    // A rejected first DELETE may still complete at the provider. An implicit SDK retry could
    // hide that unresolved operation behind a second success, so destructive transport never retries.
    this.#deleteClient = new S3Client({ ...options, maxAttempts: 1 });
  }

  /** Run by the one-shot setup job, never by a request. */
  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch {
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: body, ContentType: mimeType }),
    );
  }

  async get(key: string, maxBytes?: number): Promise<Buffer> {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new Error('INVALID_OBJECT_LIMIT');
    }
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    if (maxBytes !== undefined) {
      const body = response.Body as
        (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        body?.destroy?.();
        throw new Error('OBJECT_NOT_STREAMABLE');
      }
      try {
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
          throw new Error('OBJECT_TOO_LARGE');
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error('OBJECT_TOO_LARGE');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, size);
      } finally {
        // An over-limit or interrupted read cannot keep consuming bytes in the background.
        body.destroy?.();
      }
    }
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new Error('Object has no body');
    return Buffer.from(bytes);
  }

  close(): void {
    this.#client.destroy();
    this.#deleteClient.destroy();
  }

  async delete(key: string): Promise<void> {
    await this.#deleteClient.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  /** The keys under a prefix, a page at a time, so a caller holds at most one page in memory. */
  async *listPages(prefix: string): AsyncGenerator<string[]> {
    let token: string | undefined;
    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      yield (response.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
  }

  /** Only a clear "not there" counts as gone. Any other failure is thrown, and retried later. */
  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
      if (status?.httpStatusCode === 404) return false;
      throw error;
    }
  }
}

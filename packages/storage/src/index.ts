// S3-compatible object storage, so the same code runs against any approved store (ADR-017, ADR-021).
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
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
};

/**
 * One request, connecting included, gets this long, and the client tries at most this many times.
 * Together they stay well under the 2 minutes a workflow Activity has, so an Activity that timed out
 * is not still uploading while its retry runs. A file is at most 25 MB, on the private network.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;

/** Implements the ObjectStore port from @ensemus/application. */
export class S3ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: StorageConfig) {
    this.#bucket = config.bucket;
    this.#client = new S3Client({
      endpoint: config.endpoint,
      region: 'us-east-1', // Required by the SDK, and unused by self-hosted stores.
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: MAX_ATTEMPTS,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    });
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

  async get(key: string): Promise<Buffer> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new Error('Object has no body');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
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

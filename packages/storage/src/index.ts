// S3-compatible object storage, so the same code runs against any approved store (ADR-017, ADR-021).
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type StorageConfig = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
};

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
      maxAttempts: 3,
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
}

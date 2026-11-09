// S3-compatible object storage, so the same code runs against any approved store (ADR-017, ADR-021).
import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
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

const VERSIONING_RESPONSE_LIMIT = 4096;
// This is an intentionally narrow protocol recognizer, not a general XML parser. A genuinely
// unversioned S3 bucket returns an empty VersioningConfiguration. Reject alternative roots,
// attributes, children, entities and DTD declarations rather than guessing a compatible capability.
const EMPTY_VERSIONING_CONFIGURATION =
  /^(?:<\?xml[\t\r\n ]+version=(?:"1\.0"|'1\.0')(?:[\t\r\n ]+encoding=(?:"UTF-8"|'UTF-8'))?[\t\r\n ]*\?>[\t\r\n ]*)?<VersioningConfiguration[\t\r\n ]+xmlns=(?:"http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/"|'http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/')[\t\r\n ]*(?:\/>|>[\t\r\n ]*<\/VersioningConfiguration[\t\r\n ]*>)[\t\r\n ]*$/u;
const physicalAbsenceUnproven = () => new Error('OBJECT_PHYSICAL_ABSENCE_UNPROVEN');

async function versioningResponseBytes(body: unknown, signal: AbortSignal): Promise<Buffer> {
  if (
    !body ||
    typeof body !== 'object' ||
    !(Symbol.asyncIterator in body) ||
    !('destroy' in body) ||
    typeof body.destroy !== 'function'
  )
    throw physicalAbsenceUnproven();
  const stream = body as AsyncIterable<unknown> & { destroy: (error?: Error) => void };
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => stream.destroy(physicalAbsenceUnproven());
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw physicalAbsenceUnproven();
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw physicalAbsenceUnproven();
      size += chunk.byteLength;
      if (size > VERSIONING_RESPONSE_LIMIT) throw physicalAbsenceUnproven();
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
  return Buffer.concat(chunks, size);
}

/** Implements the ObjectStore port from @ensemus/application. */
export class S3ObjectStore {
  readonly #client: S3Client;
  readonly #mutationClient: S3Client;
  readonly #bucket: string;
  readonly #capabilityTimeoutMs: number;

  constructor(config: StorageConfig) {
    this.#bucket = config.bucket;
    const timeout = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('INVALID_STORAGE_TIMEOUT');
    this.#capabilityTimeoutMs = Math.min(timeout, REQUEST_TIMEOUT_MS);
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
    this.#mutationClient = new S3Client({ ...options, maxAttempts: 1 });
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

  /** A future native raw writer owns the durable admission before reaching this method. General
   * put() deliberately retains its old contract; legacy/derived/archive receipts are not upgraded. */
  async putSingleAttempt(
    key: string,
    body: Buffer,
    mimeType: string,
  ): Promise<{ transport: 'written' | 'unknown' }> {
    const captured = Buffer.from(body);
    try {
      const result = await this.#mutationClient.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: captured,
          ContentType: mimeType,
          ContentMD5: createHash('md5').update(captured).digest('base64'),
        }),
      );
      // Native S3 PutObject returns200 and an ETag. This is a storage-contract observation, not
      // a SQL-independent provider attestation or an inventory of historical PUT attempts.
      return {
        transport:
          result.$metadata.httpStatusCode === 200 &&
          typeof result.ETag === 'string' &&
          result.ETag.length > 0 &&
          result.ETag.length <= 1024
            ? 'written'
            : 'unknown',
      };
    } catch {
      return { transport: 'unknown' };
    }
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
    this.#mutationClient.destroy();
  }

  async delete(key: string): Promise<void> {
    const result = await this.deleteForPurge(key);
    if (result.transport !== 'deleted' || !result.capabilityVerified)
      throw physicalAbsenceUnproven();
  }

  async deleteForPurge(key: string): Promise<{
    transport: 'not_attempted' | 'deleted' | 'unknown';
    capabilityVerified: boolean;
  }> {
    try {
      await this.#assertUnversionedBucket();
    } catch {
      return { transport: 'not_attempted', capabilityVerified: false };
    }
    let result;
    try {
      result = await this.#mutationClient.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch {
      // A timeout, SDK/HTTP error or disconnected response may still have removed bytes. No retry.
      return { transport: 'unknown', capabilityVerified: false };
    }
    // The modeled operation is HTTP 204. An unrelated 2xx response is not a known completed DELETE.
    if (result.$metadata.httpStatusCode !== 204)
      return { transport: 'unknown', capabilityVerified: false };
    let capabilityVerified = result.DeleteMarker !== true && result.VersionId === undefined;
    try {
      await this.#assertUnversionedBucket();
    } catch {
      capabilityVerified = false;
    }
    // Enabling versioning cannot later return to the never-enabled state in S3: suspended is also
    // refused. Keep the genuine completed transport separate from a failed capability post-check.
    return { transport: 'deleted', capabilityVerified };
  }

  /**
   * The same capability check deleteForPurge makes first, on its own and with no object request. A
   * caller asks this before it durably admits a deletion, so an unreachable or versioned store refuses
   * before any claim exists, instead of leaving an admitted claim no later DELETE may replay.
   */
  async assertPurgeCapability(): Promise<void> {
    await this.#assertUnversionedBucket();
  }

  /** A current-key HEAD is insufficient in versioned stores, where old versions retain the bytes. */
  async isPhysicallyAbsent(key: string): Promise<boolean> {
    await this.#assertUnversionedBucket();
    const absent = !(await this.exists(key));
    await this.#assertUnversionedBucket();
    return absent;
  }

  async #assertUnversionedBucket(): Promise<void> {
    const command = new GetBucketVersioningCommand({ Bucket: this.#bucket });
    const abort = new AbortController();
    // The Node HTTP handler can return after headers. Bound the complete small protocol response,
    // including a backend that sends headers/partial XML and then never finishes its body.
    const timer = setTimeout(() => abort.abort(), this.#capabilityTimeoutMs);
    let recognizedResponse = false;
    // The pinned SDK discards the XML root before mapping known children. Without this raw check,
    // a backend that ignores ?versioning and returns ListBucketResult can look like Status absent.
    command.middlewareStack.add(
      (next) => async (args) => {
        recognizedResponse = false;
        const result = await next(args);
        const response = result.response as {
          statusCode?: number;
          headers?: Record<string, string>;
          body?: unknown;
        };
        if (
          response.statusCode !== 200 ||
          !/^(?:application|text)\/xml(?:\s*;|$)/iu.test(response.headers?.['content-type'] ?? '')
        ) {
          (response.body as { destroy?: () => void } | undefined)?.destroy?.();
          throw physicalAbsenceUnproven();
        }
        const bytes = await versioningResponseBytes(response.body, abort.signal);
        let xml: string;
        try {
          xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw physicalAbsenceUnproven();
        }
        if (!EMPTY_VERSIONING_CONFIGURATION.test(xml)) throw physicalAbsenceUnproven();
        response.body = bytes;
        recognizedResponse = true;
        return result;
      },
      {
        name: 'validateVersioningConfiguration',
        step: 'deserialize',
        // The pinned native deserializer has normal priority. This lower-priority inner handler
        // validates/restores the raw response before the native outer handler parses it.
        priority: 'low',
      },
    );
    try {
      const result = await this.#mutationClient.send(command, { abortSignal: abort.signal });
      if (
        !recognizedResponse ||
        result.$metadata.httpStatusCode !== 200 ||
        result.Status !== undefined ||
        result.MFADelete !== undefined
      )
        throw physicalAbsenceUnproven();
    } finally {
      clearTimeout(timer);
    }
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

  /** Current-key visibility only. Physical purge must use isPhysicallyAbsent, never HEAD alone. */
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

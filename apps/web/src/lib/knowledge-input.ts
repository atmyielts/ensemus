import { AppError } from '@ensemus/application';
import { addSourceSchema } from '@ensemus/contracts/knowledge';
import { INGESTIBLE_MEDIA_TYPES, MAX_DOCUMENT_BYTES } from '@ensemus/domain/knowledge';

/** Counts actual bytes, including chunked requests. Coalescing bounds allocation count even when a
 * client sends one byte per chunk; no parser sees more than the documented file + metadata budget. */
export async function readBoundedBody(request: Request, maximum: number): Promise<Buffer> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
    throw new AppError('FILE_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('INVALID_INPUT');
  const chunks: Buffer[] = [];
  let total = 0,
    current = Buffer.allocUnsafe(Math.min(65536, maximum)),
    used = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new AppError('FILE_TOO_LARGE');
      let offset = 0;
      while (offset < value.length) {
        const count = Math.min(current.length - used, value.length - offset);
        current.set(value.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === current.length) {
          chunks.push(current);
          current = Buffer.allocUnsafe(Math.min(65536, maximum));
          used = 0;
        }
      }
    }
    if (used) chunks.push(current.subarray(0, used));
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function uploadMediaType(file: File): string {
  const stated = file.type.toLowerCase().split(';')[0]?.trim() ?? '';
  if ((INGESTIBLE_MEDIA_TYPES as readonly string[]).includes(stated)) return stated;
  // Browsers often send no MIME for Markdown/CSV. This only selects a parser; its worker must still
  // validate UTF-8 and reject binary bytes. A filename never becomes a storage path.
  if (stated && stated !== 'application/octet-stream')
    throw new AppError('KNOWLEDGE_FORMAT_UNSUPPORTED');
  const extension = file.name.toLowerCase().split('.').at(-1);
  const types: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    json: 'application/json',
  };
  const selected = extension ? types[extension] : undefined;
  if (!selected) throw new AppError('KNOWLEDGE_FORMAT_UNSUPPORTED');
  return selected;
}

export async function readKnowledgeUpload(request: Request) {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new AppError('INVALID_INPUT');
  const bytes = await readBoundedBody(request, MAX_DOCUMENT_BYTES + 65536);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), {
      headers: { 'content-type': type },
    }).formData();
  } catch {
    throw new AppError('INVALID_INPUT');
  }
  if (
    [...form.keys()].some((key) => !['metadata', 'file'].includes(key)) ||
    form.getAll('metadata').length !== 1 ||
    form.getAll('file').length !== 1
  )
    throw new AppError('INVALID_INPUT');
  const metadata = form.get('metadata'),
    file = form.get('file');
  let json: string;
  if (typeof metadata === 'string') json = metadata;
  else if (
    metadata instanceof File &&
    metadata.type === 'application/json' &&
    metadata.size <= 32768
  ) {
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(await metadata.arrayBuffer());
    } catch {
      throw new AppError('INVALID_INPUT');
    }
  } else throw new AppError('INVALID_INPUT');
  if (json.length > 32768 || !(file instanceof File)) throw new AppError('INVALID_INPUT');
  if (!file.size || file.size > MAX_DOCUMENT_BYTES)
    throw new AppError(file.size ? 'FILE_TOO_LARGE' : 'INVALID_INPUT');
  let parsed: ReturnType<typeof addSourceSchema.parse>;
  try {
    parsed = addSourceSchema.parse(JSON.parse(json));
  } catch {
    throw new AppError('INVALID_INPUT');
  }
  return {
    metadata: parsed,
    mediaType: uploadMediaType(file),
    body: Buffer.from(await file.arrayBuffer()),
  };
}

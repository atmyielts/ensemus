// One spelling for an ID. A form or a request can send one in capitals, which is still a valid UUID and
// still finds the same row, because PostgreSQL compares values. JavaScript compares text, and so do
// object keys, audit references and hashes. So an ID is put in the database's own spelling where it
// comes in, and a rule that compares two of them cannot be walked around with the shift key.
import { z } from 'zod';

/** What an ID looks like in the database. Anything that is not an ID is still refused further on. */
export const canonicalId = (id: string) => id.toLowerCase();

/** A valid ID, handed on in that spelling. */
export const idSchema = z.uuid().toLowerCase();

import { z } from 'zod';

/** The Work kernel's exact title transform, shared by copied delegated Work material. */
export const workTitleInput = z.string().trim().min(1).max(300);

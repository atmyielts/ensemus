import { handleScim } from '@/server/scim';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const handle = async (request: Request, { params }: Context) =>
  handleScim(request, (await params).id);
export const GET = handle;
export const PATCH = handle;
export const DELETE = handle;
export const PUT = handle;
export const POST = handle;

// Scans complete captured surfaces. Callers must supply actual captures; synthetic tests of this
// function are scanner evidence only. Missing/empty surfaces fail rather than making absence vacuous.
export const AI_CANARY_SURFACES = [
  'temporal-persistence',
  'service-logs',
  'audit',
  'run-api',
  'steps-api',
  'timeline-html',
  'timeline-rsc',
] as const;
export type CanarySurface = { name: string; content: string };

export function holdsEncodedCanary(content: string, canary: string): boolean {
  if (!canary) throw new Error('CANARY_EMPTY');
  const bytes = Buffer.from(canary);
  return (
    content.includes(canary) ||
    content.includes(JSON.stringify(canary).slice(1, -1)) ||
    content.toLowerCase().includes(bytes.toString('hex')) ||
    content.includes(bytes.toString('base64').replace(/=+$/, '')) ||
    content.includes(bytes.toString('base64url'))
  );
}

export function scanCanarySurfaces(
  surfaces: readonly CanarySurface[],
  canaries: readonly { id: string; value: string }[],
  required: readonly string[] = AI_CANARY_SURFACES,
) {
  if (canaries.length === 0) throw new Error('CANARY_NONE');
  if (new Set(surfaces.map((surface) => surface.name)).size !== surfaces.length) {
    throw new Error('CANARY_DUPLICATE_SURFACE');
  }
  for (const name of required) {
    const surface = surfaces.find((item) => item.name === name);
    if (!surface || !surface.content.trim()) throw new Error(`CANARY_SURFACE_MISSING:${name}`);
  }
  const found: { canary_id: string; surface: string }[] = [];
  for (const surface of surfaces)
    for (const canary of canaries) {
      if (holdsEncodedCanary(surface.content, canary.value)) {
        found.push({ canary_id: canary.id, surface: surface.name });
      }
    }
  // No canary value, source text or captured content appears in the report.
  return { surfaces: surfaces.map((surface) => surface.name), found, passed: found.length === 0 };
}

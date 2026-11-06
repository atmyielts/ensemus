/** Destructive rehearsal cleanup must never inherit a site's ordinary Compose project. */
export function disposableAirgapProject(configured, pid = process.pid) {
  const project = configured ?? `ensemus-airgap-${pid}`;
  if (!/^ensemus-(?:(?:m[0-9]+-)?airgap|gates|ci)(?:-[a-z0-9]+)*$/.test(project)) {
    throw new Error(
      'Air-gap rehearsal requires an explicitly disposable ensemus airgap/gates/ci project. No cleanup was performed.',
    );
  }
  return project;
}

/** Scan and sign the images actually built for this rehearsal, including isolated image namespaces. */
export function releaseImages(env = process.env) {
  return {
    web: env.ENSEMUS_WEB_IMAGE?.trim() || 'ensemus/web:local',
    worker: env.ENSEMUS_WORKER_IMAGE?.trim() || 'ensemus/worker:local',
  };
}

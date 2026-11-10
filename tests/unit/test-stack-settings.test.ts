import { describe, expect, it } from 'vitest';
import {
  disposableAirgapProject,
  releaseImages,
} from '../../infrastructure/scripts/test-stack-settings.mjs';

describe('disposable rehearsal resources', () => {
  it('chooses an owned default and rejects ordinary or unrelated projects before cleanup', () => {
    expect(disposableAirgapProject(undefined, 123)).toBe('ensemus-airgap-123');
    for (const value of [
      'ensemus',
      'ensemus-m4-stack',
      'production',
      '',
      'ensemus-airgap/../live',
      'ENSEMUS-ci',
    ])
      expect(() => disposableAirgapProject(value)).toThrow('No cleanup was performed');
  });
  it('accepts isolated manual, CI and all-gates project names', () => {
    for (const value of [
      'ensemus-m4-airgap',
      'ensemus-airgap-123',
      'ensemus-ci-stack',
      'ensemus-ci-connectors',
      'ensemus-gates-123',
    ])
      expect(disposableAirgapProject(value)).toBe(value);
  });
  it('scans the selected images rather than stale default tags', () => {
    expect(
      releaseImages({
        ENSEMUS_WEB_IMAGE: 'ensemus-m4/web:local',
        ENSEMUS_WORKER_IMAGE: 'ensemus-m4/worker:local',
      }),
    ).toEqual({ web: 'ensemus-m4/web:local', worker: 'ensemus-m4/worker:local' });
    expect(releaseImages({ ENSEMUS_WEB_IMAGE: ' ', ENSEMUS_WORKER_IMAGE: '' })).toEqual({
      web: 'ensemus/web:local',
      worker: 'ensemus/worker:local',
    });
  });
});

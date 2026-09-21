import { describe, expect, it } from 'vitest';
import { formatRecoverableError } from '../../apps/desktop/src/renderer/api';

describe('recoverable command error copy', () => {
  it('keeps the repair action next to the stable code message', () => {
    expect(
      formatRecoverableError({
        op: 'artifact.apply_edit',
        code: 'REVISION_CONFLICT',
        message: 'Source changed during render',
        repair: 'Review the conflict candidate revision',
      }),
    ).toBe('Source changed during render — Review the conflict candidate revision');
    expect(
      formatRecoverableError({
        op: 'project.open',
        code: 'NOT_FOUND',
        message: 'Missing project',
      }),
    ).toBe('Missing project');
  });
});

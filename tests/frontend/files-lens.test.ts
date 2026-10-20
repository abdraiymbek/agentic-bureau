import { describe, expect, it } from 'vitest';
import type { ArtifactView, Revision } from '@omenflow/contracts';
import {
  PREVIEW_LIMIT_BYTES,
  baselineFiles,
  buildIssuesFromError,
  buildIssuesFromPreview,
  draftFiles,
  hasDraftWork,
  historyKey,
  previewText,
  projectFilePath,
  shortPath,
} from '../../apps/desktop/src/renderer/project/files';
import { isUnavailable } from '../../apps/desktop/src/renderer/project/optional-op';

function revision(id: string, seq: number, over: Partial<Revision> = {}): Revision {
  return {
    id,
    artifactId: 'a1',
    parentId: null,
    seq,
    origin: 'agent',
    originDetail: null,
    createdAt: '2026-10-13T12:00:00Z',
    payload: {},
    contentHash: '0'.repeat(64),
    files: [{ path: `part-r${seq}.scad`, role: 'source' }],
    inputs: [],
    rationale: '',
    reviewState: 'draft',
    ...over,
  };
}

function view(baseline: Revision | null, draftCount: number): ArtifactView {
  return {
    artifact: {
      id: 'a1',
      type: 'mechanical',
      title: 'Camera tray',
      subsystem: null,
      selectedRevisionId: baseline?.id ?? null,
      archived: false,
      createdAt: '2026-10-13T12:00:00Z',
    },
    revision: baseline,
    freshness: 'current',
    staleReasons: [],
    draftCount,
    pendingProposal: false,
  } as ArtifactView;
}

describe('working files', () => {
  const approved = revision('r2', 2, { reviewState: 'approved', parentId: 'r1' });

  it('lists approved files from the store and draft files from the newest current draft', () => {
    const v = view(approved, 1);
    expect(baselineFiles([v]).map((f) => [f.path, f.state, f.seq])).toEqual([
      ['part-r2.scad', 'approved', 2],
    ]);
    const history = [
      revision('r1', 1, { reviewState: 'superseded' }),
      approved,
      revision('r3', 3, { parentId: 'r2' }),
      revision('r4', 4, { parentId: 'r3', reviewState: 'proposed' }),
    ];
    expect(draftFiles(v, history).map((f) => [f.path, f.state, f.revisionId])).toEqual([
      ['part-r4.scad', 'proposed', 'r4'],
    ]);
  });

  it('lists the files of a draft-only object and nothing for rejected work', () => {
    const v = view(null, 1);
    expect(hasDraftWork(v)).toBe(true);
    expect(draftFiles(v, [revision('r1', 1)]).map((f) => f.state)).toEqual(['draft']);
    expect(draftFiles(v, [revision('r1', 1, { reviewState: 'rejected' })])).toEqual([]);
    expect(hasDraftWork(view(approved, 0))).toBe(false);
    expect(historyKey(view(approved, 2))).toBe('a1:r2:2:false');
  });

  it('points reveal at the file itself inside the project folder', () => {
    expect(projectFilePath('/Users/a/Rover', 'artifacts/mechanical/tray.scad')).toBe(
      '/Users/a/Rover/artifacts/mechanical/tray.scad',
    );
    expect(projectFilePath('C:\\Rover\\', 'docs/a.md')).toBe('C:\\Rover\\docs\\a.md');
    expect(shortPath('/Users/a/Projects/Sable rover', 1)).toBe('…/Sable rover');
    expect(shortPath('/Rover')).toBe('/Rover');
  });

  it('replaces cached draft files when the draft line advances with the same count and baseline', () => {
    const before = {
      ...view(approved, 1),
      head: { id: 'r3', seq: 3, reviewState: 'draft' as const },
    };
    const after = { ...before, head: { id: 'r4', seq: 4, reviewState: 'draft' as const } };
    expect(historyKey(after)).not.toBe(historyKey(before));
    expect(
      draftFiles(after, [
        approved,
        revision('r3', 3, { parentId: 'r2' }),
        revision('r4', 4, { parentId: 'r3' }),
      ]).map((file) => [file.path, file.revisionId]),
    ).toEqual([['part-r4.scad', 'r4']]);
  });

  it('previews text with lines and stops at the size limit', () => {
    const small = previewText(new TextEncoder().encode('a\nb\r\nc\n'));
    expect(small).toEqual({ lines: ['a', 'b', 'c'], truncated: false });
    const big = previewText(new Uint8Array(PREVIEW_LIMIT_BYTES + 10).fill(0x61));
    expect(big.truncated).toBe(true);
    expect(big.lines[0]).toHaveLength(PREVIEW_LIMIT_BYTES);
  });
});

describe('refused build exports', () => {
  it('reads structured issues per object from the error details', () => {
    expect(
      buildIssuesFromError({
        artifacts: [
          {
            artifactId: 'a1',
            title: 'Camera tray',
            type: 'mechanical',
            issues: [
              {
                code: 'cad_unverified',
                message: 'CAD verification: unverified',
                repair: 'Run cad_check.',
              },
            ],
          },
          { artifactId: 'a2', title: 'Clean', issues: [] },
        ],
        counts: {},
      }),
    ).toEqual([
      {
        artifactId: 'a1',
        title: 'Camera tray',
        issues: [{ message: 'CAD verification: unverified', repair: 'Run cad_check.' }],
      },
    ]);
  });

  it('reads the legacy list of preview items and the build preview itself', () => {
    const items = [
      { artifactId: 'a1', title: 'Payload capacity', issues: ['pending proposal'] },
      { artifactId: 'a2', title: 'Ready', issues: [] },
    ];
    const expected = [
      {
        artifactId: 'a1',
        title: 'Payload capacity',
        issues: [{ message: 'pending proposal', repair: null }],
      },
    ];
    expect(buildIssuesFromError(items)).toEqual(expected);
    expect(buildIssuesFromPreview({ items })).toEqual(expected);
    expect(buildIssuesFromError(undefined)).toBeNull();
    expect(buildIssuesFromError({ artifacts: [] })).toBeNull();
  });
});

describe('operations a host may not serve', () => {
  it('tells an unavailable operation from a failure', () => {
    expect(
      isUnavailable({ code: 'VALIDATION', message: 'x', details: { implementedBy: 'rust-host' } }),
    ).toBe(true);
    expect(
      isUnavailable({ code: 'VALIDATION', message: 'Unknown operation: project.coverage' }),
    ).toBe(true);
    expect(
      isUnavailable({
        code: 'VALIDATION',
        message: 'project.coverage is implemented by the Rust host',
      }),
    ).toBe(true);
    expect(isUnavailable({ code: 'NOT_FOUND', message: 'Project not open' })).toBe(false);
  });
});

import React from 'react';
import { Quotes } from '../../ui/icons';
import type { SourcePayload } from '@bureau/contracts';
import { Facts } from '../../ui/kit';
import { ExternalLink } from '../../ui/ExternalLink';
import { ArtifactFiles } from '../ArtifactFiles';
import type { StageProps } from './shared';

export function SourceStage({ view }: StageProps) {
  const rev = view.revision;
  const p = (rev?.payload ?? {}) as Partial<SourcePayload>;
  return (
    <div className="doc">
      {p.excerpt ? (
        <blockquote className="excerpt">
          <Quotes size={18} weight="fill" />
          {p.excerpt}
        </blockquote>
      ) : (
        <p className="dim">No excerpt was captured for this source.</p>
      )}
      <Facts
        rows={[
          ['Publisher', p.publisher ?? 'Unknown'],
          ['Kind', p.sourceKind ?? 'Unknown'],
          ['Captured', p.retrievedAt ? new Date(p.retrievedAt).toLocaleString() : 'Unknown'],
          ...(p.locator ? ([['Location', p.locator]] as [string, React.ReactNode][]) : []),
        ]}
      />
      {p.url && <ExternalLink url={p.url} />}
      {p.fileHash && (
        <Facts
          rows={[
            [
              'Captured file',
              <span className="mono" key="hash">
                {p.fileHash}
              </span>,
            ],
          ]}
        />
      )}
      {rev && <ArtifactFiles key={rev.id} revision={rev} files={rev.files} />}
    </div>
  );
}

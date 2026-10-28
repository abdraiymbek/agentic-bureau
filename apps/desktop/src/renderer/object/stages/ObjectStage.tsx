import React from 'react';
import type { ArtifactView } from '@bureau/contracts';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { typeMeta } from '../../ui/kit';
import { MechanicalStage } from '../MechanicalStage';
import { RevisionBanner } from '../RevisionBanner';
import { AssemblyStage } from './AssemblyStage';
import { AssumptionStage } from './AssumptionStage';
import { CalculationStage } from './CalculationStage';
import { ComponentStage } from './ComponentStage';
import { DocumentStage } from './DocumentStage';
import { RequirementStage } from './RequirementStage';
import { SourceStage } from './SourceStage';
import { TestStage } from './TestStage';
import { WiringStage } from './WiringStage';
import type { StageProps } from './shared';

function stageFor(type: ArtifactView['artifact']['type']): React.ComponentType<StageProps> {
  switch (type) {
    case 'requirement':
      return RequirementStage;
    case 'assumption':
      return AssumptionStage;
    case 'mechanical':
      return MechanicalStage;
    case 'calculation':
      return CalculationStage;
    case 'test':
      return TestStage;
    case 'wiring':
      return WiringStage;
    case 'component':
      return ComponentStage;
    case 'source':
      return SourceStage;
    case 'assembly':
      return AssemblyStage;
    default:
      return DocumentStage;
  }
}

/** Stages that do not keep to the reading measure of a document. */
const MEASURE: Partial<Record<ArtifactView['artifact']['type'], 'wide' | 'calc'>> = {
  mechanical: 'wide',
  wiring: 'wide',
  calculation: 'calc',
};

/**
 * The stage for one object, shaped by its type. `view.revision` is the revision on screen.
 * A stage that throws is contained here, so the rails, the header and the agent keep working.
 */
export function ObjectStage({ view }: StageProps) {
  const type = view.artifact.type;
  const Stage = stageFor(type);
  return (
    <ErrorBoundary label={`The ${typeMeta(type).label.toLowerCase()} stage`}>
      <div className={`stage-body stage-${MEASURE[type] ?? 'doc'}`}>
        {/* The mechanical stage places the same banner itself, under its viewport. */}
        {type !== 'mechanical' && <RevisionBanner view={view} />}
        <Stage view={view} />
      </div>
    </ErrorBoundary>
  );
}

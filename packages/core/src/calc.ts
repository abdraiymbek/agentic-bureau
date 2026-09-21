import {
  CalculationPayload,
  ErrorCodes,
  Origin,
  OmenflowError,
  convert,
  formatQty,
  isUnknown,
  newId,
  qty,
  type MaybeQuantity,
} from '@omenflow/contracts';
import type { ProjectContext } from './context.js';
import { commitRevision, createDraft } from './artifacts.js';
import { submitProposal } from './proposals.js';
import type { CalcEngine, CalcTemplate } from './tools.js';

export const CALC_EXPERIMENTAL_SCOPE =
  'Experimental: referenced source values are labels, not resolved revision fields; supplied quantities are used as given. Derived-unit inference is incomplete — declare the output unit explicitly. Do not treat results as verified engineering evidence.';

export function listTemplates(ctx: ProjectContext): CalcTemplate[] {
  return calcTool(ctx)
    .templates()
    .map((t) => ({
      ...t,
      limitations: t.limitations.includes(CALC_EXPERIMENTAL_SCOPE)
        ? t.limitations
        : [...t.limitations, CALC_EXPERIMENTAL_SCOPE],
    }));
}

function calcTool(ctx: ProjectContext): CalcEngine {
  const calc = ctx.tools.calc as CalcEngine | undefined;
  if (!calc) {
    throw new OmenflowError(ErrorCodes.TOOL_MISSING, 'Calculation engine not registered');
  }
  return calc;
}

/**
 * Run a unit-aware calculation → persisted calculation artifact draft with
 * expression, inputs+provenance, assumptions, result, and limitations.
 * If the artifact already has a baseline and submitForReview, the result
 * revision is wrapped in a proposal.
 */
export async function runCalculation(
  ctx: ProjectContext,
  input: {
    artifactId?: string;
    templateId?: string;
    expression?: string;
    inputs: {
      name: string;
      quantity: MaybeQuantity;
      sourceRef?: { artifactId: string; revisionId: string };
      literal?: boolean;
    }[];
    assumptions: string[];
    title?: string;
    submitForReview: boolean;
  },
  origin: Origin,
) {
  const calc = calcTool(ctx);
  let expression = input.expression;
  let template: CalcTemplate | undefined;
  if (input.templateId) {
    template = calc.templates().find((t) => t.id === input.templateId);
    if (!template)
      throw new OmenflowError(ErrorCodes.NOT_FOUND, `Unknown template: ${input.templateId}`);
    expression = template.expression;
    // Validate required template inputs are present.
    for (const req of template.inputs.filter((i) => i.required)) {
      const provided = input.inputs.find((i) => i.name === req.name);
      if (!provided || isUnknown(provided.quantity)) {
        throw new OmenflowError(
          ErrorCodes.INVALID_UNITS,
          `Missing required input '${req.name}' (${req.unit})`,
          {
            repair: `Supply ${req.name} in ${req.unit}.`,
          },
        );
      }
      // Dimension check against template declaration.
      const q = provided.quantity;
      if (!isUnknown(q)) convert(q as { value: number; unit: string }, req.unit);
    }
  }
  if (!expression) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      'calculation.run needs templateId or expression',
    );
  }
  for (const i of input.inputs) {
    if (isUnknown(i.quantity)) {
      throw new OmenflowError(
        ErrorCodes.INVALID_UNITS,
        `Input '${i.name}' is unknown (${(i.quantity as { reason?: string }).reason ?? 'no value'})`,
      );
    }
  }
  const firstUnit = (() => {
    const q = input.inputs[0]?.quantity;
    return q && !isUnknown(q) ? (q as { unit: string }).unit : undefined;
  })();
  const job = ctx.createJob({
    kind: 'calculation',
    tool: 'calc',
    inputs: {
      templateId: input.templateId ?? null,
      expression,
      experimental: true,
    },
    sessionId: origin.kind === 'agent' ? origin.sessionId : null,
  });
  const ac = new AbortController();
  ctx.jobCancels.set(job.id, () => ac.abort());
  ctx.jobStatus(job.id, 'running');
  let result: { value: number; unit: string };
  try {
    ctx.assertJobActive(job.id);
    result = await calc.evaluate(expression, input.inputs, template?.outputUnit ?? firstUnit, {
      signal: ac.signal,
    });
    ctx.assertJobActive(job.id);
  } catch (error) {
    ctx.jobCancels.delete(job.id);
    const e = OmenflowError.from(error);
    if (ctx.repo.getJob(job.id)?.status !== 'cancelled')
      ctx.jobStatus(job.id, e.code === ErrorCodes.CANCELLED ? 'cancelled' : 'failed', {
        error: e.toBody(),
      });
    throw e;
  }

  const limitations = [
    ...(template?.limitations ?? []),
    ...(template?.limitations?.includes(CALC_EXPERIMENTAL_SCOPE) ? [] : [CALC_EXPERIMENTAL_SCOPE]),
  ];
  const payload: CalculationPayload = {
    templateId: input.templateId,
    expression,
    inputs: input.inputs.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      sourceRef: i.sourceRef,
      literal: i.literal ?? false,
    })),
    assumptions: [...(template?.assumptions ?? []), ...input.assumptions],
    result: { quantity: qty(result.value, result.unit) },
    limitations,
    toolVersion: 'mathjs-restricted',
    ranAt: new Date().toISOString(),
    evidenceKind: 'calculated',
  };
  const inputs = input.inputs
    .filter((i) => i.sourceRef)
    .map((i) => ({
      artifactId: i.sourceRef!.artifactId,
      revisionId: i.sourceRef!.revisionId,
      relationship: 'depends_on' as const,
      label: `input ${i.name}`,
    }));

  try {
    ctx.assertJobActive(job.id);
    let artifactId = input.artifactId;
    let revision;
    if (artifactId) {
      const artifact = ctx.requireArtifact(artifactId);
      revision = commitRevision(ctx, {
        artifactId: artifact.id,
        parentId: artifact.selectedRevisionId,
        origin,
        payload,
        files: [],
        inputs,
        rationale: `run ${input.templateId ?? 'expression'}`,
        reviewState: 'draft',
      });
    } else {
      const created = createDraft(
        ctx,
        {
          type: 'calculation',
          title: input.title ?? template?.title ?? 'calculation',
          payload,
          files: [],
          inputs,
          rationale: `run ${input.templateId ?? 'expression'}`,
        },
        origin,
      );
      artifactId = created.artifact.id;
      revision = created.revision;
    }

    ctx.assertJobActive(job.id);
    let proposal = null;
    const artifact = ctx.requireArtifact(artifactId);
    if (input.submitForReview) {
      proposal = submitProposal(
        ctx,
        {
          changes: [
            {
              artifactId,
              baseRevisionId: artifact.selectedRevisionId,
              newRevisionId: revision.id,
              kind: artifact.selectedRevisionId ? 'baseline_update' : 'new_artifact',
            },
          ],
          reason: `calculation result: ${formatQty({ value: result.value, unit: result.unit })}`,
        },
        origin,
      );
    }
    ctx.assertJobActive(job.id);
    ctx.jobStatus(job.id, 'succeeded', { outputHashes: { revision: revision.id } });
    void newId;
    return {
      artifactId,
      revision,
      result: { value: result.value, unit: result.unit },
      proposal,
      experimental: true,
      limitations,
    };
  } catch (error) {
    const e = OmenflowError.from(error);
    if (ctx.repo.getJob(job.id)?.status !== 'cancelled')
      ctx.jobStatus(job.id, e.code === ErrorCodes.CANCELLED ? 'cancelled' : 'failed', {
        error: e.toBody(),
      });
    throw e;
  } finally {
    ctx.jobCancels.delete(job.id);
  }
}

export function explainInputs(ctx: ProjectContext, artifactId: string) {
  const artifact = ctx.requireArtifact(artifactId);
  const rev = artifact.selectedRevisionId
    ? ctx.repo.getRevision(artifact.selectedRevisionId)
    : ctx.repo.listRevisions(artifact.id).at(-1);
  if (!rev) throw new OmenflowError(ErrorCodes.VALIDATION, 'No revision on calculation');
  const payload = rev.payload as CalculationPayload;
  return {
    artifact,
    revision: rev,
    inputs: payload.inputs.map((i) => {
      let sourceTitle: string | null = null;
      let currentRevisionId: string | null = null;
      if (i.sourceRef) {
        const src = ctx.repo.getArtifact(i.sourceRef.artifactId);
        sourceTitle = src?.title ?? null;
        currentRevisionId = src?.selectedRevisionId ?? null;
      }
      return {
        ...i,
        sourceTitle,
        sourceMoved: i.sourceRef ? currentRevisionId !== i.sourceRef.revisionId : false,
      };
    }),
    expression: payload.expression,
    templateId: payload.templateId,
    freshness: ctx.freshnessOf(artifactId).freshness,
  };
}

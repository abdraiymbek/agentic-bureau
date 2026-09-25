/** Disposable, explicitly illustrative records for native artifact-stage review. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreApp, nullHost } from '@omenflow/core';
import {
  artifactTypes,
  type Artifact,
  type Revision,
  type ArtifactType,
} from '@omenflow/contracts';
import payloads from '../tests/fixtures/artifact-payloads.json';
import { makePreviewMesh } from '../design-system/fixtures/preview-mesh';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omen-artifact-review-'));
  const app = new CoreApp(path.join(root, 'app'), nullHost);
  const user = { kind: 'user' as const };
  try {
    const created = (await app.dispatch(
      'project.create',
      {
        name: 'Artifact display review',
        path: path.join(root, 'project'),
        intent:
          'Disposable illustrative records for verifying all fourteen artifact stages. Not an engineering design.',
      },
      user,
    )) as { projectId: string };
    const call = <T>(op: string, input: unknown) =>
      app.dispatch(op, input, user, created.projectId) as Promise<T>;
    const records = {} as Record<ArtifactType, { artifact: Artifact; revision: Revision }>;
    for (const type of artifactTypes) {
      records[type] = await call('artifact.create_draft', {
        type,
        title: `Review · ${type}`,
        payload: payloads[type],
        files:
          type === 'software'
            ? [
                {
                  path: 'software/controller.py',
                  contentBase64: Buffer.from(
                    '# Illustrative saved source\nprint("Controller startup pending hardware")\n',
                  ).toString('base64'),
                },
              ]
            : type === 'mechanical'
              ? [
                  {
                    path: 'review.preview.stl',
                    contentBase64: Buffer.from(makePreviewMesh()).toString('base64'),
                  },
                ]
              : [],
        rationale: 'Illustrative artifact display review',
      });
    }
    const supply = await call<{ artifact: Artifact; revision: Revision }>('artifact.create_draft', {
      type: 'component',
      title: 'Review · supply',
      payload: {
        ...payloads.component,
        partNumber: 'SUPPLY-12',
        description: 'Illustrative power supply for the diagram',
      },
    });
    const controller = records.component;
    const wiring = records.wiring;
    await call('artifact.update_draft', {
      artifactId: wiring.artifact.id,
      draftRevisionId: wiring.revision.id,
      payload: {
        ...payloads.wiring,
        pins: [
          {
            componentArtifactId: supply.artifact.id,
            componentRevisionId: supply.revision.id,
            pin: 'OUT',
            name: 'Supply output',
            type: 'power',
          },
          {
            ...payloads.wiring.pins[0],
            componentArtifactId: controller.artifact.id,
            componentRevisionId: controller.revision.id,
          },
        ],
        connections: [
          {
            ...payloads.wiring.connections[0],
            from: {
              componentArtifactId: supply.artifact.id,
              componentRevisionId: supply.revision.id,
              pin: 'OUT',
            },
            to: {
              componentArtifactId: controller.artifact.id,
              componentRevisionId: controller.revision.id,
              pin: 'VIN',
            },
          },
        ],
      },
      inputs: [supply, controller].map((r) => ({
        artifactId: r.artifact.id,
        revisionId: r.revision.id,
        relationship: 'depends_on',
        label: 'pinout source',
      })),
    });
    await call('component.add_offer', {
      artifactId: records.component.artifact.id,
      seller: 'Example supplier (illustrative)',
      url: 'https://example.com/controller',
      price: null,
      quantityBasis: 1,
      sourceId: records.source.artifact.id,
      availabilityText: 'Availability unknown — review fixture',
    });
    const requirement = records.requirement;
    await call('artifact.accept_draft', {
      artifactId: requirement.artifact.id,
      draftRevisionId: requirement.revision.id,
      rationale: 'Illustrative baseline to test revision switching',
    });
    await call('artifact.update_draft', {
      artifactId: requirement.artifact.id,
      baseRevisionId: requirement.revision.id,
      payload: {
        ...payloads.requirement,
        target: { value: 14, unit: 'V' },
        statement: 'The proposed controller shall operate from a 14 V supply.',
      },
    });
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="140" viewBox="0 0 440 140"><rect x="10" y="10" width="420" height="120" rx="12" fill="#eeeeee"/><text x="30" y="65" fill="#161616">Illustrative concept visual</text></svg>';
    await call('artifact.update_draft', {
      artifactId: records.concept.artifact.id,
      draftRevisionId: records.concept.revision.id,
      payload: {
        ...payloads.concept,
        visualKind: 'svg_diagram',
        visualFile: { path: 'concept.svg', role: 'preview' },
      },
      files: [{ path: 'concept.svg', contentBase64: Buffer.from(svg).toString('base64') }],
    });
    console.log(path.join(root, 'project'));
  } finally {
    await app.shutdown();
  }
}
void main();

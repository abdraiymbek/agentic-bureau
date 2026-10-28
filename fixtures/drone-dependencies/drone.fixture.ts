/**
 * Drone dependency fixture — payload→propulsion→endurance impact chain.
 * Exists to exercise cross-artifact stale propagation on the PRD's
 * propulsion/endurance example: raising the payload requirement must mark
 * the hover-throttle and endurance calculations stale without erasing them.
 */
import type { FixtureCore } from '../core';
import type { Origin } from '@bureau/contracts';

const USER: Origin = { kind: 'user' };
const q = (value: number, unit: string) => ({ value, unit });

export interface DroneRefs {
  projectId: string;
  dir: string;
  payloadReq: { artifactId: string; revisionId: string };
  propulsionCalc: { artifactId: string; revisionId: string };
  enduranceCalc: { artifactId: string; revisionId: string };
  batteryArtifactId: string;
}

export async function buildDroneProject(app: FixtureCore, dir: string): Promise<DroneRefs> {
  const created = (await app.dispatch(
    'project.create',
    {
      name: 'Survey drone (dependency fixture)',
      path: dir,
      intent:
        'Lightweight survey quad. Fixture exists to cover the PRD propulsion/' +
        'endurance impact example: payload mass change must propagate into ' +
        'thrust and endurance calculations.',
    },
    USER,
  )) as { projectId: string };
  const projectId = created.projectId;
  const call = (op: string, payload: unknown) =>
    app.dispatch(op, payload, USER, projectId) as Promise<Record<string, any>>;

  const payloadReq = await call('artifact.create_draft', {
    type: 'requirement',
    title: 'Survey payload mass',
    payload: {
      statement: 'The drone shall lift the survey sensor head.',
      target: q(0.2, 'kg'),
      acceptanceCriterion: 'Hover throttle ≤55% at takeoff mass; ≥12 min flight time.',
      priority: 'must',
      verification: 'Hover test + timed flight',
    },
  });
  await call('artifact.accept_draft', {
    artifactId: payloadReq.artifact.id,
    draftRevisionId: payloadReq.revision.id,
  });

  const srcBatt = await call('source.capture', {
    url: 'https://example-supplier.invalid/lipo-3s-2200',
    title: 'LiPo 3S 2200 mAh pack (fixture-recorded supplier listing)',
    publisher: 'fixture supplier',
    locator: 'listing, specs block',
    excerpt: '[fixture-recorded] 11.1 V nominal, 2.2 Ah, mass ≈180 g.',
    sourceKind: 'supplier',
  });

  const battery = await call('component.add_candidate', {
    title: 'LiPo 3S 2200 mAh pack',
    partNumber: 'FX-LIPO-3S-2200',
    manufacturer: 'fixture supplier',
    properties: {
      mass: { quantity: q(0.18, 'kg'), sourceId: srcBatt.artifact.id },
      nominal_voltage: { quantity: q(11.1, 'V'), sourceId: srcBatt.artifact.id },
      capacity: { quantity: q(2.2, 'Ah'), sourceId: srcBatt.artifact.id },
    },
    sourceId: srcBatt.artifact.id,
  });
  await call('artifact.accept_draft', {
    artifactId: battery.artifact.id,
    draftRevisionId: battery.revision.id,
  });

  // Thrust margin = max thrust − takeoff mass (kg out; payload flows in via
  // the depends_on edge on takeoff_mass).
  const propulsion = await call('calculation.run', {
    expression: 'max_thrust - takeoff_mass',
    title: 'Thrust margin at takeoff mass',
    inputs: [
      {
        name: 'takeoff_mass',
        quantity: q(1.1, 'kg'),
        sourceRef: { artifactId: payloadReq.artifact.id, revisionId: payloadReq.revision.id },
      },
      { name: 'max_thrust', quantity: q(2.4, 'kg'), literal: true },
    ],
    assumptions: ['Thrust quoted in kgf-equivalent per fixture motor table'],
    submitForReview: true,
  });
  await call('proposal.approve', {
    proposalId: propulsion.proposal.id,
    rationale: 'accept estimate',
  });

  // Endurance = usable energy / cruise power, reported in hours. Depends on
  // the battery revision and on the propulsion estimate revision.
  const endurance = await call('calculation.run', {
    expression: 'pack_energy / cruise_power',
    title: 'Endurance estimate',
    outputUnit: 'h',
    inputs: [
      {
        name: 'pack_energy',
        quantity: q(19.5, 'Wh'),
        sourceRef: { artifactId: battery.artifact.id, revisionId: battery.revision.id },
      },
      {
        name: 'cruise_power',
        quantity: q(95, 'W'),
        sourceRef: { artifactId: propulsion.artifactId, revisionId: propulsion.revision.id },
      },
    ],
    assumptions: ['cruise_power scales with thrust margin — fixture simplification'],
    submitForReview: true,
  });
  await call('proposal.approve', {
    proposalId: endurance.proposal.id,
    rationale: 'accept estimate',
  });

  return {
    projectId,
    dir,
    payloadReq: { artifactId: payloadReq.artifact.id, revisionId: payloadReq.revision.id },
    propulsionCalc: { artifactId: propulsion.artifactId, revisionId: propulsion.revision.id },
    enduranceCalc: { artifactId: endurance.artifactId, revisionId: endurance.revision.id },
    batteryArtifactId: battery.artifact.id,
  };
}

/**
 * Rover fixture — builds the reference inspection-rover project through the
 * real CoreApp dispatch surface (user origin). Used by the golden-path test
 * and by `pnpm fixture:rover <dir>` to materialize a project on disk.
 *
 * All part data is fixture-recorded: real parts and real published figures,
 * captured offline. Unpublished figures are labeled assumptions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreApp } from '@stark/core';
import type { Origin } from '@stark/contracts';

const USER: Origin = { kind: 'user' };
const AGENT: Origin = { kind: 'agent', sessionId: '00000000-0000-4000-8000-00000000f001' };

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

const q = (value: number, unit: string) => ({ value, unit });
const assumed = (reason: string) => ({ unknown: true as const, reason });

export interface RoverRefs {
  projectId: string;
  dir: string;
  payloadReq: { artifactId: string; revisionId: string };
  enduranceReq: { artifactId: string; revisionId: string };
  motorArtifactId: string;
  motorAltArtifactId: string;
  driverArtifactId: string;
  mcuArtifactId: string;
  cameraArtifactId: string;
  batteryArtifactId: string;
  mechanical: { artifactId: string; revisionId: string };
  massCalc: { artifactId: string; revisionId: string };
  torqueCalc: { artifactId: string; revisionId: string };
  powerCalc: { artifactId: string; revisionId: string };
  batteryCalc: { artifactId: string; revisionId: string };
  wiring: { artifactId: string; revisionId: string };
  payloadTest: { artifactId: string; revisionId: string };
  assembly: { artifactId: string; revisionId: string };
  proposalIds: string[];
}

type Op = (op: string, payload: unknown) => Promise<Record<string, any>>;

export async function buildRoverProject(app: CoreApp, dir: string): Promise<RoverRefs> {
  const created = (await app.dispatch(
    'project.create',
    {
      name: 'Sable inspection rover',
      path: dir,
      intent:
        'Small inspection rover with a removable camera tray. Carries a 300 g ' +
        'payload (sensor pack) over indoor floors and short ramps. Reference ' +
        'build for the STARK golden path.',
    },
    USER,
  )) as { projectId: string };
  const projectId = created.projectId;
  const call: Op = async (op, payload) => {
    try {
      return (await app.dispatch(op, payload, USER, projectId)) as Record<string, any>;
    } catch (e) {
      console.error(`[fixture] op failed: ${op}:`, e);
      throw e;
    }
  };
  const proposals: string[] = [];

  /* ------------------------------------------------ requirements ------- */

  const payloadReq = await call('artifact.create_draft', {
    type: 'requirement',
    title: 'Payload capacity',
    payload: {
      statement: 'The rover shall carry a removable payload pack without loss of mobility.',
      target: q(0.3, 'kg'),
      acceptanceCriterion:
        'Traverses a 15° ramp at ≥0.5 m/s carrying the payload; no slip or stall.',
      priority: 'must',
      verification: 'Ramp test with instrumented payload mass',
    },
    rationale: 'Primary mission requirement',
  });
  await call('artifact.accept_draft', {
    artifactId: payloadReq.artifact.id,
    draftRevisionId: payloadReq.revision.id,
    rationale: 'baseline requirement',
  });

  const enduranceReq = await call('artifact.create_draft', {
    type: 'requirement',
    title: 'Endurance',
    payload: {
      statement: 'The rover shall operate continuously on one battery charge.',
      target: q(30, 'min'),
      acceptanceCriterion: '≥30 min mixed drive/idle telemetry at 20 °C from a fully charged pack.',
      priority: 'should',
      verification: 'Timed run until low-voltage cutoff',
    },
  });
  await call('artifact.accept_draft', {
    artifactId: enduranceReq.artifact.id,
    draftRevisionId: enduranceReq.revision.id,
  });

  await call('artifact.create_draft', {
    type: 'assumption',
    title: 'Wheel radius (loaded)',
    payload: {
      statement: 'Loaded wheel radius for 60 mm Pololu wheels.',
      value: q(0.03, 'm'),
      reason: 'Deflection under load assumed ≈0 mm; verify on first drive test.',
      owner: 'fixture',
      needsValidation: true,
    },
  });

  const arch = await call('artifact.create_draft', {
    type: 'architecture',
    title: 'System architecture',
    payload: {
      markdown:
        '## Architecture\n\n' +
        '- **Compute**: Raspberry Pi Zero 2 W (Wi-Fi telemetry, camera capture)\n' +
        '- **Drive**: 2× Pololu micro metal gearmotor on a DRV8835 driver\n' +
        '- **Power**: 2S LiPo → 5 V buck (Pi) + direct motor rail\n' +
        '- **Payload**: removable tray (printed), 300 g sensor pack\n' +
        '- **Structure**: laser-cut chassis plate + printed tray\n\n' +
        'Single-board layout; motor driver sits beside the MCU under the tray.',
    },
  });
  await call('artifact.accept_draft', {
    artifactId: arch.artifact.id,
    draftRevisionId: arch.revision.id,
  });

  /* ------------------------------------------------ sources ------------ */

  // Captured sources land as drafts; accept each so dependents don't see
  // missing_input.
  const capture = (input: Record<string, unknown>) =>
    call('source.capture', input).then(async (r) => {
      await call('artifact.accept_draft', {
        artifactId: r.artifact.id,
        draftRevisionId: r.revision.id,
      });
      return r;
    });

  const srcPololu100 = await capture({
    url: 'https://www.pololu.com/product/2212',
    title: 'Pololu Micro Metal Gearmotor HP 6V, 100:1',
    publisher: 'Pololu',
    locator: 'product page, specs table',
    excerpt:
      '[fixture-recorded] 100:1 HP, 6 V, ~320 RPM free-run, stall torque ≈1.6 kg·cm, mass ≈9.5 g.',
    sourceKind: 'manufacturer',
  });
  const srcPololu50 = await capture({
    url: 'https://www.pololu.com/product/2204',
    title: 'Pololu Micro Metal Gearmotor HP 6V, 50:1',
    publisher: 'Pololu',
    locator: 'product page, specs table',
    excerpt:
      '[fixture-recorded] 50:1 HP, 6 V, ~625 RPM free-run, stall torque ≈0.8 kg·cm, mass ≈9.5 g.',
    sourceKind: 'manufacturer',
  });
  const srcDrv = await capture({
    url: 'https://www.pololu.com/product/2135',
    title: 'Pololu DRV8835 dual motor driver carrier',
    publisher: 'Pololu',
    locator: 'product page',
    excerpt:
      '[fixture-recorded] Dual H-bridge, 2–11 V motor supply, 1.2 A per channel, mass ≈1.2 g.',
    sourceKind: 'manufacturer',
  });
  const srcPi = await capture({
    url: 'https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/',
    title: 'Raspberry Pi Zero 2 W',
    publisher: 'Raspberry Pi',
    locator: 'product page',
    excerpt:
      '[fixture-recorded] Quad-core 1 GHz, 512 MB, 2.4 GHz Wi-Fi, mass ≈11 g, 5 V via USB or GPIO.',
    sourceKind: 'manufacturer',
  });
  const srcCam = await capture({
    url: 'https://www.raspberrypi.com/products/camera-module-3/',
    title: 'Raspberry Pi Camera Module 3 Wide',
    publisher: 'Raspberry Pi',
    locator: 'product page',
    excerpt: '[fixture-recorded] 12 MP, 120° FOV (Wide), CSI-2, mass ≈4 g.',
    sourceKind: 'manufacturer',
  });
  const srcBatt = await capture({
    url: 'https://www.pololu.com/product/4036',
    title: 'LiPo 2S 450 mAh pack (supplier listing)',
    publisher: 'Pololu',
    locator: 'product page',
    excerpt: '[fixture-recorded] 7.4 V nominal, 450 mAh, 30C, mass ≈40 g.',
    sourceKind: 'supplier',
  });
  const srcReg = await capture({
    url: 'https://www.pololu.com/product/2858',
    title: 'Pololu D24V22F5 5 V step-down regulator',
    publisher: 'Pololu',
    locator: 'product page',
    excerpt: '[fixture-recorded] 5 V out, 2.5 A, 6–36 V in, mass ≈4.3 g.',
    sourceKind: 'manufacturer',
  });

  /* ------------------------------------------------ components --------- */

  async function addComponent(
    title: string,
    partNumber: string,
    properties: Record<string, unknown>,
    offer: { seller: string; price: { amount: string; currency: string } | null; url?: string },
    sourceId: string,
    extra?: Record<string, unknown>,
  ): Promise<{ artifactId: string; revisionId: string; offerId: string | null }> {
    const res = await call('component.add_candidate', {
      title,
      partNumber,
      manufacturer: (extra?.manufacturer as string) ?? 'Pololu',
      description: (extra?.description as string) ?? '',
      properties,
      offer: { seller: offer.seller, url: offer.url, price: offer.price, sourceId },
      sourceId,
      ...(extra ?? {}),
    });
    // User fixture: accept the draft so components are baseline facts.
    await call('artifact.accept_draft', {
      artifactId: res.artifact.id,
      draftRevisionId: res.revision.id,
    });
    const cmp = await call('component.compare', { artifactIds: [res.artifact.id] });
    const offerId = (cmp.components[0]?.offers?.[0]?.id as string | undefined) ?? null;
    return { artifactId: res.artifact.id, revisionId: res.revision.id, offerId };
  }

  const motor100 = await addComponent(
    'Micro Metal Gearmotor HP 6V 100:1',
    'POLOLU-2212',
    {
      mass: { quantity: q(0.0095, 'kg'), sourceId: srcPololu100.artifact.id },
      stall_torque: {
        quantity: q(0.157, 'N*m'),
        sourceId: srcPololu100.artifact.id,
        locator: 'specs table',
      },
      free_run_rpm: { quantity: q(320, 'rpm'), sourceId: srcPololu100.artifact.id },
      rated_voltage: { quantity: q(6, 'V'), sourceId: srcPololu100.artifact.id },
    },
    {
      seller: 'Pololu',
      price: { amount: '19.95', currency: 'USD' },
      url: 'https://www.pololu.com/product/2212',
    },
    srcPololu100.artifact.id,
  );

  const motor50 = await addComponent(
    'Micro Metal Gearmotor HP 6V 50:1',
    'POLOLU-2204',
    {
      mass: { quantity: q(0.0095, 'kg'), sourceId: srcPololu50.artifact.id },
      stall_torque: {
        quantity: q(0.078, 'N*m'),
        sourceId: srcPololu50.artifact.id,
        locator: 'specs table',
      },
      free_run_rpm: { quantity: q(625, 'rpm'), sourceId: srcPololu50.artifact.id },
      rated_voltage: { quantity: q(6, 'V'), sourceId: srcPololu50.artifact.id },
    },
    {
      seller: 'Pololu',
      price: { amount: '19.95', currency: 'USD' },
      url: 'https://www.pololu.com/product/2204',
    },
    srcPololu50.artifact.id,
  );

  const driver = await addComponent(
    'DRV8835 dual motor driver carrier',
    'POLOLU-2135',
    {
      mass: { quantity: q(0.0012, 'kg'), sourceId: srcDrv.artifact.id },
      motor_voltage_max: { quantity: q(11, 'V'), sourceId: srcDrv.artifact.id },
      continuous_current: { quantity: q(1.2, 'A'), sourceId: srcDrv.artifact.id },
    },
    { seller: 'Pololu', price: { amount: '4.95', currency: 'USD' } },
    srcDrv.artifact.id,
  );

  const mcu = await addComponent(
    'Raspberry Pi Zero 2 W',
    'RPI-ZERO-2W',
    {
      mass: { quantity: q(0.011, 'kg'), sourceId: srcPi.artifact.id },
      input_voltage: { quantity: q(5, 'V'), sourceId: srcPi.artifact.id },
      // Idle+peak draw not published per workload — labeled assumption.
      avg_current: {
        quantity: assumed('workload-dependent; measure on first run'),
        sourceId: srcPi.artifact.id,
      },
    },
    { seller: 'Raspberry Pi approved reseller', price: { amount: '15.00', currency: 'USD' } },
    srcPi.artifact.id,
    { manufacturer: 'Raspberry Pi' },
  );

  const camera = await addComponent(
    'Raspberry Pi Camera Module 3 Wide',
    'RPI-CAM-3-WIDE',
    {
      mass: { quantity: q(0.004, 'kg'), sourceId: srcCam.artifact.id },
    },
    { seller: 'Raspberry Pi approved reseller', price: { amount: '25.00', currency: 'USD' } },
    srcCam.artifact.id,
    { manufacturer: 'Raspberry Pi' },
  );

  const battery = await addComponent(
    'LiPo 2S 450 mAh 30C pack',
    'POLOLU-4036',
    {
      mass: { quantity: q(0.04, 'kg'), sourceId: srcBatt.artifact.id },
      nominal_voltage: { quantity: q(7.4, 'V'), sourceId: srcBatt.artifact.id },
      capacity: { quantity: q(0.45, 'Ah'), sourceId: srcBatt.artifact.id },
    },
    { seller: 'Pololu', price: { amount: '16.95', currency: 'USD' } },
    srcBatt.artifact.id,
  );

  const regulator = await addComponent(
    'D24V22F5 5 V step-down regulator',
    'POLOLU-2858',
    {
      mass: { quantity: q(0.0043, 'kg'), sourceId: srcReg.artifact.id },
      output_voltage: { quantity: q(5, 'V'), sourceId: srcReg.artifact.id },
      output_current_max: { quantity: q(2.5, 'A'), sourceId: srcReg.artifact.id },
    },
    { seller: 'Pololu', price: { amount: '11.95', currency: 'USD' } },
    srcReg.artifact.id,
  );

  /* --------------------------------------- selection via proposals ----- */

  // Compare the two motor candidates, then select the 100:1 through review.
  await call('component.compare', { artifactIds: [motor100.artifactId, motor50.artifactId] });

  // Selection promotes a NEW revision (status: selected). Downstream refs
  // must use the post-selection revision or they go stale instantly.
  async function select(
    artifactId: string,
    revisionId: string,
    bomQty: number,
    reason: string,
    subsystem: string | null,
    offerId: string | null = null,
  ) {
    const res = await call('component.propose_selection', {
      artifactId,
      revisionId,
      bomLines: [{ subsystem, quantity: bomQty, offerId, location: null, notes: '' }],
      reason,
    });
    proposals.push(res.proposal.id);
    await call('proposal.approve', {
      proposalId: res.proposal.id,
      rationale: 'fixture user approval',
    });
    const cur = await call('artifact.read', { artifactId });
    return cur.revision.id as string;
  }

  motor100.revisionId = await select(
    motor100.artifactId,
    motor100.revisionId,
    2,
    'Torque margin wins over speed for a loaded inspection rover',
    'drive',
    motor100.offerId,
  );
  driver.revisionId = await select(
    driver.artifactId,
    driver.revisionId,
    1,
    'Two channels, 11 V headroom over 7.4 V pack',
    'drive',
    driver.offerId,
  );
  mcu.revisionId = await select(
    mcu.artifactId,
    mcu.revisionId,
    1,
    'Camera + Wi-Fi + GPIO in 11 g',
    'electronics',
    mcu.offerId,
  );
  camera.revisionId = await select(
    camera.artifactId,
    camera.revisionId,
    1,
    'Wide FOV for close inspection',
    'payload',
    camera.offerId,
  );
  battery.revisionId = await select(
    battery.artifactId,
    battery.revisionId,
    1,
    'Lightest 2S pack that meets the endurance budget',
    'power',
    battery.offerId,
  );
  regulator.revisionId = await select(
    regulator.artifactId,
    regulator.revisionId,
    1,
    'Clean 5 V rail for the Pi',
    'power',
    regulator.offerId,
  );

  /* ------------------------------------------------ mechanical --------- */

  const scadPath = path.join(FIXTURE_DIR, 'camera-tray.scad');
  const scadB64 = fs.readFileSync(scadPath).toString('base64');
  const mechanical = await call('artifact.create_draft', {
    type: 'mechanical',
    title: 'Camera tray',
    subsystem: 'payload',
    payload: {
      params: {
        tray_width: q(62, 'mm'),
        tray_depth: q(44, 'mm'),
        tray_thick: q(2.5, 'mm'),
      },
      paramManifest: [
        { name: 'tray_width', unit: 'mm', description: 'Payload bay width' },
        { name: 'tray_depth', unit: 'mm', description: 'Front-to-back depth' },
        { name: 'tray_thick', unit: 'mm', description: 'Plate thickness' },
      ],
      modelUnit: 'mm',
      material: 'PLA (fixture assumption — validate before field use)',
      manufacturing: 'FDM print, 0.2 mm layers',
    },
    files: [{ path: 'artifacts/mechanical/camera-tray.scad', contentBase64: scadB64 }],
    inputs: [
      {
        artifactId: payloadReq.artifact.id,
        revisionId: payloadReq.revision.id,
        relationship: 'depends_on',
        label: 'tray sized to payload requirement',
      },
      {
        artifactId: camera.artifactId,
        revisionId: camera.revisionId,
        relationship: 'derived_from',
        label: 'camera slot dimensions',
      },
    ],
    rationale: 'first printable tray for the removable payload',
  });
  await call('artifact.accept_draft', {
    artifactId: mechanical.artifact.id,
    draftRevisionId: mechanical.revision.id,
    rationale: 'baseline tray',
  });

  /* ------------------------------------------------ calculations ------- */

  const massCalc = await call('calculation.run', {
    templateId: 'mass_budget',
    title: 'Rover mass budget',
    inputs: [
      {
        name: 'payload',
        quantity: q(0.3, 'kg'),
        sourceRef: { artifactId: payloadReq.artifact.id, revisionId: payloadReq.revision.id },
      },
      { name: 'chassis', quantity: q(0.12, 'kg'), literal: true },
      { name: 'electronics', quantity: q(0.045, 'kg'), literal: true },
      {
        name: 'battery',
        quantity: q(0.04, 'kg'),
        sourceRef: { artifactId: battery.artifactId, revisionId: battery.revisionId },
      },
    ],
    assumptions: ['Harnesses and fasteners not included'],
    submitForReview: true,
  });
  proposals.push(massCalc.proposal.id);
  await call('proposal.approve', {
    proposalId: massCalc.proposal.id,
    rationale: 'accept baseline budget',
  });

  const torqueCalc = await call('calculation.run', {
    templateId: 'torque_load',
    title: 'Wheel torque at 15° incline',
    inputs: [
      {
        name: 'mass',
        quantity: q(0.5, 'kg'),
        sourceRef: { artifactId: massCalc.artifactId, revisionId: massCalc.revision.id },
      },
      { name: 'g', quantity: q(9.80665, 'm/s^2'), literal: true },
      { name: 'incline', quantity: q(15, 'deg'), literal: true },
      { name: 'wheel_radius', quantity: q(0.03, 'm'), literal: true },
      { name: 'accel', quantity: q(0.5, 'm/s^2'), literal: true },
    ],
    submitForReview: true,
  });
  proposals.push(torqueCalc.proposal.id);
  await call('proposal.approve', { proposalId: torqueCalc.proposal.id });

  const powerCalc = await call('calculation.run', {
    templateId: 'power_budget',
    title: 'Electrical power budget',
    inputs: [
      { name: 'avg_load', quantity: q(4.5, 'W'), literal: true },
      { name: 'peak_load', quantity: q(9, 'W'), literal: true },
      { name: 'margin', quantity: q(1.25, '1'), literal: true },
    ],
    submitForReview: true,
  });
  proposals.push(powerCalc.proposal.id);
  await call('proposal.approve', { proposalId: powerCalc.proposal.id });

  const batteryCalc = await call('calculation.run', {
    templateId: 'battery_energy',
    title: 'Usable pack energy',
    inputs: [
      {
        name: 'voltage',
        quantity: q(7.4, 'V'),
        sourceRef: { artifactId: battery.artifactId, revisionId: battery.revisionId },
      },
      {
        name: 'capacity',
        quantity: q(0.45, 'Ah'),
        sourceRef: { artifactId: battery.artifactId, revisionId: battery.revisionId },
      },
      { name: 'usable_fraction', quantity: q(0.8, '1'), literal: true },
    ],
    submitForReview: true,
  });
  proposals.push(batteryCalc.proposal.id);
  await call('proposal.approve', { proposalId: batteryCalc.proposal.id });

  /* ------------------------------------------------ wiring ------------- */

  const wiring = await call('artifact.create_draft', {
    type: 'wiring',
    title: 'Power + signal wiring',
    subsystem: 'electronics',
    payload: {
      pins: [
        {
          componentArtifactId: battery.artifactId,
          componentRevisionId: battery.revisionId,
          pin: 'BAT+',
          type: 'power',
          voltageRange: { min: q(6.4, 'V'), max: q(8.4, 'V') },
        },
        {
          componentArtifactId: battery.artifactId,
          componentRevisionId: battery.revisionId,
          pin: 'BAT-',
          type: 'ground',
        },
        {
          componentArtifactId: regulator.artifactId,
          componentRevisionId: regulator.revisionId,
          pin: 'VIN',
          type: 'power',
          voltageRange: { min: q(6, 'V'), max: q(36, 'V') },
        },
        {
          componentArtifactId: regulator.artifactId,
          componentRevisionId: regulator.revisionId,
          pin: 'VOUT',
          type: 'power',
          voltageRange: { min: q(5, 'V'), max: q(5, 'V') },
        },
        {
          componentArtifactId: regulator.artifactId,
          componentRevisionId: regulator.revisionId,
          pin: 'GND',
          type: 'ground',
        },
        {
          componentArtifactId: driver.artifactId,
          componentRevisionId: driver.revisionId,
          pin: 'VIN',
          type: 'power',
          voltageRange: { min: q(2, 'V'), max: q(11, 'V') },
        },
        {
          componentArtifactId: driver.artifactId,
          componentRevisionId: driver.revisionId,
          pin: 'GND',
          type: 'ground',
        },
        {
          componentArtifactId: driver.artifactId,
          componentRevisionId: driver.revisionId,
          pin: 'OUT1',
          type: 'signal',
        },
        {
          componentArtifactId: driver.artifactId,
          componentRevisionId: driver.revisionId,
          pin: 'OUT2',
          type: 'signal',
        },
        {
          componentArtifactId: mcu.artifactId,
          componentRevisionId: mcu.revisionId,
          pin: 'GPIO18',
          type: 'signal',
        },
        {
          componentArtifactId: mcu.artifactId,
          componentRevisionId: mcu.revisionId,
          pin: 'GPIO19',
          type: 'signal',
        },
        {
          componentArtifactId: mcu.artifactId,
          componentRevisionId: mcu.revisionId,
          pin: '5V',
          type: 'power',
          voltageRange: { min: q(4.75, 'V'), max: q(5.25, 'V') },
        },
        {
          componentArtifactId: mcu.artifactId,
          componentRevisionId: mcu.revisionId,
          pin: 'GND',
          type: 'ground',
        },
      ],
      connections: [
        {
          id: '00000000-0000-4000-8000-00000000c001',
          from: {
            componentArtifactId: battery.artifactId,
            componentRevisionId: battery.revisionId,
            pin: 'BAT+',
          },
          to: {
            componentArtifactId: driver.artifactId,
            componentRevisionId: driver.revisionId,
            pin: 'VIN',
          },
          voltage: q(7.4, 'V'),
          signalRole: 'motor rail',
          polarity: '+',
          wire: { gauge: '22 AWG', currentRating: q(3, 'A') },
        },
        {
          id: '00000000-0000-4000-8000-00000000c002',
          from: {
            componentArtifactId: battery.artifactId,
            componentRevisionId: battery.revisionId,
            pin: 'BAT+',
          },
          to: {
            componentArtifactId: regulator.artifactId,
            componentRevisionId: regulator.revisionId,
            pin: 'VIN',
          },
          voltage: q(7.4, 'V'),
          signalRole: 'regulator input',
          polarity: '+',
          wire: { gauge: '22 AWG' },
        },
        {
          id: '00000000-0000-4000-8000-00000000c003',
          from: {
            componentArtifactId: battery.artifactId,
            componentRevisionId: battery.revisionId,
            pin: 'BAT-',
          },
          to: {
            componentArtifactId: regulator.artifactId,
            componentRevisionId: regulator.revisionId,
            pin: 'GND',
          },
          signalRole: 'ground',
          polarity: '-',
        },
        {
          id: '00000000-0000-4000-8000-00000000c004',
          from: {
            componentArtifactId: battery.artifactId,
            componentRevisionId: battery.revisionId,
            pin: 'BAT-',
          },
          to: {
            componentArtifactId: driver.artifactId,
            componentRevisionId: driver.revisionId,
            pin: 'GND',
          },
          signalRole: 'ground',
          polarity: '-',
        },
        {
          id: '00000000-0000-4000-8000-00000000c005',
          from: {
            componentArtifactId: regulator.artifactId,
            componentRevisionId: regulator.revisionId,
            pin: 'VOUT',
          },
          to: {
            componentArtifactId: mcu.artifactId,
            componentRevisionId: mcu.revisionId,
            pin: '5V',
          },
          voltage: q(5, 'V'),
          signalRole: 'logic rail',
          polarity: '+',
        },
        {
          id: '00000000-0000-4000-8000-00000000c006',
          from: {
            componentArtifactId: regulator.artifactId,
            componentRevisionId: regulator.revisionId,
            pin: 'GND',
          },
          to: {
            componentArtifactId: mcu.artifactId,
            componentRevisionId: mcu.revisionId,
            pin: 'GND',
          },
          signalRole: 'ground',
          polarity: '-',
        },
        {
          id: '00000000-0000-4000-8000-00000000c007',
          from: {
            componentArtifactId: mcu.artifactId,
            componentRevisionId: mcu.revisionId,
            pin: 'GPIO18',
          },
          to: {
            componentArtifactId: driver.artifactId,
            componentRevisionId: driver.revisionId,
            pin: 'IN1',
          },
          signalRole: 'motor A PWM',
        },
        {
          id: '00000000-0000-4000-8000-00000000c008',
          from: {
            componentArtifactId: mcu.artifactId,
            componentRevisionId: mcu.revisionId,
            pin: 'GPIO19',
          },
          to: {
            componentArtifactId: driver.artifactId,
            componentRevisionId: driver.revisionId,
            pin: 'IN2',
          },
          signalRole: 'motor B PWM',
        },
      ],
      coverageNote: 'Motor OUT leads omitted pending motor pin fixture — see DRV8835 datasheet.',
    },
    inputs: [
      {
        artifactId: battery.artifactId,
        revisionId: battery.revisionId,
        relationship: 'derived_from',
        label: 'pack voltage',
      },
      {
        artifactId: driver.artifactId,
        revisionId: driver.revisionId,
        relationship: 'derived_from',
        label: 'driver pinout',
      },
      {
        artifactId: mcu.artifactId,
        revisionId: mcu.revisionId,
        relationship: 'derived_from',
        label: 'GPIO assignment',
      },
    ],
    rationale: 'first-pass wiring from selected component pinouts',
  });
  await call('artifact.accept_draft', {
    artifactId: wiring.artifact.id,
    draftRevisionId: wiring.revision.id,
  });

  /* ------------------------------------------------ test + assembly ---- */

  const payloadTest = await call('test.create_draft', {
    title: 'Ramp traverse with payload',
    procedure: [
      {
        step: 1,
        instruction: 'Charge pack to 8.4 V; bolt the 300 g payload pack into the tray.',
        expected: 'Pack secured',
      },
      {
        step: 2,
        instruction: 'Drive up a 15° ramp at full throttle from a 1 m run-up.',
        expected: 'Reaches ≥0.5 m/s mid-ramp, no slip',
      },
      {
        step: 3,
        instruction: 'Repeat 5 times; log motor current at stall margin.',
        expected: 'No driver over-current trips',
      },
    ],
    requirementRefs: [{ artifactId: payloadReq.artifact.id, revisionId: payloadReq.revision.id }],
    conditions: 'Indoor plywood ramp, 20 °C, fixture payload mass',
  });
  await call('artifact.accept_draft', {
    artifactId: payloadTest.artifact.id,
    draftRevisionId: payloadTest.revision.id,
  });

  const assembly = await call('artifact.create_draft', {
    type: 'assembly',
    title: 'Chassis assembly',
    payload: {
      steps: [
        {
          order: 1,
          instruction: 'Press-fit the gearmotors into the chassis brackets.',
          componentRefs: [motor100.artifactId],
        },
        {
          order: 2,
          instruction: 'Solder battery rail to DRV8835 VIN and to the buck VIN.',
          componentRefs: [driver.artifactId, battery.artifactId, regulator.artifactId],
        },
        {
          order: 3,
          instruction: 'Mount the Pi and camera; connect the CSI ribbon.',
          componentRefs: [mcu.artifactId, camera.artifactId],
        },
        {
          order: 4,
          instruction: 'Attach the printed tray with four M2.5 screws.',
          componentRefs: [mechanical.artifact.id],
        },
      ],
    },
  });
  await call('artifact.accept_draft', {
    artifactId: assembly.artifact.id,
    draftRevisionId: assembly.revision.id,
  });

  return {
    projectId,
    dir,
    payloadReq: { artifactId: payloadReq.artifact.id, revisionId: payloadReq.revision.id },
    enduranceReq: { artifactId: enduranceReq.artifact.id, revisionId: enduranceReq.revision.id },
    motorArtifactId: motor100.artifactId,
    motorAltArtifactId: motor50.artifactId,
    driverArtifactId: driver.artifactId,
    mcuArtifactId: mcu.artifactId,
    cameraArtifactId: camera.artifactId,
    batteryArtifactId: battery.artifactId,
    mechanical: { artifactId: mechanical.artifact.id, revisionId: mechanical.revision.id },
    massCalc: { artifactId: massCalc.artifactId, revisionId: massCalc.revision.id },
    torqueCalc: { artifactId: torqueCalc.artifactId, revisionId: torqueCalc.revision.id },
    powerCalc: { artifactId: powerCalc.artifactId, revisionId: powerCalc.revision.id },
    batteryCalc: { artifactId: batteryCalc.artifactId, revisionId: batteryCalc.revision.id },
    wiring: { artifactId: wiring.artifact.id, revisionId: wiring.revision.id },
    payloadTest: { artifactId: payloadTest.artifact.id, revisionId: payloadTest.revision.id },
    assembly: { artifactId: assembly.artifact.id, revisionId: assembly.revision.id },
    proposalIds: proposals,
  };
}

/** Agent-origin variant for the proposal-flow portion of the golden path. */
export const agentOrigin = AGENT;

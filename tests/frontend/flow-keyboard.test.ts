import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../apps/desktop/src/renderer/project/flow/model';
import { groupNodeId, layoutFlow } from '../../apps/desktop/src/renderer/project/flow/layout';
import {
  navModel,
  nextFocus,
  type Move,
} from '../../apps/desktop/src/renderer/project/flow/navigation';
import { roverGraph, syntheticGraph } from './flow-fixtures';

function rover(collapsed: string[] = []) {
  const { artifacts, edges } = roverGraph();
  const layout = layoutFlow(buildGraph(artifacts, edges), { collapsed: new Set(collapsed) });
  const model = navModel(layout);
  const id = (title: string) => layout.nodes.find((n) => n.title === title)!.id;
  const title = (nodeId: string | null) => (nodeId ? layout.byId.get(nodeId)!.title : null);
  const go = (from: string, move: Move, cameFrom?: string) =>
    title(nextFocus(model, id(from), move, cameFrom ? id(cameFrom) : null));
  return { layout, model, id, title, go };
}

describe('flow keyboard navigation', () => {
  it('moves up and down within a column, across type groups, and stops at the ends', () => {
    const { go } = rover();
    expect(go('Payload capacity', 'down')).toBe('Endurance');
    expect(go('Endurance', 'down')).toBe('Wheel radius (loaded)');
    expect(go('Wheel radius (loaded)', 'down')).toBeNull();
    expect(go('Endurance', 'up')).toBe('Payload capacity');
    expect(go('Payload capacity', 'up')).toBeNull();
    expect(go('System architecture', 'down')).toBe('Camera tray');
    expect(go('Camera tray', 'last')).toBe('Chassis assembly');
    expect(go('Chassis assembly', 'first')).toBe('System architecture');
    expect(go('System architecture', 'first')).toBeNull();
  });

  it('follows links downstream with right and upstream with left', () => {
    const { go } = rover();
    // Payload capacity feeds the camera tray, the mass budget and the ramp test.
    expect(go('Payload capacity', 'right')).toBe('Rover mass budget');
    expect(go('Camera tray', 'left')).toBe('Payload capacity');
    expect(go('Power + signal wiring', 'left')).toBe('DRV8835 dual motor driver carrier');
    expect(go('DRV8835 dual motor driver carrier', 'left')).toBe(
      'Pololu DRV8835 dual motor driver carrier',
    );
    // A link inside one column is still followed: the torque calculation rests on the mass budget.
    expect(go('Rover mass budget', 'right')).toBe('Wheel torque at 15° incline');
    expect(go('Wheel torque at 15° incline', 'left')).toBe('Rover mass budget');
  });

  it('returns along the link it came by', () => {
    const { go } = rover();
    // The mass budget has two inputs. Left goes to the nearer one, the battery pack, unless
    // focus arrived from the requirement, in which case it goes back to the requirement.
    expect(go('Rover mass budget', 'left')).toBe('LiPo 2S 450 mAh 30C pack');
    expect(go('Rover mass budget', 'left', 'Payload capacity')).toBe('Payload capacity');
    // Something that is not linked that way is not a way back.
    expect(go('Rover mass budget', 'left', 'Endurance')).toBe('LiPo 2S 450 mAh 30C pack');
  });

  it('steps to the neighbouring column where there is no link, so nothing is out of reach', () => {
    const { go } = rover();
    // Endurance feeds nothing, and nothing feeds it.
    expect(go('Endurance', 'right')).toBe('Pololu D24V22F5 5 V step-down regulator');
    expect(go('Endurance', 'left')).toBeNull();
    expect(go('Chassis assembly', 'left')).toBe('Micro Metal Gearmotor HP 6V 100:1');
    expect(go('Ramp traverse with payload', 'right')).toBeNull();
  });

  it('reaches every node from the first one', () => {
    for (const { artifacts, edges } of [roverGraph(), syntheticGraph(90, 140, 3)]) {
      const layout = layoutFlow(buildGraph(artifacts, edges));
      const model = navModel(layout);
      const seen = new Set([layout.columns[0]!.nodes[0]!]);
      const queue = [...seen];
      for (let i = 0; i < queue.length; i++) {
        for (const move of ['left', 'right', 'up', 'down'] as const) {
          const next = nextFocus(model, queue[i]!, move);
          if (next && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size).toBe(layout.nodes.length);
    }
  });

  it('treats a collapsed group as one stop', () => {
    const { go, layout, model } = rover(['component']);
    const group = groupNodeId('component');
    expect(go('Raspberry Pi Zero 2 W', 'right')).toBe('7 objects');
    expect(nextFocus(model, group, 'down')).toBeNull();
    expect(layout.byId.get(nextFocus(model, group, 'right')!)!.col).toBeGreaterThan(
      layout.byId.get(group)!.col,
    );
    expect(nextFocus(model, 'not-on-the-map', 'right')).toBeNull();
  });
});

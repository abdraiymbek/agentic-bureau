import React from 'react';
import { SlidersHorizontal } from '@phosphor-icons/react';
import { useStore } from '../store';
import { IconButton } from './ui';

/** Opens the Inspector for the object being worked on, beside its title rather than at page level. */
export function InspectButton() {
  const set = useStore((s) => s.set);
  const inspecting = useStore((s) => s.sidecarOpen && s.sidecarTab === 'inspector');
  return (
    <IconButton
      label={inspecting ? 'Inspector is open (⌘ ⇧ I)' : 'Inspect this object (⌘ ⇧ I)'}
      className={inspecting ? 'active' : ''}
      onClick={() => set({ sidecarOpen: true, sidecarTab: 'inspector' })}
    >
      <SlidersHorizontal size={15} />
    </IconButton>
  );
}

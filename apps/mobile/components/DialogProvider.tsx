import React, { useEffect, useState } from 'react';
import { AppDialog } from './AppDialog';
import { dialog } from '../lib/dialog';

/**
 * Subscribes to the shared dialog controller and renders the open dialog stack.
 * Mount once near the app root. Imperative helpers (showDialog/showInfo/...) work
 * anywhere regardless of component context.
 */
export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    return dialog.subscribe(() => setTick((t) => t + 1));
  }, []);

  return (
    <>
      {children}
      {dialog.entries.map((entry) => (
        <AppDialog key={entry.id} entry={entry} />
      ))}
    </>
  );
}

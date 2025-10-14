import React, { createContext, useContext } from 'react';
import { useRingDataCollector } from './RingDataService';

type RingCtx = ReturnType<typeof useRingDataCollector> | null;
const RingDataContext = createContext<RingCtx>(null);

export const RingDataProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
  // instantiate the hook exactly once (per provider)
  const ring = useRingDataCollector();
  return (
    <RingDataContext.Provider value={ring}>
      {children}
    </RingDataContext.Provider>
  );
};

export const useRingData = () => {
  const ctx = useContext(RingDataContext);
  if (!ctx) throw new Error('useRingData must be used inside <RingDataProvider>');
  return ctx;
};

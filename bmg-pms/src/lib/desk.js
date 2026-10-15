import { createContext, useContext } from 'react';

// Front-desk actions any page can call: open a reservation, start a booking, navigate
export const DeskCtx = createContext(null);
export const useDesk = () => useContext(DeskCtx);

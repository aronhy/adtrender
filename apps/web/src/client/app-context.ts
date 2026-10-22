import { createContext, useContext } from 'react';
import type { AppCommand, AppState, CommandResult } from './types';

export type AppContextValue = {
  registerReadback?: (refresh: () => Promise<unknown>) => () => void;
  state: AppState;
  commandVersion: number;
  refresh: () => Promise<unknown>;
  run: (command: AppCommand) => Promise<CommandResult>;
};
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('Workspace context is required');
  return context;
}

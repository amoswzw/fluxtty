import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

export interface Transport {
  send<T>(cmd: string, args?: InvokeArgs): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
}

export const transport: Transport = {
  send<T>(cmd: string, args?: InvokeArgs): Promise<T> {
    return invoke<T>(cmd, args);
  },

  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    return tauriListen<T>(event, (eventPayload) => handler(eventPayload.payload));
  },
};

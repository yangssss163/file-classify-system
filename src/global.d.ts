import type { OrganizerApi } from './shared';

declare global {
  interface Window {
    organizer: OrganizerApi;
  }
}

export {};

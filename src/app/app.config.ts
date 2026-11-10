import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { TauriWindowApi, WindowApi } from './core/backend/window-api';
import { QueryApi, TauriQueryApi } from './core/sql/query-api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: WindowApi, useClass: TauriWindowApi },
    { provide: QueryApi, useClass: TauriQueryApi },
  ],
};

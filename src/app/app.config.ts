import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { FileDialogApi, TauriFileDialogApi } from './core/backend/file-dialog-api';
import { TauriWindowApi, WindowApi } from './core/backend/window-api';
import { TauriThemeApi, ThemeApi } from './core/theme/theme-api';
import { QueryApi, TauriQueryApi } from './core/sql/query-api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: WindowApi, useClass: TauriWindowApi },
    { provide: QueryApi, useClass: TauriQueryApi },
    { provide: ThemeApi, useClass: TauriThemeApi },
    { provide: FileDialogApi, useClass: TauriFileDialogApi },
  ],
};

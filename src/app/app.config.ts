import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { FileDialogApi, TauriFileDialogApi } from './core/backend/file-dialog-api';
import { TauriWindowApi, WindowApi } from './core/backend/window-api';
import { TauriThemeApi, ThemeApi } from './core/theme/theme-api';
import { ConnectionsApi, TauriConnectionsApi } from './core/connections/connections-api';
import { SessionApi, TauriSessionApi } from './core/session/session-api';
import { SchemaApi, TauriSchemaApi } from './core/schema/schema-api';
import { QueryApi, TauriQueryApi } from './core/sql/query-api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: WindowApi, useClass: TauriWindowApi },
    { provide: QueryApi, useClass: TauriQueryApi },
    { provide: SchemaApi, useClass: TauriSchemaApi },
    { provide: ConnectionsApi, useClass: TauriConnectionsApi },
    { provide: SessionApi, useClass: TauriSessionApi },
    { provide: ThemeApi, useClass: TauriThemeApi },
    { provide: FileDialogApi, useClass: TauriFileDialogApi },
  ],
};

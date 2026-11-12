import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { ClipboardApi, TauriClipboardApi } from './core/backend/clipboard-api';
import { AboutApi, TauriAboutApi } from './core/about/about-api';
import { ExportApi, TauriExportApi } from './core/backend/export-api';
import { ChartApi, TauriChartApi } from './core/chart/chart-api';
import { BackupApi, TauriBackupApi } from './core/backup/backup-api';
import { PlanApi, TauriPlanApi } from './core/plan/plan-api';
import { MonitorApi, TauriMonitorApi } from './core/monitor/monitor-api';
import { TauriTransferApi, TransferApi } from './core/transfer/transfer-api';
import { StructureApi, TauriStructureApi } from './core/structure/structure-api';
import { CompareApi, TauriCompareApi } from './core/compare/compare-api';
import { FindApi, TauriFindApi } from './core/find/find-api';
import { DataImportApi, TauriDataImportApi } from './core/import/data-import-api';
import { FileDialogApi, TauriFileDialogApi } from './core/backend/file-dialog-api';
import { TauriWindowApi, WindowApi } from './core/backend/window-api';
import { TauriThemeApi, ThemeApi } from './core/theme/theme-api';
import { ConnectionsApi, TauriConnectionsApi } from './core/connections/connections-api';
import { FormatApi, TauriFormatApi } from './core/format/format-api';
import { SavedApi, TauriSavedApi } from './core/saved/saved-api';
import { SessionApi, TauriSessionApi } from './core/session/session-api';
import { HistoryApi, TauriHistoryApi } from './core/history/history-api';
import { SchemaApi, TauriSchemaApi } from './core/schema/schema-api';
import { QueryApi, TauriQueryApi } from './core/sql/query-api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: WindowApi, useClass: TauriWindowApi },
    { provide: QueryApi, useClass: TauriQueryApi },
    { provide: ClipboardApi, useClass: TauriClipboardApi },
    { provide: HistoryApi, useClass: TauriHistoryApi },
    { provide: ExportApi, useClass: TauriExportApi },
    { provide: PlanApi, useClass: TauriPlanApi },
    { provide: TransferApi, useClass: TauriTransferApi },
    { provide: MonitorApi, useClass: TauriMonitorApi },
    { provide: BackupApi, useClass: TauriBackupApi },
    { provide: StructureApi, useClass: TauriStructureApi },
    { provide: ChartApi, useClass: TauriChartApi },
    { provide: CompareApi, useClass: TauriCompareApi },
    { provide: FindApi, useClass: TauriFindApi },
    { provide: AboutApi, useClass: TauriAboutApi },
    { provide: DataImportApi, useClass: TauriDataImportApi },
    { provide: FormatApi, useClass: TauriFormatApi },
    { provide: SavedApi, useClass: TauriSavedApi },
    { provide: SchemaApi, useClass: TauriSchemaApi },
    { provide: ConnectionsApi, useClass: TauriConnectionsApi },
    { provide: SessionApi, useClass: TauriSessionApi },
    { provide: ThemeApi, useClass: TauriThemeApi },
    { provide: FileDialogApi, useClass: TauriFileDialogApi },
  ],
};

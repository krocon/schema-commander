import { Injectable, signal } from '@angular/core';

/** Opens the schema comparison (prompt 038). */
@Injectable({ providedIn: 'root' })
export class SchemaCompareService {
  readonly open = signal(false);
}

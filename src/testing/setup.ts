import { beforeEach } from 'vitest';
import { setLanguage } from '../app/core/i18n/i18n';

// The specs of the app read the German texts (prompt 017): they were written before the catalogs and so
// check the translation; that every English text exists is checked by `core/i18n/catalogs.spec.ts`.
beforeEach(() => setLanguage('de'));

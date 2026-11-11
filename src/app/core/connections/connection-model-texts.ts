import { translatable } from '../i18n/i18n';
import { CONNECTION_MODEL_DE } from './connection-model-texts.de';

/** Texts of the connection model: the kinds of databases (the product names stay as they are). */
export const CONNECTION_MODEL_EN = {
  sqliteFile: 'SQLite (file)',
};

export const CONNECTION_MODEL_TEXTS = translatable('connectionModel', CONNECTION_MODEL_EN, {
  de: CONNECTION_MODEL_DE,
});

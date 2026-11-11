import { translatable } from '../i18n/i18n';
import { ACTIONS, ACTION_GROUPS, ActionGroup, ActionId } from './action-catalog';
import { ACTION_GROUPS_DE, ACTION_LABELS_DE } from './action-catalog.de';

/**
 * What the user reads for an action and for its group (prompt 017). The catalog (`action-catalog.ts`) holds
 * the English names and stays free of imports; the group names of the catalog are also the stable keys.
 */
export const ACTION_LABELS_EN = Object.fromEntries(ACTIONS.map((a) => [a.id, a.label])) as Record<
  ActionId,
  string
>;
export const ACTION_GROUPS_EN = Object.fromEntries(ACTION_GROUPS.map((g) => [g, g])) as Record<
  ActionGroup,
  string
>;

const LABELS = translatable('actionLabels', ACTION_LABELS_EN, { de: ACTION_LABELS_DE });
const GROUPS = translatable('actionGroups', ACTION_GROUPS_EN, { de: ACTION_GROUPS_DE });

/** The name of an action in the current language (reactive: read it at call time, never store it). */
export function actionLabel(id: ActionId): string {
  return LABELS[id];
}

/** The name of a group of actions in the current language (reactive). */
export function groupLabel(group: ActionGroup): string {
  return GROUPS[group];
}

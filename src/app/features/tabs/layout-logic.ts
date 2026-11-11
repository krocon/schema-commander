/** A tab group of the split view (prompt 016): the first or the second. */
export type Group = 0 | 1;

/** How the two groups lie: side by side or one above the other. */
export type SplitDirection = 'row' | 'column';

/** A tab and the group it is in. */
export interface Slot {
  readonly id: string;
  readonly group: Group;
}

/** Which tab each group shows, and which group has the focus. */
export interface Shown {
  /** The tab in front: the one of the focused group. */
  readonly active: string | null;
  /** The tab of the other group; `null` while the view is not split. */
  readonly other: string | null;
}

export const otherGroup = (group: Group): Group => (group === 0 ? 1 : 0);

/** Whether both groups have tabs. */
export function isSplit(slots: readonly Slot[]): boolean {
  return slots.some((s) => s.group === 0) && slots.some((s) => s.group === 1);
}

/** A view with one empty group is no split: all tabs are in the first group then. */
export function collapse(slots: readonly Slot[]): Slot[] {
  return isSplit(slots) ? [...slots] : slots.map((s) => ({ id: s.id, group: 0 }));
}

const groupOf = (slots: readonly Slot[], id: string | null) =>
  slots.find((s) => s.id === id)?.group ?? null;

/**
 * Repairs what is shown after the tabs changed: the active tab exists (else the first one), the other
 * group shows one of its own tabs (the one it showed, else its first), and nothing while not split.
 */
export function repair(slots: readonly Slot[], shown: Shown): Shown {
  if (slots.length === 0) return { active: null, other: null };
  const active = slots.some((s) => s.id === shown.active) ? shown.active : slots[0].id;
  if (!isSplit(slots)) return { active, other: null };
  const away = otherGroup(groupOf(slots, active) ?? 0);
  const other =
    groupOf(slots, shown.other) === away
      ? shown.other
      : (slots.find((s) => s.group === away)?.id ?? null);
  return { active, other };
}

/** A tab comes to the front: the group it is in gets the focus, the other keeps what it showed. */
export function activate(slots: readonly Slot[], shown: Shown, id: string): Shown {
  const group = groupOf(slots, id);
  if (group === null) return shown;
  const was = groupOf(slots, shown.active);
  // the focus changes its group: what was in front stays visible there
  const other = was !== null && was !== group ? shown.active : shown.other;
  return repair(slots, { active: id, other });
}

/**
 * A tab is closed: its neighbour in the same group comes to the front; when the group is empty, the tab of
 * the other group does (and the split ends).
 */
export function afterClose(
  slots: readonly Slot[],
  shown: Shown,
  closed: string,
): { slots: Slot[]; shown: Shown } {
  const group = groupOf(slots, closed);
  const rest = slots.filter((s) => s.id !== closed);
  if (group === null) return { slots: [...slots], shown };
  let next = shown;
  if (shown.active === closed) {
    const mine = slots.filter((s) => s.group === group);
    const at = mine.findIndex((s) => s.id === closed);
    const neighbour = mine[at + 1] ?? mine[at - 1] ?? null;
    next = neighbour
      ? { active: neighbour.id, other: shown.other }
      : { active: shown.other, other: null };
  } else if (shown.other === closed) {
    next = { active: shown.active, other: null };
  }
  const collapsed = collapse(rest);
  return { slots: collapsed, shown: repair(collapsed, next) };
}

/**
 * Moves a tab to the other group (this is also how a view is split). It stays in front and takes the focus
 * with it; the group it left shows its neighbour. The only tab of an unsplit view cannot leave: `null`.
 */
export function moveToOther(
  slots: readonly Slot[],
  shown: Shown,
  id: string,
): { slots: Slot[]; shown: Shown } | null {
  const group = groupOf(slots, id);
  if (group === null) return null;
  const mine = slots.filter((s) => s.group === group);
  if (!isSplit(slots) && mine.length < 2) return null;
  const at = mine.findIndex((s) => s.id === id);
  const neighbour = mine[at + 1] ?? mine[at - 1] ?? null;
  const moved = slots.map((s) => (s.id === id ? { id, group: otherGroup(group) } : s));
  const collapsed = collapse(moved);
  return {
    slots: collapsed,
    shown: repair(collapsed, { active: id, other: neighbour?.id ?? null }),
  };
}

/** The focus goes to the other group; nothing happens while the view is not split. */
export function focusOther(slots: readonly Slot[], shown: Shown): Shown {
  return shown.other === null ? shown : activate(slots, shown, shown.other);
}

/** Ends the split: all tabs in the first group, the active one stays in front. */
export function unsplit(slots: readonly Slot[], shown: Shown): { slots: Slot[]; shown: Shown } {
  const all = slots.map((s) => ({ id: s.id, group: 0 as Group }));
  return { slots: all, shown: repair(all, { active: shown.active, other: null }) };
}

/** The tab a group shows; `null` for a group without tabs. */
export function shownIn(slots: readonly Slot[], shown: Shown, group: Group): string | null {
  if (groupOf(slots, shown.active) === group) return shown.active;
  return groupOf(slots, shown.other) === group ? shown.other : null;
}

/** A stored layout, forgiving: unknown groups are the first, unknown directions side by side. */
export function restoreDirection(saved: unknown): SplitDirection {
  return saved === 'column' ? 'column' : 'row';
}

export function restoreGroup(saved: unknown): Group {
  return saved === 1 ? 1 : 0;
}

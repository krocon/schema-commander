import { Plan, PlanHint, PlanNode } from '../../core/plan/plan-api';
import { PLAN_TEXTS } from './plan-texts';

/** Pure logic of the plan view (prompt 039): the tree as rows, what stands out, numbers as text. */

/** One line of the tree table. */
export interface PlanRow {
  /** The way to the node: the index among its siblings at each level, joined by dots. */
  readonly id: string;
  readonly node: PlanNode;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly open: boolean;
}

/** The nodes that are shown, top down; what is below a closed node is left out. */
export function planRows(nodes: readonly PlanNode[], closed: ReadonlySet<string>): PlanRow[] {
  const out: PlanRow[] = [];
  const walk = (list: readonly PlanNode[], prefix: string, depth: number) => {
    list.forEach((node, i) => {
      const id = prefix === '' ? String(i) : `${prefix}.${i}`;
      const open = !closed.has(id);
      out.push({ id, node, depth, hasChildren: node.children.length > 0, open });
      if (open) walk(node.children, id, depth + 1);
    });
  };
  walk(nodes, '', 0);
  return out;
}

/** Every node of a plan. */
export function allNodes(nodes: readonly PlanNode[]): PlanNode[] {
  return nodes.flatMap((n) => [n, ...allNodes(n.children)]);
}

/** What the columns of the view are measured against. */
export interface PlanScale {
  /** The longest time a node spent itself. */
  readonly maxSelf: number;
  readonly maxCost: number;
  /** Whether any node has a time, rows that came, pages. */
  readonly timed: boolean;
  readonly counted: boolean;
  readonly buffered: boolean;
}

export function scaleOf(plan: Plan): PlanScale {
  const nodes = allNodes(plan.nodes);
  return {
    maxSelf: Math.max(0, ...nodes.map((n) => n.selfMs ?? 0)),
    maxCost: Math.max(0, ...nodes.map((n) => n.cost ?? 0)),
    timed: nodes.some((n) => n.timeMs !== null),
    counted: nodes.some((n) => n.actRows !== null),
    buffered: nodes.some((n) => n.buffers !== null),
  };
}

/** The share of the longest own time a node took, 0 … 100 (for the bar). */
export function selfShare(node: PlanNode, scale: PlanScale): number {
  if (node.selfMs === null || scale.maxSelf <= 0) return 0;
  return Math.round((node.selfMs / scale.maxSelf) * 100);
}

/** Whether a node is among the expensive ones: half of the longest own time or more. */
export const expensive = (node: PlanNode, scale: PlanScale): boolean =>
  node.selfMs !== null && scale.maxSelf > 0 && node.selfMs >= scale.maxSelf / 2 && node.selfMs > 0;

/**
 * How far the estimate was off: `×12` (more rows came), `÷12` (fewer came), `''` when it was close or
 * one of the two is not known.
 */
export function factor(node: PlanNode): string {
  const { estRows: est, actRows: act } = node;
  if (est === null || act === null) return '';
  const low = Math.max(1, Math.min(est, act));
  const high = Math.max(est, act);
  const f = high / low;
  if (f < 2) return '';
  const shown =
    f >= 100
      ? Math.round(f).toLocaleString(PLAN_TEXTS.locale)
      : f.toLocaleString(PLAN_TEXTS.locale, { maximumFractionDigits: 1 });
  return `${act > est ? '×' : '÷'}${shown}`;
}

/** A number of rows or a cost: whole where it is one, else with a few digits. */
export function amount(value: number | null): string {
  if (value === null) return '';
  const locale = PLAN_TEXTS.locale;
  if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
    return Math.round(value).toLocaleString(locale);
  }
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/** Milliseconds as they read best: `0,12 ms`, `48 ms`, `2,4 s`. */
export function duration(ms: number | null): string {
  if (ms === null) return '';
  const locale = PLAN_TEXTS.locale;
  if (ms >= 10_000) return `${(ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} s`;
  if (ms >= 100) return `${Math.round(ms).toLocaleString(locale)} ms`;
  return `${ms.toLocaleString(locale, { maximumFractionDigits: ms >= 1 ? 1 : 3 })} ms`;
}

/** What a hint says, in words. */
export const hintText = (hint: PlanHint): string => PLAN_TEXTS.hints[hint];

/** The hints of a plan with the node each belongs to, the most expensive nodes first. */
export function planHints(
  plan: Plan,
): { readonly row: string; readonly node: PlanNode; readonly hint: PlanHint }[] {
  return planRows(plan.nodes, new Set())
    .flatMap((r) => r.node.hints.map((hint) => ({ row: r.id, node: r.node, hint })))
    .sort((a, b) => (b.node.selfMs ?? 0) - (a.node.selfMs ?? 0));
}

/** The rows that must be open so a node is seen: its ancestors. */
export function ancestors(id: string): string[] {
  const parts = id.split('.');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
}

/** The plan as indented text: for the clipboard, a ticket, a diff. */
export function planText(plan: Plan): string {
  const lines: string[] = [];
  const walk = (nodes: readonly PlanNode[], depth: number) => {
    for (const n of nodes) {
      const parts = [
        `${'  '.repeat(depth)}${n.op}${n.object ? ` ${n.object}` : ''}`,
        n.estRows !== null ? `est ${amount(n.estRows)}` : '',
        n.actRows !== null ? `act ${amount(n.actRows)}` : '',
        n.selfMs !== null ? `self ${duration(n.selfMs)}` : '',
        n.timeMs !== null ? `total ${duration(n.timeMs)}` : '',
        n.cost !== null ? `cost ${amount(n.cost)}` : '',
      ].filter((p) => p !== '');
      lines.push(parts.join('  ·  '));
      if (n.detail) lines.push(`${'  '.repeat(depth + 1)}${n.detail.replace(/\s+/g, ' ')}`);
      walk(n.children, depth + 1);
    }
  };
  walk(plan.nodes, 0);
  return `${lines.join('\n')}\n`;
}

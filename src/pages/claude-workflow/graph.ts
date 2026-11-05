/**
 * The workflow canvas's model: one conversation family, drawn as a tree.
 *
 * A family is the conversation everything was copied from, plus every clone and
 * fork taken out of it. The three kinds of conversation are drawn differently,
 * because they are different things:
 *
 * * the conversation the family is named after is the trunk, and is drawn in
 *   full;
 * * a **fork** copies the trunk up to the message it branches from, so the two
 *   agree turn for turn up to that message. Those turns are merged into a single
 *   node that carries both conversations, and the lines part there: the trunk
 *   runs on to the end, the fork leaves with whatever it has. A fork that has not
 *   been typed into yet has nothing of its own, so it gets an empty node to leave
 *   by — otherwise its branch would not be visible at all;
 * * a **clone** is an independent copy of the whole conversation rather than a
 *   branch of it, so it is drawn as a line of its own. A fork taken from the
 *   clone branches off that line, not off the trunk.
 *
 * Nothing is stored here. The relationships come from the app's data directory
 * and the turns from the session files, so the canvas only ever draws what is
 * actually on disk.
 */

import type { ClaudeFamilyGraph, ClaudeWorkflowSession, ClaudeWorkflowTurn } from "@/commands";

/** Size of one node card, which the layout below also spaces by. */
export const NODE_WIDTH = 268;
export const NODE_HEIGHT = 150;
/** Space between two sibling branches, and between two rows. */
const GAP_X = 40;
const GAP_Y = 56;

export interface WorkflowNode {
  /** Stable key for React, unique within the family. */
  id: string;
  question: string;
  answer: string;
  /** The reply's own id, which is what a fork branches from. */
  answerUuid?: string;
  timestamp?: string;
  /** Every conversation this turn appears in, the one it came from first. */
  sessions: ClaudeWorkflowSession[];
  /** The conversation the turn came from. */
  owner: ClaudeWorkflowSession;
  /** Forks taken at this turn: one node becoming several. */
  branches: ClaudeWorkflowSession[];
  /** Conversations that carry on from this turn with a conversation of their
   * own, when it is the turn a fork continued from. */
  branchOf: ClaudeWorkflowSession[];
  /** The conversation whose line opens here, for a line that is not the trunk —
   * a clone, drawn beside the conversation it was copied from. */
  lineStart?: ClaudeWorkflowSession;
  /** True for the node that stands for a copy with no messages of its own, so
   * that the branch it opens is visible even with nothing to show. */
  empty?: boolean;
  parent: WorkflowNode | null;
  children: WorkflowNode[];
  depth: number;
  x: number;
  y: number;
}

export interface WorkflowEdge {
  id: string;
  from: WorkflowNode;
  to: WorkflowNode;
}

export interface WorkflowLayout {
  nodes: WorkflowNode[];
  roots: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Bounds the canvas draws in, before panning and zooming. */
  width: number;
  height: number;
  /** How many messages were forked, for the header. */
  branchCount: number;
}

/** The turn's own id: its question, or the reply when a conversation opens with
 * the CLI speaking. */
function turnId(turn: ClaudeWorkflowTurn): string {
  return turn.questionUuid ?? turn.answerUuid ?? "";
}

/** A conversation's identity across projects, which some ids are only unique in. */
function sessionKey(project: string, sessionId: string): string {
  return `${project}\u0000${sessionId}`;
}

/** One line of the picture: the conversation that opened it, and the turns it
 * has drawn so far. A fork shares its parent's line; a clone has its own. */
interface Line {
  head: ClaudeWorkflowSession;
  nodes: WorkflowNode[];
  /** The node each turn is drawn on, by the turn's own id. */
  byTurn: Map<string, WorkflowNode>;
  /** The node each reply is drawn on, which is where a fork leaves from. */
  byAnswer: Map<string, WorkflowNode>;
}

export function buildWorkflow(graph: ClaudeFamilyGraph): WorkflowLayout {
  const byKey = new Map<string, ClaudeWorkflowSession>();
  for (const session of graph.sessions) {
    byKey.set(sessionKey(session.project, session.sessionId), session);
  }

  const nodes: WorkflowNode[] = [];
  const lineOf = new Map<string, Line>();
  // The conversation the family is named after, which is the one line that needs
  // no caption saying whose it is.
  const rootKey = sessionKey(graph.sessions[0]?.project ?? "", graph.rootSessionId);
  // Node ids only have to be unique within the family, and the same turn can be
  // drawn twice — once on the trunk and once on a clone's own line — so they are
  // counted rather than named after the turn.
  let sequence = 0;

  const openLine = (head: ClaudeWorkflowSession): Line => {
    const line: Line = { head, nodes: [], byTurn: new Map(), byAnswer: new Map() };
    lineOf.set(sessionKey(head.project, head.sessionId), line);
    return line;
  };

  const addNode = (
    line: Line,
    session: ClaudeWorkflowSession,
    turn: ClaudeWorkflowTurn | null
  ): WorkflowNode => {
    const node: WorkflowNode = {
      id: `n${sequence++}`,
      question: turn?.question ?? "",
      answer: turn?.answer ?? "",
      answerUuid: turn?.answerUuid,
      timestamp: turn?.timestamp,
      sessions: [session],
      owner: session,
      branches: [],
      branchOf: [],
      parent: null,
      children: [],
      depth: 0,
      x: 0,
      y: 0,
    };
    line.nodes.push(node);
    nodes.push(node);
    if (turn) {
      const id = turnId(turn);
      if (id) line.byTurn.set(id, node);
      if (turn.answerUuid) line.byAnswer.set(turn.answerUuid, node);
    }
    return node;
  };

  for (const session of graph.sessions) {
    const isRoot =
      session.sessionId === graph.rootSessionId || session.sourceSessionId === session.sessionId;
    const parent = isRoot
      ? undefined
      : byKey.get(sessionKey(session.sourceProject, session.sourceSessionId));

    // A fork carries on from the line its parent is on; a clone is a copy of the
    // whole conversation rather than a branch of it, so it opens its own. A fork
    // whose parent is gone opens its own line too, rather than vanishing.
    const merge = session.forkUuid && parent ? parent : undefined;
    let line = merge ? lineOf.get(sessionKey(merge.project, merge.sessionId)) : openLine(session);
    if (!line) line = openLine(session);

    const shared = merge ? new Set(merge.turns.map(turnId)) : new Set<string>();
    const turns = session.turns.filter((turn) => turnId(turn));

    // A parent's own read keeps its newest turns, so a copy can hold turns of
    // the shared trunk that the parent no longer draws. Those turns belong to
    // the parent, which already has them or has dropped them on purpose: the
    // copy skips them rather than growing a second trunk of its own.
    let from = 0;
    if (merge) {
      const at = turns.findIndex((turn) => shared.has(turnId(turn)));
      from = at < 0 ? 0 : at;
    }

    let previous: WorkflowNode | null = null;
    let own: WorkflowNode | null = null;
    for (let index = from; index < turns.length; index++) {
      const turn = turns[index];
      const isShared = shared.has(turnId(turn));
      let node = isShared ? line.byTurn.get(turnId(turn)) : undefined;
      if (node) {
        node.sessions.push(session);
      } else {
        node = addNode(line, session, turn);
        if (!isShared && !own) own = node;
      }
      if (previous && previous !== node && !node.parent) node.parent = previous;
      previous = node;
    }

    // Where the line opens, for the label that says whose line it is. The trunk
    // is the picture's own line and needs no caption; every other one does.
    const first = line.nodes[0];
    if (first && sessionKey(line.head.project, line.head.sessionId) !== rootKey) {
      first.lineStart = line.head;
    }

    if (!merge || !session.forkUuid) continue;

    const point = line.byAnswer.get(session.forkUuid);
    if (!point) continue;
    point.branches.push(session);

    if (own) {
      // The fork has been typed into: the branch is the turn its source does not
      // have, and the node says which conversation left here.
      own.branchOf.push(session);
    } else {
      // Nothing has been typed into it yet, so it leaves from the reply itself.
      // One card, shared by both, with the fork's own line starting empty.
      const start = addNode(line, session, null);
      start.empty = true;
      start.branchOf.push(session);
      start.parent = point;
    }
  }

  for (const node of nodes) {
    if (node.parent) node.parent.children.push(node);
  }

  // One root per line: the trunk first, then each clone in the order it was
  // made. A fork's line is its parent's, so it opens no root of its own.
  const roots: WorkflowNode[] = [];
  for (const session of graph.sessions) {
    const line = lineOf.get(sessionKey(session.project, session.sessionId));
    if (line && line.nodes[0]) roots.push(line.nodes[0]);
  }

  const { width, height } = layout(roots);

  const edges: WorkflowEdge[] = [];
  for (const node of nodes) {
    if (node.parent) {
      edges.push({ id: `${node.parent.id}->${node.id}`, from: node.parent, to: node });
    }
  }

  return {
    nodes,
    roots,
    edges,
    width,
    height,
    branchCount: graph.sessions.filter((session) => session.forkUuid).length,
  };
}

/**
 * Lays the tree out top down, one column per branch.
 *
 * A turn with no children is placed at the next free column; everything else
 * sits centred over its children, so a conversation reads as one column until it
 * forks and then as one column per branch.
 */
function layout(roots: WorkflowNode[]): { width: number; height: number } {
  let cursor = 0;
  let deepest = 0;
  // A malformed lineage could point a turn back at itself; drawing it once is
  // better than not returning at all.
  const placed = new Set<WorkflowNode>();

  const place = (node: WorkflowNode, depth: number) => {
    if (placed.has(node)) return;
    placed.add(node);
    node.depth = depth;
    node.y = depth * (NODE_HEIGHT + GAP_Y);
    deepest = Math.max(deepest, depth);

    if (node.children.length === 0) {
      node.x = cursor;
      cursor += NODE_WIDTH + GAP_X;
      return;
    }
    for (const child of node.children) place(child, depth + 1);
    const first = node.children[0];
    const last = node.children[node.children.length - 1];
    node.x = (first.x + last.x) / 2;
  };

  for (const root of roots) place(root, 0);

  return {
    width: Math.max(cursor - GAP_X, NODE_WIDTH),
    height: deepest * (NODE_HEIGHT + GAP_Y) + NODE_HEIGHT,
  };
}

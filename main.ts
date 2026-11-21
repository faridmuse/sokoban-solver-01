// sokoban-solver-01: a push-optimal Sokoban solver for make.fun's
// "Build the best Sokoban solver, 21 November 2026" bounty.
//
// How it works. The generator builds every level as a one-wide hallway with
// one to four rooms off it, each room opening onto the hallway through a
// single door, and a box pushed out of a door into the hallway can never be
// pushed back (the player would have to stand on the hallway's far side,
// which is wall). So every box stays in its room and each room is its own
// little Sokoban problem, joined to the others only by the player's walk.
// This program therefore:
//
//   1. finds the hallway (the player's row) and each room's door,
//   2. solves every room on its own with a push-based A* whose estimate is
//      the cheapest way to match its boxes to its goals, pruned by a
//      dead-square table and freeze deadlocks,
//   3. stitches the rooms' push sequences into one player-move string by
//      walking the player between pushes and between rooms with BFS,
//   4. replays the whole string on the level before writing it out.
//
// All budgets are counts of expanded states, never the wall clock, so two
// runs of the program write the same bytes. It reads no clock, no
// environment (beyond the input/output directories the kit's starter uses
// for local runs) and no files outside /bot, /input, /output and /tmp.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: 0 up, 1 down, 2 left, 3 right. d ^ 1 is the opposite direction.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// Work budgets, in expanded states. A room that runs past its budget is
// given up on; the total caps the whole run so a bad level cannot eat the
// 60-second wall. Counts only: no clock is ever read.
const MAX_EXPANSIONS_PER_ROOM = 250_000;
const MAX_TOTAL_EXPANSIONS = 2_000_000;

let totalExpansions = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall, 0 = floor
  goals: number[]; // global cell indices
  boxes: number[]; // global cell indices, sorted
  player: number; // global cell index
}

interface Room {
  door: number; // global cell: the door, on the room's side
  entry: number; // global cell: the hallway square outside the door
  cells: number[]; // global cells of the room, door included, sorted
  boxes: number[];
  goals: number[];
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y]![x] ?? '#';
      const i = y * w + x;
      if (ch !== '#') wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Split a level into its rooms: the hallway is the player's row, a door is
// a floor square in the row beside it that opens onto a hallway square, and
// a room is everything reachable from its door without stepping into the
// hallway row. Returns null when the split does not account for every box
// and goal exactly once.
function findRooms(level: Level): Room[] | null {
  const { w, h, wall, player } = level;
  const hallRow = Math.floor(player / w);
  const rooms: Room[] = [];
  const seenSets = new Set<string>();
  for (const r of [hallRow - 1, hallRow + 1]) {
    if (r < 0 || r >= h) continue;
    for (let x = 0; x < w; x++) {
      const c = r * w + x;
      if (wall[c]) continue;
      if (wall[hallRow * w + x]) continue; // no opening onto the hallway
      const cells: number[] = [];
      const seen = new Uint8Array(w * h);
      const stack = [c];
      seen[c] = 1;
      while (stack.length > 0) {
        const q = stack.pop()!;
        cells.push(q);
        const qx = q % w;
        const qy = Math.floor(q / w);
        for (let d = 0; d < 4; d++) {
          const nx = qx + DX[d]!;
          const ny = qy + DY[d]!;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || ny === hallRow) continue;
          const t = ny * w + nx;
          if (wall[t] || seen[t]) continue;
          seen[t] = 1;
          stack.push(t);
        }
      }
      cells.sort((a, b) => a - b);
      const key = cells.join(',');
      if (seenSets.has(key)) continue; // two doors into the same room
      seenSets.add(key);
      const cellSet = new Set(cells);
      const boxes = level.boxes.filter((b) => cellSet.has(b));
      const goals = level.goals.filter((g) => cellSet.has(g));
      if (boxes.length === 0 || goals.length === 0) continue;
      if (boxes.length !== goals.length) return null;
      rooms.push({ door: c, entry: hallRow * w + x, cells, boxes, goals });
    }
  }
  const roomBoxes = rooms.flatMap((r) => r.boxes);
  const roomGoals = rooms.flatMap((r) => r.goals);
  if (roomBoxes.length !== level.boxes.length) return null;
  if (roomGoals.length !== level.goals.length) return null;
  if (new Set(roomBoxes).size !== roomBoxes.length) return null;
  if (new Set(roomGoals).size !== roomGoals.length) return null;
  return rooms;
}

// Breadth-first walk on the whole level. `blocked` marks the squares the
// player may not step on (walls and boxes). Returns the move letters from
// `from` to `to`, or null when `to` cannot be reached.
function walk(
  level: Level,
  from: number,
  to: number,
  blocked: Uint8Array,
): string | null {
  if (from === to) return '';
  const { w, h } = level;
  const prev = new Int32Array(w * h).fill(-2);
  const prevDir = new Int8Array(w * h).fill(-1);
  const queue = [from];
  prev[from] = -1;
  for (let qi = 0; qi < queue.length; qi++) {
    const q = queue[qi]!;
    const qx = q % w;
    const qy = Math.floor(q / w);
    for (let d = 0; d < 4; d++) {
      const nx = qx + DX[d]!;
      const ny = qy + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const t = ny * w + nx;
      if (blocked[t] || prev[t] !== -2) continue;
      prev[t] = q;
      prevDir[t] = d;
      if (t === to) {
        let moves = '';
        for (let c = t; c !== from; c = prev[c]!) moves = LETTER[prevDir[c]!]! + moves;
        return moves;
      }
      queue.push(t);
    }
  }
  return null;
}

// The squares the player can reach from `from` without moving a box.
// `occupied` marks the boxes (local cells). Returns the reached set and its
// lowest cell, which names the whole region: any square of the region
// reaches any other, so the lowest one stands for the player's position.
function region(
  nbr: number[][],
  from: number,
  occupied: Uint8Array,
  seen: Uint8Array,
): { seen: Uint8Array; canon: number } {
  seen.fill(0);
  const stack = [from];
  seen[from] = 1;
  let canon = from;
  while (stack.length > 0) {
    const q = stack.pop()!;
    if (q < canon) canon = q;
    for (const t of nbr[q]!) {
      if (t < 0 || occupied[t] || seen[t]) continue;
      seen[t] = 1;
      stack.push(t);
    }
  }
  return { seen, canon };
}

interface Push {
  from: number; // global cell the box is pushed from
  dir: number; // 0 up, 1 down, 2 left, 3 right
}

interface SubSolution {
  pushes: Push[]; // in order, global cells
  exitable: boolean; // the player can walk out of the room afterwards
}

// Solve one self-contained subproblem: a set of floor squares (the room plus
// the hallway square outside its door, where the player starts), the boxes
// and goals inside it. Boxes may only ever sit on room squares, never on
// the entry square. `door` is the door's local cell, or -1 for a problem
// with no door (the whole-level fallback), in which case exitable is true.
// Push-based A*: a state is the sorted boxes plus the player's region, a
// step is one push, and the estimate is the cheapest matching of boxes to
// goals by shortest-path distance. Returns null when the budget runs out.
function solveSubproblem(
  wall: Uint8Array,
  w: number,
  cells: number[], // global cells, room squares first, entry square last
  roomCells: Set<number>, // global cells a box may sit on
  boxes0: number[], // global cells, sorted
  goals0: number[], // global cells
  entry: number, // global cell the player starts on
  door: number, // global cell of the door, or -1
  budget: number,
): SubSolution | null {
  const n = cells.length;
  const locOf = new Map<number, number>();
  cells.forEach((g, i) => locOf.set(g, i));
  const glob = cells;
  const entryL = locOf.get(entry)!;
  const doorL = door >= 0 ? locOf.get(door)! : -1;
  const isRoom = new Uint8Array(n);
  cells.forEach((g, i) => {
    isRoom[i] = roomCells.has(g) ? 1 : 0;
  });
  const isGoal = new Uint8Array(n);
  const goalL: number[] = [];
  for (const g of goals0) {
    const l = locOf.get(g)!;
    isGoal[l] = 1;
    goalL.push(l);
  }
  goalL.sort((a, b) => a - b);
  const nB = boxes0.length;
  const boxesL0 = boxes0.map((g) => locOf.get(g)!).sort((a, b) => a - b);

  // Neighbours of every local square, per direction (-1 = no square there).
  const nbr: number[][] = [];
  for (let i = 0; i < n; i++) {
    const g = glob[i]!;
    const gx = g % w;
    const gy = Math.floor(g / w);
    const row: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = gx + DX[d]!;
      const ny = gy + DY[d]!;
      const t = ny * w + nx;
      row.push(!wall[t] && locOf.has(t) ? locOf.get(t)! : -1);
    }
    nbr.push(row);
  }

  // Shortest-path distances between room squares, ignoring boxes. A box
  // travels at least this far in pushes, so the matching below never
  // overestimates.
  const dist = new Int32Array(n * n).fill(-1);
  for (let s = 0; s < n; s++) {
    if (!isRoom[s]) continue;
    const queue = [s];
    dist[s * n + s] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const q = queue[qi]!;
      for (const t of nbr[q]!) {
        if (t < 0 || !isRoom[t] || dist[s * n + t] >= 0) continue;
        dist[s * n + t] = dist[s * n + q]! + 1;
        queue.push(t);
      }
    }
  }

  // Dead squares: a square is live when a box on it can still be pushed to
  // a goal. Goals are live; a square is live when some push from it lands
  // on a live square with room for the player on the other side. A square
  // no push path reaches is truly dead, so a box there can never be saved.
  const live = new Uint8Array(n);
  for (const g of goalL) live[g] = 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let c = 0; c < n; c++) {
      if (live[c] || !isRoom[c]) continue;
      for (let d = 0; d < 4; d++) {
        const dest = nbr[c]![d]!;
        const src = nbr[c]![d ^ 1]!;
        if (dest >= 0 && isRoom[dest] && live[dest] && src >= 0) {
          live[c] = 1;
          changed = true;
          break;
        }
      }
    }
  }

  // Dead squares: a square is dead when no box on it can ever be pushed to
  // a goal. The live table above is exactly that reachability, so a
  // non-goal room square that is not live is dead. (Corner squares and
  // wall runs are dead by the same table: no push leaves them, or every
  // push stays on a goalless run, so the fixpoint never marks them live.
  // A separate corner or wall-run test would only repeat it, and a run
  // test that forgets a box can slide off the end of a wall is wrong.)
  const dead = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (isRoom[c] && !isGoal[c] && !live[c]) dead[c] = 1;
  }

  // Pack sorted boxes into one number when they fit, else a string. The
  // state key is the packed boxes plus the player's canonical square.
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(n, 2))));
  const numeric = nB * bits + bits <= 52;
  const pack = (bs: number[]): number | string => {
    if (!numeric) return bs.join(',');
    let p = 0;
    for (let i = nB - 1; i >= 0; i--) p = p * (1 << bits) + bs[i]!;
    return p;
  };
  const keyOf = (packed: number | string, canon: number): number | string =>
    numeric ? (packed as number) * (1 << bits) + canon : `${packed}|${canon}`;

  // Cheapest matching of boxes to goals, by subset DP over the goals.
  const hCache = new Map<number | string, number>();
  const heuristic = (bs: number[]): number => {
    const pk = pack(bs);
    const hit = hCache.get(pk);
    if (hit !== undefined) return hit;
    const m = nB;
    const dp = new Float64Array(1 << m).fill(Infinity);
    dp[0] = 0;
    for (let mask = 0; mask < 1 << m; mask++) {
      const k = popcount(mask);
      if (k >= m || dp[mask] === Infinity) continue;
      const b = bs[k]!;
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const d = dist[b * n + goalL[j]!]!;
        if (d < 0) continue;
        const nm = mask | (1 << j);
        const v = dp[mask]! + d;
        if (v < dp[nm]!) dp[nm] = v;
      }
    }
    const h = dp[(1 << m) - 1]!;
    const out = h === Infinity ? Infinity : h;
    hCache.set(pk, out);
    return out;
  };

  // Freeze deadlock: the greatest set of boxes none of which can ever be
  // pushed again. A box can be pushed when some direction has its landing
  // square and the player's square both free of walls and frozen boxes; a
  // box that fails every direction joins the frozen set, and a frozen box
  // off a goal dooms the state. Frozen boxes never move, so the test is
  // sound: the first frozen box ever pushed would need a direction no wall
  // or frozen box blocks, and it has none.
  const freezeCache = new Map<number | string, boolean>();
  const frozenDead = (bs: number[]): boolean => {
    const pk = pack(bs);
    const hit = freezeCache.get(pk);
    if (hit !== undefined) return hit;
    const occ = new Int16Array(n).fill(-1);
    bs.forEach((b, i) => {
      occ[b] = i;
    });
    let frozen = (1 << nB) - 1;
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < nB; i++) {
        if (!(frozen & (1 << i))) continue;
        const b = bs[i]!;
        let can = false;
        for (let d = 0; d < 4; d++) {
          const dest = nbr[b]![d]!;
          if (dest < 0 || !isRoom[dest]) continue;
          if (occ[dest]! >= 0 && frozen & (1 << occ[dest]!)) continue;
          const src = nbr[b]![d ^ 1]!;
          if (src < 0) continue;
          if (occ[src]! >= 0 && frozen & (1 << occ[src]!)) continue;
          can = true;
          break;
        }
        if (can) {
          frozen &= ~(1 << i);
          moved = true;
        }
      }
    }
    let bad = false;
    for (let i = 0; i < nB; i++) {
      if (frozen & (1 << i) && !isGoal[bs[i]!]) {
        bad = true;
        break;
      }
    }
    freezeCache.set(pk, bad);
    return bad;
  };

  const isGoalState = (bs: number[]): boolean => bs.every((b) => isGoal[b]);

  // A* over pushes. States are numbered; the heap orders by (f, -g, order)
  // so the search is fully determined by the level, never by timing.
  const stBoxes: (number | string)[] = [];
  const stCanon: number[] = [];
  const stG: number[] = [];
  const stParent: number[] = [];
  const stPushFrom: number[] = [];
  const stPushDir: number[] = [];
  const closed = new Map<number | string, number>();
  const heap: { f: number; g: number; seq: number; idx: number }[] = [];
  let seq = 0;
  const heapLess = (
    a: { f: number; g: number; seq: number },
    b: { f: number; g: number; seq: number },
  ): boolean =>
    a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.seq < b.seq)));
  const heapPush = (e: { f: number; g: number; seq: number; idx: number }): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): { f: number; g: number; seq: number; idx: number } => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const addState = (
    packed: number | string,
    canon: number,
    g: number,
    parent: number,
    pushFrom: number,
    pushDir: number,
  ): number => {
    const idx = stBoxes.length;
    stBoxes.push(packed);
    stCanon.push(canon);
    stG.push(g);
    stParent.push(parent);
    stPushFrom.push(pushFrom);
    stPushDir.push(pushDir);
    return idx;
  };

  const occ0 = new Uint8Array(n);
  boxesL0.forEach((b) => {
    occ0[b] = 1;
  });
  if (boxesL0.some((b) => dead[b]) || frozenDead(boxesL0)) return null;
  const h0 = heuristic(boxesL0);
  if (h0 === Infinity) return null;
  const seen0 = new Uint8Array(n);
  const r0 = region(nbr, entryL, occ0, seen0);
  const startKey = keyOf(pack(boxesL0), r0.canon);
  const start = addState(pack(boxesL0), r0.canon, 0, -1, -1, -1);
  closed.set(startKey, 0);
  if (isGoalState(boxesL0)) return finish(start);
  heapPush({ f: h0, g: 0, seq: seq++, idx: start });

  const seenBuf = new Uint8Array(n);
  const occBuf = new Uint8Array(n);
  const seenBuf2 = new Uint8Array(n);
  let expansions = 0;
  let fallback: { idx: number; g: number } | null = null;
  const unpack = (packed: number | string): number[] => {
    if (!numeric) return (packed as string).split(',').map(Number);
    const out: number[] = [];
    let p = packed as number;
    for (let i = 0; i < nB; i++) {
      out.push(p % (1 << bits));
      p = Math.floor(p / (1 << bits));
    }
    return out;
  };

  while (heap.length > 0) {
    const top = heapPop();
    const idx = top.idx;
    const k = keyOf(stBoxes[idx]!, stCanon[idx]!);
    if (closed.get(k) !== stG[idx]) continue; // a better path to it exists
    if (fallback && top.f > fallback.g) break; // no optimal answer left
    if (isGoalState(unpack(stBoxes[idx]!))) continue; // never expanded
    expansions++;
    totalExpansions++;
    if (expansions > budget || totalExpansions > MAX_TOTAL_EXPANSIONS) return null;
    const bs = unpack(stBoxes[idx]!);
    const g = stG[idx]!;
    occBuf.fill(0);
    bs.forEach((b) => {
      occBuf[b] = 1;
    });
    const reg = region(nbr, stCanon[idx]!, occBuf, seenBuf);
    for (let bi = 0; bi < nB; bi++) {
      const b = bs[bi]!;
      for (let d = 0; d < 4; d++) {
        const dest = nbr[b]![d]!;
        if (dest < 0 || !isRoom[dest] || occBuf[dest] || dead[dest]) continue;
        const src = nbr[b]![d ^ 1]!;
        if (src < 0 || occBuf[src] || !reg.seen[src]) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        const nh = heuristic(nb);
        if (nh === Infinity) continue;
        if (frozenDead(nb)) continue;
        const nOcc = new Uint8Array(n);
        nb.forEach((x) => {
          nOcc[x] = 1;
        });
        const nReg = region(nbr, b, nOcc, seenBuf2);
        const packed = pack(nb);
        const nk = keyOf(packed, nReg.canon);
        const ng = g + 1;
        const prev = closed.get(nk);
        if (prev !== undefined && prev <= ng) continue;
        closed.set(nk, ng);
        const nIdx = addState(packed, nReg.canon, ng, idx, b, d);
        if (isGoalState(nb)) {
          // A goal found here is push-optimal: the state it came from had
          // the smallest f in the heap and h >= 1, so no cheaper answer
          // exists. Keep it when the player can still walk out (the entry
          // square is in the final region); otherwise hold it as the
          // fallback for a room solved last, and keep looking.
          const exitable = doorL < 0 || nReg.seen[entryL] === 1;
          if (exitable) {
            return finish(nIdx);
          }
          if (!fallback) fallback = { idx: nIdx, g: ng };
          continue;
        }
        heapPush({ f: ng + nh, g: ng, seq: seq++, idx: nIdx });
      }
    }
  }
  if (fallback) return finish(fallback.idx);
  return null;

  function finish(idx: number): SubSolution {
    const pushes: Push[] = [];
    for (let t = idx; t > 0; t = stParent[t]!) {
      pushes.push({ from: glob[stPushFrom[t]!]!, dir: stPushDir[t]! });
    }
    pushes.reverse();
    // Exitable means the player can still walk out afterwards: the entry
    // square is in the region the player ends in. The player ends where the
    // last push left them (the pushed box's old square), or on the entry
    // square when the room was already solved.
    const endLocal = idx === start ? entryL : stPushFrom[idx]!;
    const bs = unpack(stBoxes[idx]!);
    const occ = new Uint8Array(n);
    bs.forEach((b) => {
      occ[b] = 1;
    });
    const seen = new Uint8Array(n);
    const reg = region(nbr, endLocal, occ, seen);
    const exitable = doorL < 0 || reg.seen[entryL] === 1;
    return { pushes, exitable };
  }
}

function popcount(x: number): number {
  let c = 0;
  while (x > 0) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}

// Turn a room's push list into player moves, walking the player to each
// pushing square first. `boxes` and `player` are the live global state and
// are updated as the moves are made.
function pushesToMoves(
  level: Level,
  pushes: Push[],
  boxes: number[],
  player: number,
): { moves: string; player: number } | null {
  let moves = '';
  let p = player;
  const boxSet = new Set(boxes);
  for (const push of pushes) {
    const from = push.from;
    const d = push.dir;
    const target = from - DY[d]! * level.w - DX[d]!;
    const blocked = new Uint8Array(level.w * level.h);
    level.wall.forEach((isWall, i) => {
      blocked[i] = isWall;
    });
    boxSet.forEach((b) => {
      blocked[b] = 1;
    });
    const w = walk(level, p, target, blocked);
    if (w === null) return null;
    moves += w + LETTER[d]!;
    p = from;
    boxSet.delete(from);
    boxSet.add(from + DY[d]! * level.w + DX[d]!);
  }
  return { moves, player: p };
}

// Replay a move string on the level. Returns true only when every step is
// legal and every box ends on a goal.
function replay(level: Level, moves: string): boolean {
  const boxSet = new Set(level.boxes);
  const goalSet = new Set(level.goals);
  let p = level.player;
  for (const ch of moves) {
    if (!'udlrUDLR'.includes(ch)) continue;
    const d = 'udlr'.indexOf(ch.toLowerCase());
    const q = p + DY[d]! * level.w + DX[d]!;
    if (level.wall[q]) return false;
    if (boxSet.has(q)) {
      const t = q + DY[d]! * level.w + DX[d]!;
      if (level.wall[t] || boxSet.has(t)) return false;
      boxSet.delete(q);
      boxSet.add(t);
    }
    p = q;
  }
  return [...boxSet].every((b) => goalSet.has(b));
}

// Solve one level. Returns the move string, or null when no answer was found.
function solveLevel(level: Level): string | null {
  if (level.boxes.length === 0) return '';
  const rooms = findRooms(level);
  if (rooms === null) {
    // The split failed: try the whole level as one problem when it is
    // small enough for the same search, else give up on this level.
    if (level.boxes.length > 5) return null;
    const allCells: number[] = [];
    for (let i = 0; i < level.w * level.h; i++) {
      if (!level.wall[i]) allCells.push(i);
    }
    const roomSet = new Set(allCells);
    const sub = solveSubproblem(
      level.wall,
      level.w,
      [...allCells, level.player].filter((v, i, a) => a.indexOf(v) === i),
      roomSet,
      level.boxes,
      level.goals,
      level.player,
      -1,
      MAX_EXPANSIONS_PER_ROOM,
    );
    if (sub === null) return null;
    const conv = pushesToMoves(level, sub.pushes, [...level.boxes], level.player);
    if (conv === null) return null;
    return replay(level, conv.moves) ? conv.moves : null;
  }

  // Solve each room on its own.
  const solved: { room: Room; sub: SubSolution }[] = [];
  for (const room of rooms) {
    const roomSet = new Set(room.cells);
    const sub = solveSubproblem(
      level.wall,
      level.w,
      [...room.cells, room.entry],
      roomSet,
      room.boxes,
      room.goals,
      room.entry,
      room.door,
      MAX_EXPANSIONS_PER_ROOM,
    );
    if (sub === null) return null;
    solved.push({ room, sub });
  }

  // Stitch the rooms in some order. A room whose player cannot walk out
  // afterwards (exitable false) must go last; try every order until the
  // walks between rooms all succeed and the replay checks out.
  const orders = permutations(solved.map((_, i) => i));
  for (const order of orders) {
    let ok = true;
    for (let i = 0; i < order.length - 1; i++) {
      if (!solved[order[i]!]!.sub.exitable) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let moves = '';
    let player = level.player;
    const boxes = [...level.boxes];
    for (const oi of order) {
      const { room, sub } = solved[oi!]!;
      const blocked = new Uint8Array(level.w * level.h);
      level.wall.forEach((isWall, i) => {
        blocked[i] = isWall;
      });
      boxes.forEach((b) => {
        blocked[b] = 1;
      });
      const w = walk(level, player, room.entry, blocked);
      if (w === null) {
        ok = false;
        break;
      }
      moves += w;
      const conv = pushesToMoves(level, sub.pushes, boxes, room.entry);
      if (conv === null) {
        ok = false;
        break;
      }
      moves += conv.moves;
      player = conv.player;
      // Refresh the box list from the moves just made.
      const boxSet = new Set(boxes);
      for (const push of sub.pushes) {
        boxSet.delete(push.from);
        boxSet.add(push.from + DY[push.dir]! * level.w + DX[push.dir]!);
      }
      boxes.length = 0;
      boxes.push(...boxSet);
    }
    if (!ok) continue;
    if (replay(level, moves)) return moves;
  }
  return null;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.filter((_, j) => j !== i);
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level) ?? '';
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

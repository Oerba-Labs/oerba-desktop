/* Reading GET /api/now into the small model the menu bar, notifications and badge are made from. Pure.
   Keys read, and nothing else: needs_you[] {machine, text}; owners[] (its presence marks the platform owner's answer);
   machines.*.state.workspaces[] {name, owner, status}; events[] {id, kind, subject, summary, failed}. */

import { clean, plainName } from "./text";

export interface Workspace { owner: string; name: string; status: string }
export interface Need { key: string; title: string }
export interface DeployEvent { id: number; failed: boolean; subject: string; summary: string }

export interface NowModel {
  /** The platform owner's answer, the only one that carries what waits. */
  isOwner: boolean;
  workspaces: Workspace[];
  needs: Need[];
  /** Deploy lines of the timeline, newest first. */
  deploys: DeployEvent[];
}

export interface Me { handle: string; github: string }

const MAX_WORKSPACES = 200, MAX_NEEDS = 100, MAX_EVENTS = 40;

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Whether a workspace's owner is this person: their handle or GitHub name, with or without the @github a login carries. */
function isMine(owner: string, me: Me): boolean {
  const o = owner.toLowerCase();
  return [me.handle, me.github].filter(Boolean).some((n) => o === n.toLowerCase() || o === `${n.toLowerCase()}@github`);
}

export function parseNow(body: unknown, me: Me): NowModel | null {
  const b = obj(body);
  if (b === null) return null;
  const isOwner = Array.isArray(b["owners"]);

  const workspaces: Workspace[] = [];
  for (const m of Object.values(obj(b["machines"]) ?? {})) {
    const state = obj(obj(m)?.["state"]);
    for (const w of arr(state?.["workspaces"])) {
      const o = obj(w);
      const owner = plainName(o?.["owner"]);
      const name = plainName(o?.["name"]);
      const status = clean(o?.["status"], 20).toLowerCase();
      if (owner === null || name === null || status === "") continue;
      // A developer's answer is theirs already; the owner's holds everybody's, so theirs are picked out.
      if (isOwner && !isMine(owner, me)) continue;
      if (workspaces.length < MAX_WORKSPACES) workspaces.push({ owner, name, status });
    }
  }

  const needs: Need[] = [];
  if (isOwner) {
    for (const n of arr(b["needs_you"]).slice(0, MAX_NEEDS)) {
      const o = obj(n);
      const text = clean(o?.["text"], 90);
      if (text === "") continue;
      needs.push({ key: `${clean(o?.["machine"], 40)}\t${text}`, title: text });
    }
  }

  const deploys: DeployEvent[] = [];
  for (const e of arr(b["events"]).slice(0, MAX_EVENTS)) {
    const o = obj(e);
    const id = o?.["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || o?.["kind"] !== "deploy") continue;
    deploys.push({ id, failed: o["failed"] === true, subject: clean(o["subject"], 40), summary: clean(o["summary"], 100) });
  }

  return { isOwner, workspaces, needs, deploys };
}

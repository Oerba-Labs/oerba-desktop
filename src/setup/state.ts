/* The setup screen's steps, worked out from what the probes saw. Pure. */

import { approved, hasHandle, type Who } from "./who";

export type TailscaleState = "running" | "needs-login" | "stopped" | "other" | "unreadable";

export interface Probes {
  tailscaleInstalled: boolean;
  tailscale: TailscaleState;
  oerba: { answered: boolean; who: Who | null };
}

/** done: ticked. next: the first step not done, and what to do. waiting: blocked behind an earlier one.
    ask: not blocking; Oerba's own welcome page asks it once the person is let in. */
export type StepStatus = "done" | "next" | "waiting" | "ask";
export type StepAction = "open-tailscale-download";

export interface Step {
  id: "installed" | "signed-in" | "invited" | "name" | "access";
  title: string;
  status: StepStatus;
  hint: string;
  action?: StepAction;
}

export interface SetupState {
  steps: Step[];
  /** Oerba answered: load it. Its own welcome page asks for the name and the access. */
  ready: boolean;
  /** A line under the list, for what the app could not read. */
  note: string;
}

export function computeSetup(p: Probes): SetupState {
  const answered = p.oerba.answered;
  const who = p.oerba.who;
  let note = "";

  // Oerba answering proves both Tailscale steps, whichever Tailscale the person runs.
  const installed = p.tailscaleInstalled || answered;
  const unreadable = p.tailscale === "unreadable" && p.tailscaleInstalled;
  const signedIn = p.tailscale === "running" || answered;
  if (unreadable && !answered) note = "The app could not read Tailscale's state, so it judges sign-in by whether Oerba answers.";
  if (unreadable && answered) note = "The app could not read Tailscale's state; Oerba answered, so you are signed in.";

  const done: boolean[] = [installed, signedIn, answered];
  const firstOpen = done.indexOf(false);

  const steps: Step[] = [
    { id: "installed", title: "Tailscale installed", status: "done", hint: "" },
    { id: "signed-in", title: "Signed in to Tailscale", status: "done", hint: "" },
    { id: "invited", title: "Invited to Oerba", status: "done", hint: "" },
    { id: "name", title: "Your name", status: "waiting", hint: "Oerba asks for it once you are invited." },
    { id: "access", title: "Access asked for and approved", status: "waiting", hint: "Oerba asks for it once you are invited." },
  ];
  const at = (i: number): Step => steps[i] as Step;

  at(0).status = installed ? "done" : firstOpen === 0 ? "next" : "waiting";
  if (!installed) {
    at(0).hint = "Oerba reaches you through Tailscale. Install it, then come back.";
    at(0).action = "open-tailscale-download";
  }

  if (signedIn) at(1).status = "done";
  else {
    at(1).status = firstOpen === 1 ? "next" : "waiting";
    at(1).hint = p.tailscale === "stopped" ? "Tailscale is turned off. Turn it on from its menu bar icon."
      : p.tailscaleInstalled ? "Open Tailscale from the menu bar and sign in."
      : "Sign in once Tailscale is installed.";
  }

  if (answered) at(2).status = "done";
  else {
    at(2).status = firstOpen === 2 ? "next" : "waiting";
    at(2).hint = firstOpen === 2
      ? "Ask whoever sent you the app to share Oerba with you in Tailscale, then accept the invitation in the Tailscale app. This screen checks every half minute."
      : "Needs the two steps above first.";
  }

  if (answered && who !== null) {
    if (hasHandle(who)) { at(3).status = "done"; at(3).hint = ""; }
    else { at(3).status = "ask"; at(3).hint = "Oerba will ask what to call you."; }
    if (approved(who)) { at(4).status = "done"; at(4).hint = ""; }
    else { at(4).status = "ask"; at(4).hint = "Oerba will ask for access, and the platform's owner approves it. Its page updates by itself."; }
  } else if (answered) {
    at(3).status = "ask"; at(3).hint = "Oerba will ask what to call you.";
    at(4).status = "ask"; at(4).hint = "Oerba will ask for access, and the platform's owner approves it.";
  }

  return { steps, ready: answered, note };
}

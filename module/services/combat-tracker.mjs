import {
  advanceMeleeAction,
  buildMeleeQueue,
  getCurrentMeleeAction,
  getMeleeQueueState
} from "./melee-sequencer.mjs";

let trackerHooksRegistered = false;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getViewedCombat(app) {
  return app?.viewed ?? game.combat ?? null;
}

function getRootElement(html) {
  if (html instanceof HTMLElement) return html;
  return html?.[0] ?? null;
}

function resolveEntryName(combat, entry) {
  const combatant = combat?.combatants?.get?.(entry.combatantId);
  if (combatant?.name) return combatant.name;

  const actor = entry?.actorId ? game.actors.get(entry.actorId) : null;
  return actor?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor");
}

function getApmState(actor) {
  const total = Math.max(0, Math.floor(num(
    actor?.system?.combat?.apmTotal,
    num(actor?.system?.combat?.derived?.apmTotal, 0)
  )));

  const remaining = Math.max(0, Math.floor(num(
    actor?.system?.combat?.apmRemaining,
    num(actor?.system?.combat?.derived?.apmRemaining, total)
  )));

  return { total, remaining };
}

function renderTrackerSummary(app, root, combat, state, current) {
  root.querySelector(".rifts-melee-tracker-summary")?.remove();

  const panel = document.createElement("section");
  panel.className = "rifts-melee-tracker-summary";

  const topRow = document.createElement("div");
  topRow.className = "rifts-melee-summary-row";

  const currentLabel = document.createElement("span");
  const actorName = current ? resolveEntryName(combat, current) : game.i18n.localize("RIFTS.Melee.QueueComplete");
  currentLabel.innerHTML = `<strong>${game.i18n.localize("RIFTS.Melee.CurrentMeleeAction")}:</strong> ${actorName}`;
  topRow.append(currentLabel);

  const queuePosition = document.createElement("span");
  const position = current?.queuePosition ?? state.queue.length;
  queuePosition.innerHTML = `<strong>${game.i18n.localize("RIFTS.Melee.QueuePosition")}:</strong> ${position}`;
  topRow.append(queuePosition);

  const queueLength = document.createElement("span");
  queueLength.innerHTML = `<strong>${game.i18n.localize("RIFTS.Melee.QueueLength")}:</strong> ${state.queue.length}`;
  topRow.append(queueLength);

  const passLabel = document.createElement("span");
  passLabel.innerHTML = `<strong>${game.i18n.localize("RIFTS.Melee.Pass")}:</strong> ${current?.meleePass ?? 0}`;
  topRow.append(passLabel);

  panel.append(topRow);

  if (game.user?.isGM) {
    const controlsRow = document.createElement("div");
    controlsRow.className = "rifts-melee-controls-row";

    const advanceButton = document.createElement("button");
    advanceButton.type = "button";
    advanceButton.dataset.action = "advance-melee-queue";
    advanceButton.textContent = game.i18n.localize("RIFTS.Melee.AdvanceQueue");

    advanceButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.currentTarget.disabled = true;
      await advanceMeleeAction(combat, { announce: true });
      app.render();
    });

    controlsRow.append(advanceButton);
    panel.append(controlsRow);

    const details = document.createElement("details");
    details.className = "rifts-melee-order";

    const summary = document.createElement("summary");
    summary.textContent = game.i18n.localize("RIFTS.Melee.ActionOrder");
    details.append(summary);

    const list = document.createElement("ol");
    list.className = "rifts-melee-order-list";

    state.queue.forEach((entry, index) => {
      const item = document.createElement("li");
      item.className = "rifts-melee-order-item";
      if (entry.consumed) item.classList.add("is-consumed");
      if (current?.queueIndex === index) item.classList.add("is-current");

      const name = resolveEntryName(combat, entry);
      item.textContent = `${name} (${game.i18n.localize("RIFTS.Melee.Pass")} ${entry.meleePass}, #${entry.actionIndex})`;
      list.append(item);
    });

    details.append(list);
    panel.append(details);
  }

  const controls = root.querySelector(".encounter-controls");
  if (controls?.parentElement) {
    controls.insertAdjacentElement("afterend", panel);
  } else {
    root.prepend(panel);
  }
}

function enrichCombatantRows(root, combat, current) {
  for (const row of root.querySelectorAll(".combatant[data-combatant-id]")) {
    const combatantId = row.dataset.combatantId;
    const combatant = combat?.combatants?.get?.(combatantId);
    const actor = combatant?.actor;

    row.classList.remove("rifts-melee-current", "rifts-melee-waiting");
    row.querySelector(".rifts-melee-combatant-meta")?.remove();

    if (!actor) continue;

    const apm = getApmState(actor);
    const isCurrent = Boolean(current) && current.combatantId === combatantId;
    row.classList.add(isCurrent ? "rifts-melee-current" : "rifts-melee-waiting");

    const meta = document.createElement("div");
    meta.className = "rifts-melee-combatant-meta";

    const stateKey = isCurrent ? "RIFTS.Melee.ActiveNow" : "RIFTS.Melee.WaitingForTurn";
    const heldCount = Math.max(0, Math.floor(num(actor?.system?.combat?.heldActionCount, 0)));
    const heldReady = actor?.system?.combat?.heldActionReady === true;
    const heldStatus = heldCount > 0
      ? ` • ${game.i18n.localize("RIFTS.Advanced.HoldAction")}: ${heldCount}${heldReady ? ` (${game.i18n.localize("RIFTS.Advanced.ReleaseHeldAction")})` : ""}`
      : "";
    meta.textContent = `${game.i18n.localize("RIFTS.Melee.APMRemaining")}: ${apm.remaining}/${apm.total} • ${game.i18n.localize(stateKey)}${heldStatus}`;

    const anchor = row.querySelector(".token-name")
      ?? row.querySelector(".combatant-name")
      ?? row.querySelector("h4")
      ?? row;

    anchor.append(meta);
  }
}

async function renderTrackerIntegration(app, html) {
  const combat = getViewedCombat(app);
  if (!combat) return;

  const root = getRootElement(html);
  if (!(root instanceof HTMLElement)) return;

  let state = getMeleeQueueState(combat);
  if (!state.queue.length && game.user?.isGM) {
    state = await buildMeleeQueue(combat, { announce: false }) ?? state;
  }

  const current = getCurrentMeleeAction(combat, state);

  renderTrackerSummary(app, root, combat, state, current);
  enrichCombatantRows(root, combat, current);
}

function shouldRefreshForActor(actor, changed) {
  if (!actor || !game.combat) return false;
  const hasCombatChanges = foundry.utils.getProperty(changed, "system.combat") !== undefined;
  if (!hasCombatChanges) return false;

  return game.combat.combatants.some((combatant) => combatant.actorId === actor.id);
}

export function registerCombatTrackerIntegration() {
  if (trackerHooksRegistered) return;
  trackerHooksRegistered = true;

  Hooks.on("renderCombatTracker", (app, html) => {
    void renderTrackerIntegration(app, html);
  });

  Hooks.on("updateActor", (actor, changed) => {
    if (!shouldRefreshForActor(actor, changed)) return;
    ui.combat?.render();
  });

  Hooks.on("updateCombat", (combat) => {
    if (!game.combat || combat.id !== game.combat.id) return;
    ui.combat?.render();
  });
}


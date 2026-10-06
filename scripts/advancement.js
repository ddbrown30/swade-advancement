import { NAME, FLAGS, ADVANCE_TYPE } from "./module-config.js";
import { Utils } from "./utils.js";
import { AdvanceDialog } from "./advance-dialog.js";
import { ActorState } from "./actor-state.js";
import { AdvanceHistory } from "./advance-history.js";

/**
 * Adds, edits and deletes advances and applies the result to the actor
 */
export class Advancement {

    /**
     * Replaces the character sheet's add and delete advance actions with our own
     */
    static patchCharacterSheet() {
        const sheetClass = game.swade?.sheets?.CharacterSheet;
        if (!sheetClass) {
            Utils.consoleMessage("error", { message: "Unable to find the swade CharacterSheet class. Advancement will not be available." });
            return;
        }

        sheetClass.DEFAULT_OPTIONS.actions.addAdvance = Advancement.onAddAdvanceAction;
        sheetClass.DEFAULT_OPTIONS.actions.deleteAdvance = Advancement.onDeleteAdvanceAction;
        sheetClass.DEFAULT_OPTIONS.actions.editAdvance = Advancement.onEditAdvanceAction;
        sheetClass.DEFAULT_OPTIONS.actions.togglePlannedAdvance = Advancement.onTogglePlannedAdvanceAction;
    }

    /**
     * Handles the Add Advance button on the character sheet. Called with the sheet as this
     */
    static async onAddAdvanceAction(_event, _target) {
        Advancement.openDialog(this.actor);
    }

    /**
     * Handles the delete advance button on the character sheet. Called with the sheet as this
     */
    static async onDeleteAdvanceAction(_event, target) {
        const advanceId = target.closest("li.advance")?.dataset.advanceId;
        if (!advanceId) return;
        await Advancement.deleteAdvance(this.actor, advanceId);
    }

    /**
     * Handles the edit advance button on the character sheet. Called with the sheet as this
     */
    static async onEditAdvanceAction(_event, target) {
        const advanceId = target.closest("li.advance")?.dataset.advanceId;
        if (!advanceId) return;
        Advancement.openDialog(this.actor, advanceId);
    }

    /**
     * Handles the toggle planned advance button on the character sheet. Called with the sheet as this
     */
    static async onTogglePlannedAdvanceAction(_event, target) {
        const advanceId = target.closest("li.advance")?.dataset.advanceId;
        if (!advanceId) return;
        await Advancement.togglePlanned(this.actor, advanceId);
    }

    /**
     * Opens the advance dialog for the actor or brings an existing one to the front
     */
    static openDialog(actor, advanceId) {
        if (advanceId && !actor.system.advances.list.has(advanceId)) return;

        const existing = foundry.applications.instances.get(AdvanceDialog.getId(actor));
        if (existing) {
            //There is only one dialog per actor so point it at the requested advance
            if (existing.advanceId != advanceId) existing.showAdvance(advanceId);
            existing.bringToFront();
            return existing;
        }

        const dialog = new AdvanceDialog({ actor: actor, advanceId: advanceId });
        dialog.render(true);
        return dialog;
    }

    /**
     * Gets the stored undo data for all of the actor's advances
     */
    static getAdvanceData(actor) {
        return Utils.getModuleFlag(actor, FLAGS.advances) ?? {};
    }

    /**
     * Gets the sort position the next advance added to the actor will have
     */
    static getNextAdvanceSort(actor) {
        return actor.system.advances.list.size + 1;
    }

    /**
     * Gets a snapshot of the actor as it was when the advance was taken
     * @param {Actor} actor
     * @param {String} [advanceId] Leave out for an advance that is being added
     * @param {Boolean} [planned] A planned advance is built on the actor with the planned advances before it applied
     */
    static getActorState(actor, advanceId, planned = false) {
        const entries = AdvanceHistory.getEntries(actor, advanceId);
        const advance = entries.find((e) => e.id == advanceId);
        return planned
            ? AdvanceHistory.getProjectedStateBefore(actor, entries, advance?.sort)
            : AdvanceHistory.getStateBefore(actor, entries, advance?.sort);
    }

    /**
     * Checks if the last advance is planned. Any advance added after it is planned too
     */
    static isLastAdvancePlanned(actor) {
        const entries = AdvanceHistory.getEntries(actor);
        return !!entries[entries.length - 1]?.planned;
    }

    /**
     * Checks if any advance before the one at the provided sort is planned. If so the actor is different for a planned advance than for one that isn't
     * @param {String} [excludeAdvanceId] The advance being edited
     */
    static hasPlannedBefore(actor, sort, excludeAdvanceId) {
        return AdvanceHistory.getEntries(actor).some((e) => e.planned && e.sort < sort && e.id != excludeAdvanceId);
    }

    /**
     * Checks if the actor has already taken an attribute advance in the same rank as the provided sort
     * @param {Actor} actor
     * @param {Number} advanceSort The sort of the advance being added or edited
     * @param {String} excludeAdvanceId An advance to ignore, used so that an advance being edited doesn't count against itself
     */
    static hasAttributeAdvanceThisRank(actor, advanceSort, excludeAdvanceId) {
        const rank = game.swade.util.getRankFromAdvance(advanceSort);
        return actor.system.advances.list.some((a) => a.id != excludeAdvanceId &&
                                                      a.type == ADVANCE_TYPE.ATTRIBUTE &&
                                                      game.swade.util.getRankFromAdvance(a.sort) == rank);
    }

    /**
     * Adds an advance to the end of the list and applies it to the actor
     * @param {Actor} actor
     * @param {Number} type One of ADVANCE_TYPE
     * @param {Object} selection The choices made in the dialog
     * @param {Boolean} [planned] The choices are saved but nothing is applied to the actor
     * @returns {Promise<Boolean>} true if the advance was added
     */
    static async addAdvance(actor, type, selection, planned = false) {
        const plan = await AdvanceHistory.plan(actor, { kind: "add", type: type, selection: selection, planned: planned });
        return Advancement.commit(actor, plan);
    }

    /**
     * Changes an existing advance. What the advance used to do is undone and the new choices are applied. The advance keeps its id and position.
     *
     * Later advances are brought into line with the change. For example if this advance created a skill and a later advance raised it, the
     * later advance now creates it, and if a hindrance was removed by two advances and this one is one of them, the other now only reduces it.
     * @param {Actor} actor
     * @param {String} advanceId
     * @param {Number} type One of ADVANCE_TYPE
     * @param {Object} selection The choices made in the dialog
     * @param {Boolean} [planned] Whether the advance is planned. If this changes the same goes for every advance after it. Leave out to keep it as it is
     * @returns {Promise<Boolean>} true if the advance was changed
     */
    static async editAdvance(actor, advanceId, type, selection, planned) {
        const plan = await AdvanceHistory.plan(actor, { kind: "edit", advanceId: advanceId, type: type, selection: selection, planned: planned });
        return Advancement.commit(actor, plan);
    }

    /**
     * Changes only the description of an advance. The advance's data and the actor are left exactly as they are.
     * @param {Actor} actor
     * @param {String} advanceId
     * @param {String} notes The new description
     * @returns {Promise<Boolean>} true if the description was changed
     */
    static async editDescription(actor, advanceId, notes) {
        const list = actor.system.advances.list.toJSON();
        const advance = list.find((a) => a.id == advanceId);
        if (!advance) return false;

        advance.notes = notes;
        await actor.update({ "system.advances.list": list });
        return true;
    }

    /**
     * Asks for confirmation then marks the advance and every advance after it as planned or as no longer planned.
     * Planned advances keep their choices but their changes are undone. When they are no longer planned the changes are applied again.
     */
    static async togglePlanned(actor, advanceId) {
        const advance = actor.system.advances.list.get(advanceId);
        if (!advance) return;
        const planned = !advance.planned;

        let success = false;
        try {
            const plan = await AdvanceHistory.plan(actor, { kind: "planned", advanceId: advanceId, planned: planned });
            if (!plan) return;
            if (!(await Advancement.confirmPlanned(plan, planned))) return;
            success = await Advancement.commit(actor, plan);
        } catch (error) {
            Utils.consoleMessage("error", { objects: [error], message: "Failed to change planned advances" });
        }

        if (!success) {
            Utils.showNotification("error", game.i18n.localize("SWADE_ADVANCEMENT.Warnings.PlannedFailed"));
        }
    }

    /**
     * Asks the user to confirm changing which advances are planned. Lists every advance that changes and any problems that applying them causes
     * @param {Object} plan From AdvanceHistory.plan()
     * @param {Boolean} planned Whether the advances are becoming planned or are no longer planned
     * @returns {Promise<Boolean>}
     */
    static async confirmPlanned(plan, planned) {
        const advances = plan.planChanged.map((entry) => {
            const prefix = game.i18n.format("SWADE_ADVANCEMENT.Issues.Advance", { number: entry.sort });
            const notes = plan.newReplay.results.get(entry.id)?.notes ?? Utils.stripHtml(entry.notes);
            return `<li>${Utils.escapeHtml(notes ? `${prefix}: ${notes}` : prefix)}</li>`;
        }).join("");

        //Advances that weren't created by this module can't be undone or applied since there is nothing to say what they did
        const hasUntracked = plan.planChanged.some((entry) => !plan.entries.find((e) => e.id == entry.id)?.data);

        let content = `<p>${game.i18n.localize(planned ? "SWADE_ADVANCEMENT.PlannedWarning.ToPlanned" : "SWADE_ADVANCEMENT.PlannedWarning.ToApplied")}</p>`;
        content += `<ul class="swade-advancement-issues">${advances}</ul>`;
        if (hasUntracked) {
            content += `<p class="hint">${game.i18n.localize("SWADE_ADVANCEMENT.PlannedWarning.Untracked")}</p>`;
        }
        if (plan.issues.length) {
            const issues = AdvanceHistory.describeIssues(plan.issues).map((text) => `<li>${Utils.escapeHtml(text)}</li>`).join("");
            content += `<p>${game.i18n.localize("SWADE_ADVANCEMENT.PlannedWarning.Issues")}</p><ul class="swade-advancement-issues">${issues}</ul>`;
        }

        return !!(await foundry.applications.api.DialogV2.confirm({
            window: { title: "SWADE_ADVANCEMENT.PlannedWarning.Title" },
            content: content,
            rejectClose: false,
        }));
    }

    /**
     * Asks for confirmation then deletes the advance, undoing any changes it made and moving the later advances back a step.
     * If that causes problems for the later advances a second confirmation lists them.
     */
    static async deleteAdvance(actor, id) {
        //A planned advance hasn't changed the character so there is nothing to undo
        const data = actor.system.advances.list.get(id)?.planned ? undefined : Advancement.getAdvanceData(actor)[id];
        const prompt = game.i18n.localize(data ? "SWADE_ADVANCEMENT.Delete.PromptUndo" : "SWADE_ADVANCEMENT.Delete.Prompt");

        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: "SWADE.Advances.Delete" },
            content: `<p>${prompt}</p>`,
            rejectClose: false,
        });
        if (!confirmed) return;

        let success = false;
        try {
            const plan = await AdvanceHistory.plan(actor, { kind: "delete", advanceId: id });
            if (!plan) return;

            //Deleting moves every later advance back a step which can also move them into an earlier rank
            if (plan.issues.length && !(await Advancement.confirmIssues(plan.issues, "SWADE_ADVANCEMENT.IssuesWarning.DeletePrompt"))) return;
            success = await Advancement.commit(actor, plan);
        } catch (error) {
            Utils.consoleMessage("error", { objects: [error], message: "Failed to delete advance" });
        }

        if (!success) {
            Utils.showNotification("error", game.i18n.localize("SWADE_ADVANCEMENT.Warnings.DeleteFailed"));
        }
    }

    /**
     * Asks the user to confirm a change that causes problems for later advances
     * @param {Array<Object>} issues From a plan
     * @param {String} promptKey The localization key of the text shown above the list of problems
     * @returns {Promise<Boolean>}
     */
    static async confirmIssues(issues, promptKey) {
        const items = AdvanceHistory.describeIssues(issues).map((text) => `<li>${Utils.escapeHtml(text)}</li>`).join("");
        return !!(await foundry.applications.api.DialogV2.confirm({
            window: { title: "SWADE_ADVANCEMENT.IssuesWarning.Title" },
            content: `<p>${game.i18n.localize(promptKey)}</p><ul class="swade-advancement-issues">${items}</ul>`,
            rejectClose: false,
        }));
    }

    /**
     * Makes a planned change to the advances and the actor.
     * @param {Actor} actor
     * @param {Object} plan From AdvanceHistory.plan()
     * @returns {Promise<Boolean>} true if the change was made
     */
    static async commit(actor, plan) {
        if (!plan) return false;

        const { change, target, newEntry, entries, oldEntries, oldReplay, newReplay } = plan;
        const warnings = [];
        const missing = (name) => warnings.push(game.i18n.format("SWADE_ADVANCEMENT.Undo.MissingItem", { name: name }));

        const toDelete = [];
        const itemUpdates = [];
        const actorUpdate = {};
        const skillsToCreate = [];
        const hindrancesToRestore = [];

        //Edges aren't shared between advances so they are never part of a chain. An edge is removed if its advance is deleted, changed or becomes
        //planned and added if its advance is new, changed or is no longer planned. Planned advances never have an edge on the actor
        const keptEdges = new Set();
        for (const old of oldEntries) {
            if (old.data?.type != ADVANCE_TYPE.EDGE || !oldReplay.results.get(old.id)?.applied) continue;

            const current = entries.find((e) => e.id == old.id);
            if (current && current !== newEntry && current.type == ADVANCE_TYPE.EDGE && newReplay.results.get(old.id)?.applied) {
                keptEdges.add(old.id);
                continue;
            }

            const edge = actor.items.get(old.data.edgeId);
            if (edge) toDelete.push(edge.id); else missing(old.data.edgeName);
        }

        //Skills
        const skillNames = new Set([...oldReplay.counts.skills.keys(), ...newReplay.counts.skills.keys()]);
        for (const name of skillNames) {
            const before = oldReplay.final.findSkill(name);
            const after = newReplay.final.findSkill(name);
            const steps = (newReplay.counts.skills.get(name) ?? 0) - (oldReplay.counts.skills.get(name) ?? 0);
            const actual = Advancement.findSkill(actor, name, (after ?? before)?.swid);

            if (before && !after) {
                if (actual) toDelete.push(actual.id); else missing(before.name);
            } else if (before && after) {
                if (!steps) continue;
                if (!actual) {
                    missing(before.name);
                    continue;
                }
                const die = Advancement.stepDie(Utils.getBaseSkillDie(actual), steps);
                itemUpdates.push({ _id: actual.id, "system.die.sides": die.sides, "system.die.modifier": die.modifier });
            } else if (!before && after && !actual) {
                skillsToCreate.push(after);
            }
        }

        //Attributes
        const attributes = new Set([...oldReplay.counts.attributes.keys(), ...newReplay.counts.attributes.keys()]);
        for (const attribute of attributes) {
            const steps = (newReplay.counts.attributes.get(attribute) ?? 0) - (oldReplay.counts.attributes.get(attribute) ?? 0);
            if (!steps) continue;

            const die = Advancement.stepDie(Utils.getBaseAttributeDie(actor, attribute), steps);
            actorUpdate[`system.attributes.${attribute}.die.sides`] = die.sides;
            actorUpdate[`system.attributes.${attribute}.die.modifier`] = die.modifier;
        }

        //Hindrances. Every hindrance the character has ever had is in the starting state
        const start = AdvanceHistory.getStateBefore(actor, plan.oldEntries, 0);
        for (const hindrance of start.hindrances) {
            const before = oldReplay.final.hindrances.find((h) => h.id == hindrance.id);
            const after = newReplay.final.hindrances.find((h) => h.id == hindrance.id);
            const actual = actor.items.get(hindrance.id) ?? actor.items.find((i) => i.type == "hindrance" && i.name == hindrance.name);

            if (before && !after) {
                if (actual) toDelete.push(actual.id); else missing(hindrance.name);
            } else if (before && after) {
                if (before.isMajor == after.isMajor) continue;
                if (actual) itemUpdates.push({ _id: actual.id, "system.major": after.isMajor }); else missing(hindrance.name);
            } else if (!before && after && !actual) {
                hindrancesToRestore.push(ActorState.getHindranceItemData(after));
            }
        }

        //Undo what the advance used to do then apply the new choices
        if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
        if (itemUpdates.length) await actor.updateEmbeddedDocuments("Item", itemUpdates);
        if (Object.keys(actorUpdate).length) await actor.update(actorUpdate);

        if (hindrancesToRestore.length) {
            //Keep the original ids so that anything that refers to the hindrance stays valid
            await actor.createEmbeddedDocuments("Item", hindrancesToRestore, { keepId: true });
        }

        const edgeIds = new Map();
        for (const entry of entries) {
            if (entry.type != ADVANCE_TYPE.EDGE || !entry.intent || keptEdges.has(entry.id) || !newReplay.results.get(entry.id)?.applied) continue;

            //A planned edge has no item but the item is rebuilt from the copy of the edge stored with the advance
            const source = entry.intent.source ?? entry.intent.item;
            if (!source) {
                missing(entry.intent.name);
                continue;
            }

            const edgeId = await Advancement.createEdge(actor, source);
            if (!edgeId) return false;
            edgeIds.set(entry.id, edgeId);
        }

        for (const skill of skillsToCreate) {
            const source = newEntry?.intent.skills?.find((s) => s.name.toLowerCase() == skill.name.toLowerCase())?.source ?? await fromUuid(skill.sourceUuid ?? "");
            if (!source) {
                warnings.push(game.i18n.format("SWADE_ADVANCEMENT.Undo.MissingItem", { name: skill.name }));
                continue;
            }
            await Advancement.createSkill(actor, source, skill.die);
        }

        for (const warning of warnings) {
            Utils.showNotification("warn", warning);
        }

        //Update the advances. The ids of items that were created are only known now
        const skillIds = new Map(actor.items.filter((i) => i.type == "skill").map((i) => [i.name.toLowerCase(), i.id]));
        const oldData = Advancement.getAdvanceData(actor);
        const list = actor.system.advances.list.toJSON();
        const update = {};

        const flagName = (key) => `flags.${NAME}.${FLAGS.advances}.${key}`;
        let updatedList = list;
        if (change.kind == "delete") {
            updatedList = list.filter((a) => a.id != target.id);
            update[flagName(target.id)] = _del;
        } else if (change.kind == "add") {
            updatedList = [...list, { id: newEntry.id, sort: list.length + 1 }];
        }
        updatedList.forEach((advance, index) => (advance.sort = index + 1));

        for (const entry of entries) {
            const result = newReplay.results.get(entry.id);
            const advance = updatedList.find((a) => a.id == entry.id);
            if (!advance) continue;

            //Everything after an advance that was marked as planned or no longer planned has changed too, whether or not what it chose has
            advance.planned = !!entry.planned;
            if (!result?.data) continue;

            const data = foundry.utils.deepClone(result.data);
            if (edgeIds.has(entry.id)) data.edgeId = edgeIds.get(entry.id);
            for (const skill of data.skills ?? []) {
                skill.id = skillIds.get(skill.name.toLowerCase()) ?? skill.id;
            }

            //Flags can't hold undefined and a key that is missing is what says the advance no longer has it
            for (const key of Object.keys(data)) {
                if (data[key] === undefined) delete data[key];
            }

            const previous = oldData[entry.id];
            if (entry !== newEntry && previous && foundry.utils.equals(previous, data)) continue;

            //Descriptions are only replaced if the advance changed so that notes added by the user are kept otherwise
            advance.type = data.type;
            advance.notes = AdvanceHistory.getNotes(data);

            //Flag updates are merged so anything the advance no longer has has to be removed explicitly
            for (const key of Object.keys(previous ?? {})) {
                if (!(key in data)) update[flagName(`${entry.id}.${key}`)] = _del;
            }
            for (const [key, value] of Object.entries(data)) {
                update[flagName(`${entry.id}.${key}`)] = value;
            }
        }

        update["system.advances.list"] = updatedList;
        await actor.update(update);
        return true;
    }

    /**
     * Finds the actor's skill with the name, or swid if it has one
     */
    static findSkill(actor, name, swid) {
        const lower = name.toLowerCase();
        return actor.items.find((i) => i.type == "skill" && ((swid && i.system.swid == swid) || i.name.toLowerCase() == lower));
    }

    /**
     * Moves a die up or down by the number of steps
     * @param {Object} die
     * @param {Number} steps Positive to increase, negative to decrease
     */
    static stepDie(die, steps) {
        let result = { sides: die.sides, modifier: die.modifier ?? 0 };
        for (let i = 0; i < Math.abs(steps); ++i) {
            result = steps > 0 ? Utils.increaseDie(result) : Utils.decreaseDie(result);
        }
        return result;
    }

    /**
     * Adds a copy of the edge to the actor
     * @returns {Promise<String|undefined>} The id of the new edge
     */
    static async createEdge(actor, edge) {
        const [created] = await actor.createEmbeddedDocuments("Item", [Utils.getEdgeData(edge)]);
        return created?.id;
    }

    /**
     * Adds a copy of the skill to the actor with the provided die
     */
    static async createSkill(actor, skill, die) {
        const skillData = skill.toObject();
        delete skillData._id;
        foundry.utils.setProperty(skillData, "_stats.compendiumSource", skill.pack ? skill.uuid : skill._stats?.compendiumSource ?? null);
        foundry.utils.setProperty(skillData, "system.die.sides", die.sides);
        foundry.utils.setProperty(skillData, "system.die.modifier", die.modifier ?? 0);

        const [created] = await actor.createEmbeddedDocuments("Item", [skillData]);
        return created?.id;
    }
}

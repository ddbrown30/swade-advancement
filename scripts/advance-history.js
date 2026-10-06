import { ADVANCE_TYPE, HINDRANCE_ACTION, FLAGS, SKILL_SOURCE } from "./module-config.js";
import { Utils } from "./utils.js";
import { ActorState } from "./actor-state.js";
import { EdgeRequirements } from "./edge-requirements.js";

/**
 * Works with an actor's advances as one ordered history.
 *
 * Advances depend on each other (e.g. whether a skill is created or increased depends on the advances before it),
 * so changing or deleting one advance can change what the later ones do.
 *
 * To deal with that the history is replayed on ActorState copies from before the first advance:
 *  1. The actor is rewound to before the first advance using each advance's stored undo data.
 *  2. The advances are replayed in order, once as they are now and once with the proposed change.
 *  3. Each advance's replay produces the data it should have stored, so those that differ from what is stored are corrected, and any
 *     rules that the advance breaks. The difference between the two final states is what has to be done to the real actor.
 */
export class AdvanceHistory {

    /**
     * Gets the actor's advances in order
     * @param {Actor} actor
     * @param {String} inferAdvanceId An advance that wasn't created by this module
     */
    static getEntries(actor, inferAdvanceId) {
        const allData = Utils.getModuleFlag(actor, FLAGS.advances) ?? {};
        const entries = Array.from(actor.system.advances.list.values())
            .sort((a, b) => a.sort - b.sort)
            .map((advance) => {
                const data = allData[advance.id];
                return {
                    id: advance.id,
                    type: data?.type ?? advance.type,
                    sort: advance.sort,
                    notes: advance.notes,
                    planned: advance.planned,
                    data: data,
                    intent: data ? AdvanceHistory.getIntentFromData(actor, data) : undefined,
                };
            });

        const target = inferAdvanceId ? entries.find((e) => e.id == inferAdvanceId) : undefined;
        if (target && !target.data) {
            const inference = AdvanceHistory.inferFromNotes(actor, entries, target);
            if (inference) {
                target.inference = inference;
                if (inference.data) {
                    target.data = inference.data;
                    target.intent = AdvanceHistory.getIntentFromData(actor, inference.data);
                    target.inferred = true;
                }
            }
        }

        return entries;
    }

    /**
     * Tries to work out what an advance that wasn't created by this module chose by reading its description
     * @param {Actor} actor
     * @param {Array<Object>} entries From getEntries()
     * @param {Object} target The entry for the advance
     * @returns {{data: Object|undefined, matched: Object}|undefined} Undefined if the advance has no description or nothing in it matched
     */
    static inferFromNotes(actor, entries, target) {
        const text = Utils.stripHtml(target.notes ?? "").trim();
        if (!text) return;

        const state = AdvanceHistory.getStateBefore(actor, entries, target.sort + 1);
        const type = Number(target.type);
        const matched = {};
        let data;

        switch (type) {
            case ADVANCE_TYPE.EDGE: {
                //Edges that other advances gave can't be this one's
                const claimed = new Set(entries.map((e) => e.data?.edgeId).filter((id) => id));
                const edges = state.items.filter((i) => i.type == "edge" && !claimed.has(i.id));
                const found = AdvanceHistory.findNames(text, edges);
                if (found.length != 1) return;

                matched.edgeId = found[0].id;
                data = { type: type, edgeId: found[0].id, edgeName: found[0].name, edgeSwid: found[0].swid };
                break;
            }

            case ADVANCE_TYPE.SINGLE_SKILL:
            case ADVANCE_TYPE.TWO_SKILLS: {
                const required = type == ADVANCE_TYPE.SINGLE_SKILL ? 1 : 2;
                const skills = state.skills.filter((s) => !/unskilled|untrained/i.test(s.name));
                const found = AdvanceHistory.findNames(text, skills);
                //More names than the advance has skills means we can't tell which are the right ones
                if (!found.length || found.length > required) return;

                matched.skills = found.map((s) => s.id);
                if (found.length != required) break;

                //A skill that is only a d4 can't have been raised so the advance must have added it. Skills can't be added with a single skill advance
                if (type == ADVANCE_TYPE.SINGLE_SKILL && found[0].die.sides <= 4) break;

                data = {
                    type: type,
                    skills: found.map((skill) => {
                        const created = skill.die.sides <= 4;
                        const skillData = { id: skill.id, name: skill.name, created: created, die: Utils.normalizeDie(skill.die) };
                        if (skill.swid) skillData.swid = skill.swid;
                        const source = skill.item?._stats?.compendiumSource;
                        if (created && source) skillData.sourceUuid = source;
                        return skillData;
                    }),
                };
                break;
            }

            case ADVANCE_TYPE.ATTRIBUTE: {
                const candidates = [];
                for (const attribute of Object.keys(CONFIG.SWADE.attributes)) {
                    const labels = CONFIG.SWADE.attributes[attribute];
                    const names = [Utils.getAttributeName(attribute), labels.short ? game.i18n.localize(labels.short) : undefined, attribute];
                    for (const name of new Set(names.filter((n) => n))) {
                        candidates.push({ name: name, attribute: attribute });
                    }
                }

                //An attribute can match under more than one of its names
                const attributes = new Set(AdvanceHistory.findNames(text, candidates, true).map((c) => c.attribute));
                if (attributes.size != 1) return;

                const attribute = [...attributes][0];
                matched.attribute = attribute;
                if (state.attributes[attribute]) {
                    data = { type: type, attribute: attribute, die: Utils.normalizeDie(state.attributes[attribute]) };
                }
                break;
            }

            case ADVANCE_TYPE.HINDRANCE: {
                //Only hindrances the character still has can be found. One that the advance removed outright isn't there to match
                const found = AdvanceHistory.findNames(text, state.hindrances);
                if (found.length != 1) return;

                const hindrance = found[0];
                matched.hindranceId = hindrance.id;

                //What the advance did to it is whatever would have left it the way it is now
                let action;
                if (hindrance.isMajor) {
                    if (hindrance.severity != "either") action = HINDRANCE_ACTION.reduced;
                } else if (hindrance.severity == "either") {
                    action = HINDRANCE_ACTION.reducedToMinor;
                }
                if (action) {
                    data = { type: type, action: action, hindranceId: hindrance.id, hindranceName: hindrance.name };
                }
                break;
            }

            default:
                return;
        }

        return { data: data, matched: matched };
    }

    /**
     * Finds which of the candidates are named in the text, in the order they appear. Names are matched as whole words regardless of case, and
     * what separates them doesn't matter. The longest names are matched first and each part of the text can only be used once so that a
     * shorter name inside a longer one isn't matched as well.
     * @param {String} text
     * @param {Array<Object>} candidates Objects with a name
     * @param {Boolean} all Return every candidate that matched instead of one per different name. Used when a name can mean more than one candidate
     */
    static findNames(text, candidates, all = false) {
        const lower = text.toLowerCase();
        const used = [];
        const found = [];
        const seen = new Set();

        const sorted = [...candidates].filter((c) => c.name).sort((a, b) => b.name.length - a.name.length);
        for (const candidate of sorted) {
            const name = candidate.name.toLowerCase();
            if (!all && seen.has(name)) continue;

            const regex = new RegExp(`(?<![\\p{L}\\p{N}])${Utils.escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "gu");
            let match;
            while ((match = regex.exec(lower))) {
                const start = match.index;
                const end = start + name.length;
                if (used.some(([s, e]) => start < e && end > s)) continue;

                used.push([start, end]);
                found.push({ candidate: candidate, index: start });
                seen.add(name);
                break;
            }
        }

        return found.sort((a, b) => a.index - b.index).map((f) => f.candidate);
    }

    /**
     * Gets what an advance chose from its stored data
     */
    static getIntentFromData(actor, data) {
        switch (data.type) {
            case ADVANCE_TYPE.EDGE:
                return { edgeId: data.edgeId, name: data.edgeName, swid: data.edgeSwid, item: actor.items.get(data.edgeId) };
            case ADVANCE_TYPE.SINGLE_SKILL:
            case ADVANCE_TYPE.TWO_SKILLS:
                return { skills: (data.skills ?? []).map((s) => ({ name: s.name, swid: s.swid, sourceUuid: s.sourceUuid })) };
            case ADVANCE_TYPE.ATTRIBUTE:
                return { attribute: data.attribute };
            case ADVANCE_TYPE.HINDRANCE:
                //The previous data is kept in case the hindrance can't be found when replaying
                return { hindranceId: data.hindranceId, hindranceName: data.hindranceName, previous: data };
        }
    }

    /**
     * Gets what an advance chose from the selections made in the dialog
     * @param {ActorState} state The actor before the advance, used to look up the selected skills and hindrance
     * @param {Number} type One of ADVANCE_TYPE
     * @param {Object} selection The selections made in the dialog
     */
    static async getIntentFromSelection(state, type, selection) {
        switch (type) {
            case ADVANCE_TYPE.EDGE:
                return { name: selection.edge.name, swid: selection.edge.system.swid, item: selection.edge, source: selection.edge };

            case ADVANCE_TYPE.SINGLE_SKILL:
                return { skills: [await AdvanceHistory.resolveSkill(state, selection.skill)] };

            case ADVANCE_TYPE.TWO_SKILLS:
                return { skills: await Promise.all(selection.skills.map((s) => AdvanceHistory.resolveSkill(state, s))) };

            case ADVANCE_TYPE.ATTRIBUTE:
                return { attribute: selection.attribute };

            case ADVANCE_TYPE.HINDRANCE: {
                const hindrance = state.hindrances.find((h) => h.id == selection.hindrance);
                if (!hindrance) throw new Error(`Hindrance ${selection.hindrance} not found`);
                return { hindranceId: hindrance.id, hindranceName: hindrance.name };
            }
        }
    }

    /**
     * Splits a skill dropdown value into its source and id
     */
    static parseSkillValue(value) {
        const index = value.indexOf(":");
        return [value.slice(0, index), value.slice(index + 1)];
    }

    /**
     * Converts a skill dropdown value in the form "owned:<item id>" or "new:<uuid>" into what the replay needs
     */
    static async resolveSkill(state, value) {
        const [source, id] = AdvanceHistory.parseSkillValue(value);
        if (source == SKILL_SOURCE.owned) {
            const skill = state.skills.find((s) => s.id == id);
            if (!skill) throw new Error(`Skill ${id} not found`);
            return { name: skill.name, swid: skill.swid, attribute: skill.attribute };
        }

        const skill = await fromUuid(id);
        if (!skill) throw new Error(`Skill ${id} not found`);
        return { name: skill.name, swid: skill.system.swid, attribute: skill.system.attribute, sourceUuid: skill.uuid, source: skill };
    }

    /**
     * Gets the actor as it was before the advances at or after the provided sort were applied. This undoes them in reverse order so
     * that skills created by one advance and raised by another are unwound the way they were built up.
     * @param {Array<Object>} entries From getEntries()
     * @param {Number} [sort] Everything from this sort onwards is undone. Leave out to get the actor as it is now
     */
    static getStateBefore(actor, entries, sort = Infinity) {
        const state = new ActorState(actor);
        for (const entry of [...entries].reverse()) {
            if (entry.sort >= sort && entry.data) state.rewind(entry.data);
        }
        return state;
    }

    /**
     * Works out the effects of a change to the history
     * @param {Actor} actor
     * @param {Object} change One of
     *  { kind: "add", type, selection } adds an advance to the end
     *  { kind: "edit", advanceId, type, selection } changes an advance
     *  { kind: "delete", advanceId } removes an advance and moves the later ones back a step
     * @returns {Promise<Object|undefined>} The plan, or undefined if the advance doesn't exist
     */
    static async plan(actor, change) {
        //Editing an advance that wasn't created by this module treats it as though it was if what it chose can be worked out
        const oldEntries = AdvanceHistory.getEntries(actor, change.kind == "edit" ? change.advanceId : undefined);
        const target = change.advanceId ? oldEntries.find((e) => e.id == change.advanceId) : undefined;
        if (change.kind != "add" && !target) return;

        const start = AdvanceHistory.getStateBefore(actor, oldEntries, 0);
        let entries;
        let newEntry;

        switch (change.kind) {
            case "add":
                newEntry = { id: foundry.utils.randomID(8), type: change.type, sort: oldEntries.length + 1, planned: false };
                entries = [...oldEntries, newEntry];
                break;
            case "edit":
                newEntry = { id: target.id, type: change.type, sort: target.sort, notes: target.notes, planned: false };
                entries = oldEntries.map((e) => (e === target ? newEntry : e));
                break;
            case "delete":
                entries = oldEntries.filter((e) => e !== target).map((e, i) => ({ ...e, sort: i + 1 }));
                break;
        }

        if (newEntry) {
            const before = AdvanceHistory.getStateBefore(actor, oldEntries, target?.sort ?? Infinity);
            newEntry.intent = await AdvanceHistory.getIntentFromSelection(before, change.type, change.selection);
        }

        //Where created skills came from is needed when a skill becomes created by an advance that didn't create it before
        const sources = new Map();
        for (const entry of [...oldEntries, ...(newEntry ? [newEntry] : [])]) {
            for (const skill of entry.data?.skills ?? entry.intent?.skills ?? []) {
                if (skill.sourceUuid) sources.set(skill.name.toLowerCase(), skill.sourceUuid);
            }
        }

        //The results of replaying the history without and with the change
        const oldReplay = AdvanceHistory.replay(start, oldEntries, sources);
        const newReplay = AdvanceHistory.replay(start, entries, sources);

        const issues = []; //The problems the change causes in the advances after the one being changed, not counting ones that were already there
        if (target) {
            const targetIndex = oldEntries.indexOf(target);
            for (const later of oldEntries.slice(targetIndex + 1)) {
                const existing = new Set((oldReplay.results.get(later.id)?.issues ?? []).map((i) => i.key));
                for (const issue of newReplay.results.get(later.id)?.issues ?? []) {
                    if (existing.has(issue.key)) continue;
                    issues.push({ ...issue, advanceId: later.id, number: later.sort });
                }
            }
        }

        return { change, target, newEntry, oldEntries, entries, oldReplay, newReplay, issues };
    }

    /**
     * Plays advances forward from the starting state without changing the actor
     * @param {ActorState} start The actor from before the first advance
     * @param {Array<Object>} entries The advances to play in order. Each needs an intent to have any effect
     * @param {Map<String, String>} [sources] Lower case skill names mapped to the uuid the skill is created from
     * @returns {{results: Map, final: ActorState, counts: Object}}
     */
    static replay(start, entries, sources = new Map()) {
        const state = start.clone();
        const results = new Map();
        const counts = { skills: new Map(), attributes: new Map() };
        const reduced = new Set();
        const attributeRanks = new Map();
        const history = [];

        for (const entry of entries) {
            const result = { issues: [] };
            results.set(entry.id, result);

            const historyEntry = {
                id: entry.id,
                type: entry.type,
                sort: entry.sort,
                notes: entry.notes,
                data: entry.type == ADVANCE_TYPE.EDGE && entry.intent ? { edgeSwid: entry.intent.swid } : undefined,
            };

            if (entry.type == ADVANCE_TYPE.ATTRIBUTE) {
                const rank = game.swade.util.getRankFromAdvance(entry.sort);
                const count = attributeRanks.get(rank) ?? 0;
                attributeRanks.set(rank, count + 1);
                if (count > 0) result.issues.push({ kind: "AttributeTwice", key: `AttributeTwice:${rank}` });
            }

            if (entry.intent) {
                switch (entry.type) {
                    case ADVANCE_TYPE.EDGE:
                        AdvanceHistory.replayEdge(state, entry, result, history);
                        break;
                    case ADVANCE_TYPE.SINGLE_SKILL:
                    case ADVANCE_TYPE.TWO_SKILLS:
                        AdvanceHistory.replaySkills(state, entry, result, counts, sources);
                        break;
                    case ADVANCE_TYPE.ATTRIBUTE:
                        AdvanceHistory.replayAttribute(state, entry, result, counts);
                        break;
                    case ADVANCE_TYPE.HINDRANCE:
                        AdvanceHistory.replayHindrance(state, entry, result, reduced);
                        break;
                }

                if (result.data) result.notes = AdvanceHistory.getNotes(result.data);
            }

            history.push(historyEntry);
        }

        return { results, final: state, counts };
    }

    static replayEdge(state, entry, result, history) {
        const intent = entry.intent;

        //The edge's item is needed to read its requirements. It's missing if it was deleted from the actor by some other means
        if (intent.item) {
            const check = EdgeRequirements.check(state, intent.item, entry.sort, history);
            const missing = check.groups.filter((g) => g.missing);
            if (missing.length) {
                const labels = missing.map((g) => g.requirements.filter((r) => r.missing).map((r) => r.label).join(` ${game.i18n.localize("SWADE_ADVANCEMENT.Requirements.Or")} `));
                result.issues.push({ kind: "EdgeRequirements", key: `EdgeRequirements:${labels.join("|")}`, name: intent.name, requirements: labels.join(", ") });
            }
        }

        state.items.push({ id: intent.edgeId ?? `pending-${entry.id}`, type: "edge", name: intent.name, swid: intent.swid });
        result.data = { type: ADVANCE_TYPE.EDGE, edgeId: intent.edgeId, edgeName: intent.name, edgeSwid: intent.swid };
    }

    static replaySkills(state, entry, result, counts, sources) {
        const single = entry.type == ADVANCE_TYPE.SINGLE_SKILL;
        const skills = [];

        for (const skill of entry.intent.skills) {
            const lower = skill.name.toLowerCase();
            let record = state.findSkill(skill.name, skill.swid);

            if (record) {
                const attributeDie = record.attribute ? state.attributes[record.attribute] : undefined;
                //Mirrors the rules the dialog uses for its options
                const canRaiseAlone = !attributeDie || record.die.sides >= 12 || record.die.sides >= attributeDie.sides;
                if (single && !canRaiseAlone) {
                    result.issues.push({ kind: "SingleNotEligible", key: `SingleNotEligible:${lower}`, name: skill.name });
                } else if (!single && canRaiseAlone && attributeDie) {
                    result.issues.push({ kind: "TwoNotEligible", key: `TwoNotEligible:${lower}`, name: skill.name });
                }

                record.die = Utils.increaseDie(record.die);
                skills.push({ record: record, created: false });
            } else {
                //Only the two skills advance can add a skill. We still add it so that later advances have something to raise
                if (single) {
                    result.issues.push({ kind: "SkillMissing", key: `SkillMissing:${lower}`, name: skill.name });
                }

                record = {
                    id: undefined,
                    type: "skill",
                    name: skill.name,
                    swid: skill.swid,
                    die: { sides: 4, modifier: 0 },
                    attribute: skill.attribute ?? state.actor.items.find((i) => i.type == "skill" && i.name.toLowerCase() == lower)?.system.attribute,
                    sourceUuid: skill.sourceUuid ?? sources.get(lower),
                };
                state.items.push(record);
                skills.push({ record: record, created: true });
            }

            counts.skills.set(lower, (counts.skills.get(lower) ?? 0) + 1);
        }

        result.data = {
            type: entry.type,
            skills: skills.map(({ record, created }) => {
                const skillData = { id: record.id, name: record.name, created: created, die: Utils.normalizeDie(record.die) };
                if (record.swid) skillData.swid = record.swid;
                if (created && record.sourceUuid) skillData.sourceUuid = record.sourceUuid;
                return skillData;
            }),
        };
    }

    static replayAttribute(state, entry, result, counts) {
        const attribute = entry.intent.attribute;
        const die = Utils.increaseDie(state.attributes[attribute]);
        state.attributes[attribute] = die;
        counts.attributes.set(attribute, (counts.attributes.get(attribute) ?? 0) + 1);
        result.data = { type: ADVANCE_TYPE.ATTRIBUTE, attribute: attribute, die: Utils.normalizeDie(die) };
    }

    static replayHindrance(state, entry, result, reduced) {
        const intent = entry.intent;
        const record = state.findHindrance(intent.hindranceId, intent.hindranceName);
        if (!record) {
            //The hindrance is already gone, probably removed by an earlier advance, so there is nothing for this advance to do
            result.issues.push({ kind: "HindranceMissing", key: `HindranceMissing:${intent.hindranceName}`, name: intent.hindranceName });
            result.data = foundry.utils.deepClone(intent.previous);
            return;
        }

        const action = AdvanceHistory.getHindranceAction(record, reduced.has(record.id));
        const data = { type: ADVANCE_TYPE.HINDRANCE, action: action, hindranceId: record.id, hindranceName: record.name };

        switch (action) {
            case HINDRANCE_ACTION.removed:
                data.itemData = ActorState.getHindranceItemData(record);
                state.items = state.items.filter((i) => i !== record);
                break;
            case HINDRANCE_ACTION.reducedToMinor:
                record.isMajor = false;
                break;
            case HINDRANCE_ACTION.reduced:
                reduced.add(record.id);
                break;
        }

        result.data = data;
    }

    /**
     * Decides what decreasing a hindrance does. Minor hindrances are removed. Major hindrances that have a minor version are reduced to minor.
     * Major hindrances without a minor version require two advances to remove.
     * @param {Object} hindrance A hindrance record from an ActorState
     * @param {Boolean} previouslyReduced If an earlier advance has already partially reduced the hindrance
     */
    static getHindranceAction(hindrance, previouslyReduced) {
        if (!hindrance.isMajor) return HINDRANCE_ACTION.removed;
        if (hindrance.severity == "either") return HINDRANCE_ACTION.reducedToMinor;
        return previouslyReduced ? HINDRANCE_ACTION.removed : HINDRANCE_ACTION.reduced;
    }

    /**
     * Gets the description of an advance from its data
     */
    static getNotes(data) {
        switch (data.type) {
            case ADVANCE_TYPE.EDGE:
                return data.edgeName;
            case ADVANCE_TYPE.SINGLE_SKILL:
            case ADVANCE_TYPE.TWO_SKILLS:
                return data.skills.map((s) => `${s.name} ${Utils.getDieString(s.die)}`).join(", ");
            case ADVANCE_TYPE.ATTRIBUTE:
                return `${Utils.getAttributeName(data.attribute)} ${Utils.getDieString(data.die)}`;
            case ADVANCE_TYPE.HINDRANCE: {
                const key = {
                    [HINDRANCE_ACTION.removed]: "SWADE_ADVANCEMENT.Notes.RemovedHindrance",
                    [HINDRANCE_ACTION.reducedToMinor]: "SWADE_ADVANCEMENT.Notes.ReducedHindranceToMinor",
                    [HINDRANCE_ACTION.reduced]: "SWADE_ADVANCEMENT.Notes.ReducedHindrance",
                }[data.action];
                return key ? game.i18n.format(key, { name: data.hindranceName }) : "";
            }
        }
        return "";
    }

    /**
     * Gets the text to show the user for each issue
     * @param {Array<Object>} issues From a plan
     * @returns {Array<String>}
     */
    static describeIssues(issues) {
        return issues.map((issue) => {
            const prefix = game.i18n.format("SWADE_ADVANCEMENT.Issues.Advance", { number: issue.number });
            return `${prefix}: ${game.i18n.format(`SWADE_ADVANCEMENT.Issues.${issue.kind}`, issue)}`;
        });
    }
}

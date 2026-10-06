import { POWER_POINTS_SWID, ADVANCE_TYPE, MULTIPLE_EDGE_SWIDS } from "./module-config.js";
import { Utils } from "./utils.js";

/**
 * Validates that an actor meets the requirements for an edge
 */
export class EdgeRequirements {

    /**
     * Checks all of the edge's requirements against the actor
     * @param {ActorState} state The actor as it is before the advance is applied
     * @param {Item} edge The edge being taken
     * @param {Number} advanceSort The sort position of the advance the edge is being taken with
     * @param {Array<Object>} history The advances to check the once per rank rule against, see AdvanceHistory.getEntries()
     * @param {String} [excludeAdvanceId] An advance to ignore for the once per rank checks. Used when editing so an advance doesn't conflict with itself
     * @returns {{met: Boolean, requirements: Array<{label: String, met: Boolean, unverifiable: Boolean}>}}
     */
    static check(state, edge, advanceSort, history, excludeAdvanceId) {
        const requirements = edge.system.requirements ?? [];
        const results = requirements.map((r) => {
            const result = EdgeRequirements.checkRequirement(state, r, advanceSort);
            return {
                label: EdgeRequirements.getRequirementLabel(r),
                met: result.met,
                missing: !result.met,
                unverifiable: result.unverifiable,
                combinator: r.combinator,
            };
        });

        const oncePerRankRegex = /once\s+per\s+rank/i;
        if (edge.system.swid == POWER_POINTS_SWID) {
            const rank = game.swade.util.getRankFromAdvance(advanceSort);
            //Characters can take the PP edge as many times as they want once Legendary
            if (rank !== CONFIG.SWADE.CONST.RANK.LEGENDARY) {
                const met = !EdgeRequirements.hasEdgeThisRank(history, edge, advanceSort, excludeAdvanceId);
                results.unshift({
                    label: game.i18n.localize("SWADE_ADVANCEMENT.Requirements.OncePerRank"),
                    met: met,
                    missing: !met,
                    unverifiable: false,
                });
            }
        } else if (oncePerRankRegex.test(Utils.stripHtml(edge.system.description))) {
            const met = !EdgeRequirements.hasEdgeThisRank(history, edge, advanceSort, excludeAdvanceId);
            results.unshift({
                label: game.i18n.localize("SWADE_ADVANCEMENT.Requirements.OncePerRank"),
                met: met,
                missing: !met,
                unverifiable: false,
            });
        } else if (state.actor.items.some((i) => i.system.swid === edge.system.swid)) {
            if (!MULTIPLE_EDGE_SWIDS.includes(edge.system.swid)) {
                results.unshift({
                    label: game.i18n.localize("SWADE_ADVANCEMENT.Requirements.Once"),
                    met: true,
                    unverifiable: true,
                });
            }
        }

        //Requirements joined with "or" form a group. A group is met if any of its members are met
        const groups = [];
        for (let i = 0; i < results.length; ++i) {
            if (i == 0 || results[i - 1].combinator != "or") {
                groups.push({ requirements: [] });
            }
            groups[groups.length - 1].requirements.push(results[i]);
        }

        for (const group of groups) {
            group.met = group.requirements.some((r) => r.met);
            group.missing = !group.met;
            group.unverifiable = group.requirements.every((r) => r.unverifiable);
            for (const result of group.requirements) {
                result.isOr = result.combinator == "or" && result != group.requirements[group.requirements.length - 1];
            }
        }

        return {
            met: groups.every((r) => !r.missing),
            groups: groups,
        };
    }

    /**
     * Gets the display label for a requirement
     */
    static getRequirementLabel(requirement) {
        switch (requirement.type) {
            case "rank": {
                const rank = CONFIG.SWADE.ranks[EdgeRequirements.getRequiredRankIndex(requirement.value)];
                return rank ? game.i18n.localize(rank) : String(requirement.value);
            }
            case "attribute":
                return `${Utils.getAttributeName(requirement.selector)} d${requirement.value}+`;
            default:
                return Utils.stripHtml(requirement.toString?.() ?? requirement.label ?? "");
        }
    }

    /**
     * Checks a single requirement against the actor
     * @returns {{met: Boolean, unverifiable: Boolean}}
     */
    static checkRequirement(state, requirement, advanceSort) {
        const req = { ...requirement };
        const hasItem = (type) => {
            return state.items.some((i) => {
                if (i.type != type) return false;
                if (req.selector && i.swid == req.selector) return true;
                return !!req.label && i.name.toLowerCase().startsWith(req.label.toLowerCase());
            });
        };

        if (req.type === "other" && req.label.includes("(Any)") && !req.label.includes(" or ")) {
            req.type = "edge";
        }

        switch (req.type) {
            case "wildCard":
                return { met: state.isWildcard == !!req.value, unverifiable: false };
            case "rank": {
                const requiredRank = EdgeRequirements.getRequiredRankIndex(req.value);
                if (requiredRank < 0) return { met: true, unverifiable: true };
                return { met: game.swade.util.getRankFromAdvance(advanceSort) >= requiredRank, unverifiable: false };
            }
            case "attribute": {
                const die = state.attributes[req.selector];
                if (!die) return { met: false, unverifiable: false };
                return { met: die.sides >= Number(req.value), unverifiable: false };
            }
            case "skill": {
                const skill = state.skills.find((i) => i.swid == req.selector || i.name.toLowerCase() == req.label?.toLowerCase());
                if (!skill) return { met: false, unverifiable: false };
                return { met: skill.die.sides >= Number(req.value), unverifiable: false };
            }
            case "edge":
                if (req.label.includes("at least")){
                    return { met: true, unverifiable: true };
                }
                req.label = req.label.replace(" (Any)", "");
                return { met: hasItem("edge"), unverifiable: false };
            case "hindrance":
                return { met: hasItem("hindrance"), unverifiable: false };
            case "ancestry":
                return { met: hasItem("ancestry"), unverifiable: false };
            case "power":
                return { met: hasItem("power"), unverifiable: false };
            default:
                //"Other" requirements are free text so we have no way to verify them. Leave it to the user
                return { met: true, unverifiable: true };
        }
    }

    /**
     * Converts a rank requirement value to a rank index. The value is usually an index but we also handle rank names
     */
    static getRequiredRankIndex(value) {
        if (Number.isNumeric(value)) return Number(value);

        const ranks = CONFIG.SWADE.ranks;
        let index = ranks.indexOf(value);
        if (index < 0) {
            index = ranks.findIndex((r) => game.i18n.localize(r).toLowerCase() == String(value).toLowerCase());
        }
        return index;
    }

    /**
     * Checks if the edge has already been taken with an advance in the same rank as the provided sort
     * @param {Array<Object>} history Advances in the form { id, type, sort, notes, data } where data has the edgeSwid for edges added by this module
     * @param {String} [excludeAdvanceId] An advance to ignore
     */
    static hasEdgeThisRank(history, edge, advanceSort, excludeAdvanceId) {
        const rank = game.swade.util.getRankFromAdvance(advanceSort);
        return history.some((advance) => {
            if (advance.id == excludeAdvanceId) return false;
            if (advance.type !== ADVANCE_TYPE.EDGE) return false;
            if (game.swade.util.getRankFromAdvance(advance.sort) !== rank) return false;

            const data = advance.data;
            if (data?.edgeSwid) return data.edgeSwid === edge.system.swid;

            //This advance wasn't created by this module so fall back to checking the notes for the edge name
            return Utils.stripHtml(advance.notes).toLowerCase().includes(edge.name.toLowerCase());
        });
    }
}

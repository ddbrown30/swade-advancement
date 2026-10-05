# SWADE Advancement

This module adds a validated workflow for applying Advances in the SWADE system.

Clicking the **Add Advance** button on the character sheet opens a dialog where you choose the type of advance and make your selections. Clicking **Add** adds the advance to the advance list and applies the changes to the character.

## Advance Types

* **New Edge**: Drag and drop an edge onto the dialog. The edge's requirements are checked against the character and any that are not met are highlighted. The edge is added to the character. If you have the [Item Browser](https://foundryvtt.com/packages/item-browser) module enabled, you will be able to use it to browse for an edge instead.
* **Raise Single Skill**: Choose one skill whose unmodified die is equal to or greater than its linked attribute and raise it by one die type.
* **Raise Two Skills**: Choose two skills whose unmodified dice are below their linked attributes and raise each by one die type.
* **Raise Attribute**: Raise an attribute by one die type. Only available once per rank.
* **Decrease Hindrance**: Minor hindrances are removed and Major hindrances are reduced to Minor. Major hindrances with no Minor version are removed after being decreased twice.

## Deleting Advances

When an advance added by this module is deleted, its changes are undone where possible: edges are removed, skills and attributes are lowered, newly added skills are removed and hindrances are restored.

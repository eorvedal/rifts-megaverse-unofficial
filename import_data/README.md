# Rifts Batch Imports

This directory contains import-ready JSON batch files for the Foundry bulk importer.

These files are intended to be loaded directly into a world to populate skills, powers, spells, equipment, augmentations, choice lists, and class data.

## Package Scope

This distribution includes supported JSON import batches only.

It does not include:
- OCR text
- source extraction notes
- copied rulebook text files
- older draft class batches

The supported class files in this package are the `OCC_RCC_REFRESH_BATCH_*` files.

## Quick Start

Use the Foundry bulk importer with these general settings unless a batch notes otherwise:

- `Input Format`: `JSON`
- `Duplicate Handling`: `Update Existing` when refreshing an existing world

Important:
- these files are JSON arrays
- if the importer is set to `CSV`, preview will fail
- import content batches before importing the choice lists that depend on them
- import choice lists before importing OCC/RCC batches that reference those lists

## Recommended Import Order

Import batches in this order.

### 1. Skills and Weapon Proficiencies

- `BASE_SKILLS_EXTRACT_BATCH_01.json`
- `BASE_SKILLS_EXTRACT_BATCH_02.json`
- `BASE_SKILLS_EXTRACT_BATCH_03.json`
- `CHOICE_LISTS_BATCH_01.json`

### 2. Psionics

- `PSIONICS_EXTRACT_BATCH_01.json`
- `CHOICE_LISTS_BATCH_02.json`

### 3. Spells

- `SPELLS_EXTRACT_BATCH_01.json`
- `CHOICE_LISTS_BATCH_03.json`

### 4. Equipment and Augmentations

- `GEAR_EXTRACT_BATCH_01.json`
- `ARMOR_EXTRACT_BATCH_01.json`
- `ARMOR_EXTRACT_BATCH_02.json`
- `WEAPONS_EXTRACT_BATCH_01.json`
- `WEAPONS_EXTRACT_BATCH_02.json`
- `POWER_ARMOR_EXTRACT_BATCH_01.json`
- `VEHICLES_EXTRACT_BATCH_01.json`
- `CYBERNETICS_EXTRACT_BATCH_01.json`
- `BIONICS_EXTRACT_BATCH_01.json`
- `BIONICS_EXTRACT_BATCH_02.json`
- `CYBORG_ARMOR_EXTRACT_BATCH_01.json`
- `CHOICE_LISTS_BATCH_04.json`
- `CHOICE_LISTS_BATCH_05.json`
- `CHOICE_LISTS_BATCH_06.json`
- `CHOICE_LISTS_BATCH_07.json`
- `CHOICE_LISTS_BATCH_08.json`
- `CHOICE_LISTS_BATCH_09.json`

### 5. OCC and RCC Refresh Batches

- `OCC_RCC_REFRESH_BATCH_01.json`
- `OCC_RCC_REFRESH_BATCH_02.json`
- `OCC_RCC_REFRESH_BATCH_03.json`
- `OCC_RCC_REFRESH_BATCH_04.json`
- `OCC_RCC_REFRESH_BATCH_05.json`
- `OCC_RCC_REFRESH_BATCH_06.json`
- `OCC_RCC_REFRESH_BATCH_07.json`
- `OCC_RCC_REFRESH_BATCH_08.json`

## Importer Content Type Reference

Use the file prefix to choose the correct `Content Type` in the importer.

|        File Pattern           | Content Type  |
|            ---                |     ---       |
| `BASE_SKILLS_EXTRACT_BATCH_*` | `Skill Items` |
| `PSIONICS_EXTRACT_BATCH_*`    | `Powers` |
| `SPELLS_EXTRACT_BATCH_*`      | `Powers` |
| `GEAR_EXTRACT_BATCH_*`        | `Gear` |
| `WEAPONS_EXTRACT_BATCH_*`     | `Weapons` |
| `ARMOR_EXTRACT_BATCH_*`       | `Armor` |
| `POWER_ARMOR_EXTRACT_BATCH_*` | `Armor` |
| `CYBORG_ARMOR_EXTRACT_BATCH_*`| `Armor` |
| `VEHICLES_EXTRACT_BATCH_*`    | `Vehicles` |
| `CYBERNETICS_EXTRACT_BATCH_*` | `Cybernetic Items` |
| `BIONICS_EXTRACT_BATCH_*`     | `Bionic Items` |
| `CHOICE_LISTS_BATCH_*`        | `Choice Lists` |
| `OCC_RCC_REFRESH_BATCH_*`     | `OCC` or `RCC`, depending on the file contents |

## Class Batch Notes

Use the refresh batches as the supported class imports.

These files were rebuilt against the current:
- skill catalog
- weapon proficiency catalog
- powers
- spells
- equipment
- cybernetics
- bionics
- choice lists

For class imports:
- some refresh batches contain OCC entries
- some refresh batches contain RCC entries
- choose the matching importer `Content Type` for the file you are importing

## Updating an Existing World

When refreshing content in a world that already has these items:

1. import the updated item batches first
2. re-import the related choice lists
3. re-import the affected OCC/RCC refresh batches

This keeps class references aligned with the current item catalog.

## Actor Snapshot Reminder

Items added to actors are snapshots of the world item at the time they were added.

If a world item is updated later, actors do not inherit that change automatically. Update the actor-owned copy manually or remove and re-add the item.

## File Naming

- `EXTRACT` means a content batch extracted and prepared for import
- `REFRESH` means a later rebuilt batch aligned to the current schema and choice-list structure
- `BATCH_01`, `BATCH_02`, and so on indicate sequence only

// The one place the party roster lives — shared by the single-fight and session CLIs.
export const WORLD = 'nauvis'
// Replaced 2026-09-07: the project owner left and rejoined the in-game party ("closed and
// reopened the group"), which retires the old Party object and creates a fresh one -- same
// class of change as a redeploy orphaning character ids, just scoped to the party grouping
// instead of the characters themselves (confirmed live: all 4 CHARACTERS below were still
// perfectly valid and still members of the party's roster -- only this id had gone stale).
// Found the same way as before (party.move has no queryable character->party mapping and no
// creation event -- this can't be derived from bot code alone) and confirmed via a direct chain
// read (type `::party::Party`, `members` contains exactly these 4 character ids, nothing else).
export const PARTY_ID: string | null = '0x38b0d732cf3183d0b06b4cf3e2230f4da834ab36f765a90f5758373d161bb99e'

// Discovered via `bun run enoki-login` on mainnet (2026-09-11). All 4 characters are custody in
// the same kiosk (0x7aa1ea...). Omori is the party leader (members[0] on-chain).
export const CHARACTERS = [
  {
    name: 'omori',
    id: '0x4b5684e0b2d6fc47dd5c8d41076b8a9b4e795e84fd6492f2b7917a2d134b4faf',
    classe: 'mori',
    leader: true,
  },
  {
    name: 'memorien',
    id: '0xbb86c9fa3dfc0e51700bbf56f12e1321a986d8810547fb6b2714fefa8c512cf9',
    classe: 'mori',
    leader: false,
  },
  {
    name: 'llokan',
    id: '0xea74a318f115b5f917e41bbfe1a98d2d963a6cc5a5166aacdd4053dcdc80d357',
    classe: 'yogan',
    leader: false,
  },
  {
    name: 'archero',
    id: '0xeea1b3a67f00f803208e9b1129e6912752c01e4a1a3549e5b2d6260b1f7eee6f',
    classe: 'yogan',
    leader: false,
  },
] as const
export const LEADER = CHARACTERS.find((c) => c.leader)!

// Told to us directly (2026-08-31) — client/voxel coordinates, converted to the chain's grid
// with client_to_chain_coordinate (= value + world_center, world_center = world_size/2 = 50000).
// Only used as the SEED position for the very first fight of a session; every fight after that
// carries its own position forward automatically (the Fight object's own x/z).
export const INITIAL_CHAIN_X = 48612
export const INITIAL_CHAIN_Z = 49736

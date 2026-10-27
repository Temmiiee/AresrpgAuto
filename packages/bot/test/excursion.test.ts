// excursion tests — the gathering-drive roster and the unmet-specialty trigger.
//
// The regression these lock: the default chore plan is `gather_craft`/`gather_all_craft`, but the
// roster builder recognised only the bare `gather`/`gather_all` kinds. It therefore returned EMPTY,
// `gather_needs` saw no gap, `maybe_start_excursion` bailed on an empty need list, and the party
// never left a biome its gatherers could not work — the live window held only quartz+amber (a MINER
// biome) while omori's chore wanted HERBALIST, so every gather skipped for a whole night.
import { job_xp_for_level } from '@aresrpg/immutable'
import type { CharacterRow } from '@aresrpg/protocol'

import { gather_members, gather_needs } from '../src/actions/excursion.ts'
import { create_party } from '../src/actions/party.ts'
import { config } from '../src/config.ts'
import { initial_game_state, type GameState } from '../src/state/store.ts'

const xp = (level: number): string => String(job_xp_for_level(level) ?? 0)

const character = (
  name: string,
  jobs: Record<string, string> = {},
  equipment: readonly unknown[] = []
): CharacterRow => ({ id: name, name, world: 'nauvis', jobs, equipment, x: 0, z: 0 }) as never

const party_with = (members: readonly string[], poses: Record<string, { x: number; z: number }> = {}) => {
  const party = create_party()
  party.leader_id = members[0]!
  party.members = [...members]
  for (const [id, pose] of Object.entries(poses)) party.poses.set(id, pose)
  return party
}

const gathering_names = (names: readonly string[]): readonly string[] =>
  names.filter((name) => {
    const kind = config.chore_plan[name]?.kind
    return kind === 'gather' || kind === 'gather_craft' || kind === 'gather_all' || kind === 'gather_all_craft'
  })

describe('gather_members', () => {
  it('includes every gathering chore kind, not just `gather`', () => {
    const names = ['omori', 'memorien', 'llokan', 'archero']
    const state: GameState = { ...initial_game_state, characters: names.map((name) => character(name)) }
    const members = gather_members(state, party_with(names))
    expect(members.map((member) => member.name)).toEqual(gathering_names(names))
    expect(members.length).toBeGreaterThan(0)
  })

  it('gives a single-job member its one job and a rotator all three', () => {
    const state: GameState = { ...initial_game_state, characters: [character('omori'), character('archero')] }
    const members = gather_members(state, party_with(['omori', 'archero']))
    expect(members.find((member) => member.name === 'omori')!.jobs).toEqual(['HERBALIST'])
    expect([...members.find((member) => member.name === 'archero')!.jobs].sort()).toEqual(['FARMER', 'HERBALIST', 'MINER'])
  })
})

describe('gather_needs', () => {
  it('reports an unmet specialty when the window holds no pack of the member job', () => {
    const state: GameState = {
      ...initial_game_state,
      characters: [character('omori', { HERBALIST: xp(60) }, [{ id: 't', category: 'tool_herbalist', slot: 'tool' }])],
    }
    const party = party_with(['omori'], { omori: { x: 0, z: 0 } })
    const needs = gather_needs(state, gather_members(state, party))
    expect(needs.map((need) => need.job)).toEqual(['HERBALIST'])
    // The need is scoped to the member's OWN world: an unlocked-but-remote yakutia tier must not
    // make a nauvis gap unresolvable (same-world relocation is all the excursion can do).
    expect(needs.map((need) => need.world)).toEqual(['nauvis'])
  })

  it('is satisfied by ANY unlocked tier of the job, not only the richest', () => {
    // memorien farms at level 69, so the richest unlocked FARMER tier in nauvis is wheat_malt (T3);
    // a bare wheat (T1) pack underfoot still feeds the member, so no relocation is warranted.
    const state: GameState = {
      ...initial_game_state,
      characters: [character('memorien', { FARMER: xp(69) }, [{ id: 't', category: 'tool_farmer', slot: 'tool' }])],
      zones: [{ world: 'nauvis', zx: 0, zz: 0, mob_taken: '0', res_taken: [0] } as never],
      zone_spawns: {
        'nauvis:0:0': { mobs: [], resources: [{ index: 0, nodes: 5, item_type: 'wheat', x: 0, z: 0 }] },
      } as never,
    }
    const party = party_with(['memorien'], { memorien: { x: 0, z: 0 } })
    expect(gather_needs(state, gather_members(state, party))).toEqual([])
  })

  it('skips a member that owns no tool for its job (travel cannot fix a missing tool)', () => {
    const state: GameState = { ...initial_game_state, characters: [character('omori', { HERBALIST: xp(60) })] }
    const party = party_with(['omori'], { omori: { x: 0, z: 0 } })
    expect(gather_needs(state, gather_members(state, party))).toEqual([])
  })
})

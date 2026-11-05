import {
  module_chore,
  module_craft_goals,
  module_defaults,
  module_task_complete,
  parse_bot_module,
} from '../src/modules/index.ts'

describe('specialized bot modules', () => {
  it('turns the XP profile into a combat-only scheduler', () => {
    const module = parse_bot_module({ BOT_MODULE: 'xp', BOT_MODULE_CHARACTER: 'Omori', BOT_XP_TARGET_LEVEL: '50' })
    const defaults = module_defaults(module)
    expect(defaults.fight).toBe(true)
    expect(defaults.roam).toBe(true)
    expect(defaults.gather).toBe(false)
    expect(defaults.craft).toBe(false)
    expect(defaults.dungeon).toBe(false)
    expect(module_chore(module, 'omori', 'omori', { kind: 'craft' })).toEqual({ kind: 'none' })
  })

  it('assigns one exact gathering profession and idles every other character', () => {
    const module = parse_bot_module({
      BOT_MODULE: 'job',
      BOT_JOB_TARGET: 'farmer',
      BOT_MODULE_CHARACTER: 'Memorien',
      BOT_JOB_TARGET_LEVEL: '80',
    })
    expect(module_chore(module, 'memorien', 'omori', { kind: 'none' })).toEqual({ kind: 'gather', job: 'FARMER' })
    expect(module_chore(module, 'llokan', 'omori', { kind: 'gather', job: 'MINER' })).toEqual({ kind: 'none' })
    expect(module_defaults(module).fight).toBe(false)
  })

  it('keeps supply gatherers but only one crafter for a crafting profession', () => {
    const module = parse_bot_module({
      BOT_MODULE: 'job',
      BOT_JOB_TARGET: 'TAILOR',
      BOT_MODULE_CHARACTER: 'Omori',
    })
    expect(module_chore(module, 'omori', 'omori', { kind: 'none' })).toEqual({ kind: 'craft' })
    expect(module_chore(module, 'memorien', 'omori', { kind: 'gather', job: 'FARMER' })).toEqual({ kind: 'gather', job: 'FARMER' })
    expect(module_defaults(module).craft).toBe(true)
  })

  it('holds exact-item mode once the requested owned quantity exists', () => {
    const module = parse_bot_module({
      BOT_MODULE: 'craft',
      BOT_CRAFT_TARGET: 'araknomath_spindle',
      BOT_CRAFT_QUANTITY: '2',
    })
    const one = [{ id: 'one', item_type: 'araknomath_spindle', amount: 1 }]
    const two = [{ id: 'two', item_type: 'araknomath_spindle', amount: 2 }]
    expect(module_craft_goals(module, one as never)).toEqual(['araknomath_spindle'])
    expect(module_craft_goals(module, two as never)).toEqual([])
    expect(module_task_complete(module, [{ name: 'omori' }] as never, two as never, 'omori')).toContain('2×')
  })

  it('rejects incomplete or unknown module configuration', () => {
    expect(() => parse_bot_module({ BOT_MODULE: 'craft' })).toThrow('BOT_CRAFT_TARGET')
    expect(() => parse_bot_module({ BOT_MODULE: 'job', BOT_JOB_TARGET: 'WOODCUTTER' })).toThrow('BOT_JOB_TARGET')
    expect(() => parse_bot_module({ BOT_MODULE: 'wat' })).toThrow('BOT_MODULE')
  })
})

const item_type = process.argv[2]
if (!item_type) throw new Error('Usage: bun run bot:craft <item-type> [quantity] [character]')

process.env.BOT_MODULE = 'craft'
process.env.BOT_CRAFT_TARGET = item_type
if (process.argv[3]) process.env.BOT_CRAFT_QUANTITY = process.argv[3]
if (process.argv[4]) process.env.BOT_MODULE_CHARACTER = process.argv[4]

await import('../main.ts')

export {}

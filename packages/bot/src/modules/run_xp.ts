process.env.BOT_MODULE = 'xp'
if (process.argv[2]) process.env.BOT_MODULE_CHARACTER = process.argv[2]
if (process.argv[3]) process.env.BOT_XP_TARGET_LEVEL = process.argv[3]

await import('../main.ts')

export {}

const job = process.argv[2]
if (!job) throw new Error('Usage: bun run bot:job <JOB> [character] [target-level]')

process.env.BOT_MODULE = 'job'
process.env.BOT_JOB_TARGET = job
if (process.argv[3]) process.env.BOT_MODULE_CHARACTER = process.argv[3]
if (process.argv[4]) process.env.BOT_JOB_TARGET_LEVEL = process.argv[4]

await import('../main.ts')

export {}
